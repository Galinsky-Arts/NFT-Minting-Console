import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { WalletProvider } from './auth';
import { Notice, SignInPrompt } from './components';
import type { Configuration, Session } from './model';
import { confirmWalletAction, formatEth, parseEth, sendWalletAction, signOrder } from './wallet-actions';
import type { TypedOrder, WalletAction } from './wallet-actions';
import './studio.css';

interface Props { current: Session | null; config: Configuration; connect: () => void; expired: () => void; walletProvider: () => WalletProvider | null }
interface Payment { role: string; recipient: string; bps: number | null; amountWei: string; required: boolean }
interface Inspection { facts: { owner: string; sellerIsOwner: boolean; conduit: string; name: string; symbol: string; counter: string; approval: { conduitApprovedForAll: boolean; tokenApproval: boolean }; royalty: { recipient: string; bpsAtPrice: number }; policy: { validator: string; marketplaceOperatorAllowed: boolean | null; unlistedOperatorBlocked?: boolean; directHolderTransferAllowed?: boolean; note?: string } }; fees: { known: boolean; reason?: string; fees: Payment[]; source?: string; synthetic?: boolean }; payments: Payment[] | null; blockers: string[]; marketplace: string | null }
export interface Listing { id: string; collection: string; tokenId: string; seller: string; orderHash: string; state: string; revision: number; marketplace: string; order: { domain: TypedOrder['domain']; parameters: Record<string, unknown> & { startTime: string; endTime: string; counter: string; conduitKey: string; consideration: { startAmount: string; recipient: string }[] } }; review: { priceWei: string; payments: Payment[]; royalty: { recipient: string; bpsAtPrice: number }; disclosure: string; expiresAt: string; marketplace: string; synthetic: boolean }; signed: boolean; submission: Record<string, unknown> | null; verification: { problems: string[]; facts: Record<string, unknown>; marketplace: { found?: boolean; active?: boolean; url?: string; synthetic?: boolean; error?: string } | null; checkedAt: string; listedEvidence: unknown } | null; sale: { transactionHash: string; buyer: string; payments: { recipient: string; amountWei: string }[]; royaltyPaidWei: string; royaltyExpectedWei: string } | null; replaces: string | null; updatedAt: string; typedData?: TypedOrder }
export const listingStates: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info']> = {
  prepared: ['Prepared — not signed', 'info'], signed: ['Signed — not yet submitted', 'info'], submitting: ['Submitting', 'warn'], submission_uncertain: ['Submission outcome uncertain — reconcile', 'warn'],
  submitted: ['Accepted by marketplace API — verifying', 'warn'], indexing_pending: ['Valid on-chain — marketplace not yet showing it', 'warn'], listed: ['Listed — independently verified', 'ok'],
  rejected: ['Rejected by marketplace', 'bad'], attention: ['Needs attention', 'bad'], invalid: ['No longer fillable', 'bad'], sold: ['Sold — settlement verified', 'ok'], cancelled: ['Cancelled on-chain', 'info'], expired: ['Expired', 'info'], replaced: ['Replaced by a new price', 'info'] };
const blockerText: Record<string, string> = { SIGNED_IN_WALLET_NOT_OWNER: 'The signed-in wallet does not own this token.', APPROVAL_REQUIRED: 'The marketplace conduit is not approved to transfer this collection’s tokens.', POLICY_BLOCKS_MARKETPLACE: 'The collection transfer policy blocks the marketplace.', POLICY_UNVERIFIED: 'The transfer policy could not be verified.', MARKETPLACE_NOT_CONFIGURED: 'No marketplace API is configured on the server (OpenSea API key required).', MARKETPLACE_FEES_UNKNOWN: 'Marketplace fees could not be read.' };
export function Pill({ state }: { state: string }) { const [label, tone] = listingStates[state] || [state, 'info']; return <span className={`pill pill-${tone}`}>{label}</span>; }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Marketplace(props: Props) {
  if (!props.current) return <SignInPrompt connect={props.connect} />;
  if (props.current.role !== 'owner') return <Notice>Marketplace listing requires owner access.</Notice>;
  return <MarketplaceWorkspace key={props.current.csrf} {...props} current={props.current} />;
}
function MarketplaceWorkspace({ current, config, expired, walletProvider }: Props & { current: Session }) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({ collection: localStorage.getItem('nft-console:last-collection') || '', tokenId: '', price: '', days: 7, replaces: '' });
  const [inspection, setInspection] = useState<Inspection | null>(null), [draft, setDraft] = useState<Listing | null>(null);
  const [items, setItems] = useState<Listing[]>([]), [detail, setDetail] = useState<(Listing & { events?: { event: string; occurred_at: string }[] }) | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const life = useRef(new AbortController());
  useEffect(() => () => life.current.abort(), []);
  const call = (path: string, body?: unknown) => api(path, body === undefined ? { signal: life.current.signal, timeoutMs: 60000 } : { method: 'POST', body, csrf: current.csrf, signal: life.current.signal, timeoutMs: 120000 });
  async function task(label: string, fn: () => Promise<void>) {
    if (busy) return; setBusy(label); setError(''); setMessage('');
    try { await fn(); } catch (e) { if (life.current.signal.aborted) return; if (e instanceof ApiError && e.status === 401) expired(); else setError(e instanceof Error ? e.message : 'The step did not complete.'); }
    finally { if (!life.current.signal.aborted) setBusy(''); }
  }
  const refresh = async () => { const r = await call('/api/market/listings') as { items: Listing[] }; setItems(r.items); };
  useEffect(() => { void call('/api/market/status').then(s => setStatus(s as Record<string, unknown>)).catch(() => setStatus({ available: false, reason: 'UNAVAILABLE' })); void refresh().catch(() => undefined); }, []);
  const priceWei = parseEth(form.price);
  const wallet = () => { const w = walletProvider(); if (!w) throw new Error('Reconnect your wallet to continue.'); return w; };
  const inspect = () => task('Reading ownership, approvals, policy, royalty and marketplace fees from chain', async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(form.collection) || !/^\d{1,78}$/.test(form.tokenId) || priceWei === null) throw new Error('Enter a collection address, token ID and a price in ETH.');
    localStorage.setItem('nft-console:last-collection', form.collection);
    setDraft(null); setInspection(await call('/api/market/inspect', { collection: form.collection, tokenId: form.tokenId, priceWei: priceWei.toString() }) as Inspection);
  });
  const approve = () => task('Waiting for your wallet to approve the marketplace conduit', async () => {
    const action = await call('/api/market/approval', { collection: form.collection, tokenId: form.tokenId }) as WalletAction;
    const sent = await sendWalletAction(wallet(), current, action); setBusy('Waiting for the approval to be confirmed on-chain');
    const done = await confirmWalletAction(current, sent, life.current.signal);
    if (done.state !== 'verified') throw new Error('The approval transaction was not verified (' + done.state + '). Review it in your wallet.');
    setInspection(await call('/api/market/inspect', { collection: form.collection, tokenId: form.tokenId, priceWei: priceWei!.toString() }) as Inspection);
  });
  const prepare = () => task('Preparing the exact Seaport order from fresh chain reads', async () => {
    if (!inspection?.payments) throw new Error('Check the token first.');
    const row = await call('/api/market/listings', { collection: form.collection, tokenId: form.tokenId, priceWei: priceWei!.toString(), durationDays: form.days, feeAcknowledgement: inspection.payments.map(p => [p.role, p.recipient, p.amountWei]), ...(form.replaces ? { replaces: form.replaces } : {}) }) as Listing;
    setDraft(row); await refresh();
  });
  const sign = (row: Listing) => task('Waiting for your wallet signature', async () => {
    if (!row.typedData) throw new Error('Reload the order review.');
    const signature = await signOrder(wallet(), current, row.typedData, { seller: row.seller, collection: row.collection, tokenId: row.tokenId, payments: row.review.payments, seaport: row.order.domain.verifyingContract, orderHash: row.orderHash });
    let next = await call(`/api/market/listings/${row.id}/signature`, { signature }) as Listing;
    setBusy('Submitting the signed order to the marketplace');
    next = await call(`/api/market/listings/${row.id}/submit`, {}) as Listing;
    if (['submitted', 'submission_uncertain'].includes(next.state)) { setBusy('Independently verifying the listing'); next = await call(`/api/market/listings/${row.id}/verify`, {}) as Listing; }
    setDraft(null); setDetail(next); setMessage(listingStates[next.state]?.[0] || next.state); await refresh();
  });
  const act = (row: Listing, what: 'verify' | 'submit') => task(what === 'verify' ? 'Re-verifying on-chain and with the marketplace' : 'Submitting (or reconciling) the same signed order', async () => {
    const next = await call(`/api/market/listings/${row.id}/${what}`, {}) as Listing; setDetail(next); await refresh();
  });
  const cancel = (row: Listing) => task('Waiting for your wallet to cancel the order on Seaport', async () => {
    if (!confirm('Cancel this order on-chain? This costs gas and cannot be undone.')) return;
    const action = await call(`/api/market/listings/${row.id}/cancel`, {}) as WalletAction;
    const sent = await sendWalletAction(wallet(), current, action); setBusy('Waiting for the cancellation to be confirmed');
    await confirmWalletAction(current, sent, life.current.signal);
    setDetail(await call(`/api/market/listings/${row.id}/verify`, {}) as Listing); await refresh();
  });
  const open = (row: Listing) => task('Loading listing history', async () => { setDetail(await call(`/api/market/listings/${row.id}`) as Listing); });
  const relist = (row: Listing) => { setForm({ collection: row.collection, tokenId: row.tokenId, price: '', days: 7, replaces: row.id }); setInspection(null); setDraft(null); setMessage('Enter the new price. The previous order stays valid until you cancel it on-chain — cancel it after the new one is listed.'); };
  const st = status as { available?: boolean; reason?: string; problem?: string; marketplace?: string | null; marketplaceSynthetic?: boolean; seaport?: string } | null;
  return <div className="studio">
    {st && !st.available && <Notice error>Marketplace contracts are not available on {config.chainName}: {st.problem || st.reason}. Listing is disabled; existing records remain viewable.</Notice>}
    {st?.available && !st.marketplace && <Notice>Seaport is verified on this network, but no marketplace API is configured on the server. Orders can be prepared and checked but not submitted. Ask the administrator to add an OpenSea API key.</Notice>}
    {st?.marketplaceSynthetic && <Notice>This is a disposable local test marketplace. A “listed” result here is synthetic evidence, not an OpenSea listing.</Notice>}
    {error && <Notice error>{error}</Notice>}{message && <div className="notice" role="status">{message}</div>}
    {busy && <div className="signing-status" role="status"><span className="spinner" />{busy}</div>}
    <section className="panel" aria-labelledby="list-heading">
      <div className="section-heading"><div><h2 id="list-heading">{form.replaces ? 'Change price (replacement order)' : 'List an NFT for sale'}</h2><p className="muted">Fixed-price Seaport listing in ETH. You sign the exact order in your wallet; the console then verifies it on-chain and with the marketplace.</p></div></div>
      <div className="form-grid">
        <label className="field"><span>Collection contract</span><input className="mono" value={form.collection} onChange={e => setForm({ ...form, collection: e.target.value.trim() })} placeholder="0x…" /></label>
        <label className="field"><span>Token ID</span><input inputMode="numeric" value={form.tokenId} onChange={e => setForm({ ...form, tokenId: e.target.value.trim() })} /></label>
        <label className="field"><span>Price (ETH)</span><input inputMode="decimal" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} aria-invalid={form.price !== '' && priceWei === null} /><small>{priceWei !== null && form.price ? formatEth(priceWei) : 'Gross price the buyer pays.'}</small></label>
        <label className="field"><span>Listing duration</span><select value={form.days} onChange={e => setForm({ ...form, days: Number(e.target.value) })}>{[1, 3, 7, 30, 90, 180].map(d => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}</select></label>
      </div>
      <div className="form-actions"><p>Checking reads chain state only. Nothing is signed.</p><button className="button primary" disabled={Boolean(busy)} onClick={() => void inspect()}>Check token and fees</button></div>
      {inspection && <div className="review-block" aria-label="Listing review">
        <h3>Review: {inspection.facts.name} #{form.tokenId}</h3>
        <dl className="kv">
          <div><dt>Current owner</dt><dd className="mono">{inspection.facts.owner} {inspection.facts.sellerIsOwner ? '(you)' : '(not your wallet)'}</dd></div>
          <div><dt>Marketplace conduit approval</dt><dd>{inspection.facts.approval.conduitApprovedForAll ? 'Approved' : 'Not approved'} <span className="mono muted">{short(inspection.facts.conduit)}</span></dd></div>
          <div><dt>Transfer policy</dt><dd>{inspection.facts.policy.marketplaceOperatorAllowed === true ? 'Allows the marketplace conduit' : inspection.facts.policy.marketplaceOperatorAllowed === false ? 'Blocks the marketplace conduit' : 'Unverified'}{inspection.facts.policy.note ? ` — ${inspection.facts.policy.note}` : ''}</dd></div>
          <div><dt>Creator royalty (ERC-2981)</dt><dd>{(inspection.facts.royalty.bpsAtPrice / 100).toFixed(2)}% to <span className="mono">{short(inspection.facts.royalty.recipient)}</span></dd></div>
          <div><dt>Marketplace fees</dt><dd>{inspection.fees.known ? (inspection.fees.fees.length ? inspection.fees.fees.map(f => `${(f.bps! / 100).toFixed(2)}% → ${short(f.recipient)}`).join(', ') : 'None required') + (inspection.fees.synthetic ? ' (test marketplace)' : '') : `Unknown (${inspection.fees.reason})`}</dd></div>
        </dl>
        {inspection.payments && <table className="data-table"><caption>Exact payment split if this order is filled</caption><thead><tr><th>Recipient</th><th>Role</th><th>Amount</th></tr></thead>
          <tbody>{inspection.payments.map(p => <tr key={p.role + p.recipient}><td className="mono">{short(p.recipient)}</td><td>{p.role === 'seller' ? 'Your proceeds' : p.role === 'royalty' ? 'Creator royalty' : 'Marketplace fee'}</td><td>{formatEth(p.amountWei)}</td></tr>)}</tbody></table>}
        <p className="fine-print">Royalty is included in this order and paid only if this exact order is filled. ERC-2981 is informational: direct transfers and other sale paths may not pay it. Network gas for approvals or cancellation is paid separately from your wallet.</p>
        {inspection.blockers.length > 0 && <div className="error-summary" role="alert"><strong>Before listing:</strong><ul>{inspection.blockers.map(b => <li key={b}>{blockerText[b] || b}{b === 'APPROVAL_REQUIRED' && inspection.facts.sellerIsOwner && <> <button className="text-button" onClick={() => void approve()} disabled={Boolean(busy)}>Approve conduit in wallet</button></>}{b.startsWith('POLICY') && <> <a className="text-button" href="#/collections">Configure transfer policy</a></>}</li>)}</ul></div>}
        {!inspection.blockers.length && !draft && <div className="form-actions"><p>Next: review the exact order before signing.</p><button className="button primary" disabled={Boolean(busy)} onClick={() => void prepare()}>Prepare order for review</button></div>}
      </div>}
      {draft && <OrderReview row={draft} busy={Boolean(busy)} onSign={() => void sign(draft)} onDiscard={() => setDraft(null)} />}
    </section>
    <section className="panel" aria-labelledby="listings-heading">
      <div className="section-heading"><h2 id="listings-heading">Your listings</h2><button className="button secondary" disabled={Boolean(busy)} onClick={() => void task('Refreshing', refresh)}>Refresh</button></div>
      {!items.length ? <p className="muted">No listing records yet. A minted NFT is not listed until you sign an order and it is verified here.</p> :
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Token</th><th>Price</th><th>Status</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {items.map(r => <tr key={r.id}><td><span className="mono">{short(r.collection)}</span> #{r.tokenId}</td><td>{formatEth(r.review.priceWei)}</td><td><Pill state={r.state} /></td><td>{new Date(r.updatedAt).toLocaleString()}</td>
            <td className="row-actions"><button className="text-button" onClick={() => void open(r)}>Details</button>
              {r.state === 'prepared' && <button className="text-button" onClick={() => void call(`/api/market/listings/${r.id}`).then(v => setDraft({ ...(v as Listing), typedData: { domain: r.order.domain, types: TYPES, primaryType: 'OrderComponents', message: r.order.parameters as unknown as TypedOrder['message'] } }))}>Review & sign</button>}
              {['signed', 'submission_uncertain', 'rejected'].includes(r.state) && <button className="text-button" onClick={() => void act(r, 'submit')}>{r.state === 'submission_uncertain' ? 'Reconcile submission' : 'Submit'}</button>}
              {!['prepared', 'sold', 'replaced', 'cancelled', 'expired'].includes(r.state) && <button className="text-button" onClick={() => void act(r, 'verify')}>Verify now</button>}
              {r.signed && !['sold', 'replaced', 'cancelled', 'expired'].includes(r.state) && <><button className="text-button" onClick={() => relist(r)}>Change price</button><button className="text-button" onClick={() => void cancel(r)}>Cancel order</button></>}
            </td></tr>)}
        </tbody></table></div>}
    </section>
    {detail && <ListingDetail row={detail} close={() => setDetail(null)} />}
  </div>;
}
const TYPES = { OrderComponents: [{ name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' }, { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' }, { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' }, { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' }, { name: 'counter', type: 'uint256' }],
  OfferItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }],
  ConsiderationItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }] };
function OrderReview({ row, busy, onSign, onDiscard }: { row: Listing; busy: boolean; onSign: () => void; onDiscard: () => void }) {
  const p = row.order.parameters;
  return <div className="review-block" aria-label="Exact order to sign">
    <h3>Exact Seaport order you will sign</h3>
    <dl className="kv">
      <div><dt>Seller (offerer)</dt><dd className="mono">{row.seller}</dd></div><div><dt>NFT</dt><dd className="mono">{row.collection} #{row.tokenId}</dd></div>
      <div><dt>Price</dt><dd>{formatEth(row.review.priceWei)}</dd></div><div><dt>Valid</dt><dd>{new Date(Number(p.startTime) * 1000).toLocaleString()} → {new Date(Number(p.endTime) * 1000).toLocaleString()}</dd></div>
      <div><dt>Seaport contract</dt><dd className="mono">{row.order.domain.verifyingContract} (v{row.order.domain.version}, chain {row.order.domain.chainId})</dd></div>
      <div><dt>Counter / conduit key</dt><dd className="mono">{p.counter} / {short(p.conduitKey)}</dd></div><div><dt>Order hash</dt><dd className="mono">{row.orderHash}</dd></div>
    </dl>
    <ol className="consideration">{p.consideration.map((c, i) => <li key={i}>{formatEth(c.startAmount)} → <span className="mono">{c.recipient}</span></li>)}</ol>
    <p className="fine-print">{row.review.disclosure} Signing creates an off-chain order; it moves nothing until a buyer fills it. You can cancel it later on-chain (gas required).</p>
    <div className="form-actions"><button className="button subtle" onClick={onDiscard} disabled={busy}>Not now</button><button className="button primary" onClick={onSign} disabled={busy}>Sign order in wallet and submit</button></div>
  </div>;
}
function ListingDetail({ row, close }: { row: Listing & { events?: { event: string; occurred_at: string }[] }; close: () => void }) {
  const v = row.verification;
  return <section className="panel" aria-labelledby="detail-heading"><div className="section-heading"><h2 id="detail-heading">Listing #{row.tokenId} evidence</h2><button className="button subtle" onClick={close}>Close</button></div>
    <p><Pill state={row.state} /></p>
    <dl className="kv"><div><dt>Order hash</dt><dd className="mono">{row.orderHash}</dd></div>
      {v && <div><dt>Last independent check</dt><dd>{new Date(v.checkedAt).toLocaleString()} — {v.problems.length ? 'Problems: ' + v.problems.join(', ') : 'Fillable on-chain (owner, approval, counter, signature, policy, window all valid)'}</dd></div>}
      {v?.marketplace && <div><dt>Marketplace</dt><dd>{v.marketplace.error ? `Unavailable (${v.marketplace.error})` : v.marketplace.found ? (v.marketplace.active ? 'Order found and active' : 'Order found but inactive') : 'Order not found yet'}{v.marketplace.synthetic ? ' — synthetic test marketplace' : ''} {v.marketplace.url && <a href={v.marketplace.url} target="_blank" rel="noreferrer noopener">Open marketplace page</a>}</dd></div>}
      {row.sale && <><div><dt>Buyer</dt><dd className="mono">{row.sale.buyer}</dd></div><div><dt>Sale transaction</dt><dd className="mono">{row.sale.transactionHash}</dd></div>
        <div><dt>Royalty</dt><dd>Paid {formatEth(row.sale.royaltyPaidWei)} (order specified {formatEth(row.sale.royaltyExpectedWei)}) — from the on-chain OrderFulfilled settlement.</dd></div>
        <div><dt>Payments settled</dt><dd>{row.sale.payments.map(p => `${formatEth(p.amountWei)} → ${short(p.recipient)}`).join('; ')}</dd></div></>}
      {row.submission && <div><dt>Submission</dt><dd className="mono">{JSON.stringify(row.submission)}</dd></div>}
    </dl>
    {row.events && <><h3>History</h3><ol className="history">{row.events.map((e, i) => <li key={i}>{new Date(e.occurred_at).toLocaleString()} — {e.event}</li>)}</ol></>}
  </section>;
}
