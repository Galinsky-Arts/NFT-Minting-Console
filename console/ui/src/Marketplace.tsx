import { useCallback, useEffect, useState } from 'react';
import { formatEther, parseEther, isAddress } from 'ethers';
import { api, ApiError } from './api';
import type { Configuration, Session } from './model';
import type { WalletProvider } from './auth';
import { Icon, Notice, SignInPrompt } from './components';
import { TransferPolicy } from './TransferPolicy';
import { ListingFlowError, sendAndConfirm, signOrder, type TypedOrder, type WalletTransaction } from './marketplace-wallet';

interface Payment { role: string; label: string; recipient: string; amountWei: string; bps?: number }
interface Review { marketplace: string; indexed: boolean; priceWei: string; payments: Payment[]; endTime: string; operator: string; policy: { status: string }; approvalRequired: boolean; openseaSlug: string | null; warnings: string[]; royaltyDisclosure: string }
interface Listing { id: string; chainId: number; collection: string; tokenId: string; seller: string; orderHash: string; state: string; review: Review; signed: boolean; submission: Record<string, unknown> | null; observation: { chainState?: string; chain?: Record<string, unknown>; marketplace?: { status: string; matches?: boolean } } | null; settlement: { transactionHash: string; buyer: string; currentOwner: string; royaltyPaidWei: string; expectedRoyaltyWei: string; royaltyEvidence: string; payments: { recipient: string; amountWei: string }[] } | null; cancelTx: string | null; updatedAt: string }
interface MarketInfo { configured: boolean; name?: string; marketplace?: string | null; openSeaConfigured?: boolean; note?: string }
interface Inspection { market: { name: string; operator: string }; token: { owner: string; sellerOwns: boolean; approved: boolean; royalty: { recipient: string; amountWei: string } | null; policy: { status: string } } }
interface Prepared { listing: Listing; typedData: TypedOrder; approvalTransaction: WalletTransaction | null }
interface Props { current: Session | null; config: Configuration; connect: () => void; expired: () => void; walletProvider: () => WalletProvider | null }

export const STATE_LABELS: Record<string, [string, string]> = {
  prepared: ['Awaiting your signature', 'The order is prepared. Nothing is listed until you sign it.'],
  signed: ['Signed', 'Signature verified. Checking the order before submission.'],
  submission_uncertain: ['Submission uncertain', 'The marketplace did not answer clearly. Verify looks up this exact order before anything is re-sent.'],
  rejected: ['Rejected by marketplace', 'The marketplace refused this order. It is not listed.'],
  verifying: ['Verifying', 'Waiting for independent confirmation. It is not yet counted as listed.'],
  listed: ['Listed on OpenSea, verified', 'OpenSea shows this exact order as active, and the chain shows it can be filled.'],
  valid_unindexed: ['Valid order, not on a marketplace', 'The chain shows this order can be filled, but no marketplace indexes this network. It is not an OpenSea listing.'],
  inactive: ['Inactive', 'The order cannot currently be filled (ownership, approval, transfer policy or marketplace record).'],
  expired: ['Expired', 'The order reached its expiry time.'],
  cancel_pending: ['Cancellation pending', 'Waiting for the cancel transaction to confirm.'],
  cancelled: ['Cancelled', 'Seaport records this order as cancelled. It can never be filled.'],
  sold: ['Sold', 'A buyer filled this order on-chain. Settlement evidence is shown below.'],
  superseded: ['Discarded', 'This unsigned order was replaced or discarded before signing.'],
};
const eth = (wei: string) => `${formatEther(BigInt(wei))} ETH`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const message = (e: unknown) => e instanceof ListingFlowError || e instanceof ApiError || e instanceof Error ? e.message : 'The action could not be completed.';

export function Marketplace(props: Props) {
  if (!props.current) return <SignInPrompt connect={props.connect}/>;
  return <MarketplaceWorkspace {...props} current={props.current}/>;
}

function MarketplaceWorkspace({ current, config, expired, walletProvider }: Props & { current: Session }) {
  const [info, setInfo] = useState<MarketInfo | null>(null), [listings, setListings] = useState<Listing[]>([]);
  const [form, setForm] = useState({ collection: '', tokenId: '', price: '', days: '30' });
  const [inspection, setInspection] = useState<Inspection | null>(null), [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [acknowledged, setAcknowledged] = useState(false);
  const csrf = current.csrf, owner = current.role === 'owner';
  const guard = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) expired(); setError(message(e)); }, [expired]);
  const refresh = useCallback(async () => {
    try { setInfo(await api('/api/marketplace') as MarketInfo); if (owner) setListings(await api('/api/marketplace/listings') as Listing[]); }
    catch (e) { guard(e); }
  }, [owner, guard]);
  useEffect(() => { void refresh(); }, [refresh]);
  const wallet = () => { const w = walletProvider(); if (!w) throw new ListingFlowError('Reconnect the wallet you signed in with before continuing.'); return w; };
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(''); setStatus(''); try { await fn(); } catch (e) { guard(e); } finally { setBusy(''); } };
  const priceWei = () => { try { const v = parseEther(form.price.trim() || 'x'); if (v <= 0n) throw new Error(); return v.toString(); } catch { throw new ListingFlowError('Enter a price in ETH greater than zero, for example 0.25.'); } };
  const validInput = isAddress(form.collection.trim()) && /^[0-9]{1,78}$/.test(form.tokenId.trim());

  const inspect = () => run('inspect', async () => {
    setPrepared(null);
    setInspection(await api('/api/marketplace/inspect', { method: 'POST', csrf, body: { collection: form.collection.trim(), tokenId: form.tokenId.trim(), priceWei: priceWei() }, timeoutMs: 30000 }) as Inspection);
  });
  const prepare = () => run('prepare', async () => {
    setAcknowledged(false);
    setPrepared(await api('/api/marketplace/listings', { method: 'POST', csrf, body: { collection: form.collection.trim(), tokenId: form.tokenId.trim(), priceWei: priceWei(), durationDays: Number(form.days) }, timeoutMs: 45000 }) as Prepared);
    await refresh();
  });
  const approve = () => run('approve', async () => {
    if (!prepared?.approvalTransaction) return;
    setStatus('Confirm the approval in your wallet…');
    await sendAndConfirm(wallet(), current, prepared.approvalTransaction, () => setStatus('Approval sent. Waiting for confirmation…'));
    setPrepared({ ...prepared, approvalTransaction: null }); setStatus('Approval confirmed on-chain.');
  });
  const sign = () => run('sign', async () => {
    if (!prepared) return;
    setStatus('Review the exact order in your wallet and sign it…');
    const signature = await signOrder(wallet(), current, prepared.typedData);
    setStatus('Signature received. Verifying and submitting…');
    const result = await api(`/api/marketplace/listings/${prepared.listing.id}/signature`, { method: 'POST', csrf, body: { signature }, timeoutMs: 90000 }) as Listing;
    setPrepared(null); setStatus(`Result: ${STATE_LABELS[result.state]?.[0] || result.state}.`); await refresh();
  });
  const action = (id: string, path: string, label: string) => run(label + id, async () => {
    const result = await api(`/api/marketplace/listings/${id}/${path}`, { method: 'POST', csrf, timeoutMs: 90000 }) as Listing;
    setStatus(`${STATE_LABELS[result.state]?.[0] || result.state}.`); await refresh();
  });
  const cancel = (listing: Listing, thenRelist = false) => run('cancel' + listing.id, async () => {
    const plan = await api(`/api/marketplace/listings/${listing.id}/cancel`, { method: 'POST', csrf }) as { transaction: WalletTransaction | null; note: string };
    if (plan.transaction) {
      setStatus('Confirm the Seaport cancel transaction in your wallet…');
      const hash = await sendAndConfirm(wallet(), current, plan.transaction, () => setStatus('Cancellation sent. Waiting for confirmation…'));
      const result = await api(`/api/marketplace/listings/${listing.id}/cancel-transaction`, { method: 'POST', csrf, body: { hash }, timeoutMs: 60000 }) as Listing;
      setStatus(`${STATE_LABELS[result.state]?.[0] || result.state}.`);
    } else setStatus(plan.note);
    if (thenRelist) { setForm({ collection: listing.collection, tokenId: listing.tokenId, price: formatEther(BigInt(listing.review.priceWei)), days: '30' }); setInspection(null); }
    await refresh();
  });

  if (info && !info.configured) return <div className="empty-state"><div className="empty-icon"><Icon name="layers"/></div><h2>Marketplace listing is not configured</h2><p>The server needs an RPC connection and a verified Seaport deployment for {config.chainName}. {info.note || ''}</p></div>;
  return <div className="transaction-workspace marketplace">
    {info && <div className="environment-note"><Icon name="info"/><p><strong>{info.name}.</strong> {info.note}</p></div>}
    {!owner && <Notice>Only the collection owner role can create or manage listings. You can view this page but not sign orders.</Notice>}
    {error && <Notice error>{error}</Notice>}
    {status && <p role="status" className="loading">{status}</p>}
    {owner && <TransferPolicy current={current} walletProvider={walletProvider} expired={expired}/>}
    {owner && <section className="panel" aria-labelledby="new-listing">
      <div className="section-heading"><div><span className="eyebrow">NEW LISTING</span><h2 id="new-listing">List a minted NFT for sale</h2></div></div>
      <div className="form-grid">
        <label className="field"><span>Collection contract</span><input value={form.collection} onChange={e => setForm({ ...form, collection: e.target.value })} placeholder="0x…" spellCheck={false} autoComplete="off"/></label>
        <label className="field"><span>Token ID</span><input value={form.tokenId} inputMode="numeric" onChange={e => setForm({ ...form, tokenId: e.target.value })}/></label>
        <label className="field"><span>Price (ETH)</span><input value={form.price} inputMode="decimal" onChange={e => setForm({ ...form, price: e.target.value })} placeholder="0.25"/></label>
        <label className="field"><span>Listing duration</span><select value={form.days} onChange={e => setForm({ ...form, days: e.target.value })}>{['1', '3', '7', '30', '90', '180'].map(d => <option key={d} value={d}>{d} day{d === '1' ? '' : 's'}</option>)}</select></label>
      </div>
      <div className="button-row"><button className="button secondary" disabled={!validInput || !!busy} onClick={inspect}>{busy === 'inspect' ? 'Checking…' : 'Check token'}</button>
        <button className="button primary" disabled={!validInput || !inspection?.token.sellerOwns || inspection?.token.policy.status === 'blocked' || !!busy} onClick={prepare}>{busy === 'prepare' ? 'Preparing…' : 'Prepare order for review'}</button></div>
      {inspection && <dl className="preview-grid" aria-label="Token check">
        <div><dt>Owner</dt><dd className="mono">{short(inspection.token.owner)} {inspection.token.sellerOwns ? '(you)' : '(not your wallet)'}</dd></div>
        <div><dt>Marketplace operator approval</dt><dd>{inspection.token.approved ? 'Approved' : 'Approval needed before the order can be filled'}</dd></div>
        <div><dt>Transfer policy</dt><dd>{({ compatible: 'Allows this marketplace', blocked: 'Blocks this marketplace: update the transfer policy first', 'compatible-via-authorizer': 'Allows this marketplace (authorized by its signed zone)', 'no-validator': 'No transfer validator set', 'not-creator-token': 'Not a creator-token collection', unknown: 'Could not be verified' } as Record<string, string>)[inspection.token.policy.status]}</dd></div>
        <div><dt>Creator royalty (ERC-2981)</dt><dd>{inspection.token.royalty ? `${eth(inspection.token.royalty.amountWei)} to ${short(inspection.token.royalty.recipient)}` : 'None reported'}</dd></div>
      </dl>}
    </section>}
    {prepared && <section className="panel cost-review" aria-labelledby="review-order">
      <div className="section-heading"><div><span className="eyebrow">REVIEW BEFORE SIGNING</span><h2 id="review-order">Exact Seaport order</h2></div></div>
      <p>Token #{prepared.listing.tokenId} of <span className="mono">{prepared.listing.collection}</span> for <strong>{eth(prepared.listing.review.priceWei)}</strong> on {prepared.listing.review.marketplace}, until {new Date(Number(prepared.listing.review.endTime) * 1000).toLocaleString()}.</p>
      <table className="data-table"><caption>Where the buyer's payment goes</caption><thead><tr><th scope="col">Payment</th><th scope="col">Recipient</th><th scope="col">Amount</th></tr></thead>
        <tbody>{prepared.listing.review.payments.map((p, i) => <tr key={i}><td>{p.label}</td><td className="mono">{short(p.recipient)}</td><td>{eth(p.amountWei)}</td></tr>)}</tbody></table>
      {prepared.listing.review.warnings.map((w, i) => <Notice key={i}>{w}</Notice>)}
      <p className="fine-print">{prepared.listing.review.royaltyDisclosure}</p>
      {prepared.approvalTransaction && <div className="mint-confirmation"><h3>Step 1: Approve the marketplace operator</h3>
        <p>This wallet transaction lets the Seaport operator <span className="mono">{short(prepared.listing.review.operator)}</span> transfer tokens you own in this collection, only when a buyer fills an order you signed. It costs network gas. You can revoke it later.</p>
        <button className="button secondary" disabled={!!busy} onClick={approve}>{busy === 'approve' ? 'Waiting for wallet…' : 'Approve in wallet'}</button></div>}
      <div className="mint-confirmation"><h3>{prepared.approvalTransaction ? 'Step 2: ' : ''}Sign the order</h3>
        <label className="review-checkbox"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/> I reviewed the price, payments and expiry. Signing creates an offer anyone can fill until it expires or I cancel it on-chain.</label>
        <button className="button primary" disabled={!acknowledged || !!prepared.approvalTransaction || !!busy} onClick={sign}>{busy === 'sign' ? 'Waiting for wallet…' : 'Sign and submit'}</button>
        <button className="text-button" disabled={!!busy} onClick={() => void cancel(prepared.listing).then(() => setPrepared(null))}>Discard</button></div>
    </section>}
    {owner && <section className="panel" aria-labelledby="listings">
      <div className="section-heading"><div><span className="eyebrow">YOUR ORDERS</span><h2 id="listings">Listings and sales</h2></div><button className="button secondary" onClick={() => void refresh()} disabled={!!busy}>Refresh</button></div>
      {!listings.length ? <p>No listing orders yet. Minted tokens are not listed until you sign an order here.</p> :
        <ul className="transaction-list">{listings.filter(l => l.state !== 'superseded').map(l => <li key={l.id} className="transaction-row">
          <div><strong>Token #{l.tokenId}</strong> <span className="mono">{short(l.collection)}</span> · {eth(l.review.priceWei)}</div>
          <div><span className="badge" data-state={l.state}>{STATE_LABELS[l.state]?.[0] || l.state}</span> <small>{STATE_LABELS[l.state]?.[1]}</small></div>
          {l.state === 'inactive' && l.observation?.chain && <small>Chain check: owner {l.observation.chain.sellerOwns ? 'ok' : 'changed'}, approval {l.observation.chain.approved ? 'ok' : 'missing'}, policy {String(l.observation.chain.policy)}{l.observation.marketplace ? `, marketplace ${l.observation.marketplace.status}${l.observation.marketplace.matches === false ? ' (differs from reviewed order)' : ''}` : ''}.</small>}
          {l.settlement && <dl className="preview-grid"><div><dt>Buyer</dt><dd className="mono">{short(l.settlement.buyer)}</dd></div><div><dt>Royalty paid in settlement</dt><dd>{eth(l.settlement.royaltyPaidWei)} (expected {eth(l.settlement.expectedRoyaltyWei)})</dd></div><div><dt>Transaction</dt><dd className="mono">{short(l.settlement.transactionHash)}</dd></div></dl>}
          {l.state === 'listed' && l.chainId === 1 && <a href={`https://opensea.io/assets/ethereum/${l.collection}/${l.tokenId}`} target="_blank" rel="noreferrer noopener">View on OpenSea <Icon name="arrow"/></a>}
          <div className="button-row">
            {!['sold', 'cancelled', 'superseded', 'prepared'].includes(l.state) && <button className="button secondary" disabled={!!busy} onClick={() => action(l.id, 'verify', 'verify')}>{busy === 'verify' + l.id ? 'Verifying…' : 'Verify now'}</button>}
            {['inactive', 'submission_uncertain'].includes(l.state) && <button className="button secondary" disabled={!!busy} onClick={() => action(l.id, 'submit', 'submit')}>Retry submission</button>}
            {['listed', 'valid_unindexed', 'inactive', 'verifying', 'submission_uncertain', 'rejected', 'signed', 'cancel_pending'].includes(l.state) && <>
              <button className="button secondary" disabled={!!busy} onClick={() => cancel(l)}>{busy === 'cancel' + l.id ? 'Cancelling…' : 'Cancel on-chain'}</button>
              <button className="text-button" disabled={!!busy} onClick={() => cancel(l, true)}>Change price</button></>}
            {['expired', 'cancelled'].includes(l.state) && <button className="text-button" onClick={() => { setForm({ collection: l.collection, tokenId: l.tokenId, price: formatEther(BigInt(l.review.priceWei)), days: '30' }); setInspection(null); window.scrollTo({ top: 0 }); }}>Relist</button>}
          </div>
        </li>)}</ul>}
    </section>}
  </div>;
}
