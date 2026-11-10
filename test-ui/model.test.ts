import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, session, assertChallenge, releasePage, readiness, emptyPlan, decimalUnits, validatePlan, routeFromHash, SIGN_IN_STATEMENT } from '../console/ui/src/model.ts';
import type { Plan } from '../console/ui/src/model.ts';
import { OWNER } from './fixtures.mjs';
const origin = 'https://console.example', chainId = 31337, now = Date.now();
const challenge = () => ({ challengeId: 'a'.repeat(64), chainId,
  expiresAt: new Date(now + 300000).toISOString(),
  message: `${origin} wants you to sign in with your Ethereum account:\n${OWNER}\n\n${SIGN_IN_STATEMENT}\n\nURI: ${origin}/\nVersion: 1\nChain ID: ${chainId}\nNonce: ${'b'.repeat(64)}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(now + 8 * 3600000).toISOString()}` });
const config = { chainId, chainName: 'Local test', production: false, productionReady: false, loginConfigured: true,
  pinningConfigured: false, authStore: 'memory', capabilities: { opaqueReleaseApi: false, deploy: false, mintJournal: false, localMint: false, publicLaunch: false, publicPublication: false } };
test('reads supported configuration without enabling unfinished features', () => {
  assert.deepEqual(configuration(config), { ...config, capabilities: { ...config.capabilities, privateWorkspace: false, transferPolicy: false, marketplace: null, list: false } });
  assert.equal(Object.hasOwn(configuration({ ...config, capabilities: { publish: true, mint: true } }).capabilities, 'mint'), false);
  assert.throws(() => configuration({ ...config, chainId: 10 }));
  for (const value of [undefined, false, 'true', 1, {}]) assert.equal(configuration({ ...config, capabilities: { publicPublication: value } }).capabilities.publicPublication, false);
  assert.equal(configuration({ ...config, capabilities: { publicPublication: true } }).capabilities.publicPublication, true);
});
test('validates session identity, chain, role, CSRF and timestamps', () => {
  const value = { wallet: OWNER, chainId, role: 'owner', csrf: 'c'.repeat(64), expiresAt: new Date(now + 1000).toISOString(), idleExpiresAt: new Date(now + 500).toISOString() };
  assert.equal(session(value, chainId).wallet, OWNER);
  for (const patch of [{ chainId: 1 }, { wallet: '0x123' }, { role: 'admin' }, { csrf: '' }, { expiresAt: 'tomorrow' }]) assert.throws(() => session({ ...value, ...patch }, chainId));
});
test('accepts only the exact intended sign-in message', () => assert.equal(assertChallenge(challenge(), OWNER, origin, chainId, now).message, challenge().message));
for (const [name, rewrite] of [
  ['origin', (v: string) => v.replace(origin, 'https://evil.example')],
  ['wallet', (v: string) => v.replace(OWNER, '0x' + '11'.repeat(20))],
  ['chain', (v: string) => v.replace(`Chain ID: ${chainId}`, 'Chain ID: 1')],
  ['purpose', (v: string) => v.replace(SIGN_IN_STATEMENT, 'Approve all assets.')],
  ['trailing newline', (v: string) => v + '\n'],
  ['resources', (v: string) => v + '\nResources:\n- https://evil.example'],
  ['nonce', (v: string) => v.replace('Nonce: ' + 'b'.repeat(64), 'Nonce: short')],
] as const) test(`rejects changed sign-in ${name}`, () => assert.throws(() => assertChallenge({ ...challenge(), message: rewrite(challenge().message) }, OWNER, origin, chainId, now)));
test('expired, future and excessive-duration sign-in challenges fail closed', () => {
  assert.throws(() => assertChallenge(challenge(), OWNER, origin, chainId, now + 300001));
  assert.throws(() => assertChallenge(challenge(), OWNER, origin, chainId, now - 60001));
  assert.throws(() => assertChallenge({ ...challenge(), expiresAt: new Date(now + 600000).toISOString() }, OWNER, origin, chainId, now));
});
test('reads opaque release summaries, never fabricated titles or listing status', () => {
  const item = { id: '11111111-1111-4111-8111-111111111111', state: 'draft', revision: '1', updated_at: new Date(now).toISOString(), title: 'ignored private title' };
  const value = releasePage({ items: [item], nextCursor: null });
  assert.equal(value.items.length, 1); assert.equal(Object.hasOwn(value.items[0]!, 'title'), false);
  for (const patch of [{ id: '../../private' }, { state: 'listed' }, { revision: 1 }, { updated_at: 'bad' }]) assert.throws(() => releasePage({ items: [{ ...item, ...patch }], nextCursor: null }));
});
test('readiness rejects malformed and excessive milestone lists', () => {
  assert.equal(readiness({ blockers: [{ id: 'crypto', milestones: ['NFT-10'], description: 'Not ready' }] }).blockers.length, 1);
  assert.throws(() => readiness({ blockers: [{ id: 'crypto', milestones: ['<script>'], description: 'bad' }] }));
});
test('routes resolve only to supported pages', () => {
  assert.equal(routeFromHash('#/settings'), 'settings'); assert.equal(routeFromHash('#/create'), 'create');
  assert.equal(routeFromHash('#/../../../secret'), 'releases');
});
test('planning starts with no collection-specific economics', () => assert.deepEqual(Object.values(emptyPlan()), Array(8).fill('')));
test('decimal prices and royalties never use floating point', () => {
  assert.equal(decimalUnits('0.29', 2), 29n); assert.equal(decimalUnits('0.000000000000000001', 18), 1n);
  assert.equal(decimalUnits('100', 2), 10000n);
  for (const value of ['', '-1', '1e2', 'NaN', '01', '0.001', '1.']) assert.equal(decimalUnits(value, 2), null);
});
const validPlan: Plan = { name: 'An independent collection', symbol: 'ART', supply: '250', royalty: '0.29', price: '0.000000000000000001', owner: OWNER, minter: OWNER, recipient: OWNER };
test('validates arbitrary collection parameters without AOTV defaults', () => assert.deepEqual(validatePlan(validPlan), {}));
for (const [key, value] of [ ['name',''], ['symbol','spaces forbidden'], ['supply','0'], ['supply', (1n << 256n).toString()],
  ['royalty','100.01'], ['royalty','0.001'], ['price','0'], ['price','1e-3'], ['owner','0x'+'00'.repeat(20)], ['recipient','not-a-wallet'] ] as const) {
  test(`flags invalid planner ${key}: ${value.slice(0,20)}`, () => assert.ok(validatePlan({ ...validPlan, [key]: value })[key]));
}
test('accepts the maximum exact uint256 supply without rounding', () => assert.equal(validatePlan({ ...validPlan, supply: ((1n << 256n) - 1n).toString() }).supply, undefined));
