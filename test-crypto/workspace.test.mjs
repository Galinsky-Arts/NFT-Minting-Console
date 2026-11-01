import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseWrappingKey, sealReleaseDraft, openReleaseDraft } from '../console/crypto/workspace.mjs';
const A = 'f747414c-e7dd-4c17-946c-f330ea7f7e79';
const B = 'e239828b-1a1d-457c-b50d-df51e68a032c';
const draft = { name: 'Private collection', rights: 'Secret draft rights', assets: [{ filename: 'private.png' }] };
test('opaque envelope round trip with a non-extractable authorized key', async () => {
  const key = await createReleaseWrappingKey();
  assert.equal(key.extractable, false);
  const sealed = await sealReleaseDraft(draft, { id: A, wrappingKey: key });
  assert.deepEqual(Object.keys(sealed), ['id', 'ciphertext', 'nonce']);
  assert(!JSON.stringify(sealed).includes(draft.name));
  assert.deepEqual(await openReleaseDraft(sealed, { expectedId: A, wrappingKey: key }), draft);
});
test('fresh content key and nonces produce independent records', async () => {
  const key = await createReleaseWrappingKey();
  const a = await sealReleaseDraft(draft, { id: A, wrappingKey: key });
  const b = await sealReleaseDraft(draft, { id: A, wrappingKey: key });
  assert.notEqual(a.ciphertext, b.ciphertext); assert.notEqual(a.nonce, b.nonce);
});
test('wrong key, swapped release, tampered ciphertext and nonces fail closed', async () => {
  const key = await createReleaseWrappingKey(), other = await createReleaseWrappingKey();
  const sealed = await sealReleaseDraft(draft, { id: A, wrappingKey: key });
  await assert.rejects(openReleaseDraft(sealed, { expectedId: A, wrappingKey: other }));
  await assert.rejects(openReleaseDraft({ ...sealed, id: B }, { expectedId: B, wrappingKey: key }));
  for (const field of ['ciphertext', 'nonce']) {
    const bytes = Uint8Array.from(globalThis.atob(sealed[field]), char => char.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(openReleaseDraft({ ...sealed, [field]: globalThis.btoa(String.fromCharCode(...bytes)) }, { expectedId: A, wrappingKey: key }));
  }
});
test('rejects malformed API inputs and extractable wrapping keys', async () => {
  const key = await createReleaseWrappingKey();
  await assert.rejects(sealReleaseDraft(draft, { id: 'bad', wrappingKey: key }));
  const extractable = await globalThis.crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
  await assert.rejects(sealReleaseDraft(draft, { id: A, wrappingKey: extractable }));
  const sealed = await sealReleaseDraft(draft, { id: A, wrappingKey: key });
  for (const field of ['ciphertext', 'nonce']) await assert.rejects(openReleaseDraft({ ...sealed, [field]: 'not base64' }, { expectedId: A, wrappingKey: key }));
});
test('rejects lossy or unsafe draft structures before any upload', async () => {
  const key = await createReleaseWrappingKey();
  const sparse = Array(2); sparse[1] = 1;
  const bad = [{ missing: undefined }, { count: NaN }, { items: sparse }, { toJSON: () => ({ name: 'hidden' }) },
    Object.defineProperty({}, 'secret', { value: 'not serialized' }), JSON.parse('{"__proto__":{"admin":true}}')];
  for (const draft of bad) await assert.rejects(sealReleaseDraft(draft, { id: A, wrappingKey: key }));
});

test('rejects hidden array serializers and custom array prototypes without invoking them', async () => {
  const key = await createReleaseWrappingKey();
  let called = false;
  const hidden = Object.defineProperty(['private.png'], 'toJSON', { value() { called = true; return []; } });
  const custom = ['private.png'];
  Object.setPrototypeOf(custom, Object.assign(Object.create(Array.prototype), {
    toJSON() { called = true; return []; },
  }));
  const extra = Object.defineProperty(['private.png'], 'privateField', { value: 'silently lost' });
  for (const files of [hidden, custom, extra]) {
    await assert.rejects(sealReleaseDraft({ files }, { id: A, wrappingKey: key }), /validation/);
  }
  assert.equal(called, false);
  const sealed = await sealReleaseDraft({ files: ['private.png', []] }, { id: A, wrappingKey: key });
  assert.deepEqual(await openReleaseDraft(sealed, { expectedId: A, wrappingKey: key }), { files: ['private.png', []] });
});
