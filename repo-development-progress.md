# NFT Console development progress

Source of truth: docs/DEVELOPMENT_PLAN.md, registry/prs.json, exact-head PR checks and deployment evidence. A merged contribution is not automatic completion of its entire roadmap work package.

## Current state - 2026-11-16

Merged today (all with green local tests and GitHub Actions):

- **#70 NFT-12** optional S3-compatible store for the client-encrypted workspace chunks (`PRIVATE_STORAGE_DRIVER=s3`, SigV4, no SDK). PostgreSQL stays the default; additive migration 010 is needed only before enabling S3. Hash-in-key writes, hash-checked reads, explicit deletion, 30-day retention purge of bucket objects. Tested against a signature-verifying in-process S3 fake; a 0.99 GiB (127 x 8 MiB) ciphertext upload grew server RSS by ~37 MiB (added with the status refresh). Not run against a real provider.
- **#71 NFT-32** `scripts/neon-backup.mjs` (snapshot/list/verify/schema-check/restore-plan/label-scoped prune), weekly `neon-backup.yml` (needs `NEON_API_KEY` secret) and 6-hourly `uptime.yml` that opens/updates/closes an `uptime-alert` issue. Drill run once: backup branch `backup-2026-11-16-0058-drill` (`br-misty-hat-bce9ewq5`) from `main` at LSN 0/1DB4B48, ready, schema identical to production (38 tables). No destructive restore on production.
- **#72 NFT-22** `npm run rehearse:sepolia`: full local Hardhat rehearsal, read-only Sepolia preflight when `RPC_URL` is set, factory deployment only through a loopback page signed by the owner's browser wallet, receipt recorder. Refuses to run with any private key or mnemonic in its environment.
- **#73 NFT-36** `docs/OWNER_QUICKSTART.md` + `docs/OWNER_QUICKSTART.pdf` and `docs/HANDOFF.md`.
- Registry, README and this file refreshed (status PR).

Package status (honest): NFT-12 implementation complete, acceptance pending a real provider bucket (optional owner credentials). NFT-22 implementation complete, acceptance pending the owner's Sepolia run (RPC_URL, test ETH, wallet signatures). NFT-32 implementation complete, acceptance pending owner keys (`RPC_URL`, `PINATA_JWT`, `NEON_API_KEY` for scheduled backups) and live provider checks. NFT-33 not started: needs owner funds and a go/no-go. NFT-35 partial: Engine Room push needs an external account. NFT-36 implementation complete, acceptance pending a human nontechnical and screen-reader run.

Remaining work is owner-gated only; see `docs/HANDOFF.md`. External human review remains deferred and no certification is claimed.

## State - 2026-11-15

The repository now lives at Galinsky-Arts/NFT-Minting-Console. Merged today:

- **#64** production dependency audit fixed (multer 2.5.0, body-parser 1.20.9, follow-redirects 1.16.3, qs 6.16.2) and registry/image identity moved to Galinsky-Arts (`ghcr.io/galinsky-arts/nft-minting-console`).
- **#63** consolidated completion: Seaport 1.6 / OpenSea listing core with independent verification, Limit Break v5 transfer-policy workflow (ruleset 255 / options 6), client-encrypted private workspace (Argon2id, Ed25519 root, MLS device keys, recovery, resumable encrypted storage) and Safe 1.4.1 support for policy and listing actions. Its CI was fixed (Safe suite now compiles the console contracts first). Chosen over the overlapping **#62**, which was closed; #62's unique pieces were ported in #67. **#59** (NFT-10) was closed as superseded and **#19** (CircleCI) as obsolete.
- **#58** NFT-14 minimal public collector-receipt boundary.
- **#66** registry/progress refresh; **#67** live collection inventory and offline solc hook ported from #62.
- **#65** degraded *chain not configured* runtime mode when `RPC_URL` is unset, plus `npm run db:provision-runtime` for the restricted login.

Deployment: Render `srv-dbsvpavf3r2c73bha9mg` at https://nft-minting-console.onrender.com on Neon project `silent-resonance-77956314` (Sepolia, migrations 001-009, restricted runtime login). It runs degraded until the owner supplies `RPC_URL`; see `docs/DEPLOYMENT_RENDER_NEON_20261115.md`.

Remaining owner inputs: `RPC_URL`, `PINATA_JWT`, `OPENSEA_API_KEY` (mainnet only), wallet signatures for any deployment/mint/listing, and the administrator registration with `NFT_SETUP_CODE`. Remaining engineering: large-object encrypted storage outside PostgreSQL, alerts/backups, Sepolia and disposable-mainnet rehearsals, telemetry (NFT-35) and final UX/accessibility handoff (NFT-36). External human review remains deferred and no certification is claimed.

## Earlier browser completion work - 2026-10-16

PR #52 implemented guided tutorials and explicit browser-local public presets. PR #53 implemented pre-mint total-cost review, with genuine sequential simulation tested on a pinned private Geth chain. Both are merged. Production baseline and authorization migrations001-005 were applied and verified; this does not prove the app uses that database.

PR #54 implemented secure browser administrator enrollment using a hosting setup code plus a domain/chain/purpose-bound EOA wallet proof. Claims are durable and single-winner; rotation or network changes do not reopen setup. It merged as `0df2da39642eab5c88517ed70cb309aa33e65cbc`, with112 browser checks passing, and was deployed to the existing NFT Console service. Production migration006 was checksum-verified and applied. No user administrator was invented or registered by a developer fixture.

PR #55 integrates public browser artwork/rights/media publication, exact original hashes, durable work/attempt history, short-lived public upload permissions without exposing the Pinata JWT, independent public readback, metadata generation and direct total-cost/mint handoff. Additive migration007 is required before enabling the feature. Required exact-head checks and deployment are recorded in the PR; do not assume a draft implementation has passed.

Review found and corrected an incomplete IPFS type declaration, configuration-model expectations, a recovery-refresh selection race, missing selected-history options and a regression in the synthetic mint fixture. Existing strict signed-fixture checks and manifest issuance were restored instead of deleting their tests. Saved public responses are now independently schema/identity/descriptor/hash checked by the client. Mobile pointer/layout acceptance remains required, including continued user pinch zoom.

## Next execution order (2026-10-16, historical)

Finish and verify PR55, reconcile the current guides/runbooks, apply only the new checksum-bound migration007, then deploy the exact accepted commit. Do not rerun first-time production initialization or edit historical migration bytes. Complete actual runtime/secret wiring only through authorized tools or the owner's provider interface; do not bypass a denied environment action. Verify the live setup/configuration status and provider capabilities without exposing credentials.

The broad plan still includes unfinished private E2EE drafting and key recovery/sharing, large resumable encrypted storage, Safe/delegated transaction flows, automated validator-policy provisioning, and complete marketplace signing/submission/listing verification. The public browser increment does not complete those packages. Do not remove development labeling merely because a public subset deploys, an environment flag changes, or a tutorial is marked read.

## Evidence and limits

Use docs/BROWSER_COMPLETION_PLAN.md, docs/BROWSER_INSTALLATION.md, docs/BROWSER_PUBLICATION.md, docs/PRE_MINT_COST_REVIEW.md and docs/PRODUCTION_DATABASE_20261016.md for the current implementation boundaries. Historical journal, rights and UI acceptance documents remain useful only for their dated scopes. No user funds, real private artwork or wallet signing keys are test inputs. A mint is not a listing, a URL is not an active order, and implementing-agent review is not an independent audit or certification. The owner's external-review deferral in AGENTS.md remains in force.
