import { useEffect, useState } from 'react';
import { api } from './api';
import type { Configuration, Session } from './model';
import { Pill } from './Marketplace';
import type { Listing } from './Marketplace';
import { formatEth } from './wallet-actions';
import './studio.css';
interface Summary { drafts: number | null; listings: Listing[] | null; operations: { state: string; plan?: { kind?: string } }[] | null; actions: { state: string; kind: string }[] | null }
const known = () => { try { const v = JSON.parse(localStorage.getItem('nft-console:known-collections') || '[]'); return Array.isArray(v) ? v.length : 0; } catch { return 0; } };
/** Real counts from this console's own records; anything unavailable is shown as unavailable, never as zero. */
export function Dashboard({ current, config }: { current: Session | null; config: Configuration }) {
  const [s, setS] = useState<Summary>({ drafts: null, listings: null, operations: null, actions: null });
  useEffect(() => {
    if (!current) return; const c = new AbortController(), get = (p: string) => api(p, { signal: c.signal }).catch(() => null);
    void (async () => {
      const [drafts, listings, ops, actions] = await Promise.all([config.capabilities.privateWorkspace && current.role !== 'viewer' ? get('/api/private/records') : null, current.role === 'owner' ? get('/api/market/listings') : null, config.capabilities.publicLaunch ? get('/api/launch/operations') : null, current.role === 'owner' ? get('/api/actions') : null]);
      if (!c.signal.aborted) setS({ drafts: drafts ? (drafts as { items: unknown[] }).items.length : null, listings: listings ? (listings as { items: Listing[] }).items : null, operations: ops ? (ops as { items: Summary['operations'] }).items : null, actions: actions ? (actions as { items: Summary['actions'] }).items : null });
    })();
    return () => c.abort();
  }, [current?.csrf]);
  if (!current) return null;
  const listed = s.listings?.filter(l => l.state === 'listed').length, sold = s.listings?.filter(l => l.state === 'sold').length;
  const attention = (s.listings?.filter(l => ['attention', 'submission_uncertain', 'invalid', 'rejected'].includes(l.state)).length || 0) + (s.operations?.filter(o => ['wallet_pending', 'attention', 'submitted'].includes(o.state)).length || 0) + (s.actions?.filter(a => ['submitted', 'attention'].includes(a.state)).length || 0);
  const n = (v: number | null | undefined) => v === null || v === undefined ? '—' : String(v);
  return <section aria-labelledby="dash-heading"><h2 id="dash-heading" className="sr-only">Overview</h2>
    <ol className="flow" aria-label="Release workflow">{[['private', 'Private draft'], ['private', 'Validate'], ['launch', 'Publish & verify'], ['launch', 'Review cost'], ['launch', 'Deploy'], ['collections', 'Transfer policy'], ['launch', 'Mint'], ['marketplace', 'List & verify']].map(([r, l], i) => <li key={l}><a href={`#/${r}`}>{i + 1}. {l}</a></li>)}</ol>
    <div className="dash-grid">
      <article><span>Encrypted private drafts</span><strong>{n(s.drafts)}</strong><small>{s.drafts === null ? 'Unavailable for this access level' : 'Ciphertext only on the server'}</small></article>
      <article><span>Collections opened</span><strong>{known()}</strong><small>Read live from chain in Collections</small></article>
      <article><span>Verified active listings</span><strong>{n(listed)}</strong><small>{sold ? `${sold} sold (settlement verified)` : 'Only independently verified orders count'}</small></article>
      <article><span>Needs attention</span><strong>{s.listings === null && s.operations === null ? '—' : attention}</strong><small>Uncertain, failed or pending wallet actions</small></article>
    </div>
    {s.listings && s.listings.length > 0 && <div className="panel"><h3>Recent marketplace activity</h3><ul className="history">{s.listings.slice(0, 5).map(l => <li key={l.id}>#{l.tokenId} at {formatEth(l.review.priceWei)} — <Pill state={l.state} /></li>)}</ul></div>}
  </section>;
}
