# Private encrypted object storage (NFT-12)

Private workspace files are encrypted in the browser (AES-256-GCM per chunk, keys never leave the
owner's devices) and uploaded as resumable chunks of up to 8 MiB. The server only ever receives,
stores and returns ciphertext. This document covers where those ciphertext chunks are kept.

## Drivers

| `PRIVATE_STORAGE_DRIVER` | Chunk bodies live in | Chunk index + SHA-256 live in | Needs |
| --- | --- | --- | --- |
| `postgres` (default, or unset) | PostgreSQL `nft_console.workspace_chunks.body` | PostgreSQL | nothing extra |
| `s3` | An S3-compatible bucket | PostgreSQL | migration `010_workspace_object_store.sql` and the settings below |

The S3 adapter (`console/workspace/object-store.mjs`) signs requests itself with AWS Signature V4
and path-style URLs, so it works with AWS S3, Cloudflare R2, Backblaze B2 (S3 API), Wasabi and MinIO.
No SDK dependency is added.

## Owner inputs for the S3 driver (optional)

Set these in the Render service's environment (secret values only in Render, never in git or chat):

| Variable | Secret? | Purpose |
| --- | --- | --- |
| `PRIVATE_STORAGE_DRIVER` | no | `s3` to enable; leave unset to keep PostgreSQL |
| `PRIVATE_STORAGE_ENDPOINT` | no | HTTPS endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` or `https://s3.us-east-1.amazonaws.com` |
| `PRIVATE_STORAGE_BUCKET` | no | A private bucket used only for this console |
| `PRIVATE_STORAGE_REGION` | no | Bucket region (`auto` for R2) |
| `PRIVATE_STORAGE_ACCESS_KEY_ID` | yes | Access key limited to that bucket |
| `PRIVATE_STORAGE_SECRET_ACCESS_KEY` | yes | Its secret |
| `PRIVATE_STORAGE_PREFIX` | no | Optional key prefix, default `nft-console/workspace/` |
| `PRIVATE_STORAGE_SSE` | no | Optional `AES256` or `aws:kms` provider-side encryption at rest (defence in depth; data is already client-encrypted) |

A misconfigured `s3` driver stops the app at start-up instead of silently falling back to PostgreSQL.

### Enabling it

1. Create a private bucket (block all public access). Give the key only `PutObject`, `GetObject`,
   `DeleteObject` and `ListBucket` on the prefix.
2. Add a bucket lifecycle rule that expires objects under the prefix after **31 days**. The app
   already deletes expired and deleted files itself; the rule is a backstop for any delete that fails
   during a provider outage (those failures are logged as `workspace_object_cleanup_failed`).
3. Apply migration 010 from a separate operations shell: `DATABASE_URL_UNPOOLED=... npm run db:migrate:auth`.
   It is additive and leaves existing rows on PostgreSQL storage.
4. Set the variables above in Render and redeploy. `/api/workspace` then reports `"storage":"s3"`.

Chunks already stored in PostgreSQL stay readable after the switch; new chunks go to the bucket.

## Retention and deletion

- Every encrypted file expires 30 days after creation (`workspace_objects.expires_at`). Expired files
  are never served; they are purged from PostgreSQL and the bucket the next time the owner's workspace
  is opened or a file is created.
- `DELETE /api/workspace/objects/:id` removes a file immediately: metadata in the same transaction,
  bucket objects right after the commit.
- Bucket keys contain only the internal account UUID, the random object ID, the chunk index and the
  ciphertext hash — no filenames, titles or wallet addresses.
- Each object key includes its SHA-256, so a conflicting retry can never overwrite an accepted chunk,
  and every read is hash-checked before bytes are returned (`CHUNK_INTEGRITY`, `CHUNK_MISSING`).
- Quotas are unchanged: 5 GiB of live ciphertext per account and 1 GiB per file.

## Evidence

`test-crypto/workspace-object-store.test.mjs` runs the adapter against an in-process S3 fake that
independently verifies every SigV4 signature and payload hash. It checks resumable/idempotent uploads,
conflict refusal, that PostgreSQL holds no bodies and the bucket holds no plaintext or filenames,
exact decrypted round trip, cross-account isolation, tamper and missing-object detection, explicit
deletion, 30-day retention purge and logged cleanup failure. It has not been run against a real
provider account (no owner credentials exist yet).
