import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { getBytes } from 'ethers';
import { OWNER, VIEWER, testWallets, ORIGIN } from './fixtures.mjs';

declare global {
  interface Window {
    __testSign(data: string, address: string): Promise<string>;
    __wallet: { changeAccounts(value: string): void; changeChain(value: string): void; release(): void; signCount: number; calls: string[] };
  }
}
async function installWallet(page: Page, options: { wallet?: string; chain?: string; mode?: string; name?: string } = {}) {
  await page.exposeFunction('__testSign', async (data: string, address: string) => {
    const wallet = testWallets.find(value => value.address.toLowerCase() === address.toLowerCase());
    if (!wallet) throw new Error('Unknown fixture signer.');
    return wallet.signMessage(getBytes(data));
  });
  await page.addInitScript(({ wallet, chain, mode, name }) => {
    let account = wallet, network = chain, finish: (() => void) | undefined;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    window.__wallet = { signCount: 0, calls: [],
      changeAccounts(value) { account = value; for (const fn of listeners.get('accountsChanged') || []) fn([value]); },
      changeChain(value) { network = value; for (const fn of listeners.get('chainChanged') || []) fn(value); },
      release() { finish?.(); },
    };
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }) {
        window.__wallet.calls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return network;
        if (method === 'personal_sign') {
          window.__wallet.signCount++;
          if (mode === 'reject') throw Object.assign(new Error('Declined'), { code: 4001 });
          if (mode === 'wait') await new Promise<void>(resolve => { finish = resolve; });
          if (!Array.isArray(params) || typeof params[0] !== 'string' || typeof params[1] !== 'string') throw new Error('Unexpected signing payload');
          return window.__testSign(params[0], params[1]);
        }
        throw new Error('Unsupported fixture wallet method: ' + method);
      },
      on(event: string, fn: (...args: unknown[]) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
      removeListener(event: string, fn: (...args: unknown[]) => void) { listeners.get(event)?.delete(fn); },
    };
    (window as unknown as { ethereum: typeof provider }).ethereum = provider;
    if (name) window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: 'test-wallet', name, icon: 'https://do-not-request.invalid/icon.svg', rdns: 'example.fixture' }, provider },
    })));
  }, { wallet: options.wallet || OWNER, chain: options.chain || '0x7a69', mode: options.mode || 'approve', name: options.name || '' });
}
async function openWallet(page: Page) {
  await page.locator('.topbar').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function login(page: Page) {
  await page.goto('/'); await openWallet(page);
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
}
async function navigate(page: Page, route: string) { await page.evaluate(value => { location.hash = '#/' + value; }, route); }
async function plan(page: Page) {
  await navigate(page, 'create');
  await page.getByLabel('Collection name', { exact: true }).fill('Independent work');
  await page.getByLabel('Token symbol', { exact: true }).fill('ART');
  await page.getByLabel('Maximum supply', { exact: true }).fill('25');
  await page.getByLabel('Creator royalty (%)', { exact: true }).fill('0.29');
  await page.getByLabel('Initial listing price (ETH)', { exact: true }).fill('0.000000000000000001');
}
async function inventory(page: Page, rows: Record<string, unknown>[]) {
  await page.route('**/api/config', async route => {
    const response = await route.fetch(), body = await response.json(); body.capabilities.opaqueReleaseApi = true;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/releases?*', route => route.fulfill({ json: { items: rows, nextCursor: null } }));
}
const record = { id: '11111111-1111-4111-8111-111111111111', state: 'draft', revision: '2', updated_at: '2026-10-12T12:00:00Z' };

test('workspace is responsive and does not invent collections or listings', async ({ page }, testInfo) => {
  await installWallet(page); await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every collection starts here.');
  await expect(page.getByText('Listed only after independent verification', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect to your workspace' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.screenshot({ path: `test-results/${testInfo.project.name}-workspace.png`, fullPage: true });
});
test('real EOA signature completes the browser, HTTP and local-EVM login path', async ({ page }) => {
  await installWallet(page); await login(page);
  expect(await page.evaluate(() => window.__wallet.signCount)).toBe(1);
  const cookie = (await page.context().cookies()).find(x => x.name === 'nft_session_v2');
  expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('nft_session_v2');
  expect(await page.evaluate(() => window.__wallet.calls.some(x => x.includes('sendTransaction')))).toBe(false);
});
test('wallet rejection is a cancellation, never a successful sign-in', async ({ page }) => {
  await installWallet(page, { mode: 'reject' }); await page.goto('/'); await openWallet(page);
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('You declined');
  await expect(page.getByText('Signed in', { exact: true })).not.toBeVisible();
});
test('wrong network is rejected before requesting any signature', async ({ page }) => {
  await installWallet(page, { chain: '0x1' }); await page.goto('/'); await openWallet(page);
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Switch your wallet');
  expect(await page.evaluate(() => window.__wallet.signCount)).toBe(0);
});
test('mismatched sign-in domain is refused before the wallet can sign', async ({ page }) => {
  await installWallet(page);
  await page.route('**/api/auth/challenge', async route => {
    const response = await route.fetch(), body = await response.json(); body.message = body.message.replace(ORIGIN, 'https://evil.example');
    await route.fulfill({ response, json: body });
  });
  await page.goto('/'); await openWallet(page); await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('does not match');
  expect(await page.evaluate(() => window.__wallet.signCount)).toBe(0);
});
test('account changes immediately revoke the current browser session', async ({ page }) => {
  await installWallet(page); await login(page);
  await page.evaluate(value => window.__wallet.changeAccounts(value), VIEWER);
  await expect(page.getByText('Signed in', { exact: true })).not.toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/auth/session')).status()).toBe(401);
});
test('network changes during a pending signature cannot establish authority', async ({ page }) => {
  await installWallet(page, { mode: 'wait' }); await page.goto('/'); await openWallet(page);
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__wallet.signCount)).toBe(1);
  await page.evaluate(() => { window.__wallet.changeChain('0x1'); window.__wallet.release(); });
  await expect(page.getByRole('alert')).toContainText('Wallet changed');
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
});
test('closing a pending sign-in dialog cancels late wallet authorization', async ({ page }) => {
  await installWallet(page, { mode: 'wait' }); await page.goto('/'); await openWallet(page);
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__wallet.signCount)).toBe(1);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() => window.__wallet.release());
  await expect(page.getByText('Signed in', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/cancelled|Wallet changed/);
});
test('session restore checks the same wallet and reattaches change listeners', async ({ page }) => {
  await installWallet(page); await login(page); await page.reload();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__wallet.changeChain('0x1'));
  await expect(page.getByText('Signed in', { exact: true })).not.toBeVisible();
  await expect.poll(async () => (await page.request.get('/api/auth/session')).status()).toBe(401);
});
test('a restored cookie does not grant UI access under a different wallet', async ({ page, browser }) => {
  await installWallet(page); await login(page);
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: await page.context().storageState() });
  try {
    const other = await context.newPage(); await installWallet(other, { wallet: VIEWER }); await other.goto('/');
    await expect(other.getByRole('alert')).toContainText('Reconnect the matching wallet');
    await expect(other.getByText('Signed in', { exact: true })).not.toBeVisible();
    expect((await other.request.get('/api/auth/session')).status()).toBe(401);
  } finally { await context.close(); }
});
test('viewer accounts cannot use the collection setup form', async ({ page }) => {
  await installWallet(page, { wallet: VIEWER }); await login(page); await navigate(page, 'create');
  await expect(page.getByText('Collection setup is available to an authorized console owner.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Collection name', { exact: true })).not.toBeVisible();
});
test('local planning validates exact values and never posts private fields', async ({ page }, testInfo) => {
  await installWallet(page); await login(page);
  const writes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.postData() || request.url()); });
  await plan(page); await page.getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review Independent work' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save private release', exact: true })).toBeDisabled();
  await expect(page.getByText('0.29', { exact: true })).toBeVisible();
  await expect(page.getByText('0.000000000000000001', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.screenshot({ path: `test-results/${testInfo.project.name}-setup-preview.png`, fullPage: true });
});
test('validation errors are announced and link to the invalid inputs', async ({ page }) => {
  await installWallet(page); await login(page); await navigate(page, 'create');
  await page.getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Check these fields');
  await expect(page.getByRole('alert')).toBeFocused();
  await page.getByRole('alert').getByRole('link').first().click();
  await expect(page.getByLabel('Collection name', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Collection name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
});
test('preview fields are cleared by reload and no key or seed field exists', async ({ page }) => {
  await installWallet(page); await login(page); await plan(page); await page.reload();
  await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('');
  expect(await page.locator('input[type=password]').count()).toBe(0);
});
test('configuration failure is actionable and signing remains unavailable', async ({ page }) => {
  await installWallet(page);
  await page.route('**/api/config', route => route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } }));
  await page.goto('/'); await expect(page.getByRole('alert')).toContainText('configuration could not be loaded');
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeDisabled();
  await page.unroute('**/api/config'); await page.getByRole('button', { name: 'Retry configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Connect to your workspace' })).toBeVisible();
});
test('inventory displays only server-returned records, not pretend decrypted content', async ({ page }) => {
  await installWallet(page); await inventory(page, [record]); await login(page);
  await expect(page.getByRole('heading', { name: 'Release record', exact: true })).toBeVisible();
  await expect(page.getByText('Recorded stage: draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View record', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(record.id);
  await expect(page.getByRole('dialog')).toContainText('No artwork was downloaded');
});
test('invalid inventory data becomes an error rather than false success', async ({ page }) => {
  await installWallet(page); await inventory(page, [{ ...record, state: 'listed' }]); await login(page);
  await expect(page.getByRole('alert')).toContainText('inventory could not be verified');
  await expect(page.getByRole('heading', { name: 'Release record', exact: true })).not.toBeVisible();
});
test('logout request failure is visible and can be retried', async ({ page }) => {
  await installWallet(page); await login(page);
  let fail = true;
  await page.route('**/api/auth/logout', async route => { if (fail) { fail = false; await route.abort(); } else await route.continue(); });
  await page.getByRole('button', { name: /0xf39F/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('sign-out could not be confirmed');
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  await expect.poll(async () => (await page.request.get('/api/auth/session')).status()).toBe(401);
  await expect(page.getByRole('alert')).not.toBeVisible();
});
test('extension names are text, and extension icon URLs are never requested', async ({ page }) => {
  let external = false; page.on('request', request => { if (request.url().includes('do-not-request.invalid')) external = true; });
  await installWallet(page, { name: '<img src=x onerror=alert(1)>' }); await page.goto('/'); await openWallet(page);
  await expect(page.getByRole('button', { name: '<img src=x onerror=alert(1)>', exact: true })).toBeVisible();
  expect(await page.locator('dialog img').count()).toBe(0); expect(external).toBe(false);
});
test('modal keyboard focus stays contained and Escape restores focus', async ({ page }) => {
  await installWallet(page); await page.goto('/');
  const opener = page.locator('.topbar').getByRole('button', { name: 'Connect wallet', exact: true }); await opener.click();
  for (let i = 0; i < 7; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(opener).toBeFocused();
});
test('skip link preserves the current route and focuses main content', async ({ page }) => {
  await installWallet(page); await page.goto('/#/settings');
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.locator('#main-content')).toBeFocused();
  expect(new URL(page.url()).hash).toBe('#/settings');
});
test('navigation is usable on the current viewport', async ({ page }, testInfo) => {
  await installWallet(page); await page.goto('/');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Workspace settings', exact: true }).click();
  } else await page.getByRole('navigation').getByRole('link', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspace settings');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('automated accessibility checks cover each public and signed-in screen', async ({ page }) => {
  await installWallet(page); await page.goto('/');
  let results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  expect.soft(results.violations).toEqual([]); await login(page);
  for (const route of ['create','readiness','settings']) {
    await navigate(page, route); await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (route === 'readiness') await expect(page.locator('.gate')).toHaveCount(6);
    results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    expect.soft(results.violations).toEqual([]);
  }
});
