import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAttachment, openAttachment, MIN_CHUNK_SIZE } from '../console/crypto/attachments.mjs';
import { createReleaseWrappingKey } from '../console/crypto/workspace.mjs';
import { createEncryptedRelease, readEncryptedRelease } from '../console/crypto/draft-api.mjs';

test('synthetic compromised server sees no private draft or attachment manifest', async () => {
  const id = 'f747414c-e7dd-4c17-946c-f330ea7f7e79';
  const original = Uint8Array.from({ length: MIN_CHUNK_SIZE + 17 }, (_, i) => (i * 17) & 255);
  const prepared = await prepareAttachment(new Blob([original]), {
    parentMessageId: id, filename: 'confidential-artwork.png', mediaType: 'image/png', chunkSize: MIN_CHUNK_SIZE,
  });
  const storage = new Map(), serverSeen = [];
  await prepared.encryptTo((index, bytes) => {
    serverSeen.push({ index, bytes: Uint8Array.from(bytes) });
    storage.set(index, Uint8Array.from(bytes));
  });
  const wrappingKey = await createReleaseWrappingKey();
  let stored;
  const request = async (_path, options) => {
    if (options?.method === 'POST') {
      stored = structuredClone(options.body);
      return { ...stored, revision: '1', created: true };
    }
    return { ...stored, revision: '1' };
  };
  await createEncryptedRelease({ name: 'Unpublished private release', attachments: [prepared.privateManifest] },
    { id, wrappingKey, request });
  const serverMetadata = JSON.stringify(stored);
  assert(!serverMetadata.includes('confidential-artwork.png'));
  assert(!serverMetadata.includes(prepared.privateManifest.attachment_key_hex));
  assert(!serverMetadata.includes('Unpublished private release'));
  assert(serverSeen.every(({ bytes }) => !Buffer.from(bytes).includes(Buffer.from('confidential-artwork.png'))));

  const { draft } = await readEncryptedRelease(id, { wrappingKey, request });
  const opened = await openAttachment(draft.attachments[0], id), output = [];
  const report = await opened.decryptTo(index => storage.get(index), (index, bytes) => { output[index] = Uint8Array.from(bytes); });
  assert.equal(report.wholeFileVerified, true);
  assert.deepEqual(Buffer.concat(output), Buffer.from(original));

  // The server's copied record and chunks alone are insufficient. Substitution
  // and deletion fail without letting a client accept an unauthenticated file.
  const wrongKey = await createReleaseWrappingKey();
  await assert.rejects(readEncryptedRelease(id, { wrappingKey: wrongKey, request }));
  const missing = new Map(storage); missing.delete(1);
  await assert.rejects(opened.decryptTo(index => missing.get(index), () => {}));
});
