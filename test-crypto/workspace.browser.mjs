import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

test('actual Chromium seals opaque release drafts and rejects hostile records', async () => {
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'workspace-crypto-test-page', configureServer(vite) {
      vite.middlewares.use('/workspace-crypto-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic release crypto test</title>');
      });
    } }] });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(), remoteRequests = [];
    await page.route('**/*', route => {
      if (!route.request().url().startsWith(origin + '/')) { remoteRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/workspace-crypto-test`);
    const result = await page.evaluate(async () => {
      const { createReleaseWrappingKey, sealReleaseDraft, openReleaseDraft } = await import('/console/crypto/workspace.mjs');
      const { readEncryptedRelease } = await import('/console/crypto/draft-api.mjs');
      const id = 'f747414c-e7dd-4c17-946c-f330ea7f7e79';
      const key = await createReleaseWrappingKey(), wrong = await createReleaseWrappingKey();
      const input = { name: 'Secret release', assets: [{ filename: 'private.png' }] };
      const sealed = await sealReleaseDraft(input, { id, wrappingKey: key });
      const opened = await openReleaseDraft(sealed, { expectedId: id, wrappingKey: key });
      let wrongKeyRejected = false, tamperRejected = false, rollbackRejected = false, overflowRejected = false;
      const current = await readEncryptedRelease(id, { wrappingKey: key, minimumRevision: '2',
        request: async () => ({ ...sealed, revision: '2' }) });
      try { await readEncryptedRelease(id, { wrappingKey: key, minimumRevision: '2',
        request: async () => ({ ...sealed, revision: '1' }) }); } catch { rollbackRejected = true; }
      try { await readEncryptedRelease(id, { wrappingKey: key,
        request: async () => ({ ...sealed, revision: '9223372036854775808' }) }); } catch { overflowRejected = true; }
      try { await openReleaseDraft(sealed, { expectedId: id, wrappingKey: wrong }); } catch { wrongKeyRejected = true; }
      const bytes = Uint8Array.from(globalThis.atob(sealed.ciphertext), char => char.charCodeAt(0)); bytes[bytes.length - 1] ^= 1;
      try { await openReleaseDraft({ ...sealed, ciphertext: globalThis.btoa(String.fromCharCode(...bytes)) }, { expectedId: id, wrappingKey: key }); }
      catch { tamperRejected = true; }
      return { secureContext: globalThis.isSecureContext, nonExtractable: !key.extractable,
        opaque: !JSON.stringify(sealed).includes(input.name), sameDraft: JSON.stringify(opened) === JSON.stringify(input),
        wrongKeyRejected, tamperRejected, rollbackRejected, overflowRejected, revision: current.revision };
    });
    assert.deepEqual(result, { secureContext: true, nonExtractable: true, opaque: true, sameDraft: true,
      wrongKeyRejected: true, tamperRejected: true, rollbackRejected: true, overflowRejected: true, revision: '2' });
    assert.deepEqual(remoteRequests, []);
  } finally { await browser?.close(); await server.close(); }
});
