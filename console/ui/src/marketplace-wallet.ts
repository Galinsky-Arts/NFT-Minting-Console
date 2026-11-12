import { getAddress, TypedDataEncoder } from 'ethers';
import type { WalletProvider } from './auth';
import type { Session } from './model';

export class ListingFlowError extends Error {}
export interface TypedOrder {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: 'OrderComponents';
  message: Record<string, unknown>;
}
export interface WalletTransaction { to: string; data: string; value: string }

const quantity = (v: unknown) => { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new ListingFlowError('The wallet returned an invalid value.'); return BigInt(v); };

/** The connected wallet must be the signed-in seller on the configured network before anything is requested. */
export async function matchingSeller(wallet: WalletProvider, session: Session) {
  let chain: unknown, accounts: unknown;
  try { chain = await wallet.request({ method: 'eth_chainId' }); accounts = await wallet.request({ method: 'eth_accounts' }); }
  catch { throw new ListingFlowError('The wallet could not be checked. Nothing was requested.'); }
  if (quantity(chain) !== BigInt(session.chainId)) throw new ListingFlowError('Your wallet is on a different network. Switch to the console network and retry.');
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || getAddress(accounts[0]) !== getAddress(session.wallet))
    throw new ListingFlowError('The active wallet account is not the signed-in seller. Switch accounts and retry.');
}

/** Shows the exact Seaport order in the wallet. The digest is recomputed locally so the wallet and server agree. */
export async function signOrder(wallet: WalletProvider, session: Session, order: TypedOrder): Promise<string> {
  await matchingSeller(wallet, session);
  if (order.domain.chainId !== session.chainId || getAddress(String(order.message.offerer)) !== getAddress(session.wallet))
    throw new ListingFlowError('The prepared order does not belong to this wallet and network.');
  const { EIP712Domain: _ignored, ...types } = order.types as Record<string, { name: string; type: string }[]>;
  void _ignored;
  TypedDataEncoder.hash(order.domain, types, order.message);
  const payload = JSON.stringify({ domain: order.domain, primaryType: 'OrderComponents', message: order.message,
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...types } });
  try {
    const signature = await wallet.request({ method: 'eth_signTypedData_v4', params: [session.wallet, payload] });
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new ListingFlowError('The wallet returned an invalid signature.');
    return signature;
  } catch (error) {
    if (error instanceof ListingFlowError) throw error;
    if ((error as { code?: number })?.code === 4001) throw new ListingFlowError('You declined the signature. Nothing was listed.');
    throw new ListingFlowError('The wallet could not sign the order. Nothing was listed.');
  }
}

/** Sends one reviewed transaction and waits for its receipt. Never resends automatically. */
export async function sendAndConfirm(wallet: WalletProvider, session: Session, tx: WalletTransaction, onHash?: (hash: string) => void | Promise<void>, signal?: AbortSignal): Promise<string> {
  await matchingSeller(wallet, session);
  let hash: unknown;
  try { hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: session.wallet, to: tx.to, data: tx.data, value: tx.value }] }); }
  catch (error) {
    if ((error as { code?: number })?.code === 4001) throw new ListingFlowError('You declined the transaction. Nothing was sent.');
    throw new ListingFlowError('The wallet did not send the transaction. Check the wallet before retrying.');
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ListingFlowError('The wallet returned an invalid transaction hash. Check your wallet activity before retrying.');
  await onHash?.(hash);
  for (let i = 0; i < 240; i++) {
    if (signal?.aborted) throw new ListingFlowError('Stopped waiting. The transaction may still confirm; refresh to check.');
    const receipt = await wallet.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null) as { status?: string } | null;
    if (receipt && typeof receipt.status === 'string') {
      if (quantity(receipt.status) !== 1n) throw new ListingFlowError('The transaction failed on-chain. Nothing changed.');
      return hash;
    }
    await new Promise(r => setTimeout(r, i < 10 ? 1000 : 3000));
  }
  throw new ListingFlowError('The transaction has not confirmed yet. It may still confirm; refresh to check before trying again.');
}
