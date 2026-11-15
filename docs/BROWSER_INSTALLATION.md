# Browser-first administrator registration

The installation owner registers the first administrator directly in the web interface. No wallet address needs to be sent in chat, and no private wallet key is collected. This is first-run authorization, not a mint, a listing, or proof that the complete product roadmap has shipped.

## Before enabling a new installation

Use the existing intended Neon database and its restricted application login. Apply the normal forward migration runner in a separate operator environment, including `006_browser_installation.sql`; never rerun first-time initialization over existing tables or place a migration-owner password in the application. The runtime account retains only the three original non-inherited application roles. The new tables add no schema ownership or RLS bypass.

Set the backend environment (not the repository or a preset):

- `NFT_SETUP_ENABLED=1`, `NODE_ENV=production`, and an exact HTTPS `PUBLIC_ORIGIN`.
- Restricted `DATABASE_URL`, a matching HTTPS `RPC_URL`, explicit `CHAIN_ID`, and `HOST=0.0.0.0` for the hosted service.
- `NFT_PUBLIC_LAUNCH=1` for the public-mint runtime; chain 1 additionally requires `NFT_MAINNET_ACK=ethereum-mainnet-real-fees`.
- A cryptographically random 32-byte hex value in `NFT_SETUP_CODE`. An operator can generate it with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"`, then enter it directly into the hosting secret environment. Never commit it, put it in a URL, or substitute an API credential or wallet seed.

Leave `ADMIN_WALLETS`, `EDITOR_WALLETS` and `VIEWER_WALLETS` unset/empty for this browser-enrollment mode. Existing explicitly allowlisted installations continue using the original mode with `NFT_SETUP_ENABLED` absent. Mixing the two is refused rather than silently changing an existing policy. Only direct EOA enrollment is implemented in this first-mint scope; existing Safe sign-in support remains separate.

## In the interface

The first-run screen displays the exact site, network and verified restricted-database connection. The owner obtains `NFT_SETUP_CODE` from the existing Render service's Environment settings, enters it into the password field, and connects the selected wallet. Preparing registration produces a preview of the exact origin/wallet/network/purpose/nonce/time-bound message. The owner checks its meaning, explicitly approves administrator registration, and signs that message in the wallet. This is not an on-chain transaction and does not authorize asset transfers.

The successful claim is stored durably. Reload and sign in with the same wallet using the ordinary sign-in flow. Collection owner, minter and royalty recipient are separate collection parameters, not secret setup inputs. Different accounts must also be authorized before acting through the console; this initial enrollment does not silently grant every collection-address field console access.

The setup code and wallet signature stay out of browser storage, URLs and logs. The setup cookie is short-lived, HttpOnly, same-site and HTTPS-secure in deployment. After a claim, registration is closed on all instances; changing the code cannot replace the recorded administrator. Network changes on a claimed origin fail closed rather than reopening registration. The old setup code may be removed after successful enrollment. Losing an administrator is not automatically resolved by giving a stranger the site: database-admin recovery requires a separately reviewed operator process.

## Implementation and acceptance

The runtime uses the current restricted-pool guard and database migrations, not an in-memory ownership flag. Unique insert semantics give concurrent claims one winner. Challenges use database time, are five-minute, cookie-bound and one-use, and include a hash of the current setup code. Invalid signatures consume their challenge. Challenge counts are bounded per installation across instances; authenticated setup attempts have an additional bounded process-local limit. Raw provider errors are not returned.

The tests cover actual PostgreSQL-engine SQL through PGlite, real EOA signatures, wrong origin/code/network/binding/signature, expiry/replay, concurrent claims, code rotation, immutable administrator grants and restart. The browser suite starts two independent runtime instances on the disposable restricted PostgreSQL fixture and runs the complete registration-to-normal-sign-in flow on desktop and mobile. Final exact-head GitHub and native-runtime results are recorded in the PR review, not presumed by this document.

Development labeling remains while full private drafting, public publication integration, marketplace operations and the complete roadmap are unfinished. `NODE_ENV=production`, an initialized database, and a successful administrator claim are not full-product acceptance or security certification.

## Limited mode before `RPC_URL` is configured

If `NFT_SETUP_ENABLED=1` and `RPC_URL` is unset or blank, the runtime starts in a clearly degraded **chain not configured** mode instead of exiting. It still verifies the restricted database (startup fails closed if it cannot), applies the normal security headers and serves the interface, which shows a "Blockchain connection not configured" page. `/api/health` returns `{"ok":true,"degraded":true,"chainConfigured":false,...}` and `/api/setup/status` carries `chainConfigured:false`. Every other API route, including administrator registration and sign-in, returns `503 chain_not_configured`, because proof-of-control enrollment requires the RPC network and code checks. A present but malformed or non-HTTPS `RPC_URL` is still a startup error. Setting a valid HTTPS `RPC_URL` and restarting the service opens normal first-run registration.

## Status endpoint and local telemetry (NFT-35)

`GET /api/status` is a public, non-secret, source-backed report: mode (`degraded`, `setup` or `active`), deployed commit (from `RENDER_GIT_COMMIT` when the host provides it), network, whether RPC/Pinata/OpenSea are configured (booleans only), database verification, whether administrator setup is pending, `blockedActions` naming each missing environment variable and what it unlocks, and bounded in-process metrics (requests per API group, status classes, latency buckets, server-error count, uptime). Server errors are additionally logged as one structured JSON line (`http.server_error`) without paths, identifiers, query strings, bodies or addresses. Token/listing counts, CI state and external review are listed under `notMeasured` rather than guessed. Metrics reset on restart; no external telemetry account is used.

The limited-mode page (NFT-36) lists the exact steps to add `RPC_URL` (provider endpoint, Render Environment, key name with a copy button, restart, then `NFT_SETUP_CODE` registration), moves focus to its heading, is keyboard operable and is checked with axe on desktop and mobile.
