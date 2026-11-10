import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { Notice, SignInPrompt } from './components';
import type { Configuration, Session } from './model';
import { PrivateWorkspace, indexedDbDeviceStore, fingerprint, unb64 } from '../../crypto/private-workspace.mjs';
import type { DeviceInfo, Progress, Request, WorkspaceStatus } from '../../crypto/private-workspace.mjs';
import { draftDigest, emptyRights, lifecycleLabels, newDraft, newWork, sha256Text, validateRelease } from './release-validation';
import type { DraftFile, DraftWork, Finding, ReleaseDraft, Rights } from './release-validation';
import { setHandoff } from './handoff';
import './studio.css';

interface Props { current: Session | null; config: Configuration; connect: () => void; expired: () => void }
type Row = Awaited<ReturnType<PrivateWorkspace['list']>>[number] & { title?: string };
interface Pending { workId: string; role: DraftFile['role']; name: string; size: number; manifest: unknown; blobId: string; done: number; total: number }
function transport(session: Session, expired: () => void): Request {
  return async (path, { method = 'GET', body, raw, binary, signal } = {}) => {
    const headers: Record<string, string> = { Accept: binary ? 'application/octet-stream' : 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = session.csrf;
    if (raw) headers['Content-Type'] = 'application/octet-stream'; else if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal, body: raw ? new Blob([raw as BlobPart]) : body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 401) { expired(); throw new ApiError(401, 'session_required', 'Sign in again.'); }
    if (binary && r.ok) return r.arrayBuffer();
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new ApiError(r.status, String(data.code || 'request_failed'), String(data.error || 'The request failed.')); (e as unknown as { code: string }).code = String(data.code || 'request_failed'); throw e; }
    return data;
  };
}
const explain: Record<string, string> = { DEVICE_NOT_APPROVED: 'This browser is waiting for approval from one of your other devices.', DEVICE_REVOKED: 'This browser was revoked. Use your recovery code to enroll it again as a new device.', RECOVERY_CODE_INCORRECT: 'That recovery code does not unlock this workspace.', ROLLBACK_DETECTED: 'The server returned an older version of this draft than this browser has already seen. Nothing was loaded.', RECORD_AUTHENTICATION_FAILED: 'This draft failed its integrity check and was not opened.', FINGERPRINT_MISMATCH: 'The fingerprint does not match the device’s key. Do not approve it.', DEVICE_STORE_UNAVAILABLE: 'This browser cannot store device keys (private browsing or blocked storage).' };
const messageOf = (e: unknown) => { const code = (e as { code?: string })?.code; return (code && explain[code]) || (e instanceof Error ? e.message : 'The operation did not complete.'); };
const fmtBytes = (n: number) => n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GiB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MiB' : (n / 1024).toFixed(0) + ' KiB';

export function PrivateStudio(props: Props) {
  if (!props.current) return <SignInPrompt connect={props.connect} />;
  if (props.current.role === 'viewer') return <Notice>Viewer access cannot open a private workspace.</Notice>;
  if (!(props.config.capabilities as { privateWorkspace?: boolean }).privateWorkspace) return <Notice>The private workspace requires the durable database. Ask the administrator to configure it.</Notice>;
  if (!globalThis.isSecureContext || !globalThis.indexedDB) return <Notice error>Private drafting needs a secure (HTTPS) browser context with storage enabled.</Notice>;
  return <Studio key={props.current.wallet + props.current.csrf} {...props} current={props.current} />;
}
function Studio({ current, config, expired }: Props & { current: Session }) {
  const ws = useRef(new PrivateWorkspace({ request: transport(current, expired), wallet: current.wallet, chainId: current.chainId, deviceStore: indexedDbDeviceStore() }));
  const [status, setStatus] = useState<WorkspaceStatus | null>(null), [unlocked, setUnlocked] = useState(false), [code, setCode] = useState(''), [codeSaved, setCodeSaved] = useState(false);
  const [rows, setRows] = useState<Row[]>([]), [openId, setOpenId] = useState(''), [draft, setDraft] = useState<ReleaseDraft | null>(null), [revision, setRevision] = useState(0), [dirty, setDirty] = useState(false);
  const [findings, setFindings] = useState<Finding[] | null>(null), [pending, setPending] = useState<Pending[]>([]), [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState(''), [label, setLabel] = useState(navigator.userAgent.includes('Mobile') ? 'Phone browser' : 'Desktop browser');
  const [recoveryInput, setRecoveryInput] = useState(''), [approveFp, setApproveFp] = useState<Record<string, string>>({});
  const uploads = useRef(new Map<string, AbortController>());
  useEffect(() => () => { ws.current.lock(); for (const c of uploads.current.values()) c.abort(); Object.values(previews).forEach(URL.revokeObjectURL); }, []);
  async function task(text: string, fn: () => Promise<void>) { setBusy(text); setError(''); setMessage(''); try { await fn(); } catch (e) { setError(messageOf(e)); } finally { setBusy(''); } }
  const refresh = async () => { setStatus(await ws.current.status()); };
  const loadRows = async () => { const list = await ws.current.list(); setRows(list); };
  useEffect(() => { void task('Checking your private workspace', refresh); }, []);
  const afterUnlock = async () => { setUnlocked(true); await refresh(); await loadRows(); };
  const create = () => task('Creating device keys and your encrypted workspace', async () => { const r = await ws.current.create(label); setCode(r.recoveryCode); setCodeSaved(false); await afterUnlock(); });
  const unlock = () => task('Unlocking with this device’s key', async () => { await ws.current.unlock(); await afterUnlock(); });
  const requestAccess = () => task('Registering this browser as a new device', async () => { const r = await ws.current.requestAccess(label); setMessage(`Approval requested. On an unlocked device, confirm this fingerprint: ${r.fingerprint}`); await refresh(); });
  const recover = () => task('Recovering access with your recovery code', async () => { await ws.current.recover(recoveryInput, label); setRecoveryInput(''); setMessage('Recovered. This browser is now an authorized device.'); await afterUnlock(); });
  const approve = (d: DeviceInfo) => task('Wrapping the workspace key for the approved device', async () => { await ws.current.approve(d, (approveFp[d.id] || '').trim().toUpperCase()); setMessage(`${d.label} can now unlock the workspace.`); await refresh(); });
  const revoke = (d: DeviceInfo) => task('Revoking the device and rotating the workspace key', async () => { if (!confirm(`Revoke “${d.label}”? A new workspace key and a NEW recovery code will be created; the old code stops working.`)) return; const r = await ws.current.revoke(d.id); setCode(r.recoveryCode); setCodeSaved(false); await refresh(); });
  const newCode = () => task('Creating a new recovery code', async () => { setCode(await ws.current.rotateRecoveryCode()); setCodeSaved(false); });
  const lock = () => { ws.current.lock(); setUnlocked(false); setDraft(null); setRows([]); setOpenId(''); };

  const openDraft = (id: string) => task('Decrypting the draft on this device', async () => { const v = await ws.current.load(id); const { _revision, _kind, ...rest } = v; void _kind; setDraft({ ...newDraft(config.chainId), ...rest }); setRevision(_revision); setOpenId(id); setDirty(false); setFindings(null); setPending(rest.pendingUploads || []); });
  const createDraft = (from?: ReleaseDraft) => task('Creating an encrypted draft', async () => { const id = crypto.randomUUID(); const base = from ? { ...from, works: [], deployedCollection: '', validation: null, lifecycle: 'draft', name: from.name + ' (copy)' } : newDraft(config.chainId); await ws.current.save(id, 'release', base, 0); await loadRows(); setDraft(base); setRevision(1); setOpenId(id); setDirty(false); setFindings(null); setPending([]); });
  const save = (next: ReleaseDraft = draft!, pend = pending) => task('Encrypting and saving', async () => { const r = await ws.current.save(openId, 'release', { ...next, pendingUploads: pend }, revision); setRevision(r); setDirty(false); await loadRows(); setMessage('Saved encrypted. The server holds only ciphertext.'); });
  const saveConfig = () => task('Saving a reusable configuration', async () => { const d = draft!; await ws.current.save(crypto.randomUUID(), 'configuration', { name: d.name, symbol: d.symbol, supply: d.supply, royaltyPercent: d.royaltyPercent, owner: d.owner, minter: d.minter, royaltyRecipient: d.royaltyRecipient, description: d.description, listingPriceEth: d.listingPriceEth, collectionRights: { ...d.collectionRights, approvedSha256: null, approvedAt: null } }, 0); await loadRows(); setMessage('Configuration saved (encrypted). Loading it creates an independent editable copy.'); });
  const fromConfig = (id: string) => task('Creating a new collection from the configuration', async () => { const c = await ws.current.load(id); const { _revision, _kind, ...rest } = c; void _revision; void _kind; const nid = crypto.randomUUID(); const base = { ...newDraft(config.chainId), ...rest, works: [], deployedCollection: '' }; await ws.current.save(nid, 'release', base, 0); await loadRows(); await openDraft(nid); });
  const update = (patch: Partial<ReleaseDraft>) => { setDraft(d => d && { ...d, ...patch, validation: null, lifecycle: d.lifecycle === 'validated' ? 'draft' : d.lifecycle }); setDirty(true); setFindings(null); };
  const updateWork = (id: string, patch: Partial<DraftWork>) => update({ works: draft!.works.map(w => w.id === id ? { ...w, ...patch } : w) });
  const approveRights = async (r: Rights): Promise<Rights> => ({ ...r, approvedSha256: await sha256Text(r.text), approvedAt: new Date().toISOString() });
  const validate = () => task('Validating the current draft', async () => {
    const f = await validateRelease(draft!, { chainId: config.chainId }); setFindings(f);
    const errors = f.filter(x => x.level === 'error').length, next = { ...draft!, validation: { digest: await draftDigest(draft!), at: new Date().toISOString(), errors }, lifecycle: errors ? 'draft' : draft!.lifecycle === 'draft' ? 'validated' : draft!.lifecycle };
    setDraft(next); await save(next);
  });
  async function attach(work: DraftWork, role: DraftFile['role'], file: File, resume?: Pending) {
    const key = work.id + role + file.name, controller = new AbortController(); uploads.current.set(key, controller);
    await task(`Encrypting and uploading ${file.name} (resumable)`, async () => {
      let entry: Pending | null = resume || null;
      const result = await ws.current.uploadFile(file, { recordId: openId, signal: controller.signal, resume: resume ? { manifest: resume.manifest, blobId: resume.blobId } : null,
        onProgress: (p: Progress) => { if (p.phase === 'prepared') { entry = { workId: work.id, role, name: file.name, size: file.size, manifest: p.manifest, blobId: p.blobId, done: 0, total: p.total }; const pend = [...pending.filter(x => !(x.workId === work.id && x.role === role)), entry]; setPending(pend); void ws.current.save(openId, 'release', { ...draft!, pendingUploads: pend }, revision).then(setRevision).catch(() => undefined); }
          else setPending(ps => ps.map(x => x.blobId === p.blobId ? { ...x, done: p.done, total: p.total } : x)); } });
      const manifest = result.manifest, df: DraftFile = { role, name: file.name, type: file.type, size: file.size, sha256: manifest.plaintext_hash_hex, blobId: result.blobId, manifest, complete: true };
      const works = draft!.works.map(w => w.id === work.id ? { ...w, files: [...w.files.filter(x => !(role === 'primary' && x.role === 'primary')), df] } : w);
      const pend = pending.filter(x => x.blobId !== result.blobId && !(x.workId === work.id && x.role === role)); setPending(pend);
      const next = { ...draft!, works, validation: null }; setDraft(next); void entry;
      const r = await ws.current.save(openId, 'release', { ...next, pendingUploads: pend }, revision).catch(async () => { const fresh = await ws.current.load(openId); return ws.current.save(openId, 'release', { ...next, pendingUploads: pend }, fresh._revision); }); setRevision(r); setDirty(false);
    });
    uploads.current.delete(key);
  }
  const preview = (f: DraftFile) => task(`Decrypting ${f.name} on this device`, async () => { const blob = await ws.current.downloadFile({ blobId: f.blobId, manifest: f.manifest as never }, openId); setPreviews(p => ({ ...p, [f.blobId]: URL.createObjectURL(blob) })); });
  const sendToPublication = () => task('Decrypting the selected public works for review', async () => {
    const d = draft!; if (!d.validation || d.validation.errors || d.validation.digest !== await draftDigest(d)) throw new Error('Validate the current draft with no blocking errors before choosing public material.');
    const chosen = d.works.filter(w => w.publicSelected); if (!chosen.length) throw new Error('Select at least one work to publish.');
    const items = [];
    for (const w of chosen) { const primary = w.files.find(f => f.role === 'primary')!, media = w.files.find(f => f.role === 'companion' && f.publicSelected && /^(video|audio)\//.test(f.type));
      const file = async (f: DraftFile) => new File([await ws.current.downloadFile({ blobId: f.blobId, manifest: f.manifest as never }, openId)], f.name, { type: f.type });
      const rights = w.rightsMode === 'token' ? w.rights : d.collectionRights;
      items.push({ tokenId: w.tokenId, title: w.title, description: w.description, files: { image: /^image\//.test(primary.type) ? await file(primary) : undefined, media: media ? await file(media) : /^(video|audio)\//.test(primary.type) ? await file(primary) : undefined, rights: new File([rights.text], `rights-token-${w.tokenId}.md`, { type: 'text/markdown' }) } });
    }
    setHandoff(items); location.hash = '#/launch';
  });
  const exportBackup = () => task('Building an encrypted backup', async () => {
    const records = [] as unknown[]; for (const r of rows) { const res = await fetch(`/api/private/records/${r.id}`, { credentials: 'same-origin' }); records.push(await res.json()); }
    const w = await fetch('/api/private/workspace', { credentials: 'same-origin' }).then(r => r.json());
    const blob = new Blob([JSON.stringify({ format: 'nft-console-private-backup-v1', wallet: current.wallet, chainId: current.chainId, keyEpoch: w.keyEpoch, recoveryWrap: w.recoveryWrap, records, note: 'Ciphertext only. Restoring requires the recovery code that was current when this backup was made. Media chunks remain in server storage.' }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nft-console-private-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  if (!status) return <div className="studio">{error ? <Notice error>{error}</Notice> : <p className="loading" role="status">{busy || 'Loading…'}</p>}</div>;
  return <div className="studio">
    {error && <Notice error>{error}</Notice>}{message && <div className="notice" role="status">{message}</div>}
    {busy && <div className="signing-status" role="status"><span className="spinner" />{busy}</div>}
    {code && <section className="panel recovery-panel" aria-labelledby="code-heading"><h2 id="code-heading">Your recovery code</h2>
      <p>This is the only way to regain access if you lose every authorized device. It is shown once and never sent to the server. Store it offline.</p>
      <p className="recovery-code mono" data-testid="recovery-code">{code}</p>
      <label className="check"><input type="checkbox" checked={codeSaved} onChange={e => setCodeSaved(e.target.checked)} /> I have stored this recovery code somewhere safe.</label>
      <button className="button primary" disabled={!codeSaved} onClick={() => setCode('')}>Done</button></section>}
    {!unlocked && <section className="panel" aria-labelledby="unlock-heading"><h2 id="unlock-heading">{status.exists ? 'Unlock your private workspace' : 'Create your private workspace'}</h2>
      <p className="muted">Drafts, artwork and rights are encrypted in this browser before upload. Wallet sign-in proves who you are; it is not your encryption key. The server stores only ciphertext — but it also serves this web app, so you trust the code it delivers.</p>
      <label className="field"><span>Name for this device</span><input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} /></label>
      {status.localDevice && <p className="fine-print">This browser’s device fingerprint: <span className="mono">{status.localDevice.fingerprint}</span></p>}
      <div className="row-actions">
        {!status.exists && <button className="button primary" disabled={Boolean(busy)} onClick={() => void create()}>Create encrypted workspace</button>}
        {status.exists && status.device?.state === 'active' && <button className="button primary" disabled={Boolean(busy)} onClick={() => void unlock()}>Unlock on this device</button>}
        {status.exists && !status.device && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void requestAccess()}>Request access from another device</button>}
        {status.device?.state === 'pending' && <Notice>Waiting for approval. On an unlocked device, open Private workspace → Devices and confirm fingerprint <span className="mono">{status.localDevice?.fingerprint}</span>. <button className="text-button" onClick={() => void task('Checking', refresh)}>Check again</button></Notice>}
      </div>
      {status.exists && status.device?.state !== 'active' && <div className="inline-form"><label className="field grow"><span>Recovery code</span><input className="mono" autoComplete="off" value={recoveryInput} onChange={e => setRecoveryInput(e.target.value)} placeholder="XXXX-XXXX-…" /></label><button className="button secondary" disabled={Boolean(busy) || !recoveryInput} onClick={() => void recover()}>Recover access</button></div>}
    </section>}
    {unlocked && <>
      <section className="panel"><div className="section-heading"><div><h2>Private releases</h2><p className="muted">Encrypted on this device (key epoch {ws.current.epoch}).</p></div><div className="row-actions"><button className="button primary" disabled={Boolean(busy)} onClick={() => void createDraft()}>New release draft</button><button className="button subtle" onClick={() => void exportBackup()}>Export encrypted backup</button><button className="button subtle" onClick={lock}>Lock</button></div></div>
        {!rows.length ? <p className="muted">No private drafts yet.</p> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Draft</th><th>Kind</th><th>Revision</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {rows.map(r => <tr key={r.id} className={r.id === openId ? 'selected' : ''}><td className="mono small">{r.id.slice(0, 8)}</td><td>{r.kind === 'release' ? 'Release' : 'Saved configuration'}</td><td>{r.revision}</td><td>{new Date(r.updatedAt).toLocaleString()}</td>
            <td className="row-actions">{r.kind === 'release' ? <button className="text-button" onClick={() => void openDraft(r.id)}>Open</button> : <button className="text-button" onClick={() => void fromConfig(r.id)}>New collection from this</button>}</td></tr>)}
        </tbody></table></div>}
      </section>
      {draft && <DraftEditor draft={draft} config={config} dirty={dirty} findings={findings} pending={pending} previews={previews} busy={Boolean(busy)} update={update} updateWork={updateWork} approveRights={approveRights}
        onSave={() => void save()} onValidate={() => void validate()} onAttach={(w, role, f, resume) => void attach(w, role, f, resume)} onPreview={f => void preview(f)} onPublish={() => void sendToPublication()} onSaveConfig={() => void saveConfig()} onCopy={() => void createDraft(draft)}
        onCancelUpload={p => { for (const [k, c] of uploads.current) if (k.startsWith(p.workId + p.role)) c.abort(); }} />}
      <Devices status={status} busy={Boolean(busy)} fp={approveFp} setFp={setApproveFp} approve={d => void approve(d)} revoke={d => void revoke(d)} newCode={() => void newCode()} />
    </>}
  </div>;
}
function Devices({ status, busy, fp, setFp, approve, revoke, newCode }: { status: WorkspaceStatus; busy: boolean; fp: Record<string, string>; setFp: (v: Record<string, string>) => void; approve: (d: DeviceInfo) => void; revoke: (d: DeviceInfo) => void; newCode: () => void }) {
  const [prints, setPrints] = useState<Record<string, string>>({});
  useEffect(() => { void Promise.all(status.devices.map(async d => [d.id, await fingerprint(unb64(d.publicKey))] as const)).then(e => setPrints(Object.fromEntries(e))); }, [status]);
  return <section className="panel" aria-labelledby="devices-heading"><div className="section-heading"><div><h2 id="devices-heading">Authorized devices</h2><p className="muted">Approve a new device only after comparing the fingerprint shown on that device. Revoking rotates the workspace key.</p></div><button className="button subtle" onClick={newCode} disabled={busy}>New recovery code</button></div>
    <ul className="device-list">{status.devices.map(d => <li key={d.id}><div><strong>{d.label}</strong>{d.id === status.localDevice?.id && ' (this browser)'} <span className={`pill pill-${d.state === 'active' ? 'ok' : d.state === 'pending' ? 'warn' : 'info'}`}>{d.state}</span><br /><span className="mono small">{prints[d.id] || '…'}</span></div>
      {d.state === 'pending' && <div className="inline-form"><label className="field"><span>Fingerprint shown on that device</span><input className="mono" value={fp[d.id] || ''} onChange={e => setFp({ ...fp, [d.id]: e.target.value })} /></label><button className="button secondary" disabled={busy || !fp[d.id]} onClick={() => approve(d)}>Approve</button></div>}
      {d.state !== 'revoked' && d.id !== status.localDevice?.id && <button className="text-button" disabled={busy} onClick={() => revoke(d)}>{d.state === 'pending' ? 'Reject' : 'Revoke'}</button>}</li>)}</ul></section>;
}
interface EditorProps { draft: ReleaseDraft; config: Configuration; dirty: boolean; findings: Finding[] | null; pending: Pending[]; previews: Record<string, string>; busy: boolean; update: (p: Partial<ReleaseDraft>) => void; updateWork: (id: string, p: Partial<DraftWork>) => void; approveRights: (r: Rights) => Promise<Rights>; onSave: () => void; onValidate: () => void; onAttach: (w: DraftWork, role: DraftFile['role'], f: File, resume?: Pending) => void; onPreview: (f: DraftFile) => void; onPublish: () => void; onSaveConfig: () => void; onCopy: () => void; onCancelUpload: (p: Pending) => void }
function DraftEditor(p: EditorProps) {
  const d = p.draft, field = (k: keyof ReleaseDraft, labelText: string, extra: { mono?: boolean; hint?: string; mode?: 'numeric' | 'decimal' } = {}) => <label className="field"><span>{labelText}</span><input className={extra.mono ? 'mono' : ''} inputMode={extra.mode} value={String(d[k] ?? '')} onChange={e => p.update({ [k]: e.target.value } as Partial<ReleaseDraft>)} aria-invalid={p.findings?.some(f => f.level === 'error' && f.field === k) || undefined} />{extra.hint && <small>{extra.hint}</small>}</label>;
  const errors = p.findings?.filter(f => f.level === 'error') || [];
  return <section className="panel" aria-labelledby="editor-heading">
    <div className="section-heading"><div><span className="eyebrow">{lifecycleLabels[d.lifecycle] || d.lifecycle}{p.dirty ? ' · UNSAVED CHANGES' : ''}</span><h2 id="editor-heading">{d.name || 'Untitled release'}</h2></div>
      <div className="row-actions"><button className="button secondary" disabled={p.busy} onClick={p.onSave}>Save encrypted</button><button className="button primary" disabled={p.busy} onClick={p.onValidate}>Validate</button></div></div>
    <h3>Collection settings</h3><p className="fine-print">Name, symbol, supply, roles and royalty become immutable when the collection is deployed. Nothing here is shared with previous collections.</p>
    <div className="form-grid">{field('name', 'Collection name')}{field('symbol', 'Symbol')}{field('supply', 'Maximum supply', { mode: 'numeric' })}{field('royaltyPercent', 'Royalty %', { mode: 'decimal', hint: 'Disclosed via ERC-2981; not guaranteed on every sale path.' })}
      {field('owner', 'Owner wallet', { mono: true })}{field('minter', 'Minter wallet', { mono: true })}{field('royaltyRecipient', 'Royalty recipient', { mono: true })}{field('listingPriceEth', 'Planned listing price (ETH)', { mode: 'decimal' })}</div>
    <label className="field wide"><span>Collection description (public after publication)</span><textarea value={d.description} onChange={e => p.update({ description: e.target.value })} rows={3} /></label>
    <RightsEditor title="Collection-wide rights terms" rights={d.collectionRights} busy={p.busy} onChange={r => p.update({ collectionRights: r })} approve={p.approveRights} />
    <label className="field wide"><span>Original-purchaser benefits (private, optional)</span><textarea value={d.originalPurchaserBenefits} onChange={e => p.update({ originalPurchaserBenefits: e.target.value })} rows={2} /><small>Kept in this encrypted draft only. Personal, non-transferable benefits are never written into public metadata.</small></label>
    <div className="section-heading"><h3>Works ({d.works.length})</h3><button className="button secondary" disabled={p.busy} onClick={() => p.update({ works: [...d.works, newWork()] })}>Add work</button></div>
    {d.works.map((w, i) => <article className="work-card" key={w.id} aria-label={`Work ${i + 1}`}>
      <div className="form-grid three"><label className="field"><span>Token ID</span><input inputMode="numeric" value={w.tokenId} onChange={e => p.updateWork(w.id, { tokenId: e.target.value })} /></label>
        <label className="field"><span>Title</span><input value={w.title} onChange={e => p.updateWork(w.id, { title: e.target.value })} /></label>
        <label className="field"><span>Edition (n of m, optional)</span><span className="pair"><input aria-label="Edition number" inputMode="numeric" value={w.editionNumber} onChange={e => p.updateWork(w.id, { editionNumber: e.target.value })} /> of <input aria-label="Edition size" inputMode="numeric" value={w.editionOf} onChange={e => p.updateWork(w.id, { editionOf: e.target.value })} /></span></label></div>
      <label className="field wide"><span>Description</span><textarea rows={2} value={w.description} onChange={e => p.updateWork(w.id, { description: e.target.value })} /></label>
      <DropZone label={w.files.some(f => f.role === 'primary') ? 'Replace primary artwork' : 'Primary artwork (image, video or audio)'} disabled={p.busy} onFile={f => p.onAttach(w, 'primary', f, p.pending.find(x => x.workId === w.id && x.role === 'primary' && x.name === f.name && x.size === f.size))} />
      <DropZone label="Add companion media (optional)" disabled={p.busy} onFile={f => p.onAttach(w, 'companion', f, p.pending.find(x => x.workId === w.id && x.role === 'companion' && x.name === f.name && x.size === f.size))} />
      {p.pending.filter(x => x.workId === w.id).map(x => <div key={x.blobId} className="upload-row" role="status"><span>{x.name} — {x.done}/{x.total} encrypted parts uploaded</span><progress max={x.total} value={x.done} />{x.done < x.total && <><small>Interrupted? Select the same file again to resume; accepted parts are not re-sent.</small><button className="text-button" onClick={() => p.onCancelUpload(x)}>Cancel</button></>}</div>)}
      <ul className="file-list">{w.files.map(f => <li key={f.blobId}><span>{f.role === 'primary' ? 'Primary' : 'Companion'}: {f.name} · {fmtBytes(f.size)} · SHA-256 <span className="mono">{f.sha256.slice(0, 16)}…</span></span>
        {p.previews[f.blobId] ? (/^image\//.test(f.type) ? <img src={p.previews[f.blobId]} alt={`Preview of ${f.name}`} className="thumb" /> : /^video\//.test(f.type) ? <video src={p.previews[f.blobId]} controls className="thumb" /> : /^audio\//.test(f.type) ? <audio src={p.previews[f.blobId]} controls /> : <a href={p.previews[f.blobId]} download={f.name}>Download decrypted</a>) : <button className="text-button" onClick={() => p.onPreview(f)}>Decrypt &amp; preview</button>}
        {f.role === 'companion' && <label className="check"><input type="checkbox" checked={Boolean(f.publicSelected)} onChange={e => p.updateWork(w.id, { files: w.files.map(x => x.blobId === f.blobId ? { ...x, publicSelected: e.target.checked } : x) })} /> Include in public package</label>}
        <button className="text-button" onClick={() => p.updateWork(w.id, { files: w.files.filter(x => x.blobId !== f.blobId) })}>Remove</button></li>)}</ul>
      <fieldset className="radio-row"><legend>Rights for this work</legend><label><input type="radio" checked={w.rightsMode === 'collection'} onChange={() => p.updateWork(w.id, { rightsMode: 'collection' })} /> Collection terms</label><label><input type="radio" checked={w.rightsMode === 'token'} onChange={() => p.updateWork(w.id, { rightsMode: 'token', rights: w.rights.text ? w.rights : { ...emptyRights(), text: d.collectionRights.text } })} /> Token-specific variation</label></fieldset>
      {w.rightsMode === 'token' && <RightsEditor title={`Token ${w.tokenId || i + 1} rights`} rights={w.rights} busy={p.busy} onChange={r => p.updateWork(w.id, { rights: r })} approve={p.approveRights} />}
      <div className="row-actions"><label className="check"><input type="checkbox" checked={w.publicSelected} onChange={e => p.updateWork(w.id, { publicSelected: e.target.checked })} /> Select for publication</label><button className="text-button" onClick={() => p.update({ works: d.works.filter(x => x.id !== w.id) })}>Remove work</button></div>
    </article>)}
    {p.findings && <div className="findings" aria-live="polite"><h3>Validation {errors.length ? `— ${errors.length} blocking issue${errors.length > 1 ? 's' : ''}` : '— no blocking issues'}</h3>
      <ul>{p.findings.map((f, i) => <li key={i} className={`finding finding-${f.level}`}><strong>{f.level === 'error' ? 'Blocking' : f.level === 'warning' ? 'Warning' : 'Note'}:</strong> {f.message}{f.fix && <span className="muted"> {f.fix}</span>}</li>)}</ul></div>}
    {d.validation && <p className="fine-print">Last validated {new Date(d.validation.at).toLocaleString()} ({d.validation.errors} blocking). Any edit invalidates this result.</p>}
    <div className="form-actions"><div className="row-actions"><button className="button subtle" onClick={p.onSaveConfig} disabled={p.busy}>Save settings as reusable configuration</button><button className="button subtle" onClick={p.onCopy} disabled={p.busy}>New independent collection from these settings</button></div>
      <button className="button primary" disabled={p.busy || !d.validation || d.validation.errors > 0 || p.dirty} onClick={p.onPublish}>Review selected works for publication</button></div>
    <p className="fine-print">Choosing works decrypts them only in this browser and opens the publication review. Nothing is uploaded publicly until you approve publication there.</p>
  </section>;
}
function RightsEditor({ title, rights, busy, onChange, approve }: { title: string; rights: Rights; busy: boolean; onChange: (r: Rights) => void; approve: (r: Rights) => Promise<Rights> }) {
  const [current, setCurrent] = useState('');
  useEffect(() => { void sha256Text(rights.text).then(setCurrent); }, [rights.text]);
  const stale = rights.approvedSha256 && rights.approvedSha256 !== current;
  return <div className="rights-editor"><label className="field wide"><span>{title}</span><textarea rows={5} value={rights.text} onChange={e => onChange({ ...rights, text: e.target.value })} /></label>
    <p className="fine-print">{rights.approvedSha256 ? (stale ? <strong>Edited after approval — the approved hash no longer matches. Re-approve.</strong> : <>Approved {rights.approvedAt && new Date(rights.approvedAt).toLocaleString()} · SHA-256 of exact UTF-8 bytes <span className="mono">{rights.approvedSha256.slice(0, 20)}…</span></>) : 'Not approved yet. Write your own terms or have them prepared; NFT Console does not generate licenses.'}</p>
    <div className="row-actions"><label className="text-button file-pick">Load from file<input type="file" accept=".md,.txt" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void f.text().then(text => onChange({ ...rights, text, approvedSha256: null, approvedAt: null })); }} /></label>
      <button className="button secondary" disabled={busy || !rights.text.trim() || (Boolean(rights.approvedSha256) && !stale)} onClick={() => void approve(rights).then(onChange)}>Approve these exact terms</button></div></div>;
}
function DropZone({ label, onFile, disabled }: { label: string; onFile: (f: File) => void; disabled: boolean }) {
  const [over, setOver] = useState(false);
  return <label className={`drop-zone${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && !disabled) onFile(f); }}>
    <span>{label}</span><small>Drag a file here or choose one. It is encrypted in this browser before upload.</small><input type="file" disabled={disabled} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} /></label>;
}
