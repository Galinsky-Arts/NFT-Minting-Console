-- Ciphertext-only private release workspace (E2EESA server-ciphertext-only@0.1.0).
-- Holds public device certificates, MLS key packages and handshake/application messages, sealed drafts
-- and encrypted file chunks. Never content keys, account-root secrets, recovery material or plaintext.
-- Retention: every ciphertext row expires 30 days after its last write (profile maximum).
CREATE TABLE nft_console.workspace_accounts (
  account_id uuid PRIMARY KEY REFERENCES nft_console.accounts(id),
  chain_id bigint NOT NULL CHECK(chain_id IN(1,11155111,31337)),
  root_public_key text NOT NULL CHECK(root_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  epoch bigint NOT NULL DEFAULT 0 CHECK(epoch>=0),
  generation integer NOT NULL DEFAULT 1 CHECK(generation>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE nft_console.workspace_devices (
  account_id uuid NOT NULL REFERENCES nft_console.workspace_accounts(account_id), device_id text NOT NULL CHECK(device_id ~ '^[0-9a-f]{32}$'),
  certificate jsonb NOT NULL CHECK(jsonb_typeof(certificate)='object' AND octet_length(certificate::text)<=2048),
  key_package text NOT NULL CHECK(length(key_package)<=16384),
  label text NOT NULL DEFAULT '' CHECK(length(label)<=80),
  status text NOT NULL CHECK(status IN('pending','active','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,device_id)
);
CREATE TABLE nft_console.workspace_enrollments (
  account_id uuid NOT NULL REFERENCES nft_console.workspace_accounts(account_id), device_id text NOT NULL CHECK(device_id ~ '^[0-9a-f]{32}$'),
  signature_public_key text NOT NULL CHECK(signature_public_key ~ '^[A-Za-z0-9+/]{43}=$'), label text NOT NULL DEFAULT '' CHECK(length(label)<=80),
  certificate jsonb CHECK(certificate IS NULL OR (jsonb_typeof(certificate)='object' AND octet_length(certificate::text)<=2048)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',
  PRIMARY KEY(account_id,device_id)
);
CREATE TABLE nft_console.workspace_log (
  account_id uuid NOT NULL REFERENCES nft_console.workspace_accounts(account_id), seq bigint NOT NULL CHECK(seq>0),
  epoch bigint NOT NULL CHECK(epoch>=0), kind text NOT NULL CHECK(kind IN('commit','welcome','application')),
  sender_device text NOT NULL CHECK(sender_device ~ '^[0-9a-f]{32}$'), target_device text CHECK(target_device ~ '^[0-9a-f]{32}$'),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  PRIMARY KEY(account_id,seq), CHECK((kind='welcome')=(target_device IS NOT NULL))
);
CREATE UNIQUE INDEX workspace_one_commit_per_epoch ON nft_console.workspace_log(account_id,epoch) WHERE kind='commit';
CREATE TABLE nft_console.workspace_drafts (
  account_id uuid NOT NULL REFERENCES nft_console.workspace_accounts(account_id), draft_id text NOT NULL CHECK(draft_id ~ '^[0-9a-f]{32}$'),
  revision integer NOT NULL CHECK(revision>=1), content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  sealed jsonb NOT NULL CHECK(jsonb_typeof(sealed)='object' AND octet_length(sealed::text)<=1048576),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  PRIMARY KEY(account_id,draft_id)
);
CREATE TABLE nft_console.workspace_objects (
  account_id uuid NOT NULL REFERENCES nft_console.workspace_accounts(account_id), object_id text NOT NULL CHECK(object_id ~ '^[0-9a-f]{32}$'),
  chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 65536), chunk_size integer NOT NULL CHECK(chunk_size BETWEEN 65536 AND 8388608),
  ciphertext_size bigint NOT NULL CHECK(ciphertext_size>0 AND ciphertext_size<=1073741824),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  PRIMARY KEY(account_id,object_id)
);
CREATE TABLE nft_console.workspace_chunks (
  account_id uuid NOT NULL, object_id text NOT NULL, chunk_index integer NOT NULL CHECK(chunk_index>=0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), body bytea NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 8388624),
  PRIMARY KEY(account_id,object_id,chunk_index), FOREIGN KEY(account_id,object_id) REFERENCES nft_console.workspace_objects(account_id,object_id) ON DELETE CASCADE
);
REVOKE ALL ON nft_console.workspace_enrollments,nft_console.workspace_accounts,nft_console.workspace_devices,nft_console.workspace_log,nft_console.workspace_drafts,nft_console.workspace_objects,nft_console.workspace_chunks FROM PUBLIC;
ALTER TABLE nft_console.workspace_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE nft_console.workspace_enrollments ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE nft_console.workspace_devices ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE nft_console.workspace_log ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_log FORCE ROW LEVEL SECURITY;
ALTER TABLE nft_console.workspace_drafts ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE nft_console.workspace_objects ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE nft_console.workspace_chunks ENABLE ROW LEVEL SECURITY; ALTER TABLE nft_console.workspace_chunks FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON nft_console.workspace_accounts TO nft_console_api; GRANT UPDATE(epoch,generation) ON nft_console.workspace_accounts TO nft_console_api;
GRANT SELECT,INSERT,DELETE ON nft_console.workspace_enrollments TO nft_console_api; GRANT UPDATE(certificate) ON nft_console.workspace_enrollments TO nft_console_api;
GRANT SELECT,INSERT ON nft_console.workspace_devices TO nft_console_api; GRANT UPDATE(status,updated_at,key_package) ON nft_console.workspace_devices TO nft_console_api;
GRANT SELECT,INSERT,DELETE ON nft_console.workspace_log TO nft_console_api;
GRANT SELECT,INSERT,DELETE ON nft_console.workspace_drafts TO nft_console_api; GRANT UPDATE(revision,content_hash,sealed,updated_at,expires_at) ON nft_console.workspace_drafts TO nft_console_api;
GRANT SELECT,INSERT,DELETE ON nft_console.workspace_objects TO nft_console_api;
GRANT SELECT,INSERT,DELETE ON nft_console.workspace_chunks TO nft_console_api;
CREATE POLICY workspace_accounts_member ON nft_console.workspace_accounts TO nft_console_api
  USING(account_id=nft_console.current_account_id() AND nft_console.actor_bound() AND chain_id=nullif(current_setting('nft_console.chain_id',true),'')::bigint AND current_setting('nft_console.console_role',true) IN('owner','editor'))
  WITH CHECK(account_id=nft_console.current_account_id() AND nft_console.actor_bound() AND chain_id=nullif(current_setting('nft_console.chain_id',true),'')::bigint AND current_setting('nft_console.console_role',true) IN('owner','editor'));
CREATE POLICY workspace_enrollments_member ON nft_console.workspace_enrollments TO nft_console_api
  USING(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_enrollments.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_enrollments.account_id));
CREATE POLICY workspace_devices_member ON nft_console.workspace_devices TO nft_console_api
  USING(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_devices.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_devices.account_id));
CREATE POLICY workspace_log_member ON nft_console.workspace_log TO nft_console_api
  USING(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_log.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_log.account_id));
CREATE POLICY workspace_drafts_member ON nft_console.workspace_drafts TO nft_console_api
  USING(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_drafts.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_drafts.account_id));
CREATE POLICY workspace_objects_member ON nft_console.workspace_objects TO nft_console_api
  USING(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_objects.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM nft_console.workspace_accounts w WHERE w.account_id=workspace_objects.account_id));
CREATE POLICY workspace_chunks_member ON nft_console.workspace_chunks TO nft_console_api
  USING(EXISTS(SELECT 1 FROM nft_console.workspace_objects o WHERE o.account_id=workspace_chunks.account_id AND o.object_id=workspace_chunks.object_id))
  WITH CHECK(EXISTS(SELECT 1 FROM nft_console.workspace_objects o WHERE o.account_id=workspace_chunks.account_id AND o.object_id=workspace_chunks.object_id));
CREATE FUNCTION nft_console.guard_workspace() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='workspace_accounts' THEN
    IF NEW.root_public_key IS DISTINCT FROM OLD.root_public_key OR NOT ((NEW.generation=OLD.generation AND NEW.epoch=OLD.epoch+1) OR (NEW.generation=OLD.generation+1 AND NEW.epoch=0))
      THEN RAISE EXCEPTION 'Workspace root is immutable; epochs advance by one or restart in a new generation'; END IF;
  ELSIF TG_TABLE_NAME='workspace_devices' THEN
    IF NEW.certificate IS DISTINCT FROM OLD.certificate OR (OLD.status='revoked' AND NEW.status<>'revoked') OR (OLD.status='active' AND NEW.status='pending')
       OR (OLD.status<>'pending' AND NEW.key_package IS DISTINCT FROM OLD.key_package) THEN RAISE EXCEPTION 'Device authorization can only advance'; END IF;
  ELSIF TG_TABLE_NAME='workspace_enrollments' THEN
    IF OLD.certificate IS NOT NULL THEN RAISE EXCEPTION 'Enrollment certificates are write-once'; END IF;
  ELSIF TG_TABLE_NAME='workspace_drafts' THEN
    IF NEW.revision<>OLD.revision+1 OR NEW.sealed->>'previousHash' IS DISTINCT FROM OLD.content_hash OR (NEW.sealed->>'revision')::integer<>NEW.revision
      THEN RAISE EXCEPTION 'Draft revisions must chain from the current revision'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION nft_console.guard_workspace() FROM PUBLIC;
CREATE TRIGGER guard_workspace_account BEFORE UPDATE ON nft_console.workspace_accounts FOR EACH ROW EXECUTE FUNCTION nft_console.guard_workspace();
CREATE TRIGGER guard_workspace_device BEFORE UPDATE ON nft_console.workspace_devices FOR EACH ROW EXECUTE FUNCTION nft_console.guard_workspace();
CREATE TRIGGER guard_workspace_draft BEFORE UPDATE ON nft_console.workspace_drafts FOR EACH ROW EXECUTE FUNCTION nft_console.guard_workspace();
CREATE TRIGGER guard_workspace_enrollment BEFORE UPDATE ON nft_console.workspace_enrollments FOR EACH ROW EXECUTE FUNCTION nft_console.guard_workspace();
