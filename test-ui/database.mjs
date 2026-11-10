import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { migrateAuth } from '../scripts/migrate-auth.mjs';
import { GuardedDatabasePool, databaseOptions } from '../console/data/pool.mjs';
import { PostgresAuthStore } from '../console/auth/postgres.mjs';
import { AuthError } from '../console/auth/core.mjs';
import { ORIGIN } from './fixtures.mjs';

// Dedicated CI/local test database only. Never initialize a provider project,
// use a migration-owner credential for HTTP requests, or fall back to memory.
export async function setupBrowserDatabase(roles) {
  const value = process.env.TEST_DATABASE_URL_UNPOOLED;
  if (process.env.NFT_UI_FIXTURE !== '1' || process.env.NFT_TEST_DISPOSABLE_DATABASE !== 'yes' || !value) {
    throw new Error('Browser acceptance requires an explicitly disposable PostgreSQL database.');
  }
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/nft_console_ci') {
    throw new Error('Browser acceptance refuses non-loopback or non-fixture databases.');
  }
  const admin = new pg.Client(databaseOptions(value));
  const password = randomBytes(32).toString('hex');
  await admin.connect();
  try {
    if (Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) < (process.env.NFT_TEST_ALLOW_POSTGRES_16 === 'yes' && !process.env.CI ? 160000 : 180000)) {
      throw new Error('Browser acceptance requires PostgreSQL 18.');
    }
    const existing = await admin.query("SELECT to_regnamespace('nft_console') AS existing");
    if (existing.rows[0].existing) throw new Error('Browser acceptance requires a fresh disposable database.');
    await migrate(admin); await migrateAuth(admin);
    await admin.query(`CREATE ROLE nft_console_browser_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT nft_console_api,nft_console_auth_service,nft_console_identity
      TO nft_console_browser_runtime WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
  } finally { await admin.end(); }
  url.username = 'nft_console_browser_runtime'; url.password = password;
  const raw = new pg.Pool(databaseOptions(url.toString()));
  raw.on('error', () => console.error('Disposable browser database connection failed.'));
  const pool = new GuardedDatabasePool(raw);
  // Test parallelism must not exhaust production-sized per-IP quotas. Only
  // this fixture raises its limit, bounded by the real store's maximum.
  class BrowserStore extends PostgresAuthStore {
    async limitRequest(key, maximum, interval) {
      return super.limitRequest(key, Math.min(maximum * 100, 10000), interval);
    }
  }
  const store = new BrowserStore({ pool, origin: ORIGIN, chainId: 31337, roles,
    errorFactory: (status, code) => new AuthError(status, code) });
  try { await store.sweep(); }
  catch (error) { await raw.end(); throw error; }
  return { store, runtimeUrl: url.toString(), close: () => raw.end() };
}
