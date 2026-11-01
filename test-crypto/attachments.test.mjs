import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createCipheriv } from 'node:crypto';
import { prepareAttachment, openAttachment, validatePrivateManifest, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE } from '../console/crypto/attachments.mjs';
const C = MIN_CHUNK_SIZE;
const options = { parentMessageId: 'release-message-1', filename: 'private-artwork.bin', mediaType: 'application/octet-stream', chunkSize: C };
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function reseal(manifest) {
  const context = { ...manifest, domain: 'E2EESA-ATTACHMENT-MANIFEST-v1' };
  delete context.attachment_key_hex; delete context.manifest_context_digest_hex;
  return { ...manifest, manifest_context_digest_hex: hash(canonical(context)) };
}
function aad(m, i, length) {
  return Buffer.from(canonical({ domain: 'E2EESA-ATTACHMENT-CHUNK-v1', attachment_id: m.attachment_id,
    manifest_context_digest_hex: m.manifest_context_digest_hex, chunk_index: i, chunk_count: m.chunk_count,
    plaintext_length_bytes: length }));
}
function iv(m, i) { const b = Buffer.alloc(12); Buffer.from(m.nonce_prefix_hex, 'hex').copy(b); b.writeBigUInt64BE(BigInt(i), 4); return b; }
async function fixture(size = C * 2 + 9) {
  const input = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 256);
  const prepared = await prepareAttachment(new Blob([input]), options), chunks = [];
  await prepared.encryptTo((i, bytes) => { chunks[i] = bytes; });
  return { input, prepared, m: prepared.privateManifest, chunks };
}
for (const size of [0, 1, C - 1, C, C + 1, C * 2 + 9]) {
  test(`round trip ${size} bytes, exact tags/count/hash and callback lifetime`, async () => {
    const { input, m, chunks } = await fixture(size);
    assert.equal(m.plaintext_hash_hex, hash(input));
    assert.equal(chunks.length, Math.max(1, Math.ceil(size / C)));
    assert.equal(chunks.reduce((n, c) => n + c.length, 0), size + chunks.length * 16);
    const opened = await openAttachment(m, options.parentMessageId), output = [], references = [];
    const report = await opened.decryptTo(i => chunks[i], (i, bytes) => { output[i] = Uint8Array.from(bytes); references.push(bytes); });
    assert.equal(report.wholeFileVerified, true);
    assert.deepEqual(Buffer.concat(output), Buffer.from(input));
    assert(references.every(bytes => bytes.every(b => b === 0)));
  });
}
test('independent OpenSSL decryption validates canonical AAD, nonce and context digest', async () => {
  const { input, m, chunks } = await fixture();
  assert.equal(reseal(m).manifest_context_digest_hex, m.manifest_context_digest_hex);
  const output = chunks.map((bytes, i) => {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(m.attachment_key_hex, 'hex'), iv(m, i));
    decipher.setAAD(aad(m, i, bytes.length - 16)); decipher.setAuthTag(bytes.slice(-16));
    return Buffer.concat([decipher.update(bytes.slice(0, -16)), decipher.final()]);
  });
  assert.deepEqual(Buffer.concat(output), Buffer.from(input));
});
test('fresh identifiers, keys and nonce prefix for identical files and derivatives', async () => {
  const a = await fixture(1), b = await fixture(1);
  for (const field of ['attachment_id', 'key_id', 'attachment_key_hex', 'nonce_prefix_hex', 'storage_object_id']) assert.notEqual(a.m[field], b.m[field]);
  assert.equal(a.m.attachment_key_hex.length, 64);
  assert.notDeepEqual(a.chunks[0], b.chunks[0]);
});
test('rejects bit flips, wrong key, cross-file substitution and wrong chunk position before releasing bytes', async () => {
  const a = await fixture(), b = await fixture(), opened = await openAttachment(a.m, options.parentMessageId);
  const changed = Uint8Array.from(a.chunks[0]); changed[10] ^= 1;
  for (const [index, bytes] of [[0, changed], [0, b.chunks[0]], [0, a.chunks[1]], [1, a.chunks[0]]]) {
    await assert.rejects(opened.decryptChunk(index, bytes), /validation/);
  }
  const wrong = await openAttachment({ ...a.m, attachment_key_hex: 'ab'.repeat(32) }, options.parentMessageId);
  await assert.rejects(wrong.decryptChunk(0, a.chunks[0]), /validation/);
  let delivered = 0;
  await assert.rejects(opened.decryptTo(() => changed, () => delivered++));
  assert.equal(delivered, 0);
});
test('rejects truncation, extension, absent chunks and out-of-range indexes', async () => {
  const { m, chunks } = await fixture(), opened = await openAttachment(m, options.parentMessageId);
  for (const bytes of [chunks[0].slice(1), new Uint8Array(chunks[0].length + 1), undefined, [], 'ciphertext']) await assert.rejects(opened.decryptChunk(0, bytes));
  for (const index of [-1, 0.5, m.chunk_count, Number.MAX_SAFE_INTEGER, '0', NaN]) await assert.rejects(opened.decryptChunk(index, chunks[0]));
  await assert.rejects(opened.decryptTo(i => i < 2 ? chunks[i] : undefined, () => {}));
});
test('every manifest field is bound or type/format checked', async () => {
  const { m } = await fixture();
  for (const [field, value] of Object.entries(m)) {
    if (field === 'attachment_key_hex') continue; // excluded by normative digest; wrong-key AEAD checked above
    const modified = { ...m, [field]: typeof value === 'number' ? value + 1 : value + 'x' };
    assert.throws(() => validatePrivateManifest(modified, options.parentMessageId), /validation/, field);
  }
  assert.throws(() => validatePrivateManifest({ ...m, extra: 'secret' }, options.parentMessageId));
  assert.throws(() => validatePrivateManifest(m, 'another-release'));
  assert.throws(() => validatePrivateManifest(m));
  assert.throws(() => validatePrivateManifest(reseal({ ...m, chunk_count: m.chunk_count + 1 }), options.parentMessageId));
  assert.throws(() => validatePrivateManifest(reseal({ ...m, plaintext_size_bytes: 0 }), options.parentMessageId));
});
test('changing metadata and recomputing digest does not bypass chunk authentication', async () => {
  const { m, chunks } = await fixture();
  for (const changes of [{ filename: 'substituted.txt' }, { storage_object_id: 'ab'.repeat(16) }, { parent_message_id: 'other' }, { plaintext_hash_hex: '00'.repeat(32) }]) {
    const changed = reseal({ ...m, ...changes }), opened = await openAttachment(changed, changed.parent_message_id);
    await assert.rejects(opened.decryptChunk(0, chunks[0]));
  }
});
test('whole-file verification rejects valid tags over bytes inconsistent with claimed hash', async () => {
  const { m } = await fixture(3), malicious = reseal({ ...m, plaintext_hash_hex: '00'.repeat(32) });
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(m.attachment_key_hex, 'hex'), iv(m, 0));
  cipher.setAAD(aad(malicious, 0, 3));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from('abc')), cipher.final(), cipher.getAuthTag()]);
  const opened = await openAttachment(malicious, options.parentMessageId);
  let authenticatedChunk = false;
  await assert.rejects(opened.decryptTo(() => ciphertext, () => { authenticatedChunk = true; }), /validation/);
  assert.equal(authenticatedChunk, true); // quarantined sink MUST NOT commit without final successful result
});
test('encrypt capability cannot reuse nonces: duplicate, concurrent, failed and cancelled calls', async () => {
  const a = await prepareAttachment(new Blob(['a']), options);
  const first = a.encryptTo(() => {});
  await assert.rejects(a.encryptTo(() => {})); await first;
  await assert.rejects(a.encryptTo(() => {}));
  const b = await prepareAttachment(new Blob(['a']), options);
  await assert.rejects(b.encryptTo(() => { throw new Error('sink unavailable'); }));
  await assert.rejects(b.encryptTo(() => {}));
  const controller = new AbortController(), c = await prepareAttachment(new Blob(['a']), { ...options, signal: controller.signal });
  controller.abort(); let called = false;
  await assert.rejects(c.encryptTo(() => { called = true; }), /cancelled/);
  assert.equal(called, false); await assert.rejects(c.encryptTo(() => {}));
});
test('cancellation during write stops further chunks and failed plaintext sinks are wiped', async () => {
  const controller = new AbortController(), p = await prepareAttachment(new Blob([new Uint8Array(C * 3)]), { ...options, signal: controller.signal });
  let writes = 0;
  await assert.rejects(p.encryptTo(() => { writes++; controller.abort(); }), /cancelled/);
  assert.equal(writes, 1);
  const { m, chunks } = await fixture(), opened = await openAttachment(m, options.parentMessageId); let reference;
  await assert.rejects(opened.decryptTo(i => chunks[i], (_i, bytes) => { reference = bytes; throw new Error('sink failed'); }));
  assert(reference.every(x => x === 0));
});
test('manifest and ciphertext caller mutation during async key import cannot change context', async () => {
  const { m, chunks, input } = await fixture();
  const mutable = { ...m }, pending = openAttachment(mutable, options.parentMessageId);
  mutable.filename = 'changed'; mutable.attachment_key_hex = '00'.repeat(32);
  const opened = await pending, copy = Uint8Array.from(chunks[0]), decrypting = opened.decryptChunk(0, copy);
  copy.fill(0); assert.deepEqual(await decrypting, input.slice(0, C));
});
test('invalid sizes, metadata and non-Blob sources fail before callbacks', async () => {
  for (const chunkSize of [0, C - 1, MAX_CHUNK_SIZE + 1, 1.1, Infinity, '65536']) await assert.rejects(prepareAttachment(new Blob(['a']), { ...options, chunkSize }));
  for (const filename of ['', 'a\u0000b', 'a'.repeat(1025), 42, '\ud800']) await assert.rejects(prepareAttachment(new Blob(['a']), { ...options, filename }));
  await assert.rejects(prepareAttachment({ size: 10, slice() { throw new Error('unreachable'); } }, options));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareAttachment(new Blob(['a']), { ...options, signal: controller.signal }), /cancelled/);
});
test('64 MiB file encrypts/decrypts sequentially with at most one chunk passed to sink', async () => {
  const size = 64 * 1024 * 1024, blob = new Blob([new Uint8Array(size)]);
  const p = await prepareAttachment(blob, { ...options, chunkSize: MAX_CHUNK_SIZE });
  const opened = await openAttachment(p.privateManifest, options.parentMessageId);
  let count = 0, active = 0;
  await p.encryptTo(async (i, bytes) => {
    assert.equal(++active, 1); assert(bytes.length <= MAX_CHUNK_SIZE + 16);
    const plaintext = await opened.decryptChunk(i, bytes); assert(plaintext.every(x => x === 0));
    count += plaintext.length; active--;
  });
  assert.equal(count, size);
});
test('native immutable Blob access ignores subclass size and slice substitutions', async () => {
  class MutableBlob extends Blob {
    get size() { return 9; }
    slice() { throw new Error('must not use attacker-supplied slice'); }
    arrayBuffer() { throw new Error('must not use attacker-supplied arrayBuffer'); }
  }
  const prepared = await prepareAttachment(new MutableBlob(['abc']), options);
  assert.equal(prepared.privateManifest.plaintext_size_bytes, 3);
  assert.equal(prepared.privateManifest.plaintext_hash_hex, hash('abc'));
  const opened = await openAttachment(prepared.privateManifest, options.parentMessageId);
  await prepared.encryptTo(async (i, bytes) => assert.equal(new TextDecoder().decode(await opened.decryptChunk(i, bytes)), 'abc'));
});

test('manifest validation never invokes accessors or text coercion hooks', async () => {
  const { m } = await fixture(3);
  let invoked = false;
  for (const field of Object.keys(m)) {
    const getter = Object.defineProperty({ ...m }, field, { enumerable: true, get() { invoked = true; return m[field]; } });
    assert.throws(() => validatePrivateManifest(getter, options.parentMessageId), /validation/);
  }
  for (const field of ['attachment_id', 'key_id', 'attachment_key_hex', 'storage_object_id', 'plaintext_hash_hex', 'manifest_context_digest_hex']) {
    const coercion = { toString() { invoked = true; return m[field]; } };
    assert.throws(() => validatePrivateManifest({ ...m, [field]: coercion }, options.parentMessageId), /validation/);
  }
  assert.equal(invoked, false);
  const hidden = Object.defineProperty({ ...m }, 'extra', { value: 'not serialized' });
  assert.throws(() => validatePrivateManifest(hidden, options.parentMessageId), /validation/);
  const symbol = { ...m, [Symbol('hidden')]: 'not serialized' };
  assert.throws(() => validatePrivateManifest(symbol, options.parentMessageId), /validation/);
  assert.deepEqual(validatePrivateManifest({ ...m }, options.parentMessageId), m);
});
