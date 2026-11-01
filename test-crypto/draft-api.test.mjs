import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseWrappingKey } from '../console/crypto/workspace.mjs';
import { createEncryptedRelease, readEncryptedRelease, updateEncryptedRelease } from '../console/crypto/draft-api.mjs';
const id = 'f747414c-e7dd-4c17-946c-f330ea7f7e79';
const draft = { name: 'Hidden release title', rights: 'Private rights text' };
test('authenticated transport sees only ciphertext and can return the private draft to the key holder', async () => {
  const wrappingKey = await createReleaseWrappingKey();
  let stored;
  const request = async (path, options) => {
    assert.match(path, /^\/api\/releases/);
    if (options?.method === 'POST') {
      assert.deepEqual(Object.keys(options.body), ['id', 'ciphertext', 'nonce']);
      assert(!JSON.stringify(options.body).includes(draft.name));
      stored = options.body;
      return { ...stored, revision: '1', created: true };
    }
    return { ...stored, revision: '1' };
  };
  assert.deepEqual(await createEncryptedRelease(draft, { id, wrappingKey, request }), { id, revision: '1', created: true });
  assert.deepEqual(await readEncryptedRelease(id, { wrappingKey, request }), { id, revision: '1', draft });
});
test('rejects server substitutions, malformed revisions and unavailable key', async () => {
  const wrappingKey = await createReleaseWrappingKey();
  const response = { id, ciphertext: 'bad', nonce: 'bad', revision: '1' };
  await assert.rejects(createEncryptedRelease(draft, { id, wrappingKey, request: async () => response }));
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: async () => ({ ...response, revision: '0' }) }));
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: async () => ({ ...response, id: 'other' }) }));
  await assert.rejects(createEncryptedRelease(draft, { id, request: async () => response }));
});
test('edit path sends only resealed bytes and enforces compare-and-swap response', async () => {
  const wrappingKey = await createReleaseWrappingKey();
  const next = { ...draft, name: 'Updated private title' };
  let sawPut = false;
  const request = async (path, options) => {
    assert.equal(path, `/api/releases/${id}`); assert.equal(options.method, 'PUT');
    assert.equal(options.body.expectedRevision, '7');
    assert.deepEqual(Object.keys(options.body), ['ciphertext', 'nonce', 'expectedRevision']);
    assert(!JSON.stringify(options.body).includes(next.name));
    sawPut = true;
    return { id, ciphertext: options.body.ciphertext, nonce: options.body.nonce, revision: '8', changed: true };
  };
  assert.deepEqual(await updateEncryptedRelease(next, { id, expectedRevision: '7', wrappingKey, request }), { id, revision: '8' });
  assert(sawPut);
  await assert.rejects(updateEncryptedRelease(next, { id, expectedRevision: '0', wrappingKey, request }));
  await assert.rejects(updateEncryptedRelease(next, { id, expectedRevision: '7', wrappingKey,
    request: async (_path, options) => ({ id, ciphertext: options.body.ciphertext, nonce: options.body.nonce, revision: '7', changed: true }) }));
});

test('trusted minimum revision rejects reported rollback and validates before requesting', async () => {
  const wrappingKey = await createReleaseWrappingKey();
  let record;
  await createEncryptedRelease(draft, { id, wrappingKey, request: async (_path, options) => {
    record = { ...options.body, revision: '7', created: false }; return record;
  } });
  const request = async () => record;
  assert.equal((await readEncryptedRelease(id, { wrappingKey, request, minimumRevision: '7' })).revision, '7');
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request, minimumRevision: '8' }));
  for (const minimumRevision of ['0', '-1', '01', '1.5', '9223372036854775808', 7, null]) {
    let called = false;
    await assert.rejects(readEncryptedRelease(id, { wrappingKey, minimumRevision, request: async () => { called = true; return record; } }));
    assert.equal(called, false);
  }
});

test('server revision bounds match PostgreSQL bigint including the terminal read revision', async () => {
  const wrappingKey = await createReleaseWrappingKey();
  let sealed;
  await createEncryptedRelease(draft, { id, wrappingKey, request: async (_path, options) => {
    sealed = options.body; return { ...sealed, revision: '1', created: true };
  } });
  const maximum = '9223372036854775807';
  assert.equal((await readEncryptedRelease(id, { wrappingKey, minimumRevision: maximum,
    request: async () => ({ ...sealed, revision: maximum }) })).revision, maximum);
  for (const revision of ['9223372036854775808', '9999999999999999999', '1e2', '01', 1]) {
    await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: async () => ({ ...sealed, revision }) }));
  }
  let called = false;
  await assert.rejects(updateEncryptedRelease(draft, { id, wrappingKey, expectedRevision: maximum,
    request: async () => { called = true; } }));
  assert.equal(called, false);
  const result = await updateEncryptedRelease(draft, { id, wrappingKey, expectedRevision: '9223372036854775806',
    request: async (_path, options) => ({ id, ciphertext: options.body.ciphertext, nonce: options.body.nonce,
      revision: maximum, changed: true }) });
  assert.equal(result.revision, maximum);
});
