# Render + Neon deployment - 2026-11-15

Owner-authorized deployment inside the Galinsky-Arts accounts only. No other Render service or Neon project was changed. The older `dark-math-52213387` reference in `PRODUCTION_DATABASE_20261016.md` belongs to the previous account and is not used.

## Resources

| Item | Value |
| --- | --- |
| Neon project | `silent-resonance-77956314` (`nft-minting-console`, PostgreSQL 17, aws-us-east-1, org `org-red-surf-69664431`) |
| Neon branch / database | `br-rough-poetry-bccqytug` / `neondb` (direct, non-pooler endpoint) |
| Render service | `srv-dbsvpavf3r2c73bha9mg` (`nft-minting-console`, free plan, virginia, node runtime) |
| URL | https://nft-minting-console.onrender.com |
| Source | `main` of this repository, auto-deploy on commit |
| Build | `npm ci --include=dev --no-audit --no-fund && npm run compile && npm run build:ui` |
| Start / health | `node console/runtime.mjs` / `/api/health` |
| Network | Ethereum Sepolia (`CHAIN_ID=11155111`) |

## Database initialization

Baseline `001_release_model.sql` and authorization migrations `001`-`009` were applied once by the checksum-ledger runner (`npm run db:migrate:auth`) with the Neon migration owner. The restricted login `nft_console_runtime` was then created by `npm run db:provision-runtime` (LOGIN NOINHERIT, no superuser/createdb/createrole/replication/bypassrls; only `nft_console_api`, `nft_console_auth_service`, `nft_console_identity` with ADMIN FALSE, INHERIT FALSE, SET TRUE). The application's `DATABASE_URL` uses only that login, and every pooled connection re-verifies the identity.

The operator sandbox could not reach Neon's PostgreSQL hosts, so the one-time migration ran in the first Render build with the owner URL in a temporary bootstrap variable (the runtime still refuses `DATABASE_URL_UNPOOLED`). Immediately afterwards the bootstrap variable and migration steps were removed from the service, the `neondb_owner` password was reset through the Neon API (invalidating the copy that had been in Render) and the service was redeployed. Future migrations must run from a separate operations environment with a freshly issued owner credential.

## Environment variables

Set (values only in Render, never in git): `NODE_VERSION`, `NODE_ENV=production`, `HOST=0.0.0.0`, `PUBLIC_ORIGIN`, `CHAIN_ID=11155111`, `NFT_PUBLIC_LAUNCH=1`, `NFT_SETUP_ENABLED=1`, generated `NFT_SETUP_CODE` (64 hex characters) and generated-password `DATABASE_URL`.

Owner-supplied, intentionally unset: `RPC_URL` (HTTPS Sepolia JSON-RPC endpoint; required for administrator registration, sign-in and every chain feature), `PINATA_JWT` (public IPFS publication), `OPENSEA_API_KEY` (marketplace submission/verification; OpenSea does not index Sepolia) and `NFT_MAINNET_ACK` (only together with `CHAIN_ID=1` after reviewing real-fee responsibility).

## Current state and next steps

Without `RPC_URL` the runtime starts in the documented degraded *chain not configured* mode (see `BROWSER_INSTALLATION.md`): the restricted database is verified, `/api/health` reports `degraded:true`, and registration, sign-in, minting and marketplace routes return `503 chain_not_configured`. After the owner adds `RPC_URL` in Render (Environment), the service restarts; the owner then opens the site, enters the `NFT_SETUP_CODE` value from the same settings page and registers the administrator wallet by signature. No transaction was sent and no administrator was registered by the deploying agent.

Still pending for NFT-32 acceptance: alerts, backup/restore drill, external object storage for large encrypted drafts (Neon free storage is small), provider credentials and a live Sepolia rehearsal. Free Render instances sleep when idle and have no persistent disk; all durable state is in Neon.
