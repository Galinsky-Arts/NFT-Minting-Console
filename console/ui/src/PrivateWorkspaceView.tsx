import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from './model';
import { ApiError } from './api';
import { Icon, Notice, SignInPrompt } from './components';
import { PrivateWorkspace, emptyDraft, backupFileName, type DraftDocument, type Overview, type PrivateFile } from './workspace-client';
import type { SealedVault } from '../../crypto/workspace.mjs';
import * as Wcrypto from '../../crypto/workspace.mjs';

type Phase = 'loading' | 'setup' | 'choose' | 'locked' | 'open';
const msg = (e: unknown) => e instanceof Error ? e.message : 'The private workspace action failed.';

export function PrivateWorkspaceView({ current, connect, expired }: { current: Session | null; connect: () => void; expired: () => void }) {
  if (!current) return <SignInPrompt connect={connect}/>;
  if (!['owner', 'editor'].includes(current.role)) return <Notice>Private release workspaces are available to owners and editors.</Notice>;
  return <Workspace current={current} expired={expired}/>;
}

function Workspace({ current, expired }: { current: Session; expired: () => void }) {
  const ws = useRef(new PrivateWorkspace(current)).current;
  const [phase, setPhase] = useState<Phase>('loading'), [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [pass, setPass] = useState(''), [pass2, setPass2] = useState(''), [label, setLabel] = useState('This browser');
  const [recovery, setRecovery] = useState<{ code: string; saved: boolean } | null>(null), [fp, setFp] = useState('');
  const [restore, setRestore] = useState<{ code: string; file: SealedVault | null }>({ code: '', file: null });
  const [draftId, setDraftId] = useState<string | null>(null), [draft, setDraft] = useState<DraftDocument | null>(null), [dirty, setDirty] = useState(false);
  const run = async (name: string, fn: () => Promise<void>) => { setBusy(name); setError(''); try { await fn(); } catch (e) { if (e instanceof ApiError && e.status === 401) expired(); setError(msg(e)); } finally { setBusy(''); } };
  const refresh = useCallback(async () => { const o = ws.unlocked ? await ws.sync() : await ws.overview(); setOverview(o); return o; }, [ws]);
  useEffect(() => { void (async () => {
    try { const o = await ws.overview(); setOverview(o); const local = await ws.localVault(); setPhase(local ? 'locked' : o.exists ? 'choose' : 'setup'); }
    catch (e) { setError(msg(e)); setPhase('setup'); }
  })(); return () => ws.lock(); }, [ws]);
  const passOk = [...pass].length >= 12 && pass === pass2;

  const setup = () => run('setup', async () => {
    setStatus('Deriving your vault key (this takes a few seconds)…');
    const { code, backup } = await ws.setup(pass, label);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); a.download = backupFileName(current.wallet); a.click();
    setRecovery({ code, saved: false }); setPass(''); setPass2(''); setStatus(''); await refresh(); setPhase('open');
  });
  const unlock = () => run('unlock', async () => { setStatus('Unlocking…'); await ws.unlock(pass); setPass(''); setStatus(''); await refresh(); setPhase('open'); });
  const enroll = () => run('enroll', async () => { setStatus('Creating this device’s keys…'); setFp(await ws.beginEnrollment(pass, label, overview!)); setPass(''); setPass2(''); setStatus(''); setPhase('open'); });
  const recover = () => run('recover', async () => {
    if (!restore.file) throw new Error('Choose your recovery backup file.');
    setStatus('Restoring from your recovery backup…'); await ws.recover(restore.code.trim(), restore.file, pass, label, overview!); setPass(''); setPass2(''); setStatus(''); await refresh(); setPhase('open');
  });
  const check = () => run('check', async () => { if (ws.awaitingCertificate) { const ok = await ws.continueEnrollment(); if (!ok) { setStatus('Not certified yet. Compare the fingerprint on an authorized device.'); return; } } await refresh(); setStatus(ws.member ? 'This device is now an authorized member.' : 'Waiting for an authorized device to approve this one.'); });
  const openDraft = (id: string) => run('open' + id, async () => { setDraft(await ws.openDraft(id)); setDraftId(id); setDirty(false); });
  const save = () => run('save', async () => { const id = await ws.saveDraft(draftId, draft!); setDraftId(id); setDirty(false); await refresh(); setStatus('Saved. Only your authorized devices can decrypt it.'); });

  if (phase === 'loading') return <p className="loading" role="status">Loading your private workspace…</p>;
  const passFields = <>
    <label className="field"><span>Vault passphrase (12+ characters)</span><input type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)}/></label>
    {phase !== 'locked' && <label className="field"><span>Repeat passphrase</span><input type="password" autoComplete="new-password" value={pass2} onChange={e => setPass2(e.target.value)}/></label>}
    {phase !== 'locked' && <label className="field"><span>Name for this device</span><input value={label} maxLength={80} onChange={e => setLabel(e.target.value)}/></label>}
  </>;
  return <div className="transaction-workspace private-workspace">
    <div className="environment-note"><Icon name="lock"/><p><strong>End-to-end encrypted drafts.</strong> Artwork, rights and release details are encrypted in this browser before upload. The server stores ciphertext only and cannot read it. This web page is still delivered by the console’s server, so you are trusting the code it serves.</p></div>
    {error && <Notice error>{error}</Notice>}
    {status && <p role="status" className="loading">{status}</p>}
    {phase === 'setup' && <section className="panel" aria-labelledby="ws-setup"><div className="section-heading"><div><span className="eyebrow">FIRST DEVICE</span><h2 id="ws-setup">Create your private workspace</h2></div></div>
      <p>This creates your account root key and this device’s keys. They are stored only in this browser, locked by your passphrase. Your wallet is not used to encrypt anything.</p>
      <div className="form-grid">{passFields}</div><button className="button primary" disabled={!passOk || !!busy} onClick={setup}>{busy ? 'Creating…' : 'Create encrypted workspace'}</button></section>}
    {phase === 'choose' && <>
      <section className="panel" aria-labelledby="ws-enroll"><div className="section-heading"><div><span className="eyebrow">ADD THIS DEVICE</span><h2 id="ws-enroll">Enroll this browser</h2></div></div>
        <p>You will see a fingerprint here. On a device that is already authorized, compare it and approve. Only then can this browser decrypt your drafts.</p>
        <div className="form-grid">{passFields}</div><button className="button primary" disabled={!passOk || !!busy} onClick={enroll}>Request access</button></section>
      <section className="panel" aria-labelledby="ws-recover"><div className="section-heading"><div><span className="eyebrow">LOST EVERY DEVICE?</span><h2 id="ws-recover">Recover with your backup</h2></div></div>
        <p>Recovery signs out every other device and starts a new device group. You need your recovery backup file and its recovery code.</p>
        <div className="form-grid">
          <label className="field"><span>Recovery backup file</span><input type="file" accept="application/json" onChange={async e => { const f = e.target.files?.[0]; if (f) { try { const parsed = JSON.parse(await f.text()) as SealedVault; setRestore(r => ({ ...r, file: parsed })); } catch { setError('That is not a recovery backup file.'); } } }}/></label>
          <label className="field"><span>Recovery code</span><input value={restore.code} onChange={e => setRestore(r => ({ ...r, code: e.target.value }))} spellCheck={false} autoComplete="off"/></label>
          {passFields}</div>
        <button className="button secondary" disabled={!passOk || !restore.file || !restore.code || !!busy} onClick={recover}>Recover workspace</button></section></>}
    {phase === 'locked' && <section className="panel" aria-labelledby="ws-unlock"><div className="section-heading"><div><span className="eyebrow">LOCKED</span><h2 id="ws-unlock">Unlock your private workspace</h2></div></div>
      <div className="form-grid">{passFields}</div>
      <div className="button-row"><button className="button primary" disabled={[...pass].length < 12 || !!busy} onClick={unlock}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <button className="text-button" onClick={() => run('forget', async () => { if (confirmForget()) { await ws.forgetLocalVault(); setPhase(overview?.exists ? 'choose' : 'setup'); } })}>Remove this device’s vault</button></div></section>}
    {phase === 'open' && <>
      {recovery && !recovery.saved && <section className="panel" aria-labelledby="ws-code"><h2 id="ws-code">Save your recovery code now</h2>
        <p>Your recovery backup file was downloaded. Together with this code, it restores access if you lose every device. It is shown only once and the console cannot recover it.</p>
        <p className="mono recovery-code" aria-label="Recovery code">{recovery.code}</p>
        <label className="review-checkbox"><input type="checkbox" onChange={e => setRecovery({ ...recovery, saved: e.target.checked })}/> I stored the recovery code and backup file somewhere safe and separate.</label></section>}
      <div className="button-row"><button className="button secondary" disabled={!!busy} onClick={() => run('sync', async () => { await refresh(); setStatus('Synchronized.'); })}>Sync</button>
        <button className="text-button" onClick={() => { ws.lock(); setDraft(null); setDraftId(null); setPhase('locked'); }}>Lock</button></div>
      {(ws.awaitingCertificate || ws.awaitingApproval) && <section className="panel"><h2>Waiting for approval</h2>
        <p>On an authorized device, open Private workspace → Devices and confirm this fingerprint matches exactly:</p><p className="mono recovery-code">{fp || ws.fingerprint()}</p>
        <button className="button secondary" disabled={!!busy} onClick={check}>Check again</button></section>}
      {ws.member && <>
        <Devices ws={ws} overview={overview} run={run} busy={busy} refresh={refresh}/>
        <section className="panel" aria-labelledby="ws-drafts"><div className="section-heading"><div><span className="eyebrow">ENCRYPTED</span><h2 id="ws-drafts">Release drafts</h2></div>
          <button className="button secondary" onClick={() => { setDraft(emptyDraft()); setDraftId(null); setDirty(true); }}>New draft</button></div>
          {overview?.retention && <p className="fine-print">{overview.retention}</p>}
          {!overview?.drafts?.length ? <p>No drafts yet.</p> : <ul className="transaction-list">{overview.drafts.map(d => <li key={d.draftId} className="transaction-row">
            <div><strong className="mono">Draft {d.draftId.slice(0, 8)}</strong> · revision {d.revision} · saved {new Date(d.updatedAt).toLocaleString()}</div>
            <button className="button secondary" disabled={!!busy} onClick={() => openDraft(d.draftId)}>{busy === 'open' + d.draftId ? 'Decrypting…' : 'Open'}</button></li>)}</ul>}
        </section>
        {draft && <DraftEditor ws={ws} draft={draft} draftId={draftId} setDraft={d => { setDraft(d); setDirty(true); }} save={save} saving={busy === 'save'} dirty={dirty} ensureId={async () => { const id = await ws.saveDraft(draftId, draft); setDraftId(id); setDirty(false); await refresh(); return id; }}/>}
      </>}
    </>}
  </div>;
}
function confirmForget() { return window.confirm('Remove this browser’s encrypted vault? Other devices and your recovery backup are not affected.'); }

function Devices({ ws, overview, run, busy, refresh }: { ws: PrivateWorkspace; overview: Overview | null; run: (n: string, f: () => Promise<void>) => Promise<void>; busy: string; refresh: () => Promise<Overview> }) {
  const [compare, setCompare] = useState<Record<string, boolean>>({});
  const enroll = (overview?.enrollments || []).filter(e => !e.certified), pending = (overview?.devices || []).filter(d => d.status === 'pending');
  return <section className="panel" aria-labelledby="ws-devices"><div className="section-heading"><div><span className="eyebrow">ACCESS</span><h2 id="ws-devices">Devices</h2></div></div>
    {enroll.map(e => <div key={e.deviceId} className="mint-confirmation"><h3>New device request: {e.label || 'Unnamed device'}</h3>
      <p>Fingerprint shown here: <span className="mono">{fingerprintOf(e.signaturePublicKey)}</span></p>
      {ws.isRootHolder ? <><label className="review-checkbox"><input type="checkbox" checked={!!compare[e.deviceId]} onChange={x => setCompare({ ...compare, [e.deviceId]: x.target.checked })}/> The fingerprint on the other device matches exactly.</label>
        <button className="button primary" disabled={!compare[e.deviceId] || !!busy} onClick={() => run('certify', async () => { await ws.certify(e.deviceId, e.signaturePublicKey); await refresh(); })}>Certify device</button></>
        : <p>Only your first device (which holds the account root) can certify new devices.</p>}</div>)}
    {pending.map(d => <div key={d.deviceId} className="mint-confirmation"><h3>Ready to approve: {d.label || d.deviceId.slice(0, 8)}</h3>
      <button className="button primary" disabled={!!busy} onClick={() => run('approve', async () => { await ws.approve(d.deviceId); await refresh(); })}>Approve and share draft keys</button></div>)}
    <ul>{(overview?.devices || []).filter(d => d.status !== 'pending').map(d => <li key={d.deviceId}>{d.label || d.deviceId.slice(0, 8)} — {d.status}{d.deviceId === ws.deviceId ? ' (this device)' : ''}
      {d.status === 'active' && d.deviceId !== ws.deviceId && <button className="text-button" disabled={!!busy} onClick={() => run('revoke', async () => { if (window.confirm('Revoke this device? Draft keys will be rotated and every draft re-encrypted.')) { await ws.revoke(d.deviceId); await refresh(); } })}>Revoke</button>}</li>)}</ul>
    {ws.isRootHolder && <button className="text-button" disabled={!!busy} onClick={() => run('backup', async () => { const code = await ws.exportBackup(); window.alert('New recovery backup downloaded. Recovery code (write it down now): ' + code); })}>Download a new recovery backup</button>}
  </section>;
}
const fingerprintOf = (k: string) => Wcrypto.fingerprint(k);

function DraftEditor({ ws, draft, draftId, setDraft, save, saving, dirty, ensureId }: { ws: PrivateWorkspace; draft: DraftDocument; draftId: string | null; setDraft: (d: DraftDocument) => void; save: () => void; saving: boolean; dirty: boolean; ensureId: () => Promise<string> }) {
  const [progress, setProgress] = useState<Record<string, string>>({}), [error, setError] = useState(''), [previews, setPreviews] = useState<Record<string, string>>({});
  const aborts = useRef(new Map<string, AbortController>()), latest = useRef(draft); latest.current = draft;
  const set = (patch: Partial<DraftDocument>) => setDraft({ ...draft, ...patch });
  const putFile = (key: string, f: PrivateFile) => { const next = { ...latest.current, files: { ...latest.current.files, [key]: f } }; latest.current = next; setDraft(next); return next; };
  const upload = async (file: File, existingKey?: string) => {
    setError('');
    try {
      const id = draftId ?? await ensureId();
      const existing = existingKey ? draft.files[existingKey] ?? null : null;
      const control = new AbortController(), key = existingKey ?? `${file.name}-${Date.now()}`; aborts.current.set(key, control);
      const result: PrivateFile = await ws.uploadFile(id, file, existing, (done, total, phase) => setProgress(p => ({ ...p, [key]: `${phase}: ${done}/${total} chunks` })), control.signal,
        async pending => { await ws.saveDraft(id, putFile(key, pending)); });
      await ws.saveDraft(id, putFile(key, result)); setProgress(p => ({ ...p, [key]: 'Encrypted, stored, verified and saved to the draft.' }));
    } catch (e) { setError(msg(e)); }
  };
  const preview = async (key: string, f: PrivateFile) => { try { const blob = await ws.openFile(draftId!, f); setPreviews(p => ({ ...p, [key]: URL.createObjectURL(blob) })); } catch (e) { setError(msg(e)); } };
  useEffect(() => () => { Object.values(previews).forEach(URL.revokeObjectURL); }, [previews]);
  return <section className="panel" aria-labelledby="draft-editor"><div className="section-heading"><div><span className="eyebrow">{draftId ? `DRAFT ${draftId.slice(0, 8)}` : 'NEW DRAFT'}</span><h2 id="draft-editor">{draft.title || 'Untitled release'}</h2></div></div>
    {error && <Notice error>{error}</Notice>}
    <div className="form-grid">
      <label className="field"><span>Release title</span><input value={draft.title} onChange={e => set({ title: e.target.value })}/></label>
      <label className="field"><span>Collection name</span><input value={draft.collection.name} onChange={e => set({ collection: { ...draft.collection, name: e.target.value } })}/></label>
      <label className="field"><span>Symbol</span><input value={draft.collection.symbol} onChange={e => set({ collection: { ...draft.collection, symbol: e.target.value } })}/></label>
      <label className="field"><span>Maximum supply</span><input inputMode="numeric" value={draft.collection.maxSupply} onChange={e => set({ collection: { ...draft.collection, maxSupply: e.target.value } })}/></label>
      <label className="field"><span>Royalty (%)</span><input inputMode="decimal" value={draft.collection.royaltyPercent} onChange={e => set({ collection: { ...draft.collection, royaltyPercent: e.target.value } })}/></label>
    </div>
    <label className="field"><span>Description</span><textarea rows={3} value={draft.description} onChange={e => set({ description: e.target.value })}/></label>
    <label className="field"><span>Private notes and rights drafts</span><textarea rows={4} value={draft.notes} onChange={e => set({ notes: e.target.value })}/></label>
    <h3>Works</h3>
    {draft.works.map((w, i) => <div key={i} className="form-grid">
      <label className="field"><span>Token ID</span><input value={w.tokenId} inputMode="numeric" onChange={e => set({ works: draft.works.map((x, j) => j === i ? { ...x, tokenId: e.target.value } : x) })}/></label>
      <label className="field"><span>Work title</span><input value={w.title} onChange={e => set({ works: draft.works.map((x, j) => j === i ? { ...x, title: e.target.value } : x) })}/></label>
      <button className="text-button" onClick={() => set({ works: draft.works.filter((_, j) => j !== i) })}>Remove work</button></div>)}
    <button className="text-button" onClick={() => set({ works: [...draft.works, { tokenId: String(draft.works.length + 1), title: '', description: '', fileIds: [] }] })}>Add work</button>
    <h3>Private files</h3>
    <label className="field"><span>Add artwork, audio, video or documents (encrypted before upload; large files resume after interruptions)</span><input type="file" multiple onChange={e => { for (const f of Array.from(e.target.files || [])) void upload(f); e.target.value = ''; }}/></label>
    <ul className="transaction-list">{Object.entries(draft.files).map(([key, f]) => <li key={key} className="transaction-row">
      <div><strong>{f.manifest.filename}</strong> · {(f.manifest.plaintext_size_bytes / 1048576).toFixed(1)} MB · {f.verified ? 'encrypted and verified' : 'upload incomplete'}</div>
      {progress[key] && <small role="status">{progress[key]}</small>}
      <div className="button-row">
        {!f.verified && <label className="button secondary">Resume (choose the same file)<input hidden type="file" onChange={e => { const x = e.target.files?.[0]; if (x) void upload(x, key); }}/></label>}
        {aborts.current.get(key) && !f.verified && <button className="text-button" onClick={() => aborts.current.get(key)?.abort()}>Pause</button>}
        {f.verified && draftId && <button className="text-button" onClick={() => void preview(key, f)}>Decrypt and preview</button>}
        {previews[key] && <a href={previews[key]} download={f.manifest.filename}>Download decrypted copy</a>}
      </div>
      {previews[key] && f.manifest.media_type.startsWith('image/') && <img src={previews[key]} alt={`Decrypted preview of ${f.manifest.filename}`} style={{ maxWidth: 240 }}/>}
    </li>)}</ul>
    {Object.entries(progress).filter(([k]) => !draft.files[k]).map(([k, v]) => <p key={k} role="status">{k.replace(/-\d+$/, '')}: {v}</p>)}
    <div className="button-row"><button className="button primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Encrypting…' : dirty ? 'Save encrypted draft' : 'Saved'}</button></div>
    <p className="fine-print">Nothing here is public. To release a work, use Publish to choose exactly which files and metadata become public.</p>
  </section>;
}
