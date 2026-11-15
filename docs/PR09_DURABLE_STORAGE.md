# NFT-09: durable authentication and release permissions

**2026-10-12 / PR #18 / implemented increment, not full milestone acceptance.**
Read this after the original PR09_AUTH_STATUS.md, which records the earlier
memory-only increment. The 36-work-package plan and production gates remain.

## Implemented

The PostgreSQL authentication store preserves sessions across app restarts and
coordinates one-use challenges, rate limits and capacity across instances. Each
operation uses one checked-out connection, a transaction-local service role,
database time and a per-realm row lock. A session touch never resurrects a revoked
or expired record. Raw bearer cookies are not persisted. Contract verification
proofs are retained only for current-policy revalidation, not logged.

Realm identity binds the exact origin and chain. A deterministic wallet-role
policy digest rejects inconsistent instance configuration. Policy changes require
an operator preview and the exact previously inspected digest; applying a changed
policy atomically revokes existing sessions/challenges. Unchanged policy does not
unexpectedly sign everyone out.

Release accounts are bound from authenticated wallet/chain identity, never JSON
owner fields. The release API supports create, read, paginated inventory,
revision-checked saves, viewer/editor grants, revocation and permission history.
Same-write retries are idempotent; stale competing writes fail. Access remains
revocable after a target wallet is removed from the console allowlist. Revoking
an unknown target is an authorized no-op, not creation of another account.

PostgreSQL row-level security enforces release and chain separation. The ACL
function uses a narrow read-only definer role without BYPASSRLS or application
membership. Editors cannot grant access, publish, rewrite ownership, or create
chain/royalty evidence. Database triggers record grant/revoke events atomically;
audit rows are append-only. Existing immutable token/rights constraints remain.

The application checks its restricted database login and exact non-inherited
memberships on every connection lease, refusing migration-owner credentials,
extra roles, schema ownership and direct schema access. Remote TLS verifies the
server certificate and enables channel binding when supported. URL SSL options
cannot override that policy. Configured database failure never falls back to an
in-memory session store. Startup awaits storage readiness and shutdown drains it.

## Scope of the API

Authenticated endpoints are `/api/releases`, `/api/releases/:releaseId`,
`/api/releases/:releaseId/permissions/:wallet`, and the owner-only
`/api/releases/:releaseId/permission-events`. Mutations retain origin and CSRF
protection. Draft requests contain only bounded canonical-base64 ciphertext and
nonce fields, plus UUID or expected revision. Unknown fields and plaintext
name/rights inputs are rejected.

**Opaque bytes are not proof of encryption.** This API does not implement client
E2EE, recovery or a key-sharing design. The current UI does not send plaintext
form fields to it. `privateDrafts`, public publication, minting and listing remain
disabled pending their implementation and acceptance. `NODE_ENV=production`
still refuses startup. Do not run development mode as a production workaround.

## Operations

Apply the unchanged baseline and new authorization migrations in a separate
operations environment using a direct `DATABASE_URL_UNPOOLED` from the secret
manager:

```sh
npm run db:migrate:auth
```

A separate checksum ledger rejects modified, missing and out-of-order applied
migration history. Migrations are never automatically executed by the API.
Temporary SET membership needed for Neon function-ownership transfer is revoked
when the migration introduced it; existing operator grants are not removed.

Provision the dedicated application login through the database administrator:

```sql
CREATE ROLE nft_console_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT nft_console_api, nft_console_auth_service, nft_console_identity
  TO nft_console_runtime WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

Set the password in the provider's secure role-management flow, never in GitHub
or chat. `npm run db:provision-runtime` performs exactly these statements from an
operations environment holding both `DATABASE_URL_UNPOOLED` (migration owner)
and the app's `DATABASE_URL` (runtime login, whose password it applies); it
refuses a non-restricted existing login or unexpected memberships. Give the app only this restricted connection as `DATABASE_URL`. Do not
provide the migration credential, ACL-reader membership, schema ownership or
additional grants. The app rejects `DATABASE_URL_UNPOOLED` in its environment.

For changed allowlists, preview with `npm run auth:policy` in the operations
environment, then explicitly apply the inspected digest:

```sh
npm run auth:policy -- --apply --expected-policy=<inspected-current-digest>
```

Start instances with the matching new configuration; stale instances fail
closed. This changes application authorization only, not NFT ownership or keys.

## Executed evidence and remaining acceptance

The current dependency-free suite passed **86 tests, zero failures or skips**
on Node 22.16.0. It uses explicit pool/HTTP models and proves control flow and
negative cases, not actual pg-driver, Express, wallet or browser integration.
Syntax checks passed for all new JavaScript modules and tests.

The live Neon PostgreSQL 18 role/RLS suite passed **20 assertions**, then passed
again after review, on isolated branch `br-cool-queen-b400hn78` in project
`dark-math-52213387`. Its synthetic account/release/grant fixtures roll back.
The production parent `br-late-forest-b4z0hjsa` was not changed. This live test
exercised the SQL role/policy layer via the connector, not the JavaScript driver
or checksum migration runner. See `evidence/pr09b-results.json` for claim limits.

The new `durable-postgres.test.mjs` applies both migration ledgers to a fresh
PGlite PostgreSQL engine and exercises actual store/repository SQL, replay,
restart persistence, quotas, isolation, edits, audit and revocation. It is wired
into the existing mandatory `npm run test:auth` glob. It was **not executed
locally** because the locked external dependencies could not be installed.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm run test:integration
```

An optional native multi-connection pg-driver run requires an EMPTY isolated
`TEST_DATABASE_URL_UNPOOLED` and `NFT_TEST_DISPOSABLE_DATABASE=yes`, then
`npm run test:auth:postgres`. Missing configuration fails rather than skipping.
Never point that test at production or an existing application database.

Full exact-head CI, native-driver/HTTP coverage, actual Safe interaction and
security acceptance still need successful evidence. Prior isolated results are
not a substitute. Mainnet minting, OpenSea order submission, real-sale/royalty
rehearsal and independent cryptographic review remain separate gates.

## Privacy and review limits

Wallet identities and contract login proofs are authorization records, not E2EE
creative drafts. Expired rows are pruned while the application runs; deletion
from active tables does not erase WAL, replicas, backups or provider recovery
history. Backup retention and operational review remain mandatory. Audit records
contain identifiers, permission changes and timestamps, not draft content.

No real artwork, private signing key, mainnet transaction or marketplace order
was used. This implementation and the separate assistant self-review do not
constitute independent expert certification or an accepted production release.
