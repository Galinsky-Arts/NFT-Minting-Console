-- NFT-12: allow encrypted chunk bodies to live in an S3-compatible object store.
-- PostgreSQL keeps the chunk index and SHA-256 for every chunk; only the opaque ciphertext body moves out.
-- Additive: existing rows default to storage='postgres' and keep their body. Required only before
-- PRIVATE_STORAGE_DRIVER=s3 is enabled; the default PostgreSQL driver does not reference these columns.
ALTER TABLE nft_console.workspace_chunks ALTER COLUMN body DROP NOT NULL;
ALTER TABLE nft_console.workspace_chunks ADD COLUMN storage text NOT NULL DEFAULT 'postgres';
ALTER TABLE nft_console.workspace_chunks ADD CONSTRAINT workspace_chunks_storage_body CHECK(
  (storage='postgres' AND body IS NOT NULL) OR (storage='s3' AND body IS NULL));
