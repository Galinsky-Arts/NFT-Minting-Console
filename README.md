# NFT Console

A general-purpose workspace for independent NFT collections, using this project's custom ERC-721C-compatible collection family. Not an Androids Of The Vine-only product.

> **Status (2026-11-16): engineering complete for everything that does not need the owner; live operation awaits owner credentials and wallet signatures.**
> Browser administrator enrollment, public publication with exact readback, cost review, wallet deployment/minting and recovery, the client-encrypted private workspace (devices, recovery, resumable encrypted files, optional S3-compatible ciphertext storage), transfer-policy provisioning and Seaport/OpenSea listing with independent verification (EOA and Safe) are implemented and pass CI. Operations: dated Neon backup branches with a schema-verified restore drill, weekly backup and 6-hourly uptime-alert workflows, and `npm run rehearse:sepolia` (local rehearsal plus read-only Sepolia preflight; transactions only through the owner's wallet). The hosted Sepolia instance at https://nft-minting-console.onrender.com runs in a degraded *chain not configured* mode until `RPC_URL` is set. Start with the [Owner Quick Start](docs/OWNER_QUICKSTART.md) ([PDF](docs/OWNER_QUICKSTART.pdf)) and the [handoff summary](docs/HANDOFF.md). Still owner-gated: `RPC_URL`, administrator registration, wallet-signed factory deployment and Sepolia rehearsal, optional provider keys, the disposable mainnet rehearsal and a human nontechnical/screen-reader acceptance run. No user mint, active listing, live marketplace sale or security certification is claimed; external review is deferred.

## First-run administrator registration

The [browser-first installation flow](docs/BROWSER_INSTALLATION.md) lets the installation owner enter a hosting setup code, connect a wallet and review a purpose-bound message to register the first administrator directly in the interface. No wallet address needs to be sent in chat. Ownership is durable and single-winner, and rotating the setup code does not reopen the installation. Existing environment-allowlisted installations remain supported; do not combine the two modes.

The [owner checklist](docs/MINT_INPUT_CHECKLIST.md) documents exact hosting variables and provider links. Apply all forward database migrations and use the restricted runtime login, never a migration-owner credential. The [browser completion plan](docs/BROWSER_COMPLETION_PLAN.md) separates implementation, accepted release scope, deployment and actual NFT evidence.

## Public upload-to-mint workflow

In **Deploy & mint**, the [public browser workbench](docs/BROWSER_PUBLICATION.md) lets the owner select final artwork or a poster, complete rights and optional audio/video, inspect local previews and approve saving immutable public commitments. Selection alone never uploads. Each Publish and verify action uses a short-lived, MIME/size/public-scoped Pinata permission; the account JWT stays on the backend. Independent gateway readback checks the exact original SHA-256 and length. A returned CID is not proof of verified bytes.

Saved public work history survives reload and restart. An uncertain upload can be recovered by its existing CID without uploading again. Generate canonical metadata from verified files, review it, publish/verify it, and send the result directly to total-cost and mint review. Repeat for additional works. No CLI or JSON download/import step is required for this public path; existing CLI bundles remain supported.

The [total-cost panel](docs/PRE_MINT_COST_REVIEW.md) starts a read-only full-release simulation automatically once exact public readback is approved. It covers a new deployment plus all supplied mint batches, or only remaining mints for an existing collection. It separates simulated network-fee estimates, the gas-margin budget and wallet funding shortfalls. Quotes expire and changed inputs invalidate them. Unknown provider subscriptions, approvals and marketplace charges are excluded rather than represented as zero. The required sequential simulation must be supported by the configured RPC; an unavailable quote is not a zero price or permission to sign.

Preparing each immutable deployment/mint plan now automatically runs the independent wallet-RPC simulation and fee review, in addition to server-side verification. Deployment and minting still require a separate explicit fee approval and wallet signature. The server does not hold signing keys or broadcast user transactions. Receipt verification and durable recovery remain mandatory. Additional NFTs in the same collection use its verified existing contract, not another deployment. See the [automatic rehearsal guide](docs/AUTOMATIC_MINT_REHEARSAL.md) for the exact-snapshot, safety, and provider-support limits.

This public workflow is separate from the encrypted private workspace and the Marketplace page; legal approval of rights terms remains the owner's. Limits and acceptance evidence are in the linked documents.

## Help and reusable configurations

**Help & tutorials** is available before sign-in. Twelve searchable guides include Administrator Setup, wallet connection, collection creation, configuration reuse, artwork/rights, AOTV companion materials, publication, deployment, minting, recovery, marketplace handoff and troubleshooting. Back/Next, target highlighting, Close/Escape and local reading-progress resume are included. The guide never performs a signature, upload or paid action. See the [catalog and boundaries](docs/GUIDED_TUTORIALS.md).

**Saved configurations** is available in collection setup and Deploy & mint. Save explicitly named non-confidential constructor settings, load an editable copy, change parameters and generate another independent collection through the interface. JSON import/export provides manual backup and device transfer. These presets are unencrypted, browser-local, wallet/network scoped settings, not cloud sync or private drafts. They cannot contain credentials, artwork, rights files, signatures or transaction approvals.

The separate [local rights workbench](docs/PUBLICATION_PREPARATION.md) hashes exact text/Markdown/PDF bytes and prepares a public metadata preview. It is not itself an uploader, encryption workflow, PDF renderer or legal review. The public publication workbench is a different, explicitly approved flow.

## Androids Of The Vine rights

The optional token-specific Creator's Companion Portfolio identifies exactly two projects and their existing informational/creative materials in each enabled token's final Schedule A. Disabled tokens receive no such portfolio. The [40-by-2 schedule tooling](docs/AOTV_COMPANION_ALLOCATION.md) generates drafts only.

The original rights and metadata are frozen historical references. The [revised Token #1 working agreement and provisional schedule](releases/androids-of-the-vine/token-001/README.md) are not approved final release bytes. Do not reuse a historical rights hash for revised text. The separate future collector-allocation language in Section 5 remains a review issue. A preset or successful test cannot approve offering terms.

## Build and run

Use the pinned **Node 22.20.0 / npm 10.9.3** and committed lockfile:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm start
```

Configure [console/.env.example](console/.env.example) through the backend environment. `RPC_URL` is the complete HTTPS endpoint; `PINATA_JWT` is backend-only. An exact `PUBLIC_ORIGIN`, matching network and restricted durable database are required. Browser enrollment additionally needs `NFT_SETUP_ENABLED=1`, a random `NFT_SETUP_CODE`, and empty environment wallet allowlists. Mainnet public mode requires the explicit real-fee acknowledgment. See the installation runbook before activation.

Migration credentials belong in a separate operations environment. Configured database failure never falls back to memory. Missing UI artifacts return 503. Development mode is not a production workaround. Local/Sepolia legacy rehearsal remains separately gated at `/legacy/`.

## Verification and operating references

```sh
npm run ci
npm run test:ui:model
npx --no-install playwright install --with-deps chromium
npm run test:ui:browser
```

CI exercises real local contracts, a pinned transfer validator, Safe 1.4.1, native PostgreSQL, browser/accessibility workflows and pinned Geth sequential simulation. Publication browser tests use actual multipart bytes with an explicitly synthetic local provider, not genuine Pinata credentials. The cost-response UI fixture and real simulation-engine tests are separately identified. User funds, user signing keys and genuine private artwork are never test fixtures.

Start with the [Product Charter](docs/PRODUCT_CHARTER.md), [36-work-package plan](docs/DEVELOPMENT_PLAN.md), [canonical registry](registry/prs.json) and [current progress](repo-development-progress.md). Additional references: [durable authorization](docs/PR09_DURABLE_STORAGE.md), [native/Safe acceptance](docs/PR09_RUNTIME_ACCEPTANCE.md), [UI acceptance](docs/PR15_UI_ACCEPTANCE.md), [public launch operations](docs/PUBLIC_LAUNCH.md), [exact public readback](docs/PUBLIC_FILE_VERIFICATION.md), [mint journal](docs/MINT_JOURNAL.md), [wallet recovery](docs/MINT_WALLET_UI.md), [factory rehearsal](docs/MINT_RECONCILIATION.md), [Sepolia rehearsal](docs/SEPOLIA_REHEARSAL.md), [backups and alerts](docs/BACKUP_AND_ALERTS.md), [private object storage](docs/PRIVATE_OBJECT_STORAGE.md) and [production database initialization](docs/PRODUCTION_DATABASE_20261016.md). Dated historical acceptance documents do not override current implementation or deployment evidence.

## Security and product invariants

Names, supply, wallet roles, royalties, artwork and rights are independently chosen per collection. Deployed immutable economics and finalized token fields cannot be rewritten by loading a preset. Never restore validator-wide automatic approval or a seizure path. Public IPFS is not private encrypted storage. A mint is not an active order; a URL is not proof of a listing; signing in is not asset-transfer approval.

The [client attachment component](docs/CLIENT_ATTACHMENT_CRYPTO.md) supplies chunked AEAD and hashes; the private workspace (`console/crypto/workspace.mjs`, `console/workspace/`) adds device authorization, MLS key delivery, recovery and ciphertext-only storage. See the [threat model](docs/THREAT_MODEL.md), [privacy inventory](docs/PRIVACY_INVENTORY.md), [applicability/profile](docs/E2EESA_APPLICABILITY.md) and [scoped status](security/e2eesa-status.json).

Under [AGENTS.md](AGENTS.md), independent human/external review is deferred, not a development or deployment prerequisite. Implementing agents perform source/security review and applicable tests, fix real defects and retain source-bound evidence. Failed checks and actual vulnerabilities still block merge. Neither assistant review nor record integrity is independent certification. Run `python3 scripts/validate_e2eesa_status.py` for the status record, not as a substitute for acceptance testing.
