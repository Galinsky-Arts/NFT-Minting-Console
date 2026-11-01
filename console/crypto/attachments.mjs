/** Client-only attachment format. Private manifests contain keys: NEVER send
 * them to storage/API/logs. Parent-message E2EE/device authorization is separate. */
import { sha256 } from '@noble/hashes/sha256';

export const ATTACHMENT_PROFILE = 'attachment-chunked-aead@0.1.0';
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_FILE_SIZE = 1024 ** 4;
const encoder = new TextEncoder();
const FIELDS = ['format_version', 'profile', 'attachment_id', 'parent_message_id', 'key_id',
  'attachment_key_hex', 'aead', 'hash', 'nonce_prefix_hex', 'chunk_size_bytes', 'chunk_count',
  'plaintext_size_bytes', 'filename', 'media_type', 'plaintext_hash_hex', 'storage_object_id',
  'manifest_context_digest_hex'];
const HEX32 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const fail = () => { throw new Error('Attachment validation failed.'); };
const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), x => Number.parseInt(x, 16));
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])));
const randomHex = length => hex(globalThis.crypto.getRandomValues(new Uint8Array(length)));
function textField(value, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || encoder.encode(value).length > max ||
      /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) fail();
}
function dimensions(size, chunkSize) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE ||
      !Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) fail();
  return Math.max(1, Math.ceil(size / chunkSize));
}
function contextDigest(manifest) {
  const context = { ...manifest, domain: 'E2EESA-ATTACHMENT-MANIFEST-v1' };
  delete context.attachment_key_hex;
  delete context.manifest_context_digest_hex;
  return hex(sha256(encoder.encode(canonical(context))));
}
/** Copy and validate before any async operation; untrusted objects cannot
 * change the authenticated context during a WebCrypto or storage await. */
export function validatePrivateManifest(input, expectedParentMessageId) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).length !== FIELDS.length) fail();
  const m = {};
  for (const field of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    m[field] = descriptor.value;
  }
  // Reject objects before regex checks, which would otherwise call toString.
  for (const field of FIELDS.filter(k => !['format_version', 'chunk_size_bytes', 'chunk_count', 'plaintext_size_bytes'].includes(k))) {
    if (typeof m[field] !== 'string') fail();
  }
  if (m.format_version !== 1 || m.profile !== ATTACHMENT_PROFILE || m.aead !== 'ALG-AES-256-GCM' ||
      m.hash !== 'ALG-SHA-256' || !ID.test(m.attachment_id) || !ID.test(m.key_id) ||
      !ID.test(m.storage_object_id) || !HEX32.test(m.attachment_key_hex) ||
      !HEX32.test(m.plaintext_hash_hex) || !HEX32.test(m.manifest_context_digest_hex) ||
      typeof m.nonce_prefix_hex !== 'string' || !/^[0-9a-f]{8}$/.test(m.nonce_prefix_hex)) fail();
  textField(m.parent_message_id, 128);
  textField(expectedParentMessageId, 128);
  textField(m.filename, 1024);
  textField(m.media_type, 255, true);
  if (m.parent_message_id !== expectedParentMessageId ||
      m.chunk_count !== dimensions(m.plaintext_size_bytes, m.chunk_size_bytes) ||
      m.manifest_context_digest_hex !== contextDigest(m)) fail();
  return Object.freeze(m);
}
function position(m, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= m.chunk_count) fail();
  return Math.min(m.chunk_size_bytes, m.plaintext_size_bytes - index * m.chunk_size_bytes);
}
function parameters(m, index) {
  const nonce = new Uint8Array(12);
  nonce.set(unhex(m.nonce_prefix_hex));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false);
  return { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: encoder.encode(canonical({
    domain: 'E2EESA-ATTACHMENT-CHUNK-v1', attachment_id: m.attachment_id,
    manifest_context_digest_hex: m.manifest_context_digest_hex,
    chunk_index: index, chunk_count: m.chunk_count, plaintext_length_bytes: position(m, index),
  })) };
}
async function importKey(m, usage) {
  const raw = unhex(m.attachment_key_hex);
  try { return await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]); }
  finally { raw.fill(0); }
}
function abort(signal) { if (signal?.aborted) throw new Error('Attachment operation cancelled.'); }

/** Two bounded passes over an immutable Blob: hash first, encrypt second.
 * Ciphertext callback receives only index and ciphertext, never private metadata.
 * The private manifest must be wrapped in an authenticated E2EE parent message.
 * Encryption is one-shot: on failure restart with a fresh attachment/key. */
export async function prepareAttachment(blob, { parentMessageId, filename, mediaType = '',
  chunkSize = 1024 * 1024, signal } = {}) {
  if (!(blob instanceof Blob)) fail();
  textField(parentMessageId, 128); textField(filename, 1024); textField(mediaType, 255, true);
  // Use native Blob methods: subclasses cannot change source bytes between passes.
  const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get.call(blob);
  const read = (start, end) => Blob.prototype.arrayBuffer.call(Blob.prototype.slice.call(blob, start, end));
  const count = dimensions(size, chunkSize), digest = sha256.create();
  try {
    for (let index = 0; index < count; index++) {
      abort(signal);
      const bytes = new Uint8Array(await read(index * chunkSize, Math.min(size, (index + 1) * chunkSize)));
      try { abort(signal); digest.update(bytes); } finally { bytes.fill(0); }
    }
    abort(signal);
    const m = { format_version: 1, profile: ATTACHMENT_PROFILE, attachment_id: randomHex(16),
      parent_message_id: parentMessageId, key_id: randomHex(16), attachment_key_hex: randomHex(32),
      aead: 'ALG-AES-256-GCM', hash: 'ALG-SHA-256', nonce_prefix_hex: randomHex(4),
      chunk_size_bytes: chunkSize, chunk_count: count, plaintext_size_bytes: size,
      filename, media_type: mediaType, plaintext_hash_hex: hex(digest.digest()), storage_object_id: randomHex(16) };
    m.manifest_context_digest_hex = contextDigest(m);
    const manifest = validatePrivateManifest(m, parentMessageId);
    let used = false;
    return Object.freeze({ privateManifest: manifest, async encryptTo(writeCiphertext) {
      if (used || typeof writeCiphertext !== 'function') fail();
      used = true;
      abort(signal);
      const key = await importKey(manifest, 'encrypt');
      for (let index = 0; index < count; index++) {
        abort(signal);
        const bytes = new Uint8Array(await read(index * chunkSize, Math.min(size, (index + 1) * chunkSize)));
        try {
          abort(signal);
          if (bytes.length !== position(manifest, index)) fail();
          const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(parameters(manifest, index), key, bytes));
          abort(signal);
          await writeCiphertext(index, ciphertext);
        } finally { bytes.fill(0); }
      }
      abort(signal);
      return Object.freeze({ ciphertextComplete: true, chunks: count });
    } });
  } finally { digest.destroy(); }
}

/** This function requires an already-authenticated parent manifest and expected
 * parent identity. Validating its digest alone does NOT authenticate its sender. */
export async function openAttachment(input, expectedParentMessageId) {
  const m = validatePrivateManifest(input, expectedParentMessageId);
  const key = await importKey(m, 'decrypt');
  async function decryptChunk(index, ciphertext) {
    const length = position(m, index);
    if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength !== length + 16) fail();
    // Copy caller-controlled memory before awaiting WebCrypto.
    const snapshot = Uint8Array.from(ciphertext);
    try { return new Uint8Array(await globalThis.crypto.subtle.decrypt(parameters(m, index), key, snapshot)); }
    catch { fail(); }
  }
  return Object.freeze({ decryptChunk, async decryptTo(readCiphertext, writeAuthenticatedChunk, { signal } = {}) {
    if (typeof readCiphertext !== 'function' || typeof writeAuthenticatedChunk !== 'function') fail();
    const digest = sha256.create();
    try {
      for (let index = 0; index < m.chunk_count; index++) {
        abort(signal);
        const ciphertext = await readCiphertext(index);
        abort(signal);
        const plaintext = await decryptChunk(index, ciphertext);
        try {
          abort(signal); digest.update(plaintext);
          // Sink must quarantine the output until wholeFileVerified is returned.
          await writeAuthenticatedChunk(index, plaintext);
        } finally { plaintext.fill(0); }
      }
      abort(signal);
      if (hex(digest.digest()) !== m.plaintext_hash_hex) fail();
      return Object.freeze({ wholeFileVerified: true, chunks: m.chunk_count, plaintextBytes: m.plaintext_size_bytes });
    } finally { digest.destroy(); }
  } });
}
