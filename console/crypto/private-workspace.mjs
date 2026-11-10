/**
 * End-to-end encrypted private workspace (client only). Standard WebCrypto primitives:
 *  - Workspace key (WK): random AES-256-GCM key, held only in memory while unlocked.
 *  - Device keys: non-extractable ECDH P-256 key pairs kept in this browser (IndexedDB).
 *  - Device wrap: ECIES-style ephemeral-static ECDH P-256 -> HKDF-SHA-256 -> AES-256-GCM, bound to account,
 *    chain, device ID and key epoch in both the HKDF info and the AEAD associated data.
 *  - Recovery: 256-bit random recovery code -> HKDF-SHA-256 -> AES-256-GCM wrap of WK, bound to account and epoch.
 *  - Records: AES-256-GCM under WK with AAD binding account, chain, record ID, kind, revision and epoch,
 *    so a server cannot substitute records or present an old revision as a newer one.
 *  - Files: the pinned E2EESA attachment profile (attachments.mjs); private manifests live inside records.
 * Wallet login signatures are never used as keys. The server receives public keys, wraps and ciphertext only.
 */
import { prepareAttachment, resumeAttachment, openAttachment } from './attachments.mjs';
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
export class WorkspaceError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new WorkspaceError(code); };
export const b64 = bytes => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return globalThis.btoa(s); };
export const unb64 = v => Uint8Array.from(globalThis.atob(v), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const accountScope = (wallet, chainId) => { if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || !Number.isSafeInteger(chainId)) fail('ACCOUNT'); return `${chainId}:${wallet.toLowerCase()}`; };
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function createDeviceKeys() {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}
export async function fingerprint(publicKey) {
  const h = new Uint8Array(await subtle().digest('SHA-256', concat(enc.encode('NFT-CONSOLE-DEVICE-FP-v1'), publicKey)));
  return Array.from(h.slice(0, 10), x => x.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join('-').toUpperCase();
}
async function hkdfKey(secret, salt, info, usage) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, { name: 'AES-GCM', length: 256 }, false, usage);
}
export async function generateWorkspaceKey() { return rand(32); }
const wrapInfo = (scope, deviceId, epoch) => enc.encode(`NFT-CONSOLE-WK-DEVICE-WRAP-v1|${scope}|${deviceId}|${epoch}`);
/** Wrap raw WK bytes to a device public key (65-byte uncompressed P-256). */
export async function wrapForDevice(wk, devicePublicKey, { wallet, chainId, deviceId, epoch }) {
  if (!(wk instanceof Uint8Array) || wk.length !== 32 || devicePublicKey.length !== 65) fail('WRAP_INPUT');
  const scope = accountScope(wallet, chainId), info = wrapInfo(scope, deviceId, epoch);
  const eph = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const peer = await subtle().importKey('raw', devicePublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
  const salt = rand(16), iv = rand(12);
  try {
    const kek = await hkdfKey(shared, salt, info, ['encrypt']);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: info }, kek, wk));
    return concat(Uint8Array.of(1), new Uint8Array(await subtle().exportKey('raw', eph.publicKey)), salt, iv, ct);
  } finally { shared.fill(0); }
}
export async function unwrapForDevice(wrapped, devicePrivateKey, { wallet, chainId, deviceId, epoch }) {
  if (!(wrapped instanceof Uint8Array) || wrapped.length !== 1 + 65 + 16 + 12 + 48 || wrapped[0] !== 1) fail('WRAP_FORMAT');
  const info = wrapInfo(accountScope(wallet, chainId), deviceId, epoch);
  try {
    const peer = await subtle().importKey('raw', wrapped.slice(1, 66), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, devicePrivateKey, 256));
    try {
      const kek = await hkdfKey(shared, wrapped.slice(66, 82), info, ['decrypt']);
      const wk = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: wrapped.slice(82, 94), additionalData: info }, kek, wrapped.slice(94)));
      if (wk.length !== 32) fail('WRAP_FORMAT');
      return wk;
    } finally { shared.fill(0); }
  } catch (e) { if (e instanceof WorkspaceError) throw e; fail('UNWRAP_FAILED'); }
}
export function newRecoveryCode() { const r = rand(32); let bits = 0, value = 0, out = '';
  for (const byte of r) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(value << (5 - bits)) & 31]; r.fill(0); return out.match(/.{1,4}/g).join('-'); }
function recoverySecret(code) {
  const clean = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 52 || [...clean].some(c => !B32.includes(c))) fail('RECOVERY_CODE_FORMAT');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) { value = ((value << 5) | B32.indexOf(c)) & 0xffff; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Uint8Array.from(out.slice(0, 32));
}
const recoveryInfo = (scope, epoch) => enc.encode(`NFT-CONSOLE-WK-RECOVERY-v1|${scope}|${epoch}`);
export async function wrapForRecovery(wk, code, { wallet, chainId, epoch }) {
  const secret = recoverySecret(code), info = recoveryInfo(accountScope(wallet, chainId), epoch), salt = rand(16), iv = rand(12);
  try { const kek = await hkdfKey(secret, salt, info, ['encrypt']);
    return concat(Uint8Array.of(1), salt, iv, new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: info }, kek, wk))); }
  finally { secret.fill(0); }
}
export async function unwrapRecovery(wrapped, code, { wallet, chainId, epoch }) {
  if (wrapped.length !== 1 + 16 + 12 + 48 || wrapped[0] !== 1) fail('WRAP_FORMAT');
  const secret = recoverySecret(code), info = recoveryInfo(accountScope(wallet, chainId), epoch);
  try { const kek = await hkdfKey(secret, wrapped.slice(1, 17), info, ['decrypt']);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: wrapped.slice(17, 29), additionalData: info }, kek, wrapped.slice(29))); }
  catch { fail('RECOVERY_CODE_INCORRECT'); } finally { secret.fill(0); }
}
const recordAad = (scope, id, kind, revision, epoch) => enc.encode(`NFT-CONSOLE-RECORD-v1|${scope}|${id}|${kind}|${revision}|${epoch}`);
async function aesKey(wk, usage) { return subtle().importKey('raw', wk, 'AES-GCM', false, [usage]); }
export async function sealRecord(wk, value, { wallet, chainId, id, kind, revision, epoch }) {
  const plain = enc.encode(JSON.stringify({ v: 1, value, pad: 'x'.repeat(32) }));
  if (plain.length > 1024 * 1024 - 64) fail('RECORD_TOO_LARGE');
  const iv = rand(12), ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: recordAad(accountScope(wallet, chainId), id, kind, revision, epoch) }, await aesKey(wk, 'encrypt'), plain));
  plain.fill(0); return concat(Uint8Array.of(1), iv, ct);
}
export async function openRecord(wk, envelope, { wallet, chainId, id, kind, revision, epoch }) {
  if (!(envelope instanceof Uint8Array) || envelope[0] !== 1 || envelope.length < 60) fail('RECORD_FORMAT');
  try { const plain = await subtle().decrypt({ name: 'AES-GCM', iv: envelope.slice(1, 13), additionalData: recordAad(accountScope(wallet, chainId), id, kind, revision, epoch) }, await aesKey(wk, 'decrypt'), envelope.slice(13));
    const parsed = JSON.parse(dec.decode(plain)); if (parsed?.v !== 1) fail('RECORD_FORMAT'); return parsed.value; }
  catch (e) { if (e instanceof WorkspaceError) throw e; fail('RECORD_AUTHENTICATION_FAILED'); }
}

/** Device persistence: IndexedDB in browsers (non-extractable private key), injectable for tests. */
export function indexedDbDeviceStore(name = 'nft-console-private-devices-v1') {
  const open = () => new Promise((resolve, reject) => { const r = globalThis.indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('devices'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new WorkspaceError('DEVICE_STORE_UNAVAILABLE')); });
  const op = async (mode, fn) => { const db = await open(); try { return await new Promise((resolve, reject) => { const tx = db.transaction('devices', mode), req = fn(tx.objectStore('devices')); let out; req.onsuccess = () => { out = req.result; }; tx.oncomplete = () => resolve(out); tx.onerror = tx.onabort = () => reject(new WorkspaceError('DEVICE_STORE_UNAVAILABLE')); }); } finally { db.close(); } };
  return { get: key => op('readonly', s => s.get(key)), put: (key, value) => op('readwrite', s => s.put(value, key)), delete: key => op('readwrite', s => s.delete(key)) };
}
export function memoryDeviceStore() { const m = new Map(); return { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; }
const highWaterKey = (scope, id) => `hw:${scope}:${id}`;

/**
 * Workspace client. `request(path, {method, body, raw})` must be the authenticated same-origin API transport.
 */
export class PrivateWorkspace {
  #wk = null; #epoch = 0;
  constructor({ request, wallet, chainId, deviceStore }) { this.request = request; this.wallet = wallet; this.chainId = chainId; this.store = deviceStore; this.scope = accountScope(wallet, chainId); }
  get unlocked() { return Boolean(this.#wk); }
  get epoch() { return this.#epoch; }
  lock() { this.#wk?.fill(0); this.#wk = null; }
  async device() { return (await this.store.get('device:' + this.scope)) || null; }
  async ensureDevice(label) {
    let d = await this.device(); if (d) return d;
    const keys = await createDeviceKeys(); d = { id: globalThis.crypto.randomUUID(), label: String(label || 'This browser').slice(0, 80), privateKey: keys.privateKey, publicKey: keys.publicKey };
    await this.store.put('device:' + this.scope, d); return d;
  }
  async status() { const d = await this.device(); const w = await this.request('/api/private/workspace' + (d ? `?device=${d.id}` : ''), { method: 'GET' }); return { ...w, localDevice: d ? { id: d.id, label: d.label, fingerprint: await fingerprint(d.publicKey) } : null }; }
  /** First device: creates the workspace key, returns the recovery code that the user must store offline. */
  async create(label) {
    const d = await this.ensureDevice(label), wk = await generateWorkspaceKey(), code = newRecoveryCode();
    const ctx = { wallet: this.wallet, chainId: this.chainId, deviceId: d.id, epoch: 1 };
    await this.request('/api/private/workspace', { method: 'POST', body: { deviceId: d.id, label: d.label, publicKey: b64(d.publicKey), wrappedKey: b64(await wrapForDevice(wk, d.publicKey, ctx)), recoveryWrap: b64(await wrapForRecovery(wk, code, ctx)) } });
    this.#wk = wk; this.#epoch = 1; return { recoveryCode: code, deviceId: d.id };
  }
  async unlock() {
    const d = await this.device(); if (!d) fail('DEVICE_NOT_ENROLLED');
    const w = await this.request(`/api/private/workspace?device=${d.id}`, { method: 'GET' });
    if (!w.exists) fail('WORKSPACE_MISSING'); if (w.device?.state !== 'active' || !w.device.wrappedKey) fail(w.device?.state === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_NOT_APPROVED');
    if (w.device.wrappedEpoch !== w.keyEpoch) fail('DEVICE_WRAP_STALE');
    this.#wk = await unwrapForDevice(unb64(w.device.wrappedKey), d.privateKey, { wallet: this.wallet, chainId: this.chainId, deviceId: d.id, epoch: w.keyEpoch });
    this.#epoch = w.keyEpoch; return w;
  }
  async requestAccess(label) { const d = await this.ensureDevice(label); await this.request('/api/private/devices', { method: 'POST', body: { deviceId: d.id, label: d.label, publicKey: b64(d.publicKey) } }); return { deviceId: d.id, fingerprint: await fingerprint(d.publicKey) }; }
  /** Approve a pending device from an unlocked device after the user compared fingerprints on both screens. */
  async approve(pending, confirmedFingerprint) {
    if (!this.#wk) fail('LOCKED'); const me = await this.device(), pk = unb64(pending.publicKey);
    if (await fingerprint(pk) !== confirmedFingerprint) fail('FINGERPRINT_MISMATCH');
    return this.request(`/api/private/devices/${pending.id}/approve`, { method: 'POST', body: { approverId: me.id, keyEpoch: this.#epoch, wrappedKey: b64(await wrapForDevice(this.#wk, pk, { wallet: this.wallet, chainId: this.chainId, deviceId: pending.id, epoch: this.#epoch })) } });
  }
  /** Recovery on a new or reset browser using the offline recovery code. */
  async recover(code, label) {
    const w = await this.request('/api/private/workspace', { method: 'GET' }); if (!w.exists) fail('WORKSPACE_MISSING');
    const wk = await unwrapRecovery(unb64(w.recoveryWrap), code, { wallet: this.wallet, chainId: this.chainId, epoch: w.keyEpoch });
    const { deviceId } = await this.requestAccess(label), d = await this.device();
    await this.request(`/api/private/devices/${deviceId}/recover`, { method: 'POST', body: { keyEpoch: w.keyEpoch, wrappedKey: b64(await wrapForDevice(wk, d.publicKey, { wallet: this.wallet, chainId: this.chainId, deviceId, epoch: w.keyEpoch })) } });
    this.#wk = wk; this.#epoch = w.keyEpoch; return { deviceId };
  }
  /** Revoke a device: rotate WK, rewrap for remaining devices, re-seal every record, issue a new recovery code. */
  async revoke(deviceId) {
    if (!this.#wk) fail('LOCKED'); const w = await this.request('/api/private/workspace', { method: 'GET' }), me = await this.device();
    if (deviceId === me.id) fail('CANNOT_REVOKE_SELF');
    const epoch = w.keyEpoch + 1, wk = await generateWorkspaceKey(), code = newRecoveryCode();
    const wraps = [];
    for (const d of w.devices.filter(x => x.state === 'active' && x.id !== deviceId)) wraps.push({ deviceId: d.id, wrappedKey: b64(await wrapForDevice(wk, unb64(d.publicKey), { wallet: this.wallet, chainId: this.chainId, deviceId: d.id, epoch })) });
    const records = [];
    for (const r of (await this.request('/api/private/records', { method: 'GET' })).items) {
      const value = await this.load(r.id);
      records.push({ id: r.id, expectedRevision: r.revision, envelope: b64(await sealRecord(wk, value, { wallet: this.wallet, chainId: this.chainId, id: r.id, kind: r.kind, revision: r.revision + 1, epoch })) });
    }
    await this.request(`/api/private/devices/${deviceId}/revoke`, { method: 'POST', body: { keyEpoch: epoch, recoveryWrap: b64(await wrapForRecovery(wk, code, { wallet: this.wallet, chainId: this.chainId, epoch })), wraps, records } });
    this.#wk.fill(0); this.#wk = wk; this.#epoch = epoch;
    for (const r of records) await this.store.put(highWaterKey(this.scope, r.id), r.expectedRevision + 1);
    return { recoveryCode: code, keyEpoch: epoch };
  }
  async rotateRecoveryCode() { if (!this.#wk) fail('LOCKED'); const code = newRecoveryCode();
    await this.request('/api/private/recovery', { method: 'POST', body: { keyEpoch: this.#epoch, recoveryWrap: b64(await wrapForRecovery(this.#wk, code, { wallet: this.wallet, chainId: this.chainId, epoch: this.#epoch })) } }); return code; }
  async list() { return (await this.request('/api/private/records', { method: 'GET' })).items; }
  async load(id) {
    if (!this.#wk) fail('LOCKED'); const r = await this.request(`/api/private/records/${id}`, { method: 'GET' });
    if (r.id !== id) fail('RECORD_SUBSTITUTED');
    const seen = await this.store.get(highWaterKey(this.scope, id)); if (seen && r.revision < seen) fail('ROLLBACK_DETECTED');
    if (r.keyEpoch !== this.#epoch) fail('STALE_KEY_EPOCH');
    const value = await openRecord(this.#wk, unb64(r.envelope), { wallet: this.wallet, chainId: this.chainId, id, kind: r.kind, revision: r.revision, epoch: r.keyEpoch });
    await this.store.put(highWaterKey(this.scope, id), r.revision); return { ...value, _revision: r.revision, _kind: r.kind };
  }
  async save(id, kind, value, expectedRevision, { archived = false } = {}) {
    if (!this.#wk) fail('LOCKED'); const clean = { ...value }; delete clean._revision; delete clean._kind;
    const envelope = await sealRecord(this.#wk, clean, { wallet: this.wallet, chainId: this.chainId, id, kind, revision: expectedRevision + 1, epoch: this.#epoch });
    const r = await this.request(`/api/private/records/${id}`, { method: 'PUT', body: { kind, expectedRevision, keyEpoch: this.#epoch, envelope: b64(envelope), archived } });
    if (r.revision !== expectedRevision + 1) fail('UNEXPECTED_REVISION');
    await this.store.put(highWaterKey(this.scope, id), r.revision); return r.revision;
  }
  /** Encrypted, resumable upload. Returns the private manifest + blob id to store inside the (encrypted) record. */
  async uploadFile(file, { recordId, onProgress = () => {}, signal, resume = null, chunkSize = 1024 * 1024 } = {}) {
    const prepared = resume ? await resumeAttachment(file, resume.manifest, recordId, { signal }) : await prepareAttachment(file, { parentMessageId: recordId, filename: file.name || 'file', mediaType: file.type || '', chunkSize, signal });
    const m = prepared.privateManifest, blobId = resume?.blobId || globalThis.crypto.randomUUID();
    const ciphertextBytes = m.plaintext_size_bytes + 16 * m.chunk_count;
    if (!resume) onProgress({ phase: 'prepared', manifest: m, blobId, done: 0, total: m.chunk_count });
    const state = await this.request('/api/private/blobs', { method: 'POST', body: { id: blobId, chunkCount: m.chunk_count, ciphertextBytes } });
    const have = new Set(state.chunks.map(c => c.index)); let done = have.size;
    onProgress({ phase: 'uploading', manifest: m, blobId, done, total: m.chunk_count });
    await prepared.encryptTo(async (index, ct) => {
      for (let attempt = 0; ; attempt++) {
        try { await this.request(`/api/private/blobs/${blobId}/chunks/${index}`, { method: 'PUT', raw: ct, signal }); break; }
        catch (e) { if (signal?.aborted || attempt >= 3 || e?.code === 'CHUNK_CONFLICT') throw e; await new Promise(r => setTimeout(r, 400 * 2 ** attempt)); }
      }
      done++; onProgress({ phase: 'uploading', manifest: m, blobId, done, total: m.chunk_count });
    }, ...(resume ? [{ skip: i => have.has(i) }] : []));
    if (!resume && have.size) fail('UNEXPECTED_EXISTING_CHUNKS');
    await this.request(`/api/private/blobs/${blobId}/complete`, { method: 'POST', body: {} });
    onProgress({ phase: 'complete', manifest: m, blobId, done: m.chunk_count, total: m.chunk_count });
    return { blobId, manifest: m };
  }
  async downloadFile({ blobId, manifest }, recordId, { onProgress = () => {}, signal } = {}) {
    const opener = await openAttachment(manifest, recordId), parts = [];
    const result = await opener.decryptTo(async index => new Uint8Array(await this.request(`/api/private/blobs/${blobId}/chunks/${index}`, { method: 'GET', binary: true, signal })),
      async (index, plain) => { parts.push(plain.slice()); onProgress({ done: index + 1, total: manifest.chunk_count }); }, { signal });
    if (!result.wholeFileVerified) fail('FILE_INTEGRITY');
    return new Blob(parts, { type: manifest.media_type || 'application/octet-stream' });
  }
}
