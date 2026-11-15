import { getAddress, isAddress } from 'ethers/address';
const ZeroAddress = '0x0000000000000000000000000000000000000000';

export type Role = 'owner' | 'editor' | 'viewer';
export type Route = 'releases' | 'create' | 'readiness' | 'settings' | 'transactions' | 'launch' | 'marketplace' | 'workspace';
export interface Configuration {
  chainId: number; chainName: string; production: boolean; productionReady: boolean;
  loginConfigured: boolean; pinningConfigured: boolean; authStore: string;
  capabilities: { opaqueReleaseApi: boolean; deploy: boolean; mintJournal: boolean; localMint: boolean; publicLaunch?: boolean; publicPublication?: boolean };
}
export interface Session {
  wallet: string; chainId: number; role: Role; csrf: string; expiresAt: string; idleExpiresAt: string;
}
export interface ReleaseSummary { id: string; state: string; revision: string; updatedAt: string }
export interface ReleasePage { items: ReleaseSummary[]; nextCursor: string | null }
export interface Readiness { blockers: { id: string; milestones: string[]; description: string }[] }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SIGN_IN_STATEMENT = 'Sign in to NFT Console. This does not authorize publishing, minting, listing, or asset transfers.';
export const ROUTES: Route[] = ['releases', 'create', 'readiness', 'settings', 'transactions', 'launch', 'marketplace', 'workspace'];
export function routeFromHash(hash: string): Route {
  const route = hash.replace(/^#\/?/, '');
  return ROUTES.includes(route as Route) ? route as Route : 'releases';
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The server returned an invalid response.');
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 240): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('The server returned an invalid response.');
  return value;
}
function timestamp(value: unknown): string {
  const text = string(value, 40);
  if (!Number.isFinite(Date.parse(text))) throw new Error('The server returned an invalid timestamp.');
  return text;
}
export function configuration(value: unknown): Configuration {
  const v = record(value), capabilities = record(v.capabilities);
  if (![1, 11155111, 31337].includes(v.chainId as number)) throw new Error('Unsupported console network.');
  return { chainId: v.chainId as number, chainName: string(v.chainName, 80),
    production: v.production === true, productionReady: v.productionReady === true,
    loginConfigured: v.loginConfigured === true, pinningConfigured: v.pinningConfigured === true,
    authStore: string(v.authStore, 80), capabilities: {
      opaqueReleaseApi: capabilities.opaqueReleaseApi === true, deploy: capabilities.deploy === true,
      publicLaunch: capabilities.publicLaunch === true, publicPublication: capabilities.publicPublication === true, mintJournal: capabilities.mintJournal === true, localMint: v.chainId === 31337 && capabilities.localMint === true,
    } };
}
export function session(value: unknown, chainId: number): Session {
  const v = record(value);
  if (v.chainId !== chainId || !['owner', 'editor', 'viewer'].includes(v.role as string) ||
      typeof v.wallet !== 'string' || !isAddress(v.wallet) || getAddress(v.wallet) === ZeroAddress ||
      typeof v.csrf !== 'string' || !/^[0-9a-f]{64}$/.test(v.csrf)) throw new Error('The sign-in response did not match this console.');
  return { wallet: getAddress(v.wallet), role: v.role as Role, chainId,
    csrf: v.csrf, expiresAt: timestamp(v.expiresAt), idleExpiresAt: timestamp(v.idleExpiresAt) };
}
export function assertChallenge(value: unknown, wallet: string, origin: string, chainId: number, now = Date.now()) {
  const v = record(value), message = string(v.message, 4096);
  if (v.chainId !== chainId || typeof v.challengeId !== 'string' || !/^[0-9a-f]{64}$/.test(v.challengeId)) {
    throw new Error('The sign-in request does not match this console.');
  }
  const lines = message.split('\n');
  if (lines.length !== 11 || lines[0] !== `${origin} wants you to sign in with your Ethereum account:` ||
      lines[1]?.toLowerCase() !== wallet.toLowerCase() || lines[2] !== '' || lines[3] !== SIGN_IN_STATEMENT || lines[4] !== '' ||
      lines[5] !== `URI: ${origin}/` || lines[6] !== 'Version: 1' || lines[7] !== `Chain ID: ${chainId}` ||
      !/^Nonce: [0-9a-f]{64}$/.test(lines[8] || '') || !lines[9]?.startsWith('Issued At: ') ||
      !lines[10]?.startsWith('Expiration Time: ')) throw new Error('The sign-in request does not match this console, account and network.');
  const issued = Date.parse(lines[9]!.slice(11)), expires = Date.parse(lines[10]!.slice(17));
  const challengeExpires = Date.parse(timestamp(v.expiresAt));
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 60_000 || now - issued > 300_000 ||
      expires <= now || expires - issued > 8 * 3600_000 || challengeExpires <= now ||
      challengeExpires > issued + 300_000) throw new Error('This sign-in request expired or your device clock needs checking.');
  return { challengeId: v.challengeId, message, chainId };
}
const states = new Set(['draft','validated','published','deployed','policy-configured','minting','minting-closed','archived']);
export function releasePage(value: unknown): ReleasePage {
  const v = record(value);
  if (!Array.isArray(v.items) || v.items.length > 100 || (v.nextCursor !== null && (typeof v.nextCursor !== 'string' || !UUID.test(v.nextCursor)))) {
    throw new Error('The release inventory could not be verified.');
  }
  const items = v.items.map(item => {
    const row = record(item);
    if (typeof row.id !== 'string' || !UUID.test(row.id) || !states.has(row.state as string) ||
        typeof row.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.revision)) throw new Error('The release inventory could not be verified.');
    return { id: row.id, state: row.state as string, revision: row.revision, updatedAt: timestamp(row.updated_at) };
  });
  return { items, nextCursor: v.nextCursor as string | null };
}
export function readiness(value: unknown): Readiness {
  const v = record(value);
  if (!Array.isArray(v.blockers) || v.blockers.length > 50) throw new Error('Release readiness is unavailable.');
  return { blockers: v.blockers.map(item => {
    const row = record(item);
    if (!Array.isArray(row.milestones) || row.milestones.length > 36 || row.milestones.some(x => typeof x !== 'string' || !/^NFT-\d{2}$/.test(x))) {
      throw new Error('Release readiness is unavailable.');
    }
    return { id: string(row.id, 80), milestones: row.milestones as string[], description: string(row.description, 1000) };
  }) };
}
export function shortAddress(wallet: string): string { return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`; }
export interface Plan { name: string; symbol: string; supply: string; royalty: string; price: string; owner: string; minter: string; recipient: string }
export const emptyPlan = (): Plan => ({ name: '', symbol: '', supply: '', royalty: '', price: '', owner: '', minter: '', recipient: '' });
export function decimalUnits(value: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || value.length > 100 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
export function validatePlan(plan: Plan): Partial<Record<keyof Plan, string>> {
  const errors: Partial<Record<keyof Plan, string>> = {};
  if (!plan.name.trim() || plan.name.trim().length > 120) errors.name = 'Enter a collection name of 1 to 120 characters.';
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(plan.symbol)) errors.symbol = 'Use 1 to 16 letters, numbers, dashes or underscores.';
  if (!/^[1-9][0-9]{0,77}$/.test(plan.supply) || BigInt(plan.supply) > (1n << 256n) - 1n) errors.supply = 'Enter a positive whole-number supply within the contract limit.';
  const royalty = decimalUnits(plan.royalty, 2);
  if (royalty === null || royalty > 10000n) errors.royalty = 'Enter a royalty from 0 to 100%, with at most two decimal places.';
  const price = decimalUnits(plan.price, 18);
  if (price === null || price <= 0n || price > (1n << 256n) - 1n) errors.price = 'Enter a positive ETH price with at most 18 decimal places.';
  for (const key of ['owner', 'minter', 'recipient'] as const) {
    if (!isAddress(plan[key]) || getAddress(plan[key]) === ZeroAddress) errors[key] = 'Enter a valid nonzero Ethereum address.';
  }
  return errors;
}
