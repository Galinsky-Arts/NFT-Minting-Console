import * as W from '../../crypto/workspace.mjs';
import type { AccountRoot, DeviceCertificate, DeviceKeys, GroupState, KeyPackageBundle, SealedDraft, SealedVault } from '../../crypto/workspace.mjs';
import { prepareAttachment, resumeAttachment, openAttachment } from '../../crypto/attachments.mjs';
import type { PrivateAttachmentManifest } from '../../crypto/attachments.mjs';
import { api } from './api';
import type { Session } from './model';

/** Browser engine for the client-encrypted workspace. Plaintext, keys and the vault key never leave this tab. */
export interface PrivateFile { manifest: PrivateAttachmentManifest; objectId: string; uploaded: boolean; verified: boolean }
export interface DraftDocument {
  kind: 'release-draft'; title: string; description: string; notes: string;
  collection: { name: string; symbol: string; maxSupply: string; royaltyPercent: string };
  works: { tokenId: string; title: string; description: string; fileIds: string[] }[];
  files: Record<string, PrivateFile>;
}
export interface Overview {
  exists: boolean; rootPublicKey?: string; epoch?: string; generation?: number; retention?: string;
  devices?: { deviceId: string; label: string; status: string; certificate: DeviceCertificate }[];
  enrollments?: { deviceId: string; signaturePublicKey: string; label: string; certified: boolean }[];
  drafts?: { draftId: string; revision: number; contentHash: string; updatedAt: string; expiresAt: string }[];
}
interface VaultState {
  v: 1; wallet: string; chainId: number; generation: number; root: AccountRoot | null; rootPublicKey: string;
  device: DeviceKeys; cert: DeviceCertificate | null; kpPublic: string | null; kpPrivate: unknown; group: string | null;
  draftKeys: Record<string, string>; cursor: number; label: string;
}
export const emptyDraft = (): DraftDocument => ({ kind: 'release-draft', title: '', description: '', notes: '', collection: { name: '', symbol: '', maxSupply: '1', royaltyPercent: '5' }, works: [], files: {} });

/* --------------------------- IndexedDB (sealed only) --------------------------- */
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const r = indexedDB.open('nft-console-private', 1); r.onupgradeneeded = () => r.result.createObjectStore('vaults'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function idbGet(key: string): Promise<SealedVault | null> { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('vaults').objectStore('vaults').get(key); r.onsuccess = () => res((r.result as SealedVault) ?? null); r.onerror = () => rej(r.error); }); }
async function idbPut(key: string, value: SealedVault | null): Promise<void> { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('vaults', 'readwrite'); const s = t.objectStore('vaults'); if (value) s.put(value, key); else s.delete(key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
/** Uint8Array-safe JSON for the MLS private key package kept inside the encrypted vault. */
const pack = (v: unknown): unknown => v instanceof Uint8Array ? { $u8: W.b64(v) } : Array.isArray(v) ? v.map(pack) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)])) : v;
const unpack = (v: unknown): unknown => v && typeof v === 'object' && !Array.isArray(v) && '$u8' in (v as Record<string, unknown>) ? W.unb64((v as { $u8: string }).$u8) : Array.isArray(v) ? v.map(unpack) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)])) : v;
const download = (name: string, data: unknown) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
export const backupFileName = (wallet: string) => `nft-console-recovery-${wallet.slice(2, 8).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;

export class PrivateWorkspace {
  private key: Uint8Array | null = null; private sealed: SealedVault | null = null; private state: VaultState | null = null;
  private groupState: GroupState | null = null; private revisions = new Map<string, { revision: number; contentHash: string }>();
  constructor(private session: Session) {}
  get storageKey() { return `vault:${this.session.chainId}:${this.session.wallet.toLowerCase()}`; }
  get unlocked() { return Boolean(this.state); }
  get deviceId() { return this.state?.device.deviceId ?? null; }
  get isRootHolder() { return Boolean(this.state?.root); }
  get member() { return Boolean(this.groupState); }
  get awaitingCertificate() { return Boolean(this.state && !this.state.cert); }
  get awaitingApproval() { return Boolean(this.state?.cert && !this.groupState); }
  localVault() { return idbGet(this.storageKey); }
  overview() { return api('/api/workspace') as Promise<Overview>; }
  lock() { this.key?.fill(0); this.key = null; this.state = null; this.groupState = null; this.revisions.clear(); }
  private kpBundle: KeyPackageBundle | null = null;
  private async persist() {
    const s = this.state!; s.group = this.groupState ? W.saveGroup(this.groupState) : null;
    this.sealed = W.resealVault(this.key!, this.sealed!, s); await idbPut(this.storageKey, this.sealed);
  }
  private async write(path: string, body: unknown, method = 'POST') { return api(path, { method, csrf: this.session.csrf, body, timeoutMs: 60000 }); }

  /** First device: account root, device certificate, MLS group, sealed vault, recovery code and backup file. */
  async setup(passphrase: string, label: string) {
    const root = W.createAccountRoot(), device = await W.newDeviceKeys();
    const cert = W.certifyDevice(root, { deviceId: device.deviceId, signaturePublicKey: W.unb64(device.publicKey) });
    const kp = await W.keyPackageFor(device, cert);
    const state: VaultState = { v: 1, wallet: this.session.wallet.toLowerCase(), chainId: this.session.chainId, generation: 1, root, rootPublicKey: root.publicKey, device, cert, kpPublic: kp.publicPackage, kpPrivate: pack(kp.privatePackage), group: null, draftKeys: {}, cursor: 0, label };
    const vault = await W.createVault(passphrase, state);
    await this.write('/api/workspace', { rootPublicKey: root.publicKey, device: { deviceId: device.deviceId, certificate: cert, keyPackage: kp.publicPackage, label } });
    this.key = vault.key; this.sealed = vault.sealed; this.state = state; this.kpBundle = kp;
    this.groupState = await W.createWorkspaceGroup(root.publicKey, kp); await this.persist();
    const code = W.newRecoveryCode();
    return { code, backup: await W.createRecoveryBackup(code, { root, draftKeys: {}, accountWallet: state.wallet }) };
  }
  async unlock(passphrase: string) {
    const sealed = await idbGet(this.storageKey); if (!sealed) throw new Error('No private workspace vault is stored on this device.');
    const opened = await W.openVault(passphrase, sealed); const s = opened.state as VaultState;
    if (s.wallet !== this.session.wallet.toLowerCase() || s.chainId !== this.session.chainId) throw new Error('This vault belongs to a different wallet or network.');
    this.key = opened.key; this.sealed = sealed; this.state = s;
    if (s.kpPublic) { const k = W.inspectKeyPackage(s.rootPublicKey, s.kpPublic); this.kpBundle = { publicPackage: s.kpPublic, privatePackage: unpack(s.kpPrivate), keyPackage: k.keyPackage }; }
    this.groupState = s.group ? W.loadGroup(s.group, s.rootPublicKey) : null;
  }
  /** New device without the root: publish a public key whose fingerprint the user compares on an authorized device. */
  async beginEnrollment(passphrase: string, label: string, overview: Overview) {
    const device = await W.newDeviceKeys();
    const state: VaultState = { v: 1, wallet: this.session.wallet.toLowerCase(), chainId: this.session.chainId, generation: overview.generation ?? 1, root: null, rootPublicKey: overview.rootPublicKey!, device, cert: null, kpPublic: null, kpPrivate: null, group: null, draftKeys: {}, cursor: 0, label };
    const vault = await W.createVault(passphrase, state); await idbPut(this.storageKey, vault.sealed);
    await this.write('/api/workspace/enrollments', { deviceId: device.deviceId, signaturePublicKey: device.publicKey, label });
    this.key = vault.key; this.sealed = vault.sealed; this.state = state;
    return W.fingerprint(device.publicKey);
  }
  fingerprint() { return this.state ? W.fingerprint(this.state.device.publicKey) : ''; }
  /** After certification: build the MLS key package bound to the certificate and ask to be added. */
  async continueEnrollment(): Promise<boolean> {
    const s = this.state!; if (s.cert) return true;
    const { certificate } = await api(`/api/workspace/enrollments/${s.device.deviceId}`) as { certificate: DeviceCertificate | null };
    if (!certificate) return false;
    if (!W.verifyDeviceCert(s.rootPublicKey, certificate, W.unb64(s.device.publicKey))) throw new Error('The certificate does not match this device key. Do not continue.');
    const kp = await W.keyPackageFor(s.device, certificate);
    await this.write('/api/workspace/devices', { deviceId: s.device.deviceId, certificate, keyPackage: kp.publicPackage, label: s.label });
    s.cert = certificate; s.kpPublic = kp.publicPackage; s.kpPrivate = pack(kp.privatePackage); this.kpBundle = kp; await this.persist(); return true;
  }
  async certify(deviceId: string, signaturePublicKey: string) {
    if (!this.state?.root) throw new Error('Only a device holding the account root can certify new devices.');
    await this.write(`/api/workspace/enrollments/${deviceId}/certificate`, { certificate: W.certifyDevice(this.state.root, { deviceId, signaturePublicKey: W.unb64(signaturePublicKey) }) });
  }
  /** Replays the ordered server log: Welcome (join), commits and key-delivery messages. */
  async sync(): Promise<Overview> {
    const s = this.state!; const o = await this.overview();
    if (!o.exists) throw new Error('The private workspace no longer exists on the server.');
    if (o.rootPublicKey !== s.rootPublicKey) throw new Error('The server presented a different account root. Stop and contact support.');
    if ((o.generation ?? 1) !== s.generation) { s.generation = o.generation ?? 1; s.cursor = 0; if (!s.root) this.groupState = null; }
    for (;;) {
      const log = await api(`/api/workspace/log?device=${s.device.deviceId}&after=${s.cursor}`) as { seq: string; epoch: string; kind: string; senderDevice: string; body: string }[];
      if (!log.length) break;
      for (const m of log) {
        s.cursor = Number(m.seq);
        if (m.kind === 'welcome') { if (!this.groupState && this.kpBundle) this.groupState = await W.joinWorkspace(s.rootPublicKey, m.body, this.kpBundle); continue; }
        if (!this.groupState || m.senderDevice === s.device.deviceId || BigInt(m.epoch) < BigInt(W.epochOf(this.groupState))) continue;
        const r = await W.receive(this.groupState, m.body); this.groupState = r.state;
        if (r.payload?.type === 'keys') Object.assign(s.draftKeys, r.payload.keys as Record<string, string>);
      }
    }
    await this.persist(); return o;
  }
  private async sendKeys() {
    const s = this.state!; if (!this.groupState) return;
    const sent = await W.sendToMembers(this.groupState, { type: 'keys', keys: s.draftKeys });
    await this.write('/api/workspace/messages', { epoch: sent.epoch, senderDevice: s.device.deviceId, body: sent.message }); this.groupState = sent.state; await this.persist();
  }
  async approve(deviceId: string) {
    const s = this.state!; if (!this.groupState) throw new Error('This device is not yet a member.');
    const d = await api(`/api/workspace/devices/${deviceId}`) as { keyPackage: string; status: string };
    if (d.status !== 'pending') throw new Error('That device is not awaiting approval.');
    const add = await W.addDevice(this.groupState, s.rootPublicKey, d.keyPackage);
    await this.write('/api/workspace/commits', { epoch: W.epochOf(this.groupState), senderDevice: s.device.deviceId, commit: add.commit, welcome: { targetDevice: deviceId, body: add.welcome }, activate: deviceId });
    this.groupState = add.state; await this.persist(); await this.sendKeys();
  }
  /** Revokes a device in MLS, then rotates every draft key and re-encrypts each draft under its new key. */
  async revoke(deviceId: string) {
    const s = this.state!; if (!this.groupState) throw new Error('This device is not a member.');
    const removed = await W.removeDevice(this.groupState, deviceId);
    await this.write('/api/workspace/commits', { epoch: W.epochOf(this.groupState), senderDevice: s.device.deviceId, commit: removed.commit, revoke: deviceId });
    this.groupState = removed.state; await this.persist();
    for (const draftId of Object.keys(s.draftKeys)) {
      const doc = await this.openDraft(draftId).catch(() => null); s.draftKeys[draftId] = W.newDraftKey(); if (doc) await this.saveDraft(draftId, doc, false);
    }
    await this.sendKeys();
  }
  async openDraft(draftId: string): Promise<DraftDocument> {
    const key = this.state!.draftKeys[draftId]; if (!key) throw new Error('This device has not received the key for this draft yet. Sync, or approve this device from an authorized one.');
    const sealed = await api(`/api/workspace/drafts/${draftId}`) as SealedDraft;
    const doc = W.decryptDraft(key, sealed, { draftId }) as DraftDocument; this.revisions.set(draftId, { revision: sealed.revision, contentHash: sealed.contentHash }); return doc;
  }
  async saveDraft(draftId: string | null, doc: DraftDocument, announce = true): Promise<string> {
    const s = this.state!; const id = draftId ?? W.newId(); let isNew = false;
    if (!s.draftKeys[id]) { s.draftKeys[id] = W.newDraftKey(); isNew = true; }
    const prev = this.revisions.get(id);
    const sealed = W.encryptDraft(s.draftKeys[id]!, { draftId: id, revision: prev ? prev.revision + 1 : 1, previousHash: prev?.contentHash ?? null }, doc);
    await this.write(`/api/workspace/drafts/${id}`, { sealed }, 'PUT');
    this.revisions.set(id, { revision: sealed.revision, contentHash: sealed.contentHash }); await this.persist();
    if (isNew && announce) await this.sendKeys();
    return id;
  }
  /** Encrypts and uploads a file in chunks; resumes from the server's received set; verifies by full decryption. */
  async uploadFile(draftId: string, file: File, existing: PrivateFile | null, onProgress: (done: number, total: number, phase: string) => void, signal: AbortSignal, onManifest?: (f: PrivateFile) => Promise<void>): Promise<PrivateFile> {
    const chunkSize = 4 * 1024 * 1024;
    const prepared = existing ? await resumeAttachment(file, existing.manifest, draftId, { signal }) : await prepareAttachment(file, { parentMessageId: draftId, filename: file.name, mediaType: file.type.slice(0, 255), chunkSize, signal });
    const m = prepared.privateManifest, objectId = m.storage_object_id;
    const status = await this.write('/api/workspace/objects', { objectId, chunkCount: m.chunk_count, chunkSize: m.chunk_size_bytes, ciphertextSize: m.plaintext_size_bytes + 16 * m.chunk_count }) as { received: { index: number }[] };
    if (!existing) await onManifest?.({ manifest: m, objectId, uploaded: false, verified: false });
    const have = new Set(status.received.map(r => r.index)); let done = have.size; onProgress(done, m.chunk_count, 'Encrypting and uploading');
    const put = async (index: number, input: Uint8Array) => {
      const ciphertext = new Uint8Array(input);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext)); const sha = Array.from(digest, x => x.toString(16).padStart(2, '0')).join('');
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw new Error('Upload paused. Choose the same file again to resume.');
        const r = await fetch(`/api/workspace/objects/${objectId}/chunks/${index}`, { method: 'PUT', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha, 'X-CSRF-Token': this.session.csrf }, body: ciphertext }).catch(() => null);
        if (r?.ok) break; if (r && r.status < 500 && r.status !== 429) throw new Error('The server refused an encrypted chunk.');
        if (attempt >= 4) throw new Error('The connection was interrupted. Choose the same file again to resume where it stopped.');
        await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
      }
      done++; onProgress(done, m.chunk_count, 'Encrypting and uploading');
    };
    if ('encryptTo' in prepared) await prepared.encryptTo(put); else await prepared.encryptMissing(have, put);
    onProgress(0, m.chunk_count, 'Verifying the stored copy');
    const opened = await openAttachment(m, draftId); let verifiedChunks = 0;
    await opened.decryptTo(async i => { const r = await fetch(`/api/workspace/objects/${objectId}/chunks/${i}`, { credentials: 'same-origin', signal }); if (!r.ok) throw new Error('Chunk missing'); return new Uint8Array(await r.arrayBuffer()); }, () => { verifiedChunks++; onProgress(verifiedChunks, m.chunk_count, 'Verifying the stored copy'); }, { signal });
    return { manifest: m, objectId, uploaded: true, verified: true };
  }
  /** Decrypts a private file locally into a Blob (never sent anywhere). */
  async openFile(draftId: string, f: PrivateFile): Promise<Blob> {
    const opened = await openAttachment(f.manifest, draftId), parts: Uint8Array[] = [];
    await opened.decryptTo(async i => new Uint8Array(await (await fetch(`/api/workspace/objects/${f.objectId}/chunks/${i}`, { credentials: 'same-origin' })).arrayBuffer()), (i, p) => { parts[i] = new Uint8Array(p); });
    return new Blob(parts as BlobPart[], { type: f.manifest.media_type || 'application/octet-stream' });
  }
  async exportBackup() {
    const s = this.state!; if (!s.root) throw new Error('Only a device holding the account root can create a recovery backup.');
    const code = W.newRecoveryCode(); download(backupFileName(s.wallet), await W.createRecoveryBackup(code, { root: s.root, draftKeys: s.draftKeys, accountWallet: s.wallet })); return code;
  }
  /** Recovery when every device is lost: restore the root from the backup, sign a reset, start a new group. */
  async recover(code: string, backup: SealedVault, passphrase: string, label: string, overview: Overview) {
    const restored = await W.openRecoveryBackup(code, backup);
    if (restored.accountWallet !== this.session.wallet.toLowerCase()) throw new Error('This backup belongs to a different wallet.');
    if (restored.root.publicKey !== overview.rootPublicKey) throw new Error('This backup does not match the workspace on the server.');
    const device = await W.newDeviceKeys(); const cert = W.certifyDevice(restored.root, { deviceId: device.deviceId, signaturePublicKey: W.unb64(device.publicKey) });
    const kp = await W.keyPackageFor(device, cert); const generation = (overview.generation ?? 1) + 1;
    const signed = W.signReset(restored.root, { wallet: this.session.wallet, chainId: this.session.chainId, generation, deviceId: device.deviceId });
    await this.write('/api/workspace/reset', { ...signed, device: { deviceId: device.deviceId, certificate: cert, keyPackage: kp.publicPackage, label } });
    const state: VaultState = { v: 1, wallet: this.session.wallet.toLowerCase(), chainId: this.session.chainId, generation, root: restored.root, rootPublicKey: restored.root.publicKey, device, cert, kpPublic: kp.publicPackage, kpPrivate: pack(kp.privatePackage), group: null, draftKeys: restored.draftKeys, cursor: 0, label };
    const vault = await W.createVault(passphrase, state); this.key = vault.key; this.sealed = vault.sealed; this.state = state; this.kpBundle = kp;
    this.groupState = await W.createWorkspaceGroup(restored.root.publicKey, kp); await this.persist();
  }
  async forgetLocalVault() { this.lock(); await idbPut(this.storageKey, null); }
}
