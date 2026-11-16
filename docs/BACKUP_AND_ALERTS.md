# Backups and alerts (NFT-32)

## What is protected where

| Data | Where it lives | Backup |
| --- | --- | --- |
| Releases, roles, mint/launch journals, workspace ciphertext (default driver) | Neon project `silent-resonance-77956314`, branch `main` | Neon point-in-time history (6 h on the current plan) + dated `backup-*` branches |
| Workspace ciphertext with `PRIVATE_STORAGE_DRIVER=s3` | Owner's S3-compatible bucket | Provider versioning if wanted; client-encrypted, owner keeps the device/recovery keys |
| Contracts, tokens, listings | The blockchain / OpenSea | Not in the database; unaffected by any restore |
| Wallet keys, workspace recovery phrase | Owner's wallet and devices only | Owner responsibility (see `docs/OWNER_QUICKSTART.md`) |

## Database backups

`scripts/neon-backup.mjs` uses the Neon API (`https://console.neon.tech/api/v2`, key from `NEON_API_KEY`).
A backup is a compute-less child branch named `backup-YYYY-MM-DD-HHMM[-label]`. It is copy-on-write,
so it costs only storage for data that later changes on `main`, and it keeps its data after the 6-hour
history window has passed.

```bash
NEON_API_KEY=... npm run backup:snapshot -- --label manual   # create
NEON_API_KEY=... npm run backup:list                         # list
NEON_API_KEY=... node scripts/neon-backup.mjs verify NAME          # state=ready, parent present
NEON_API_KEY=... node scripts/neon-backup.mjs schema-check NAME    # drill: backup schema == production schema
node scripts/neon-backup.mjs restore-plan NAME                     # print the restore procedure
```

`prune --keep N --label L --confirm` deletes only the oldest non-default `backup-*` branches carrying
label `L`; it is a dry run without `--confirm`. Nothing in the script resets or restores production.

### Weekly automation

`.github/workflows/neon-backup.yml` runs every Monday 03:41 UTC (and on demand): snapshot with label
`weekly`, verify, schema-check, then keep the newest four weekly backups. **Owner input:** add a Neon
API key as the repository secret `NEON_API_KEY` (GitHub > Settings > Secrets and variables > Actions).
Until then the job only prints a notice and succeeds.

### Restore

Run `node scripts/neon-backup.mjs restore-plan <name>` for the exact steps. In short:

- **Inspect (non-destructive):** add a compute to the backup branch in the Neon console and query it.
- **Roll back production:** suspend the Render service, use Neon *Restore* on `main` from the backup
  branch with "preserve as" a dated branch, resume the service. Connection strings do not change.
- **Point the app at a copy:** add a compute to the backup branch and set Render `DATABASE_URL` to it.

### Drill record - 2026-11-16

Run by the implementing agent from the session sandbox against project `silent-resonance-77956314`:

- `snapshot --label drill` created branch **`backup-2026-11-16-0058-drill`** (`br-misty-hat-bce9ewq5`),
  parent `main` (`br-rough-poetry-bccqytug`) at LSN `0/1DB4B48`, no compute endpoint.
- `verify` returned `ok: true`, state `ready`.
- `schema-check` rendered both schemas through the Neon API: 38 tables on each side, identical.
- Not exercised: a destructive restore of `main` (deliberately not done on production) and a
  row-level data comparison (requires a compute and database credentials). Nothing existing was
  deleted, reset or restored.

## Uptime alerts

`.github/workflows/uptime.yml` runs every 6 hours (minute 17) and on demand. `scripts/uptime-check.mjs`
requests `https://nft-minting-console.onrender.com/api/status` (three attempts, 90 s each, to ride out
a free-tier cold start). Any HTTP 200 JSON answer counts as up, including the current `degraded`
"chain not configured" mode.

- Down: opens one issue labelled `uptime-alert` (or comments on the open one) and the run fails.
- Recovered: comments with the response time and mode, then closes the issue.

GitHub emails repository watchers about new issues, so watching the repository is the notification
channel; no extra secret is needed (the workflow uses the built-in `GITHUB_TOKEN`).

When an alert opens: check Render (service `srv-dbsvpavf3r2c73bha9mg` > Events and Logs) and the Neon
project status. A Render deploy failure leaves the previous version serving; a database outage shows
as `database_unavailable` responses.
