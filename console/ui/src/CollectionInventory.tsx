import { useState } from 'react';
import { isAddress } from 'ethers';
import { api, ApiError } from './api';
import { Notice } from './components';

interface Token { tokenId: string; owner: string; metadataURI: string; title: string; mediaSHA256: string; rightsURI: string; rightsSHA256: string }
interface Inventory { collection: string; name: string; symbol: string; seriesSize: string; totalMinted: string; remainingSupply: string; mintingClosed: boolean; owner: string; minter: string; royaltyRecipient: string; royaltyBps: number; validator: string; page: number; hasMore: boolean; tokens: Token[]; block: number }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Read-only live view of a deployed collection: immutable settings, remaining supply and minted works. */
export function CollectionInventory({ expired }: { expired: () => void }) {
  const [address, setAddress] = useState(''), [inventory, setInventory] = useState<Inventory | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = async (page = 0) => {
    const target = address.trim();
    if (!isAddress(target)) { setError('Enter a deployed collection contract address.'); return; }
    setBusy(true); setError('');
    try { setInventory(await api(`/api/collections/${target}?page=${page}`) as Inventory); }
    catch (e) { if (e instanceof ApiError && e.status === 401) expired(); setError(e instanceof Error ? e.message : 'The collection could not be read.'); setInventory(null); }
    finally { setBusy(false); }
  };
  return <section className="panel" aria-labelledby="inventory-heading">
    <div className="section-heading"><div><span className="eyebrow">EXISTING COLLECTION</span><h2 id="inventory-heading">Collection inventory</h2><p className="muted">Read live from the chain: immutable settings, remaining supply and every minted work. Nothing here is signed or changed.</p></div></div>
    <form className="form-grid" onSubmit={e => { e.preventDefault(); void load(0); }}>
      <label className="field"><span>Collection contract</span><input value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off"/></label>
      <div className="field"><button className="button secondary" type="submit" disabled={busy}>{busy ? 'Reading…' : 'Read collection'}</button></div>
    </form>
    {error && <Notice error>{error}</Notice>}
    {inventory && <>
      <dl className="preview-grid">
        <div><dt>Name</dt><dd>{inventory.name} ({inventory.symbol})</dd></div>
        <div><dt>Supply</dt><dd>{inventory.totalMinted} minted of {inventory.seriesSize} · {inventory.remainingSupply} remaining{inventory.mintingClosed ? ' · minting closed' : ''}</dd></div>
        <div><dt>Royalty (immutable)</dt><dd>{(inventory.royaltyBps / 100).toFixed(2)}% to <span className="mono">{short(inventory.royaltyRecipient)}</span></dd></div>
        <div><dt>Owner / minter</dt><dd className="mono">{short(inventory.owner)} / {short(inventory.minter)}</dd></div>
        <div><dt>Transfer validator</dt><dd className="mono">{short(inventory.validator)}</dd></div>
        <div><dt>Read at block</dt><dd>{inventory.block}</dd></div>
      </dl>
      {inventory.tokens.length === 0 ? <p className="muted">No minted works in token IDs {inventory.page * 100 + 1}–{inventory.page * 100 + 100}.</p> :
        <div className="table-scroll"><table className="data-table"><caption>Minted works (token IDs {inventory.page * 100 + 1}–{inventory.page * 100 + 100})</caption>
          <thead><tr><th scope="col">Token</th><th scope="col">Title</th><th scope="col">Holder</th><th scope="col">Metadata</th></tr></thead>
          <tbody>{inventory.tokens.map(t => <tr key={t.tokenId}><td>#{t.tokenId}</td><td>{t.title}</td><td className="mono">{short(t.owner)}</td><td className="mono">{t.metadataURI}</td></tr>)}</tbody></table></div>}
      <div className="row-actions">
        {inventory.page > 0 && <button className="button subtle" type="button" disabled={busy} onClick={() => void load(inventory.page - 1)}>Previous IDs</button>}
        {inventory.hasMore && <button className="button subtle" type="button" disabled={busy} onClick={() => void load(inventory.page + 1)}>Next IDs</button>}
      </div>
    </>}
  </section>;
}
