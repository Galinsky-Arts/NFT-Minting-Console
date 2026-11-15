> **Owner instruction, 2026-10-13:** Independent human/external security review is deferred and is not a prerequisite for implementation, merge or deployment. AI source/security review and applicable passing tests are the operational review process. Actual defects and missing functionality still require fixes. External review/certification remain honestly pending. See [AGENTS.md](../AGENTS.md) and [review policy](../security/review-policy.json). This supersedes conflicting older review-gate wording below.

> **Canonical PR work registry:** [`registry/prs.json`](../registry/prs.json). The detailed plan below is retained; agents must update PR counts and mappings in the registry file.

# NFT Console — Complete Development & Handoff Plan

**Status:** Approved *scope proposal* / implementation plan; individual PRs are not marked complete until verified.  
**Repository:** https://github.com/Galinsky-Arts/NFT-Minting-Console  
**Authoritative security specification:** https://github.com/neophilism/End-To-End-Everywhere-Security-Architecture-Standard  
**Plan revision:** 2026-10-10, initial baseline.
**Independent handoff companion files:** [Recovered Decisions & Context](HANDOFF_CONTEXT.md) · [Completeness Audit / Blockers](HANDOFF_STATUS.md) · [Frozen Original Contract and Rights](../reference/androids-of-the-vine/). Read these before PR-01; they preserve design constraints from earlier discussions that were not fully described in the 36-PR list.  
**Product name:** **NFT Console**. Never title the product after an individual NFT collection.

## 1. Product contract: what the finished product does

NFT Console is a professional, approachable web application for creating **any number of independent NFT collections/releases** using the user's preferred, custom ERC-721C-compatible *collection contract family*. A release can contain one work, a numbered limited edition of one work, or many distinct media works (images, videos, audio, and other digital files). Each release has its own name, ticker/symbol, max supply, optional series/edition identifiers, royalty recipient and percentage, owner and minter addresses, rights documents, metadata, prices, network, and durable deployment record. The defaults are reusable and editable; **Androids Of The Vine (40 NFTs, AOTV, 6% royalty, 1 ETH initial listing)** is a historical example/preset only, not the schema.

### Definition of done

A nontechnical authorized user can:
1. Sign into a responsive web UI and open their encrypted releases dashboard.
2. Create/edit a private release, enter collection settings and rights, drag/drop multiple works/previews, and review a media grid and edition assignments.
3. Save the draft locally and/or encrypted in the cloud, resume on another authorized device through a documented recovery/key-sharing flow, and see upload/preparation progress and item-level errors.
4. Click **Validate** for automated media, rights, hashes, supply, account, contract, marketplace-policy and chain safety checks, with plain-language findings and actionable repairs.
5. Choose **Test** (local/Sepolia) or **Deploy** (mainnet), understand gas/cost/chain/irreversibility, sign only the necessary on-chain transactions with their wallet or approved Safe flow, and receive durable receipts.
6. Configure and verify the collection's compatible transfer-validator settings through a gated setup wizard; never grant broad validator operator approval or use the compromised Limit Break Payment Processor.
7. Mint one or more NFTs efficiently with a preview of exact immutable on-chain values and post-mint checks.
8. Create, sign, submit and **independently verify** a live OpenSea listing at the selected price and currency; see its true status and link. A minted NFT must never be reported as listed when no valid order exists.
9. See collection inventory, token IDs, deployed policy, listings, transaction history, royalty checks and precise errors; re-list or mint subsequent works under an existing collection without redeploying.
10. Create an entirely different collection later via the same steps, with no project-specific hard coding or manual code edits.

**Non-goals:** custody of private keys, unapproved autonomous financial transactions, bypass of legal/securities requirements, hiding public NFT content from marketplace buyers, guarantees of marketplace royalty enforcement across all transfer methods, or claims of security-standard certification without evidence.

## 2. Mandatory architecture & invariants

- **One deploy per collection, not per NFT.** Contracts are factory-parameterized by collection name/symbol, maximum supply, owner, minter, royalty recipient/rate and applicable rights/hash model. Mint repeated works against the existing address.
- **Preferred custom contract remains the source of truth.** First compare the current repo's generic `NFTCollection.sol` against the last audited 178-line no-autoapproval variant and preserve its tested security semantics. Any divergences, constructor changes or new batching logic must be reviewed and reaudited; do not call the new contract “audited” by inheritance.
- **Immutable creative/economic layer:** each minted token's media hash, rights hash, rights URI, metadata URI, title and defined edition are write-once; enforce explicit max supply/ID uniqueness; no admin seizure; 6% only when chosen (configurable for other releases). Roles may be smart wallets; test Safe and EIP-7702 paths. Rights and purchaser-benefit language must be per-release and reviewed, not an invisible default.
- **Trusted OWNER transfer-policy model, visibly disclosed:** OWNER can maintain marketplace compatibility and can loosen/tighten or inadvertently block transfers. No `AutomaticValidatorTransferApproval`; neither owner nor validator receives holder operator approvals by default. Direct wallet transfers may evade on-chain royalty enforcement; disclose this accurately.
- **Separate modes:** (i) *private workspace* encrypts draft files, rights, thumbnails and sensitive project info before server storage; (ii) *explicit publish* uploads selected plaintext media, metadata and public rights to public content-addressed storage, with warning and irreversible consent. Never claim public IPFS assets are E2EE. Do not include secrets, investor information or personal Circle registry details in public NFT metadata.
- **E2EESA exact version/profile pinned and scoped.** Profile applicability is based on components/data flows, not repository names; requirements are resolved and accompanied by evidence. No conformance/certification claim until production scope and external verification satisfy upstream rules. The upstream standard is under active pre-1.0 development.
- **Cryptography and key boundaries:** use a version-pinned E2EESA attachment encryption profile (fresh per-file 256-bit keys, authenticated chunk encryption, authenticated manifest, unique nonces); cryptographic randomness; ciphertext-only server storage; key derivation/wrapping, authorized multi-device transfer, revocation limits and recovery have explicit designs. Server never learns draft encryption keys or unencrypted drafts. Wallet signatures **authenticate** separately; they are not automatically E2EE encryption keys. Public rendering of client-supplied plaintext while preparing publication occurs on the trusted client.
- **Web execution trust:** normal hosted web apps trust the code-serving origin. Select/document the honest E2EESA browser security profile and release-integrity controls; stronger independently verified bootstrap can be a later extension. CSP/TLS/SRI do not magically remove malicious-origin risk.
- **Server/admin boundaries:** wallet-based auth with nonce/domain/chain/expiry/replay protection and SIWE-equivalent validated format; approved Safe authentication strategy; RBAC; CSRF/session hardening; upload size/mime checks, quotas, rate limits and budget controls; pinning keys/OpenSea keys server-side; no raw signing keys stored; encrypted storage and backups.
- **Publication/chain invariants:** preflight the exact chain ID, deployed bytecode and known contract version, roles, supply, validator status, minting closure, token availability, token hash/URI/rights values, gas, IPFS retrieval and marketplace authorizer before asking for signatures. Fail closed on mismatch. Record receipts and recover from interrupted workflows idempotently.
- **Chain/environment support:** Ethereum mainnet canonical; Sepolia for rehearsal; other EVM chains only after audited compatibility and marketplace support checks. No “one-click” promise implying no signature or fees.
- **No release bypass:** CI checks, dependency pinning, SAST, secrets scan, contract static tests/integration/adversarial tests, signed build provenance, vulnerability triage, manual security review, disposable mainnet real-sale rehearsal and rollout rollback/stop controls precede production launch.

## 3. Technology choices and controls

- Web: accessible responsive TypeScript React application with persistent release wizard, media previews, upload queue, status timeline, wallet connection and clear signing flow.
- Backend: TypeScript service handling authenticated session, job orchestration, IPFS pinning, OpenSea API proxy, indexing receipts, status reconciliation and structured redacted logs. Never holds plaintext private drafts.
- Data: Postgres (Neon eligible) for metadata/operations with envelope-encrypted values where needed; encrypted object storage for draft blobs, public IPFS for only confirmed published content. Use explicit retention/deletion policies.
- Ethereum: ABI/bytecode built from pinned contract toolchain; viem or ethers wallet adapters with Safe support; deterministic deployment records/config profiles; compare executable bytecode/codehash before writes.
- Marketplace: OpenSea current supported listing-action endpoint or maintained SDK; seller reviews the precise approvals, Seaport zone, royalty consideration, price/currency, expiration and fee recipients; signs through wallet. Verify via API **and** relevant on-chain state rather than assuming API receipt equals a live listing.
- Security: standards manifest (exact upstream release/commit and selected E2EESA profiles), machine-readable application-to-standard requirement crosswalk, threat model, conformance evidence, automated adversarial fixtures.
- Ops: GitHub Actions required branch checks, Render web/API deployment, Neon database, managed object storage/IPFS service, alerts, logs, backups, runbooks, and Engine Room progress integration.

**Implementation decisions deliberately reserved for PRs 04, 08 and 10:** crypto-library/profile selection, cross-device key recovery design, and verified-browser client trust profile. Must be selected by evidence against the pinned E2EESA source, not invented algorithm parameters.

## 4. Execution plan — complete ordered PR backlog

All numbered PRs below are planned **work packages**, not already-created pull requests. Implementation can chain independent PRs; the base prerequisites and acceptance gates must stay intact. Each PR must update relevant documentation/tests. A PR is **complete** only after tests, review and merge; a feature is **production-ready** only after its applicable implementation, test and operational checks; external human review is deferred.

### Foundation and audited-contract parity

**PR-01 — Repository baseline and project charter.** Verify currently committed files, remove inconsistent AOTV product labels and obsolete instructions, describe generic release vs token model, define supported chains, feature lifecycle and single authoritative plan. **Depends:** none. **Acceptance:** links/data model/use cases agreed, no project-specific constants outside examples.

**PR-02 — CI reliability and reproducibility.** Pin dependencies and compiler; commit lockfile; run compile, lint, unit tests, TS typecheck, security scanning and build on PRs; prohibit incomplete jobs from becoming green. **Depends:** 01. **Acceptance:** clean checkout passes CI deterministically; failed Solidity build blocks merge.

**PR-03 — Audit parity: original custom contract vs current generic fork.** File-by-file compare against exact most recent 178-line no-autoapproval approved package; document security invariants, threat implications of constructor/supply/royalty/batch changes, ABI/interface/ERC2981/OZ override compatibility, validator operator paths. **Depends:** 01–02. **Acceptance:** parity diff, explicit approved changes, required audit findings and corrective test matrix committed. This is a blocking production gate.

**PR-04 — Generic collection contract stabilization.** Make collection factory-parameterized without losing no-autoapproval/immutable economics/security behavior; test arbitrary supply, rights and media hashes, mint batching bounds, role separation, ERC165 interfaces, ownership, events, Smart-wallet paths. **Depends:** 03. **Acceptance:** compile/tests pass on pinned toolchain; no new unreviewed rights/admin mutation.

**PR-05 — Real Limit Break validator integration & adversarial suite.** Use pinned actual validator implementation/ruleset; test whitelist (options 6), OpenSea signed-zone authorizer, owner policy changes, malicious validator/operator attempts, freeze/restore, royalty-free direct transfers, EOA/Safe/7702 cases. **Depends:** 04. **Acceptance:** versioned live-library tests and security assertion report; no claim of royalty enforcement where bypass paths exist.

**PR-06 — Deployment factory artifacts and deployment contracts.** Version/bytecode IDs, constructor validation, chain registry, owner/minter multisig support, deterministic deployment receipts, no key custody, duplicate-deploy safety. **Depends:** 04–05. **Acceptance:** script and app instantiate at least two unrelated collections with independent parameters.

### Data, E2EE, privacy and access

**PR-07 — Release schema, ownership and data migrations.** Normalize releases, assets, editions, token records, rights versions, transaction jobs, listings, deployment profiles and activity log; preserve exact hashes and immutable publication references. **Depends:** 01. **Acceptance:** schema migrations and multi-collection isolation tests.

**PR-08 — E2EESA applicability, profile lock, threat model and privacy inventory.** Pin upstream commit/tag (candidate ≠ certified); identify component/data-flow scope and attacker models; assign exact relevant attachments, storage, client, transport, identity/secret management, backups, telemetry, supply-chain, verification profiles. **Depends:** 01–03. **Acceptance:** machine-readable profile selection and claim limitations, threat model, evidence matrix, upstream-conformance resolver check; AI source/security review before crypto activation; external review deferred.

**PR-09 — Authenticated admin login, RBAC and wallet/Safe identity.** SIWE-style challenge (domain/nonce/expiration/chain), session rotation/CSRF, 2FA optional, authorized wallets, per-release permissions, audit events, test network replay and phishing defenses. **Depends:** 07–08. **Acceptance:** unauthorized API cannot pin, read metadata, mutate drafts or deploy; contract wallet login validated.

**PR-10 — Client-side draft E2EE and per-file chunking.** Implement E2EESA-compatible authenticated chunk file encryption, per-file unique keys/nonces, manifests, secure key wrapping, client-side validation, malicious chunk/range/reorder/replay tests. **Depends:** 08–09. **Acceptance:** API/object storage see only ciphertext and minimal routing metadata; server compromise test cannot decrypt drafts.

**PR-11 — Recovery, devices, key management and encrypted sharing.** Specify recovery options, device authorization, key rotation and revocation limits, encrypted sync without server decryption, no wallet seed/private key reuse. **Depends:** 10. **Acceptance:** lose/recover device and unauthorized-device tests; recovery caveats clear.

**PR-12 — Private encrypted object storage and retention.** Resumable large-file encrypted multipart uploads, object lifecycle cleanup, server-side authorization, ciphertext manifests, usage quotas and cost safeguards. **Depends:** 09–11. **Acceptance:** gigabyte-class file test without memory blowup; no plaintext object/log/backup; retention/deletion test.

**PR-13 — Publishing boundary and public-media preflight.** Explicit declassification confirmation: preview exact works/rights/filenames/metadata to be public; strip sensitive EXIF/personal metadata when requested; local decrypt/reassemble/validate; publish plaintext to IPFS only after separate confirmation. **Depends:** 10–12. **Acceptance:** private bytes never leave client unencrypted except intentionally published asset; cancel publishes nothing publicly.

**PR-14 — Compliance and collector-personal-data handling.** Per-release configurable rights template/optional collector perks, age/eligibility/legal notices, privacy policy, deletion/retention for personal collector records; no investment access defaults; counsel-review checkpoint for rights/benefits. **Depends:** 07–08. **Acceptance:** public NFT has only authorized rights/IP information; personal membership register is separated and protected.

### End-user release experience

**PR-15 — Premium UI design system and responsive shell.** Navigation, accessible forms, mobile/desktop layouts, typography/spacing, upload affordances, progress/errors, keyboard/screen-reader tests and coherent “Create release” entry. **Depends:** 01,07. **Acceptance:** tested accessible responsive layouts and recognizable state.

**PR-16 — Multi-release dashboard and saved settings.** List collections by status, reusable templates without shared immutable state, drafts, archive/search, next token ID, current listings; saved owner/minter/royalty defaults editable per release. **Depends:** 07,09,10,15. **Acceptance:** create two independent releases, leave and resume encrypted draft.

**PR-17 — Collection builder: all collection inputs.** Name, symbol, max supply, royalty %, recipient, owner/minter, chains, collection cover, optional edition naming, default list price/currency and checklist. **Depends:** 04,16. **Acceptance:** editable valid values; no hard-coded AOTV; immutable inputs lock after deploy.

**PR-18 — Drag/drop media and bulk assignment UI.** Add multiple image/video/audio/other files, reorder, drag/drop, thumbnails, display image for non-image assets, per-work name/description/traits, one artwork with N editions or N distinct artworks, duplicate detection, max sizes. **Depends:** 12,15,17. **Acceptance:** multi-gigabyte resumable encrypted upload, recover, preview, item-level retry with bounded browser memory.

**PR-19 — Rights/document editor and policy templates.** Upload/edit rights, apply collection-level vs token-level terms explicitly, parse/hash signed-off final bytes, prevent stale rights/metadata hashes, track nontransferable off-chain membership separately. **Depends:** 13–14,17–18. **Acceptance:** on-chain hashes match exact public rights documents, per-token overrides are explicit, no retroactive rewrite.

**PR-20 — Review/publish wizard and irreversible actions screen.** Human-readable media gallery, exact hashes and on-chain fields, costs, chain, roles, approvals, IPFS public-file preview, warnings and user-confirmed state transition. **Depends:** 13,17–19. **Acceptance:** no silent publish; cancel and retry idempotently; metadata/content gateway round-trip checks.

### Deployment, minting and listings

**PR-21 — Automated validator policy provisioning.** Implement correct real validator list creation/owner binding, OpenSea SignedZone authorizer, ruleset 255/options 6, policy read-back, fail-closed mismatch and owner/admin transaction flow; zero broad operator approvals. **Depends:** 05–06,09,20. **Acceptance:** correct on-chain read-back and simulation; malicious validator regression preserved; compatibility and user risk disclosure.

**PR-22 — Local + Sepolia end-to-end rehearsal orchestration.** Test deployments from UI, mock validator tests isolated from production, actual validator integration where deployed, mint, direct wallet transfer, blocked marketplace test, failures displayed, repeatability. **Depends:** 20–21. **Acceptance:** completely documented signed test route with durable transaction receipts.

**PR-23 — Safe/EOA wallet signing and transaction queue.** Model pre-simulation, gas estimates, network switch, Safe proposal/confirmations, signature states, rejected/underpriced transactions, reorgs, retries without duplicate minting; no custody. **Depends:** 09,21–22. **Acceptance:** successful EOA/Safe tests and failures never misrepresented as success.

**PR-24 — Canonical deployment wizard.** After gates, deploy contract, configure validator, register addresses/codehash/network, verify chain state and ownership, preserve reproducible release record; approvals exactly scoped. **Depends:** 06,20–23. **Acceptance:** fresh generic collection end-to-end, signing required, no deploy when test gate red.

**PR-25 — Batch mint pipeline.** Per-work IPFS metadata hash preflight, token-ID vacancy checks, immutable input confirmation, up to bounded batch size, transaction status, partial/atomic error semantics, on-chain attestation and resync. **Depends:** 19–24. **Acceptance:** 1, multiple editions, and distinct works successfully minted under same collection; no duplicate ID; readback matches.

**PR-26 — OpenSea listing integration: approvals/signatures/posting.** Current official listing actions/SDK, accurate price/currency/fees/expiration/zone, user-approved operator scope, signed order submission, API rate-limit/retry handling. **Depends:** 05,21,23,25. **Acceptance:** owner creates real valid listing from UI (including Safe if supported), no private keys/API keys in browser; test real marketplace state.

**PR-27 — Independent listing and royalty verification.** Index OpenSea listing by contract/token/chain/order hash, verify order still active and priced correctly; validate royalty recipient and actual sale settlement in disposable mainnet rehearsal; document direct-transfer limitations. **Depends:** 26. **Acceptance:** cannot say “Listed” without verified active listing; payout verified with sale receipts, or release blocked.

**PR-28 — Single “Mint & List” guided operation.** Orchestrate validated prepare → sign mint → index → required marketplace approval/sign order → verify listing, with safe resume at every step. **Depends:** 24–27. **Acceptance:** end-user can complete one NFT without Terminal, copy/paste or jumping between apps except wallet prompts; no false one-signature promise.

**PR-29 — Existing collection minting, edition inventory and re-listing.** Reopen collection, mint next unminted ID(s), track remaining supply, minted works and listing lifecycle; reveal immutable settings. **Depends:** 16,25–28. **Acceptance:** mint NFTs #2–#N in same release and a wholly different release without code modification.

### Production safety, launch and handoff

**PR-30 — Threat-driven audit and contract verification.** AI-assisted source/security review of contract changes vs original audited version (independent human review deferred, not a launch prerequisite), property/fuzz tests, real validator, adversarial roles, signing, upload/publishing boundary, client ciphertext, marketplace phishing/approval attacks. **Depends:** 05,08–13,21–29. **Acceptance:** no unresolved critical/high severity findings; signed findings and remediation evidence.

**PR-31 — Build integrity and E2EESA scoped conformance evidence.** Lockfile/SBOM/provenance, secret scan, signed artifacts, browser release integrity/trust-boundary statement, upstream exact-source requirement mapping, evidence bundle; do not claim certification based solely on tests. **Depends:** 02,08,10–13,30. **Acceptance:** reproducible release, explicit verified vs unverified controls, valid scoped evidence.

**PR-32 — Render/Neon/storage/IPFS deployment and secrets setup.** Environment separation, secure secrets, managed TLS, database migrations, bucket policies, storage encryption, domain/CORS, alerts, logs, backups and restore, cost/budget controls. **Depends:** 09–13,23–25,31. **Acceptance:** production-like staging functional, alerts and recovery drill passed, no secret/browser leakage.

**PR-33 — Disposable mainnet OpenSea rehearsal.** Deploy *throwaway* collection with exact production owner/minter/validator compatibility, mint cheap test NFT, list and buy it through OpenSea, check 6% or selected rate payout, transfer, revoke risky approvals; stop if any mismatch. **Depends:** 27,30–32. **Acceptance:** real mainnet receipt bundle and user-approved go/no-go; expense disclosed.

**PR-34 — Production launch and staged rollout.** Production deployment, final live security/CI gating, domain/health monitoring, staged allowlisted mint, emergency disable of console writes, incident runbook; contract owner controls treated as irreversible and external. **Depends:** 33. **Acceptance:** end-to-end successful mainnet mint/list/verified order on the live app, documented manual signoffs, monitoring healthy.

**PR-35 — Engine Room telemetry and status integration.** Report deployed URL, CI, outstanding PRs, contract audits, environment, failed jobs, launch status, token/listing counts and blocked actions using accurate source-backed data. **Depends:** 02,24,32–34. **Acceptance:** Engine Room shows real measured progress and links, never guessed counts.

**PR-36 — Final UX, accessibility, documentation and handoff.** Run nontechnical acceptance tests, screen-reader/keyboard audit, concise PDF quick start, detailed support/runbook, backup and key recovery checklist, user privacy controls, full issue/PR roadmap and repeatability guide. **Depends:** 29–35. **Acceptance:** second account can take over repo using README/docs/issues without prior-chat memory; owner can create another release unaided.

## 5. Parallel sequencing and release gates

**Stream A — contract/security:** 01→02→03→04→05→06→21→22→23→24→25→26→27→28→29→30→31→33→34.  
**Stream B — encrypted platform/data:** 01→07→08→09→10→11→12→13→14.  
**Stream C — UI:** 01→07→15→16→17→18→19→20, then 28–29.  
**Stream D — operations:** 02→31→32→33→34→35→36.  

The streams may run concurrently, but **do not deploy production until contract parity, real-validator, client E2EE, publish-boundary, AI security review, disposable-mainnet sale/royalty, recovery, and CI gates are all green.**

Milestones:
- **M1 — documented baseline:** PR 01–08. No production claim.
- **M2 — functional private beta:** PR 09–20. Encrypted drafts and intuitive release builder.
- **M3 — end-to-end testnet:** PR 21–25. Signed deploy/mint and readback.
- **M4 — marketplace integration:** PR 26–29. Verified listing under real marketplace.
- **M5 — trusted production:** PR 30–36. Audit, operational/security evidence, rehearsed production and handoff.

## 6. PR execution rules

- Every PR gets: purpose, exact affected components, prerequisites, threat/security implications, diff, tests, acceptance evidence, screenshots for UI, deployment/recovery impact and current blockers.
- Chain nonconflicting PRs automatically when tests/review are green; do not silently merge red tests or expand scope.
- Security-sensitive PRs require a substantive AI-assisted security review and E2EESA crosswalk updates.
- Failures are fixed, not waived for launch. Material product/legal choices are escalated; implementation decisions follow best practice and this plan.
- “Feature implemented,” “tests passed,” “deployed,” “active listing,” “royalty settled” and “security conformance” are **distinct statuses** backed by separate evidence.
- Never store wallet seeds, private keys, E2EE content keys or privileged service secrets in GitHub, public IPFS or browser-accessible configuration.

## 7. Existing code status (must not be mistaken for done)

At plan writing the repository already contains an early generic Solidity contract, simple HTML/CSS/JS front end, express server, wallet sign-in, Pinata upload route, basic preflight, batch mint interactions and an initial CI workflow. **This is an unverified prototype**, not the finished secure console. It has not established contract parity with the last reviewed package, audited generic changes, genuinely private E2EE drafts, robust administrative role management, persisted multi-release orchestration, polished design, complete validator setup, Safe flows, automatic OpenSea listing, full testnet/mainnet rehearsal, or production deployment.

PR 02 must validate the current CI after the latest fixes; past initial runs failed due Node setup expecting a missing lockfile. PR 03 must independently establish actual Solidity compilation and original-contract parity before anyone signs a production deployment. PR 08–13 supersede the existing server-side plaintext upload architecture for private drafts; publishing must be redesigned with user-approved client declassification. Do **not** publish secrets or sensitive private media through the prototype.

## 8. Inputs needed eventually (not needed to develop code)

At launch, authorized wallet(s)/Safe signatures, verified chain network, hosting domain, funded gas wallet, hosted database and storage/IPFS credentials, and an OpenSea API key/appropriate signing session. User should provide credentials only to their providers' secret managers—never in chat, repo, a web form without a secure secret-management flow, or public artifacts.

The initial specific collection(s) to mint, sale price, rights agreement and artwork are per-release user content, **not compile-time application configuration**. Reusable defaults may be saved privately.

## 9. Objective acceptance walkthrough (final end-to-end)

A fresh user account opens the live app and creates **“Release Alpha”**, 3 image NFTs at 0.05 ETH, 4% royalty, its own rights. They upload three images, privately save/resume the draft, inspect hashes, publish selected content, sign one generic contract deployment, configure validator, mint IDs 1–3 with a batch signature and see three verified OpenSea listings with correct prices and royalty settings. Then they create **“Release Beta”**, 50 video editions (poster files, 6% royalty, 1 ETH price), deploy its independent collection and batch-mint the first 10. Later they resume and mint editions 11–20 **without redeploying Beta**. A different authorized device cannot open either private draft until key authorization/recovery. A secondary buyer sees only the intentionally published NFT assets and rights, not private drafts or admin records.

**Completion is based on these observable operations and security evidence, not on PR count alone.**
