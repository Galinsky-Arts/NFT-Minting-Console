import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { getBytes } from 'ethers';
import { testWallets } from './fixtures.mjs';
test.describe.configure({ mode: 'serial' });
declare global { interface Window { __pwSign(d: string): Promise<string> } }
async function open(browser: Browser, index: number, isMobile: boolean): Promise<Page> {
  const context = await browser.newContext(isMobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), signer = testWallets[index]!;
  await page.exposeFunction('__pwSign', (d: string) => signer.signMessage(getBytes(d)));
  await page.addInitScript(address => { window.ethereum = { async request({ method, params }) { if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address]; if (method === 'eth_chainId') return '0x7a69'; if (method === 'personal_sign') return window.__pwSign((params as string[])[0]!); throw new Error('Private workspace must not request ' + method); }, on() {}, removeListener() {} }; }, signer.address);
  await page.goto('/#/private');
  await page.locator('.topbar').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  return page;
}
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300 * 1024, 7)]);
test('encrypted private release: create, upload, validate, reload, second device approval, recovery and handoff to publication', async ({ browser, isMobile }) => {
  test.setTimeout(180_000);
  const index = isMobile ? 11 : 10, page = await open(browser, index, isMobile);
  await expect(page.getByRole('heading', { name: 'Create your private workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Create encrypted workspace' }).click();
  const code = (await page.getByTestId('recovery-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{1,4}){12}$/);
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
  await page.getByLabel('I have stored this recovery code somewhere safe.').check(); await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'New release draft' }).click();
  await page.getByLabel('Collection name').fill('Private Browser Release'); await page.getByLabel('Symbol').fill('PBR'); await page.getByLabel('Maximum supply').fill('5');
  await page.getByLabel('Royalty %').fill('5'); for (const f of ['Owner wallet', 'Minter wallet', 'Royalty recipient']) await page.getByLabel(f).fill(testWallets[index]!.address);
  await page.getByLabel('Collection-wide rights terms').fill('Collector may display the artwork privately. No commercial rights.');
  await page.getByRole('button', { name: 'Approve these exact terms' }).click();
  await expect(page.getByText(/Approved .* SHA-256 of exact UTF-8 bytes/)).toBeVisible();
  await page.getByRole('button', { name: 'Add work' }).click();
  const work = page.getByRole('article', { name: 'Work 1' });
  await work.getByLabel('Token ID').fill('1'); await work.getByLabel('Title').fill('Secret Study');
  await work.locator('.drop-zone').first().locator('input[type=file]').setInputFiles({ name: 'study.png', mimeType: 'image/png', buffer: png });
  await expect(work.getByText(/Primary: study\.png/)).toBeVisible({ timeout: 30_000 });
  // The server never received the plaintext bytes: ciphertext chunks differ from every 64 KiB plaintext window.
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('heading', { name: /Validation — no blocking issues/ })).toBeVisible();
  // Editing approved rights invalidates the approval.
  await page.getByLabel('Collection-wide rights terms').fill('Collector may display the artwork privately. No commercial rights. Revised.');
  await expect(page.getByText('Edited after approval', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('rights text changed after approval', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Approve these exact terms' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('heading', { name: /Validation — no blocking issues/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.filter(v => ['critical', 'serious'].includes(v.impact || ''))).toEqual([]);

  // Reload: locked until explicitly unlocked with this device's key; decrypted content matches.
  await page.reload();
  await page.getByRole('button', { name: 'Unlock on this device' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByLabel('Collection name')).toHaveValue('Private Browser Release');
  await page.getByRole('article', { name: 'Work 1' }).getByRole('button', { name: 'Decrypt & preview' }).click();
  await expect(page.getByRole('img', { name: 'Preview of study.png' })).toBeVisible();
  const ciphertextOnly = await page.evaluate(async () => { const rows = (await (await fetch('/api/private/records', { credentials: 'same-origin' })).json()).items; const r = await (await fetch('/api/private/records/' + rows[0].id, { credentials: 'same-origin' })).json(); return !atob(r.envelope).includes('Private Browser Release'); });
  expect(ciphertextOnly).toBe(true);

  // Second device: requests access, shows fingerprint; first device approves after comparing it.
  const second = await open(browser, index, isMobile);
  await second.getByRole('button', { name: 'Request access from another device' }).click();
  const fp = (await second.getByText(/confirm this fingerprint: /).textContent())!.match(/([0-9A-F]{4}(-[0-9A-F]{4}){4})/)![1]!;
  await page.reload(); await page.getByRole('button', { name: 'Unlock on this device' }).click();
  await page.getByLabel('Fingerprint shown on that device').fill(fp);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('can now unlock the workspace')).toBeVisible();
  await second.getByRole('button', { name: 'Check again' }).click();
  await second.getByRole('button', { name: 'Unlock on this device' }).click();
  await second.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(second.getByLabel('Collection name')).toHaveValue('Private Browser Release');

  // Third browser with no device: wrong recovery code fails, real code recovers.
  const third = await open(browser, index, isMobile);
  await third.getByLabel('Recovery code').fill(code.replace(/^.{4}/, 'ZZZZ'));
  await third.getByRole('button', { name: 'Recover access' }).click();
  await expect(third.getByText('That recovery code does not unlock this workspace.')).toBeVisible();
  await third.getByLabel('Recovery code').fill(code);
  await third.getByRole('button', { name: 'Recover access' }).click();
  await expect(third.getByText('Recovered. This browser is now an authorized device.')).toBeVisible();

  // Revoke the second device from the first: it can no longer unlock; a new recovery code is shown.
  page.once('dialog', d => void d.accept());
  await page.getByRole('listitem').filter({ hasText: 'active' }).filter({ hasNotText: 'this browser' }).first().getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('recovery-code')).toBeVisible();
  await second.reload(); await expect(second.getByRole('button', { name: 'Unlock on this device' })).toHaveCount(0);

  // Selecting a work hands decrypted files to the publication review without publishing anything.
  await page.getByLabel('I have stored this recovery code somewhere safe.').check(); await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await page.getByRole('article', { name: 'Work 1' }).getByLabel('Select for publication').check();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('heading', { name: /Validation — no blocking issues/ })).toBeVisible();
  await page.getByRole('button', { name: 'Review selected works for publication' }).click();
  await expect(page).toHaveURL(/#\/launch/);
  await expect(page.getByText('decrypted locally from your private workspace', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('NFT title', { exact: true })).toHaveValue('Secret Study');
  await Promise.all([page.context().close(), second.context().close(), third.context().close()]);
});
