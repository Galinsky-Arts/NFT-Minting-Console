-- Marketplace listings, owner wallet actions and the end-to-end encrypted private workspace.
-- The server stores only ciphertext, public device keys and wrapped keys for the private workspace.
CREATE FUNCTION nft_console.self_scope(account uuid,chain bigint) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT account=nft_console.current_account_id() AND nft_console.actor_bound() AND chain=nullif(current_setting('nft_console.chain_id',true),'')::bigint
$$;
REVOKE ALL ON FUNCTION nft_console.self_scope(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nft_console.self_scope(uuid,bigint) TO nft_console_api;
CREATE FUNCTION nft_console.owner_scope(account uuid,chain bigint) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT nft_console.self_scope(account,chain) AND current_setting('nft_console.console_role',true)='owner'
$$;
REVOKE ALL ON FUNCTION nft_console.owner_scope(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nft_console.owner_scope(uuid,bigint) TO nft_console_api;

CREATE TABLE nft_console.market_listings (
  account_id uuid NOT NULL REFERENCES nft_console.accounts(id), id uuid NOT NULL,
  chain_id bigint NOT NULL CHECK(chain_id IN(1,11155111,31337)),
  collection text NOT NULL CHECK(collection ~ '^0x[0-9a-fA-F]{40}$'), token_id numeric(78,0) NOT NULL CHECK(token_id>=0),
  seller text NOT NULL CHECK(seller ~ '^0x[0-9a-fA-F]{40}$'), order_hash text NOT NULL CHECK(order_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK(state IN('prepared','signed','submitting','submission_uncertain','submitted','rejected','listed','indexing_pending','attention','sold','cancelled','expired','invalid','replaced')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100000),
  marketplace text NOT NULL CHECK(marketplace IN('opensea','fixture')),
  order_json jsonb NOT NULL CHECK(jsonb_typeof(order_json)='object' AND octet_length(order_json::text)<=32768),
  review jsonb NOT NULL CHECK(jsonb_typeof(review)='object' AND octet_length(review::text)<=32768),
  signature text CHECK(signature ~ '^0x[0-9a-f]{130}$'),
  submission jsonb CHECK(submission IS NULL OR octet_length(submission::text)<=16384),
  verification jsonb CHECK(verification IS NULL OR octet_length(verification::text)<=32768),
  sale jsonb CHECK(sale IS NULL OR octet_length(sale::text)<=16384),
  prepared_block bigint NOT NULL CHECK(prepared_block>=0), replaces uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,id), UNIQUE(chain_id,order_hash)
);
CREATE TABLE nft_console.wallet_actions (
  account_id uuid NOT NULL REFERENCES nft_console.accounts(id), id uuid NOT NULL,
  chain_id bigint NOT NULL CHECK(chain_id IN(1,11155111,31337)),
  kind text NOT NULL CHECK(kind IN('policy','approval','cancel')),
  subject jsonb NOT NULL CHECK(jsonb_typeof(subject)='object' AND octet_length(subject::text)<=8192),
  tx jsonb NOT NULL CHECK(jsonb_typeof(tx)='object' AND octet_length(tx::text)<=16384),
  state text NOT NULL CHECK(state IN('prepared','wallet_rejected','submitted','verified','failed','attention')),
  tx_hash text CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'), result jsonb CHECK(result IS NULL OR octet_length(result::text)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,id)
);
CREATE TABLE nft_console.market_events (
  account_id uuid NOT NULL REFERENCES nft_console.accounts(id), id bigint GENERATED ALWAYS AS IDENTITY,
  chain_id bigint NOT NULL, subject uuid NOT NULL, event text NOT NULL CHECK(length(event)<=64),
  detail jsonb NOT NULL CHECK(octet_length(detail::text)<=16384), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,id)
);

-- Private workspace. Key epoch increments on every revocation-driven rotation; stale writes are rejected.
CREATE TABLE nft_console.private_workspaces (
  account_id uuid NOT NULL REFERENCES nft_console.accounts(id), chain_id bigint NOT NULL CHECK(chain_id IN(1,11155111,31337)),
  key_epoch integer NOT NULL CHECK(key_epoch BETWEEN 1 AND 1000000),
  recovery_wrap bytea NOT NULL CHECK(octet_length(recovery_wrap) BETWEEN 40 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,chain_id)
);
CREATE TABLE nft_console.private_devices (
  account_id uuid NOT NULL, chain_id bigint NOT NULL, id uuid NOT NULL,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  public_key bytea NOT NULL CHECK(octet_length(public_key)=65), state text NOT NULL CHECK(state IN('pending','active','revoked')),
  wrapped_key bytea CHECK(wrapped_key IS NULL OR octet_length(wrapped_key) BETWEEN 40 AND 512), wrapped_epoch integer,
  approved_by uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
  PRIMARY KEY(account_id,chain_id,id), UNIQUE(account_id,chain_id,public_key),
  FOREIGN KEY(account_id,chain_id) REFERENCES nft_console.private_workspaces(account_id,chain_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((state='active')=(wrapped_key IS NOT NULL AND wrapped_epoch IS NOT NULL) OR state='revoked')
);
CREATE TABLE nft_console.private_records (
  account_id uuid NOT NULL, chain_id bigint NOT NULL, id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('release','configuration')),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000000), key_epoch integer NOT NULL,
  envelope bytea NOT NULL CHECK(octet_length(envelope) BETWEEN 60 AND 1048576),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,chain_id,id), FOREIGN KEY(account_id,chain_id) REFERENCES nft_console.private_workspaces(account_id,chain_id)
);
CREATE TABLE nft_console.private_blobs (
  account_id uuid NOT NULL, chain_id bigint NOT NULL, id uuid NOT NULL,
  chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 262144), ciphertext_bytes bigint NOT NULL CHECK(ciphertext_bytes BETWEEN 16 AND 4398046511104),
  complete boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,chain_id,id), FOREIGN KEY(account_id,chain_id) REFERENCES nft_console.private_workspaces(account_id,chain_id)
);
CREATE TABLE nft_console.private_blob_chunks (
  account_id uuid NOT NULL, chain_id bigint NOT NULL, blob_id uuid NOT NULL, index integer NOT NULL CHECK(index>=0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 16 AND 8388624),
  PRIMARY KEY(account_id,chain_id,blob_id,index), FOREIGN KEY(account_id,chain_id,blob_id) REFERENCES nft_console.private_blobs(account_id,chain_id,id) ON DELETE CASCADE
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['market_listings','wallet_actions','market_events','private_workspaces','private_devices','private_records','private_blobs','private_blob_chunks'] LOOP
    EXECUTE format('REVOKE ALL ON nft_console.%I FROM PUBLIC',t);
    EXECUTE format('ALTER TABLE nft_console.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE nft_console.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT ON nft_console.market_listings,nft_console.wallet_actions,nft_console.market_events TO nft_console_api;
GRANT UPDATE(state,revision,signature,submission,verification,sale,updated_at) ON nft_console.market_listings TO nft_console_api;
GRANT UPDATE(state,tx_hash,result,updated_at) ON nft_console.wallet_actions TO nft_console_api;
GRANT SELECT,INSERT ON nft_console.private_workspaces,nft_console.private_devices,nft_console.private_records,nft_console.private_blobs,nft_console.private_blob_chunks TO nft_console_api;
GRANT UPDATE(key_epoch,recovery_wrap,updated_at) ON nft_console.private_workspaces TO nft_console_api;
GRANT UPDATE(state,wrapped_key,wrapped_epoch,approved_by,revoked_at) ON nft_console.private_devices TO nft_console_api;
GRANT UPDATE(revision,key_epoch,envelope,archived,updated_at) ON nft_console.private_records TO nft_console_api;
GRANT UPDATE(complete) ON nft_console.private_blobs TO nft_console_api;
GRANT DELETE ON nft_console.private_blobs TO nft_console_api;
GRANT USAGE ON SEQUENCE nft_console.market_events_id_seq TO nft_console_api;
CREATE POLICY market_listings_owner ON nft_console.market_listings TO nft_console_api USING(nft_console.owner_scope(account_id,chain_id)) WITH CHECK(nft_console.owner_scope(account_id,chain_id));
CREATE POLICY wallet_actions_owner ON nft_console.wallet_actions TO nft_console_api USING(nft_console.owner_scope(account_id,chain_id)) WITH CHECK(nft_console.owner_scope(account_id,chain_id));
CREATE POLICY market_events_owner ON nft_console.market_events TO nft_console_api USING(nft_console.owner_scope(account_id,chain_id)) WITH CHECK(nft_console.owner_scope(account_id,chain_id));
CREATE POLICY private_workspace_self ON nft_console.private_workspaces TO nft_console_api USING(nft_console.self_scope(account_id,chain_id)) WITH CHECK(nft_console.self_scope(account_id,chain_id));
CREATE POLICY private_devices_self ON nft_console.private_devices TO nft_console_api USING(nft_console.self_scope(account_id,chain_id)) WITH CHECK(nft_console.self_scope(account_id,chain_id));
CREATE POLICY private_records_self ON nft_console.private_records TO nft_console_api USING(nft_console.self_scope(account_id,chain_id)) WITH CHECK(nft_console.self_scope(account_id,chain_id));
CREATE POLICY private_blobs_self ON nft_console.private_blobs TO nft_console_api USING(nft_console.self_scope(account_id,chain_id)) WITH CHECK(nft_console.self_scope(account_id,chain_id));
CREATE POLICY private_chunks_self ON nft_console.private_blob_chunks TO nft_console_api USING(nft_console.self_scope(account_id,chain_id)) WITH CHECK(nft_console.self_scope(account_id,chain_id));

-- Integrity guards: append-only events, immutable order commitments, accepted chunks never change,
-- monotonic record revisions and key epochs, revoked devices never return.
CREATE FUNCTION nft_console.guard_market_private() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='market_listings' THEN
    IF ROW(NEW.account_id,NEW.id,NEW.chain_id,NEW.collection,NEW.token_id,NEW.seller,NEW.order_hash,NEW.order_json,NEW.review,NEW.marketplace,NEW.prepared_block,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.account_id,OLD.id,OLD.chain_id,OLD.collection,OLD.token_id,OLD.seller,OLD.order_hash,OLD.order_json,OLD.review,OLD.marketplace,OLD.prepared_block,OLD.created_at)
       OR (OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature) OR NEW.revision<>OLD.revision+1
       OR OLD.state IN('sold','replaced') THEN RAISE EXCEPTION 'Listing order commitments are immutable'; END IF;
  ELSIF TG_TABLE_NAME='wallet_actions' THEN
    IF ROW(NEW.account_id,NEW.id,NEW.chain_id,NEW.kind,NEW.subject,NEW.tx,NEW.created_at) IS DISTINCT FROM ROW(OLD.account_id,OLD.id,OLD.chain_id,OLD.kind,OLD.subject,OLD.tx,OLD.created_at)
       OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) OR OLD.state IN('verified','failed') THEN RAISE EXCEPTION 'Wallet action commitments are immutable'; END IF;
  ELSIF TG_TABLE_NAME='private_workspaces' THEN
    IF NEW.key_epoch<>OLD.key_epoch+1 AND NOT(NEW.key_epoch=OLD.key_epoch AND NEW.recovery_wrap IS DISTINCT FROM OLD.recovery_wrap) THEN RAISE EXCEPTION 'Key epoch must advance by one'; END IF;
  ELSIF TG_TABLE_NAME='private_devices' THEN
    IF OLD.state='revoked' OR ROW(NEW.account_id,NEW.chain_id,NEW.id,NEW.public_key,NEW.label) IS DISTINCT FROM ROW(OLD.account_id,OLD.chain_id,OLD.id,OLD.public_key,OLD.label) THEN RAISE EXCEPTION 'Device identity is immutable and revocation is final'; END IF;
  ELSIF TG_TABLE_NAME='private_records' THEN
    IF NEW.revision<>OLD.revision+1 OR NEW.key_epoch<OLD.key_epoch OR NEW.kind<>OLD.kind THEN RAISE EXCEPTION 'Record revisions must advance by one'; END IF;
  ELSIF TG_TABLE_NAME='private_blobs' THEN
    IF OLD.complete OR NEW.chunk_count<>OLD.chunk_count OR NEW.ciphertext_bytes<>OLD.ciphertext_bytes THEN RAISE EXCEPTION 'Completed encrypted objects are immutable'; END IF;
  ELSE RAISE EXCEPTION 'Append-only'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION nft_console.guard_market_private() FROM PUBLIC;
CREATE TRIGGER guard_listing BEFORE UPDATE ON nft_console.market_listings FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_action BEFORE UPDATE ON nft_console.wallet_actions FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_events BEFORE UPDATE OR DELETE ON nft_console.market_events FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_workspace BEFORE UPDATE ON nft_console.private_workspaces FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_device BEFORE UPDATE ON nft_console.private_devices FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_record BEFORE UPDATE ON nft_console.private_records FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_blob BEFORE UPDATE ON nft_console.private_blobs FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
CREATE TRIGGER guard_chunk BEFORE UPDATE ON nft_console.private_blob_chunks FOR EACH ROW EXECUTE FUNCTION nft_console.guard_market_private();
