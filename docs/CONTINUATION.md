# NFT Console — continuation record (2026-11-10)

Branch `feat/complete-console`. Supersedes the 36-PR sequence per owner instruction.

## Implemented and tested in this branch
- **Marketplace (Seaport 1.6 / OpenSea):** `console/market/*`, `console/ui/src/Marketplace.tsx`. Inspect token (owner, conduit approval, transfer-policy simulation, ERC-2981 royalty, marketplace-required fees) → conduit approval tx → exact order review → EIP-712 wallet signature (re-checked client- and server-side) → submit → independent verification (Seaport order hash/status/counter, ownership, approval, signature, time window, policy) + marketplace lookup. `listed` requires both. Uncertain submissions reconcile by order hash (identical signed order only). Sale evidence from `OrderFulfilled` logs incl. royalty actually paid; cancel via on-chain `cancel`; price change = replacement order.
- **Transfer policy:** `console/market/policy.mjs`, Collections page. Plans OWNER txs (setTransferValidator, createList, whitelist conduit, applyList, ruleset 255/options 6), re-plans from chain after each receipt, fail-closed readback + behavioural simulation. Validator never gets holder approval.
- **Private E2EE workspace:** `console/crypto/private-workspace.mjs`, `console/private/*`, `PrivateStudio.tsx`. Device ECDH P-256 keys (non-extractable, IndexedDB), ECIES-style WK wraps, recovery code, fingerprint-confirmed device approval, revocation with key rotation + record re-seal + new recovery code, AAD-bound records with rollback detection, resumable encrypted chunked uploads (E2EESA attachment profile + verified `resumeAttachment`), encrypted backup export. Server stores ciphertext only.
- **Release editor + validation** (`release-validation.ts`), rights approval bound to exact bytes, reusable encrypted configurations, publication handoff (decrypt selected works locally → existing publication workbench; nothing published without consent).
- **Collections inventory** (`GET /api/collections/:address`), dashboard, help page.
- **Migration** `db/auth-migrations/008_market_policy_private_workspace.sql` (forward-only, RLS, immutability guards).

## Test results (local, this branch)
- Hardhat contract tests 71 passing; real Seaport + pinned validator integration (`npm run test:market`) 6 passing.
- Node: auth 283, crypto 28 (incl. 8 E2EE workspace scenarios on embedded Postgres), publication 23, data 8, ui-model 125, marketplace transport 23, rights 13, registry 4 — all passing.
- Playwright desktop+mobile: 126 passing (incl. new marketplace/policy and private-workspace flows, axe checks, no horizontal overflow).
- lint, typecheck, `npm audit --omit=dev --audit-level=high`: clean.
- Local environment notes: solc fetched from GitHub releases via `HARDHAT_SOLC_PATH`; Postgres 16 with `NFT_TEST_ALLOW_POSTGRES_16=yes` (CI keeps 18).

## Not verified / blocked (external)
- **No live OpenSea verification:** no `OPENSEA_API_KEY`. OpenSea adapter (`marketplaces.mjs`) response shapes are unverified against the live API. Browser tests use a clearly labeled synthetic order book over real Seaport.
- **No Sepolia/mainnet evidence:** no RPC key, no wallet. Mainnet validator code hash not pinned (read and displayed at runtime).
- **Hosting:** the authorized Render workspace has no services and the Neon org has no projects (previous deployment lived in another account). Deployment needs `RPC_URL`, `PINATA_JWT`, `OPENSEA_API_KEY`, `NFT_SETUP_CODE` in Render secrets; then create Neon project, apply migrations 001–008 with a migration credential, create restricted runtime role, create Render web service from this repo (Dockerfile).
- Safe multi-sig for marketplace/policy actions: EOA path implemented; Safe signing exists for login only.
- Independent human security review: pending (owner-deferred); this is AI self-review only.

## Next concrete action
Provide the provider secrets, then deploy (Neon project → migrations → Render service), run a Sepolia rehearsal: deploy, policy, mint, list on OpenSea testnets, verify.
