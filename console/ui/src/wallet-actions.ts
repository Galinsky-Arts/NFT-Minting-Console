import { getAddress } from 'ethers/address';
import { TypedDataEncoder } from 'ethers/hash';
import { api } from './api';
import type { WalletProvider } from './auth';
import type { Session } from './model';

export interface WalletAction { id: string; kind: 'policy' | 'approval' | 'cancel'; subject: Record<string, unknown> & { purpose?: string; collection?: string; step?: string }; tx: { to: string; from: string; data: string; value: string }; state: string; txHash: string | null; result: Record<string, unknown> | null; createdAt: string }
export class WalletRejected extends Error {}
const hex = (n: number) => '0x' + n.toString(16);
async function matchWallet(wallet: WalletProvider, session: Session, expectedFrom: string) {
  const chain = await wallet.request({ method: 'eth_chainId', params: [] });
  if (typeof chain !== 'string' || BigInt(chain) !== BigInt(session.chainId)) throw new Error(`Switch your wallet to the console network (chain ${session.chainId}) and retry. Nothing was sent.`);
  const accounts = await wallet.request({ method: 'eth_accounts', params: [] });
  if (!Array.isArray(accounts) || !accounts.some(a => typeof a === 'string' && getAddress(a) === getAddress(expectedFrom))) throw new Error(`Select wallet ${expectedFrom} in your wallet extension. Nothing was sent.`);
  if (getAddress(session.wallet) !== getAddress(expectedFrom)) throw new Error('This action must be signed by the wallet you are signed in with.');
}
const rejected = (e: unknown) => typeof e === 'object' && e !== null && ((e as { code?: unknown }).code === 4001 || /reject|denied|cancel/i.test(String((e as { message?: unknown }).message || '')));

/** Sends the exact server-prepared transaction, then records the hash. The server re-reads the chain to verify it. */
export async function sendWalletAction(wallet: WalletProvider, session: Session, action: WalletAction): Promise<WalletAction> {
  await matchWallet(wallet, session, action.tx.from);
  let hash: unknown;
  try { hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: action.tx.from, to: action.tx.to, data: action.tx.data, value: '0x0', chainId: hex(session.chainId) }] }); }
  catch (e) {
    if (rejected(e)) { await api(`/api/actions/${action.id}/rejected`, { method: 'POST', body: {}, csrf: session.csrf }).catch(() => undefined); throw new WalletRejected('You rejected the request in your wallet. Nothing was sent.'); }
    throw new Error('The wallet did not confirm whether it sent the transaction. Check your wallet activity before retrying; the action stays recorded.');
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('The wallet returned an invalid transaction hash.');
  return await api(`/api/actions/${action.id}/submitted`, { method: 'POST', body: { transactionHash: hash }, csrf: session.csrf }) as WalletAction;
}
/** Polls the server's independent receipt verification until the transaction is verified or fails. */
export async function confirmWalletAction(session: Session, action: WalletAction, signal?: AbortSignal, timeoutMs = 180000): Promise<WalletAction> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = await api(`/api/actions/${action.id}/reconcile`, { method: 'POST', body: {}, csrf: session.csrf, signal }) as WalletAction & { pending?: boolean };
    if (!next.pending && ['verified', 'failed', 'attention'].includes(next.state)) return next;
    if (Date.now() > deadline) return next;
    await new Promise(r => setTimeout(r, 1500));
  }
}
export interface TypedOrder { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> & { offerer: string; consideration: { startAmount: string; recipient: string }[]; offer: { token: string; identifierOrCriteria: string }[] } }
/** Signs the Seaport order only after re-checking that it matches the reviewed listing. */
export async function signOrder(wallet: WalletProvider, session: Session, typed: TypedOrder, reviewed: { seller: string; collection: string; tokenId: string; payments: { recipient: string; amountWei: string }[]; seaport: string; orderHash: string }) {
  await matchWallet(wallet, session, reviewed.seller);
  const m = typed.message;
  const item = m.offer[0];
  if (!item || m.offer.length !== 1 || getAddress(m.offerer) !== getAddress(reviewed.seller) || getAddress(item.token) !== getAddress(reviewed.collection) || item.identifierOrCriteria !== reviewed.tokenId ||
    m.consideration.length !== reviewed.payments.length || m.consideration.some((c, i) => { const p = reviewed.payments[i]; return !p || getAddress(c.recipient) !== getAddress(p.recipient) || c.startAmount !== p.amountWei; }) ||
    typed.domain.chainId !== session.chainId || getAddress(typed.domain.verifyingContract) !== getAddress(reviewed.seaport) || typed.domain.name !== 'Seaport')
    throw new Error('The order to sign does not match the reviewed listing. Nothing was signed.');
  const types = { ...typed.types }; delete (types as Record<string, unknown>).EIP712Domain;
  if (TypedDataEncoder.from(types).hash(m).toLowerCase() !== reviewed.orderHash.toLowerCase()) throw new Error('The order hash does not match the reviewed listing. Nothing was signed.');
  const payload = TypedDataEncoder.getPayload(typed.domain, types, m);
  try { return await wallet.request({ method: 'eth_signTypedData_v4', params: [reviewed.seller, JSON.stringify(payload)] }) as string; }
  catch (e) { if (rejected(e)) throw new WalletRejected('You rejected the signature. No order exists.'); throw new Error('The wallet could not sign the order.'); }
}
export const formatEth = (wei: string | bigint) => { const v = BigInt(wei), whole = v / 10n ** 18n, frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return `${whole}${frac ? '.' + frac : ''} ETH`; };
export function parseEth(text: string): bigint | null { if (!/^\d{1,9}(\.\d{1,18})?$/.test(text.trim())) return null; const [w = '0', f = ''] = text.trim().split('.'); return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0')); }
