import { useState } from 'react';
import { isAddress } from 'ethers';
import { api, ApiError } from './api';
import type { Session } from './model';
import type { WalletProvider } from './auth';
import { Icon, Notice } from './components';
import { ListingFlowError, sendAndConfirm } from './marketplace-wallet';

interface Step { id: string; label: string; to: string; data: string; value: string }
interface PolicyPlan {
  configured: boolean; steps: Step[]; disclosure: string[]; listId: string | null; validator: string; whitelistRuleset: string;
  policy: { rulesetId: number; listId: string; customRuleset: string; globalOptions: number; rulesetOptions: number };
  marketplace: { account: string; role: string; listed: boolean; name: string };
  ownerIsContract?: boolean; safeBatch?: unknown;
}

/** OWNER walks through the exact validator transactions; every step is followed by an on-chain readback. */
export function TransferPolicy({ current, walletProvider, expired }: { current: Session; walletProvider: () => WalletProvider | null; expired: () => void }) {
  const [collection, setCollection] = useState(''), [plan, setPlan] = useState<PolicyPlan | null>(null);
  const [listHash, setListHash] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(''), [understood, setUnderstood] = useState(false);
  const fail = (e: unknown) => { if (e instanceof ApiError && e.status === 401) expired(); setError(e instanceof Error ? e.message : 'The policy step failed.'); };
  const load = async (listId: string | null = plan?.listId ?? null) => setPlan(await api('/api/policy/inspect', { method: 'POST', csrf: current.csrf, body: { collection: collection.trim(), listId }, timeoutMs: 30000 }) as PolicyPlan);
  const check = async () => { setBusy(true); setError(''); setStatus(''); setUnderstood(false); try { await load(null); } catch (e) { fail(e); } finally { setBusy(false); } };
  const next = async () => {
    const step = plan?.steps[0], wallet = walletProvider();
    if (!step) return;
    setBusy(true); setError('');
    try {
      if (!wallet) throw new ListingFlowError('Reconnect the OWNER wallet before continuing.');
      setStatus(`Confirm "${step.label}" in your wallet…`);
      const hash = await sendAndConfirm(wallet, current, step, () => setStatus('Sent. Waiting for confirmation…'));
      if (step.id === 'create-list') setPlan(await api('/api/policy/list', { method: 'POST', csrf: current.csrf, body: { collection: collection.trim(), hash }, timeoutMs: 30000 }) as PolicyPlan);
      else await load();
      setStatus('Confirmed and read back from the chain.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return <section className="panel" aria-labelledby="policy-heading">
    <div className="section-heading"><div><span className="eyebrow">COLLECTION OWNER</span><h2 id="policy-heading">Marketplace transfer policy</h2></div></div>
    <p>Before a marketplace can sell tokens from a creator-token collection, the collection's transfer validator must allow that marketplace. Each change is a wallet transaction from the collection OWNER.</p>
    <div className="form-grid"><label className="field"><span>Collection contract</span><input value={collection} onChange={e => { setCollection(e.target.value); setPlan(null); }} placeholder="0x…" spellCheck={false}/></label></div>
    <div className="button-row"><button className="button secondary" disabled={!isAddress(collection.trim()) || busy} onClick={check}>{busy && !plan ? 'Reading policy…' : 'Check policy'}</button></div>
    {error && <Notice error>{error}</Notice>}
    {status && <p role="status" className="loading">{status}</p>}
    {plan && <>
      {plan.configured ? <Notice><Icon name="check"/> Verified on-chain: whitelist ruleset {plan.policy.rulesetId} with options {plan.policy.rulesetOptions}, your list #{plan.policy.listId}, and the {plan.marketplace.role} for {plan.marketplace.name} is listed.</Notice>
        : <Notice>{plan.steps.length} OWNER transaction{plan.steps.length === 1 ? '' : 's'} needed. Progress is read back from the chain after each one, so you can stop and resume at any time.</Notice>}
      <ul>{plan.disclosure.map((d, i) => <li key={i}>{d}</li>)}</ul>
      {!plan.configured && <>
        <ol>{plan.steps.map(s => <li key={s.id}>{s.label} <small className="mono">to {s.to.slice(0, 10)}…</small></li>)}</ol>
        <label className="review-checkbox"><input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)}/> I understand this policy controls which marketplaces can move tokens in this collection, for every holder.</label>
        {plan.ownerIsContract ? <div className="mint-confirmation"><h3>Execute in your Safe</h3>
          <p>Your OWNER is a smart-contract wallet. Download the batch, import it into the Safe Transaction Builder, collect the owner confirmations and execute it. Then return here: the console reads the result from the chain.</p>
          <button className="button secondary" disabled={!understood} onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(plan.safeBatch, null, 2)], { type: 'application/json' })); a.download = `nft-console-policy-${collection.trim().slice(2, 8).toLowerCase()}.json`; a.click(); }}>Download Safe batch ({plan.steps.length} transaction{plan.steps.length === 1 ? '' : 's'})</button>
          {plan.steps[0]?.id === 'create-list' && <label className="field"><span>Executed Safe transaction hash (contains the new list)</span><input value={listHash} onChange={e => setListHash(e.target.value.trim())} placeholder="0x…"/></label>}
          <button className="button primary" disabled={busy} onClick={() => { setBusy(true); setError(''); void (async () => { try {
            if (listHash) setPlan(await api('/api/policy/list', { method: 'POST', csrf: current.csrf, body: { collection: collection.trim(), hash: listHash }, timeoutMs: 30000 }) as PolicyPlan); else await load();
            setStatus('Read back from the chain.'); } catch (e) { fail(e); } finally { setBusy(false); } })(); }}>I executed it: check the chain</button></div>
        : <button className="button primary" disabled={!understood || busy} onClick={next}>{busy ? 'Waiting for wallet…' : `Send: ${plan.steps[0]?.label ?? ''}`}</button>}
      </>}
    </>}
  </section>;
}
