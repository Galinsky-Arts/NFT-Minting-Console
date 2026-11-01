import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../scripts/migrate.mjs';
import { migrateAuth } from '../scripts/migrate-auth.mjs';
import { ReleaseRepository } from '../console/data/releases.mjs';
import { createReleaseWrappingKey } from '../console/crypto/workspace.mjs';
import { createEncryptedRelease, readEncryptedRelease, updateEncryptedRelease } from '../console/crypto/draft-api.mjs';

// Execute the production repository's SQL and RLS with serialized embedded
// PostgreSQL leases. This is not a deployed HTTP or native pg-driver claim.
class EmbeddedPool {
  constructor(db) { this.db = db; this.tail = Promise.resolve(); }
  async connect() {
    const previous = this.tail;
    let unlock;
    this.tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    let released = false;
    return { query: (...args) => this.db.query(...args), release() {
      if (!released) { released = true; unlock(); }
    } };
  }
}
const owner = { wallet: '0x' + '11'.repeat(20), role: 'owner', chainId: 11155111 };
const other = { wallet: '0x' + '22'.repeat(20), role: 'owner', chainId: 11155111 };

test('encrypted draft client composes with production repository, RLS and revision CAS', async t => {
  const db = new PGlite();
  await db.waitReady;
  t.after(() => db.close());
  await migrate(db);
  await migrateAuth(db);
  await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const pool = new EmbeddedPool(db), roles = new Map([[owner.wallet, owner.role], [other.wallet, other.role]]);
  const repository = new ReleaseRepository({ pool, knownRoles: () => roles });
  const id = randomUUID(), wrappingKey = await createReleaseWrappingKey();
  const observed = [];
  const transport = actor => async (path, options) => {
    observed.push(structuredClone({ path, options }));
    if (path === '/api/releases' && options?.method === 'POST') return repository.create(actor, options.body);
    assert.equal(path, `/api/releases/${id}`);
    if (options?.method === 'PUT') return repository.update(actor, id, options.body);
    assert.equal(options, undefined);
    return repository.get(actor, id);
  };
  const request = transport(owner);
  const draft = { name: 'Unpublished title must stay private', rights: 'Private rights draft',
    attachments: [{ filename: 'unpublished-art.png', attachment_key_hex: 'a7'.repeat(32) }] };
  await createEncryptedRelease(draft, { id, wrappingKey, request });
  const oldRecord = await repository.get(owner, id);
  const databaseRows = await db.query('SELECT workspace_ciphertext,workspace_nonce FROM nft_console.releases');
  assert.equal(databaseRows.rows.length, 1);
  assert.deepEqual(Buffer.from(databaseRows.rows[0].workspace_ciphertext), Buffer.from(oldRecord.ciphertext, 'base64'));
  assert.deepEqual(Buffer.from(databaseRows.rows[0].workspace_nonce), Buffer.from(oldRecord.nonce, 'base64'));
  const serialized = JSON.stringify({ observed, databaseRows: databaseRows.rows });
  for (const secret of [draft.name, draft.rights, draft.attachments[0].filename, draft.attachments[0].attachment_key_hex]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(await readEncryptedRelease(id, { wrappingKey, request, minimumRevision: '1' }), { id, revision: '1', draft });

  // Permission is necessary even for ciphertext; possession of the encryption
  // key does not bypass the production repository's account isolation.
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: transport(other) }), e => e.code === 'release_not_found');
  const wrongKey = await createReleaseWrappingKey();
  await assert.rejects(readEncryptedRelease(id, { wrappingKey: wrongKey, request }));

  // Both clients read revision 1. Exactly one encrypted edit may commit.
  const edits = await Promise.allSettled(['first', 'second'].map(name => updateEncryptedRelease({ ...draft, name },
    { id, expectedRevision: '1', wrappingKey, request })));
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(edits.filter(result => result.status === 'rejected' && result.reason.code === 'release_conflict').length, 1);
  const latest = await readEncryptedRelease(id, { wrappingKey, request, minimumRevision: '2' });
  assert.equal(latest.revision, '2');
  assert(['first', 'second'].includes(latest.draft.name));
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, minimumRevision: '2', request: async () => oldRecord }));

  // A copied database envelope cannot be opened with server material alone.
  // A server can still relabel a replay's revision: this guard makes no claim
  // of cryptographic freshness against a fully malicious storage server.
  const corrupted = { ...await repository.get(owner, id) };
  const bytes = Buffer.from(corrupted.ciphertext, 'base64');
  bytes[bytes.length - 1] ^= 1;
  corrupted.ciphertext = bytes.toString('base64');
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: async () => corrupted }));
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: async () => ({ ...corrupted, id: randomUUID() }) }));
  await assert.rejects(readEncryptedRelease(id, { wrappingKey, request: async () => { throw new Error('storage unavailable'); } }), /storage unavailable/);
  assert.equal((await repository.get(owner, id)).revision, '2');
});
