import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { WalletProvider } from './auth';
import { Notice, SignInPrompt } from './components';
import type { Configuration, Session } from './model';
import { confirmWalletAction, sendWalletAction, WalletRejected } from './wallet-actions';
import type { WalletAction } from './wallet-actions';
import { Pill } from './Marketplace';
import type { Listing } from './Marketplace';
import './studio.css';

interface Props { current: Session | null; config: Configuration; connect: () => void; expired: () => void; walletProvider: () => WalletProvider | null }
interface Token { tokenId: string; owner: string; metadataURI: string; title: string; mediaSHA256: string; rightsURI: string; rightsSHA256: string }
interface Inventory { collection: string; name: string; symbol: string; seriesSize: string; totalMinted: string; remainingSupply: string; mintingClosed: boolean; owner: string; minter: string; royaltyRecipient: string; royaltyBps: number; validator: string; tokens: Token[]; block: number; readAt: string }
interface PolicyView { state: { configured: boolean; owner: string; validator: string; currentValidator: string; policy: { rulesetId: number; listId: string; customRuleset: string; globalOptions: number; rulesetOptions: number }; checks: Record<string, boolean>; targetListId: string; whitelistRuleset: string; validatorCodeHash: string }; steps: { id: string; summary: string; to: string; from: string }[]; pendingActions: WalletAction[]; explanation: { allows: string[]; blocks: string[]; ownerPowers: string[]; neverGranted: string[] }; operators: string[] }
const KNOWN_KEY = 'nft-console:known-collections';
const checkLabels: Record<string, string> = { validatorSet: 'Collection uses the reviewed transfer validator', listOwnedByCollectionOwner: 'Marketplace list owned by the collection OWNER', listApplied: 'List applied to the collection', operatorsWhitelisted: 'Marketplace conduit whitelisted', authorizersListed: 'Marketplace authorizer listed', rulesetConfigured: 'Whitelist ruleset 255 with options 6 selected' };

export function Collections(props: Props) {
  if (!props.current) return <SignInPrompt connect={props.connect} />;
  return <CollectionsWorkspace key={props.current.csrf} {...props} current={props.current} />;
}
function readKnown(): string[] { try { const v = JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x)).slice(0, 50) : []; } catch { return []; } }
function CollectionsWorkspace({ current, config, expired, walletProvider }: Props & { current: Session }) {
  const [known, setKnown] = useState<string[]>(readKnown), [address, setAddress] = useState(readKnown()[0] || '');
  const [inventory, setInventory] = useState<Inventory | null>(null), [policy, setPolicy] = useState<PolicyView | null>(null), [listings, setListings] = useState<Listing[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const life = useRef(new AbortController()); useEffect(() => () => life.current.abort(), []);
  const owner = current.role === 'owner';
  async function task(label: string, fn: () => Promise<void>) {
    if (busy) return; setBusy(label); setError(''); setMessage('');
    try { await fn(); } catch (e) { if (life.current.signal.aborted) return; if (e instanceof ApiError && e.status === 401) expired(); else setError(e instanceof Error ? e.message : 'The step did not complete.'); }
    finally { if (!life.current.signal.aborted) setBusy(''); }
  }
  const load = (target = address) => task('Reading the collection contract', async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error('Enter a deployed collection contract address.');
    const inv = await api(`/api/collections/${target}`, { signal: life.current.signal, timeoutMs: 60000 }) as Inventory;
    setInventory(inv); const next = [target, ...known.filter(k => k.toLowerCase() !== target.toLowerCase())].slice(0, 50); setKnown(next); localStorage.setItem(KNOWN_KEY, JSON.stringify(next));
    if (owner) {
      if (config.capabilities.transferPolicy) setPolicy(await api('/api/policy/inspect', { method: 'POST', body: { collection: target }, csrf: current.csrf, signal: life.current.signal, timeoutMs: 60000 }) as PolicyView);
      setListings(((await api(`/api/market/listings?collection=${target}`, { signal: life.current.signal }).catch(() => ({ items: [] }))) as { items: Listing[] }).items);
    }
  });
  useEffect(() => { if (address) void load(address); }, []);
  const runStep = (step: PolicyView['steps'][number]) => task(`Waiting for your wallet: ${step.summary}`, async () => {
    const wallet = walletProvider(); if (!wallet) throw new Error('Reconnect your wallet.');
    const action = await api('/api/policy/step', { method: 'POST', body: { collection: inventory!.collection, step: step.id }, csrf: current.csrf }) as WalletAction;
    try { const sent = await sendWalletAction(wallet, current, action); setBusy('Waiting for on-chain confirmation, then reading the policy back');
      const done = await confirmWalletAction(current, sent, life.current.signal); if (done.state !== 'verified') throw new Error(`The transaction was not verified (${done.state}). The policy was re-read; review the next step.`); }
    finally { setPolicy(await api('/api/policy/inspect', { method: 'POST', body: { collection: inventory!.collection }, csrf: current.csrf }) as PolicyView); }
  });
  const reconcile = (a: WalletAction) => task('Checking the recorded transaction on-chain', async () => { await confirmWalletAction(current, a, life.current.signal, 5000); setPolicy(await api('/api/policy/inspect', { method: 'POST', body: { collection: inventory!.collection }, csrf: current.csrf }) as PolicyView); });
  const exportInventory = () => { if (!inventory) return; const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), chainId: config.chainId, inventory, listings: listings.map(l => ({ tokenId: l.tokenId, state: l.state, priceWei: l.review.priceWei, orderHash: l.orderHash, sale: l.sale })) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${inventory.symbol}-${inventory.collection.slice(0, 8)}-records.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  void WalletRejected;
  return <div className="studio">
    {error && <Notice error>{error}</Notice>}{message && <div className="notice" role="status">{message}</div>}
    {busy && <div className="signing-status" role="status"><span className="spinner" />{busy}</div>}
    <section className="panel"><div className="section-heading"><div><h2>Open a deployed collection</h2><p className="muted">Everything on this page is read live from {config.chainName}. Nothing here is placeholder data.</p></div></div>
      <div className="inline-form"><label className="field grow"><span>Collection contract</span><input className="mono" list="known-collections" value={address} onChange={e => setAddress(e.target.value.trim())} placeholder="0x…" /></label>
        <datalist id="known-collections">{known.map(k => <option key={k} value={k} />)}</datalist><button className="button primary" disabled={Boolean(busy)} onClick={() => void load()}>Load</button></div></section>
    {inventory && <section className="panel" aria-labelledby="inv-heading">
      <div className="section-heading"><div><span className="eyebrow">{inventory.symbol} · CHAIN {config.chainId}</span><h2 id="inv-heading">{inventory.name}</h2></div><div className="row-actions"><a className="button secondary" href="#/launch">Mint more works</a><a className="button secondary" href="#/marketplace">List a token</a><button className="button subtle" onClick={exportInventory}>Export records</button></div></div>
      <dl className="kv">
        <div><dt>Contract</dt><dd className="mono">{inventory.collection}</dd></div><div><dt>Supply</dt><dd>{inventory.totalMinted} minted of {inventory.seriesSize} (immutable) · {inventory.remainingSupply} remaining{inventory.mintingClosed ? ' · minting permanently closed' : ''}</dd></div>
        <div><dt>OWNER</dt><dd className="mono">{inventory.owner}</dd></div><div><dt>MINTER</dt><dd className="mono">{inventory.minter}</dd></div>
        <div><dt>Royalty (immutable)</dt><dd>{(inventory.royaltyBps / 100).toFixed(2)}% to <span className="mono">{inventory.royaltyRecipient}</span></dd></div><div><dt>Transfer validator</dt><dd className="mono">{inventory.validator}</dd></div>
        <div><dt>Read at</dt><dd>block {inventory.block}, {new Date(inventory.readAt).toLocaleString()}</dd></div>
      </dl>
      <h3>Minted works</h3>
      {!inventory.tokens.length ? <p className="muted">No tokens minted yet.</p> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Token</th><th>Title</th><th>Holder</th><th>Metadata / rights (fixed at mint)</th><th>Listing</th></tr></thead><tbody>
        {inventory.tokens.map(t => { const l = listings.find(x => x.tokenId === t.tokenId && !['replaced'].includes(x.state)); return <tr key={t.tokenId}><td>#{t.tokenId}</td><td>{t.title}</td><td className="mono">{t.owner.slice(0, 8)}…{t.owner.slice(-4)}</td>
          <td className="mono small">{t.metadataURI}<br />media {t.mediaSHA256.slice(0, 12)}… · rights {t.rightsSHA256.slice(0, 12)}…</td><td>{l ? <Pill state={l.state} /> : <span className="muted">Not listed</span>}</td></tr>; })}
      </tbody></table></div>}
    </section>}
    {inventory && owner && <section className="panel" aria-labelledby="policy-heading">
      <div className="section-heading"><div><h2 id="policy-heading">Transfer policy &amp; marketplace compatibility</h2><p className="muted">Limit Break v5 transfer validator, whitelist ruleset 255 with options 6. Each change is a transaction you sign as OWNER; the console reads the result back and fails closed on any difference.</p></div>{policy && <span className={`pill pill-${policy.state.configured ? 'ok' : 'warn'}`}>{policy.state.configured ? 'Configured and verified' : 'Not configured'}</span>}</div>
      {!config.capabilities.transferPolicy && <Notice>Transfer-policy automation needs a configured validator and marketplace contracts on this network.</Notice>}
      {policy && <>
        <ul className="checklist">{Object.entries(policy.state.checks).map(([k, ok]) => <li key={k} className={ok ? 'ok' : 'todo'}><span aria-hidden="true">{ok ? '✓' : '○'}</span> {checkLabels[k] || k}</li>)}</ul>
        <div className="two-col"><div><h3>What this policy allows</h3><ul>{policy.explanation.allows.map(x => <li key={x}>{x}</li>)}</ul><h3>What it blocks</h3><ul>{policy.explanation.blocks.map(x => <li key={x}>{x}</li>)}</ul></div>
          <div><h3>Owner powers (disclosed)</h3><ul>{policy.explanation.ownerPowers.map(x => <li key={x}>{x}</li>)}</ul><h3>Never granted</h3><ul>{policy.explanation.neverGranted.map(x => <li key={x}>{x}</li>)}</ul></div></div>
        <p className="fine-print">Validator {policy.state.validator} (code hash {policy.state.validatorCodeHash.slice(0, 18)}…), whitelist ruleset {policy.state.whitelistRuleset}. Marketplace operator: {policy.operators.join(', ')}.</p>
        {policy.pendingActions.map(a => <div className="notice" key={a.id}>A {a.subject.step} transaction is {a.state}{a.txHash ? ` (${a.txHash.slice(0, 12)}…)` : ''}. <button className="text-button" onClick={() => void reconcile(a)}>Check it on-chain</button></div>)}
        {getAddressSafe(policy.state.owner) !== getAddressSafe(current.wallet) && !policy.state.configured ? <Notice>Only the collection OWNER ({policy.state.owner}) can configure the policy. Sign in with that wallet.</Notice> :
          policy.steps[0] && (() => { const step = policy.steps[0]!; return <div className="review-block"><h3>Next owner transaction ({policy.steps.length} remaining in this phase)</h3><p>{step.summary}</p><p className="fine-print">To <span className="mono">{step.to}</span> from <span className="mono">{step.from}</span>. Gas is paid from your wallet. Steps are re-planned from chain state after each confirmation, so an interrupted step is never blindly repeated.</p>
            <button className="button primary" disabled={Boolean(busy)} onClick={() => void runStep(step)}>Review in wallet</button></div>; })()}
      </>}
    </section>}
  </div>;
}
const getAddressSafe = (a: string) => a.toLowerCase();
