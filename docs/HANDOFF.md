# NFT Console - Handoff

State as of 2026-11-16. Owner guide: `docs/OWNER_QUICKSTART.md` (PDF: `docs/OWNER_QUICKSTART.pdf`).
Plan and package status: `docs/DEVELOPMENT_PLAN.md`, `registry/prs.json`, `repo-development-progress.md`.
Agent rules: `AGENTS.md`.

## Architecture

| Layer | What | Where |
| --- | --- | --- |
| Contracts | `NFTCollection` (immutable economics, ERC-2981 royalty, Limit Break v5 transfer validator hooks) and `NFTCollectionFactory` v2 (CREATE2 per requester + release ID; no owner/minter/signing role) | `contracts/`, Hardhat + solc 0.8.24 |
| Browser app | React/Vite UI: collections, release creation, private workspace, deploy & mint, transactions, marketplace (Seaport 1.6/OpenSea), readiness, settings, tutorials | `console/ui/src`, built to `console/dist` |
| Wallet signing | All deployments, mints, policy changes and listings are signed in the user's wallet (EOA or Safe 1.4.1). The server never holds keys | `console/public/app.js`, `console/ui/src/*-wallet.ts` |
| Server | Express runtime: wallet signature sign-in, RBAC, setup-code administrator enrollment, release/journal APIs, cost quotes, publication workbench (Pinata), marketplace verification, status/telemetry | `console/runtime.mjs`, `console/server.mjs`, `console/*/` |
| Private workspace | Client-side E2EE: Argon2id vault, Ed25519 account root, MLS device keys, sealed drafts, resumable AES-GCM chunks. Server stores ciphertext only (PostgreSQL by default, optional S3) | `console/crypto/`, `console/workspace/` |
| Database | PostgreSQL with row-level security; restricted runtime login; checksum-ledger migrations | `db/migrations`, `db/auth-migrations` (001-010) |

## Operations

| Item | Value |
| --- | --- |
| Hosting | Render web service `srv-dbsvpavf3r2c73bha9mg`, free plan, auto-deploys `main` |
| URL | https://nft-minting-console.onrender.com (`/api/status`, `/api/health`) |
| Database | Neon project `silent-resonance-77956314`, branch `main` (`br-rough-poetry-bccqytug`), db `neondb` |
| Network | Ethereum Sepolia (`CHAIN_ID=11155111`) |
| CI | GitHub Actions on every PR (`contract-ci.yml` and others); `npm run ci` locally |
| Migrations | From a separate operations shell only: `DATABASE_URL_UNPOOLED=... npm run db:migrate:auth` (the app refuses migration credentials). Migration 010 is applied only when enabling S3 storage |

Current runtime mode: **degraded / chain not configured** until the owner sets `RPC_URL`. The database and
restricted login are verified; sign-in, deployment and minting return `503 chain_not_configured`.
Free Render instances sleep when idle (first request can take ~50 s).

## Environment variables (Render)

Set by the deployer (no action needed): `NODE_VERSION`, `NODE_ENV=production`, `HOST=0.0.0.0`,
`PUBLIC_ORIGIN`, `CHAIN_ID=11155111`, `NFT_PUBLIC_LAUNCH=1`, `NFT_SETUP_ENABLED=1`, `NFT_SETUP_CODE`,
`DATABASE_URL` (restricted runtime login).

Owner inputs:

| Variable | Secret | Purpose |
| --- | --- | --- |
| `RPC_URL` | yes (contains provider key) | HTTPS Sepolia (later mainnet) JSON-RPC; enables every chain feature |
| `DEPLOYMENT_FACTORY_ADDRESS` | no | Factory deployed by the owner's wallet (`npm run rehearse:sepolia -- --sign-factory`) |
| `PINATA_JWT` | yes | Public IPFS publication |
| `OPENSEA_API_KEY` | yes | OpenSea listing submission/verification (mainnet) |
| `NFT_MAINNET_ACK` | no | `ethereum-mainnet-real-fees`, only with `CHAIN_ID=1` |
| `PRIVATE_STORAGE_DRIVER/ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY` (+ optional `PREFIX`, `SSE`) | key + secret | Encrypted workspace chunks in an S3-compatible bucket (`docs/PRIVATE_OBJECT_STORAGE.md`) |
| Optional: `TRANSFER_VALIDATOR_ADDRESS`, `OPENSEA_SIGNED_ZONE`, `SEAPORT_ADDRESS`, `SEAPORT_CONDUIT_KEY`, `MARKETPLACE_FEE_RECIPIENT`, `MARKETPLACE_FEE_BPS` | no | Override chain defaults from `config/chains.json` |

GitHub repository secret (optional): `NEON_API_KEY` for the weekly backup workflow.
Never commit secrets; `.env*` is git-ignored.

## Backups

- Neon point-in-time history (6 h) plus dated backup branches via `scripts/neon-backup.mjs`.
- Drill on 2026-11-16: `backup-2026-11-16-0058-drill` (`br-misty-hat-bce9ewq5`) created from `main`,
  verified ready, schema identical to production (38 tables). Destructive restore not exercised on production.
- Weekly workflow `neon-backup.yml` (needs `NEON_API_KEY`), keeps four weekly backups.
- Restore procedure: `node scripts/neon-backup.mjs restore-plan <name>`; details in `docs/BACKUP_AND_ALERTS.md`.

## Alerts

`uptime.yml` checks `/api/status` every 6 hours and opens/updates/closes an `uptime-alert` issue.
Watch the repository to be emailed. Render's own dashboard shows deploy failures and logs.

## Rehearsals

- Local: `npm run mint:rehearse` / `npm run rehearse:sepolia` (factory, two collections, 24 verified mints) - passing.
- Sepolia: `docs/SEPOLIA_REHEARSAL.md` - orchestration ready; **not performed** (owner RPC, test ETH, wallet signatures).
- Disposable mainnet OpenSea rehearsal (NFT-33): **not performed**; needs owner funds and go/no-go.

## What remains (owner-gated only)

1. `RPC_URL` in Render, then administrator registration with `NFT_SETUP_CODE`.
2. Factory deployment signed by the owner's wallet, then `DEPLOYMENT_FACTORY_ADDRESS`.
3. Sepolia rehearsal with the owner's wallet (deploy, mint, list) and receipt evidence (NFT-22 acceptance).
4. Optional provider keys: `PINATA_JWT`, `OPENSEA_API_KEY`, S3 storage credentials, `NEON_API_KEY`.
5. Disposable mainnet rehearsal and mainnet go/no-go (NFT-33), with real funds.
6. Nontechnical acceptance run and screen-reader audit by a person (NFT-36 acceptance).
7. External human security review remains deferred by owner policy (AGENTS.md); no audit or
   certification is claimed.

## Taking over

Read `AGENTS.md`, this file, `repo-development-progress.md` and `registry/prs.json`. Run `npm ci` and
`npm run ci` (Node 22.20; `HARDHAT_SOLC_PATH` for offline solc). Work in PRs to `main`; CI must be green.
