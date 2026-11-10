import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { getBytes } from 'ethers';
import { testWallets } from './fixtures.mjs';
test.describe.configure({ mode: 'serial' });
async function rpc(method: string, params: unknown[] = []): Promise<any> /* eslint-disable-line @typescript-eslint/no-explicit-any */ {
  const r = await fetch('http://127.0.0.1:4179', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NFT-Test': 'disposable-local-only' }, body: JSON.stringify({ method, params }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result;
}
declare global { interface Window { __mkRpc(m: string, p: unknown[]): Promise<unknown>; __mkSign(d: string): Promise<string>; __mkTyped(p: string): Promise<string>; __mkCalls: string[]; __mkMode: string } }
async function setup(page: Page, index: number) {
  const signer = testWallets[index]!;
  await page.exposeFunction('__mkSign', (d: string) => signer.signMessage(getBytes(d)));
  await page.exposeFunction('__mkTyped', (payload: string) => { const p = JSON.parse(payload); const types = { ...p.types }; delete types.EIP712Domain; return signer.signTypedData(p.domain, types, p.message); });
  await page.exposeFunction('__mkRpc', async (method: string, params: unknown[]) => {
    if (method !== 'eth_sendTransaction') return rpc(method, params);
    const v = params[0] as Record<string, string>;
    if (v.from?.toLowerCase() !== signer.address.toLowerCase()) throw new Error('Unexpected sender');
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [signer.address, 'pending'])));
    const gas = BigInt(await rpc('eth_estimateGas', [{ from: v.from, to: v.to, data: v.data }])) * 12n / 10n;
    const raw = await signer.signTransaction({ to: v.to, data: v.data, value: 0n, nonce, gasLimit: gas, gasPrice: 2_000_000_000n, chainId: 31337n, type: 0 });
    return rpc('eth_sendRawTransaction', [raw]);
  });
  await page.addInitScript(address => {
    window.__mkCalls = []; window.__mkMode = 'ok';
    window.ethereum = { async request({ method, params }) {
      window.__mkCalls.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'personal_sign') return window.__mkSign((params as string[])[0]!);
      if (method === 'eth_signTypedData_v4') { if (window.__mkMode === 'reject') throw Object.assign(new Error('User rejected'), { code: 4001 }); return window.__mkTyped((params as string[])[1]!); }
      if (method === 'eth_sendTransaction' && window.__mkMode === 'reject') throw Object.assign(new Error('User rejected'), { code: 4001 });
      return window.__mkRpc(method, (params as unknown[]) || []);
    }, on() {}, removeListener() {} };
  }, signer.address);
  await page.goto('/#/collections');
  await page.locator('.topbar').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  return rpc('market_context', [index]) as Promise<{ collection: string; seaport: string; validator: string; conduit: string }>;
}
test('collection inventory, owner transfer policy, verified listing, sale with royalty evidence, cancel and relist', async ({ page, isMobile }) => {
  test.setTimeout(180_000);
  const ctx = await setup(page, isMobile ? 9 : 8);
  await page.getByLabel('Collection contract').fill(ctx.collection);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Market Browser/ })).toBeVisible();
  await expect(page.getByText('3 minted of 20 (immutable)', { exact: false })).toBeVisible();
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  // Five OWNER transactions; each is re-planned from chain state and read back.
  for (let i = 0; i < 6; i++) {
    if (await page.getByText('Configured and verified', { exact: true }).isVisible()) break;
    await page.getByRole('button', { name: 'Review in wallet', exact: true }).click();
    await expect(page.locator('.signing-status')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.notice-error')).toHaveCount(0);
  }
  await expect(page.getByText('Configured and verified', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByText('Whitelist ruleset 255 with options 6 selected')).toBeVisible();

  await page.goto('/#/marketplace');
  await page.getByLabel('Collection contract').fill(ctx.collection);
  await page.getByLabel('Token ID').fill('1');
  await page.getByLabel('Price (ETH)').fill('1');
  await page.getByRole('button', { name: 'Check token and fees' }).click();
  await expect(page.getByText('The marketplace conduit is not approved', { exact: false })).toBeVisible();
  await expect(page.getByText('disposable local test marketplace', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Approve conduit in wallet' }).click();
  await expect(page.getByRole('button', { name: 'Prepare order for review' })).toBeVisible({ timeout: 30_000 });
  const split = page.getByRole('table', { name: /Exact payment split/ });
  await expect(split.getByText('0.93 ETH')).toBeVisible(); await expect(split.getByText('0.06 ETH')).toBeVisible(); await expect(split.getByText('0.01 ETH')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare order for review' }).click();
  await expect(page.getByRole('heading', { name: 'Exact Seaport order you will sign' })).toBeVisible();
  // Rejected signature leaves a prepared, unsigned record; nothing is submitted.
  await page.evaluate(() => { window.__mkMode = 'reject'; });
  await page.getByRole('button', { name: 'Sign order in wallet and submit' }).click();
  await expect(page.getByText('You rejected the signature', { exact: false })).toBeVisible();
  await page.evaluate(() => { window.__mkMode = 'ok'; });
  await page.getByRole('button', { name: 'Sign order in wallet and submit' }).click();
  const listings = page.getByRole('region', { name: 'Your listings' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'Your listings' }) }));
  await expect(page.getByText('Listed — independently verified').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('synthetic test marketplace', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.__mkCalls.filter(c => c === 'eth_signTypedData_v4').length)).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(accessibility.violations.filter(v => ['critical', 'serious'].includes(v.impact || ''))).toEqual([]);

  // A buyer fills the order on real Seaport; verification derives the sale and royalty from settlement logs.
  const row = await page.evaluate(async () => { const r = await fetch('/api/market/listings', { credentials: 'same-origin' }); return (await r.json()).items.find((x: { state: string }) => x.state === 'listed'); });
  await rpc('market_buy', [{ parameters: row.order.parameters, signature: row.signature }]);
  await listings.getByRole('button', { name: 'Verify now' }).first().click();
  await expect(page.getByText('Sold — settlement verified').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Paid 0.06 ETH (order specified 0.06 ETH)', { exact: false })).toBeVisible();

  // Token 2: list, then change price (replacement) and cancel the original on-chain.
  await page.getByLabel('Token ID').fill('2'); await page.getByLabel('Price (ETH)').fill('2');
  await page.getByRole('button', { name: 'Check token and fees' }).click();
  await page.getByRole('button', { name: 'Prepare order for review' }).click();
  await page.getByRole('button', { name: 'Sign order in wallet and submit' }).click();
  await expect(page.getByText('Listed — independently verified').first()).toBeVisible({ timeout: 30_000 });
  page.once('dialog', d => void d.accept());
  await listings.getByRole('button', { name: 'Cancel order' }).first().click();
  await expect(page.getByText('Cancelled on-chain').first()).toBeVisible({ timeout: 30_000 });
  // The cancelled order cannot be filled.
  const cancelled = await page.evaluate(async () => { const r = await fetch('/api/market/listings', { credentials: 'same-origin' }); return (await r.json()).items.find((x: { state: string }) => x.state === 'cancelled'); });
  await expect(rpc('market_buy', [{ parameters: cancelled.order.parameters, signature: cancelled.signature }])).rejects.toThrow();
});
