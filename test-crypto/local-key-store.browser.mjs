import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

test('Chromium persists a non-extractable key and does not silently replace a missing key', async () => {
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'local-key-test-page', configureServer(vite) {
      vite.middlewares.use('/local-key-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local key test</title>');
      });
    } }] });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(), page = await context.newPage(), remote = [];
    await page.route('**/*', route => {
      if (!route.request().url().startsWith(origin + '/')) { remote.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/local-key-test`);
    const initial = await page.evaluate(async () => {
      const { loadLocalReleaseKey, createLocalReleaseKey } = await import('/console/crypto/local-key-store.mjs');
      const { sealReleaseDraft, openReleaseDraft } = await import('/console/crypto/workspace.mjs');
      const wallet = '0x' + 'ab'.repeat(20), id = 'f747414c-e7dd-4c17-946c-f330ea7f7e79';
      const missing = await loadLocalReleaseKey(wallet, 31337);
      const key = await createLocalReleaseKey(wallet, 31337);
      const again = await createLocalReleaseKey(wallet, 31337);
      const sealed = await sealReleaseDraft({ name: 'Hidden' }, { id, wrappingKey: key });
      const reopened = await openReleaseDraft(sealed, { expectedId: id, wrappingKey: again });
      return { missing: missing === null, nonExtractable: !key.extractable, sameKey: reopened.name === 'Hidden', sealed };
    });
    assert.equal(initial.missing, true); assert.equal(initial.nonExtractable, true); assert.equal(initial.sameKey, true);
    await page.reload();
    const reopened = await page.evaluate(async sealed => {
      const { loadLocalReleaseKey } = await import('/console/crypto/local-key-store.mjs');
      const { openReleaseDraft } = await import('/console/crypto/workspace.mjs');
      const key = await loadLocalReleaseKey('0x' + 'ab'.repeat(20), 31337);
      const wrongAccount = await loadLocalReleaseKey('0x' + 'cd'.repeat(20), 31337);
      return { draft: await openReleaseDraft(sealed, { expectedId: sealed.id, wrappingKey: key }),
        wrongAccountMissing: wrongAccount === null };
    }, initial.sealed);
    assert.deepEqual(reopened, { draft: { name: 'Hidden' }, wrongAccountMissing: true });
    assert.deepEqual(remote, []);
  } finally { await browser?.close(); await server.close(); }
});
