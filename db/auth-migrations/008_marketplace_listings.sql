-- Seaport listing journal. Stores the exact reviewed order the owner's wallet signed and
-- independently observed evidence. Never holds keys, API credentials or private release data.
CREATE TABLE nft_console.marketplace_listings (
  account_id uuid NOT NULL REFERENCES nft_console.accounts(id), id uuid NOT NULL,
  chain_id bigint NOT NULL CHECK(chain_id IN(1,11155111,31337)),
  seaport text NOT NULL CHECK(seaport ~ '^0x[0-9a-f]{40}$'),
  collection text NOT NULL CHECK(collection ~ '^0x[0-9a-f]{40}$'),
  token_id numeric(78,0) NOT NULL CHECK(token_id>=0),
  seller text NOT NULL CHECK(seller ~ '^0x[0-9a-f]{40}$'),
  order_hash text NOT NULL CHECK(order_hash ~ '^0x[0-9a-f]{64}$'),
  components jsonb NOT NULL CHECK(jsonb_typeof(components)='object' AND octet_length(components::text)<=16384),
  review jsonb NOT NULL CHECK(jsonb_typeof(review)='object' AND octet_length(review::text)<=16384),
  signature text CHECK(signature ~ '^0x[0-9a-f]+$' AND length(signature) BETWEEN 130 AND 8194 AND length(signature)%2=0),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','signed','submission_uncertain','rejected','verifying','listed','valid_unindexed','inactive','expired','cancel_pending','cancelled','sold','superseded')),
  submission jsonb CHECK(submission IS NULL OR (jsonb_typeof(submission)='object' AND octet_length(submission::text)<=4096)),
  observation jsonb CHECK(observation IS NULL OR (jsonb_typeof(observation)='object' AND octet_length(observation::text)<=8192)),
  settlement jsonb CHECK(settlement IS NULL OR (jsonb_typeof(settlement)='object' AND octet_length(settlement::text)<=8192)),
  cancel_tx text CHECK(cancel_tx ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,id), UNIQUE(chain_id,order_hash)
);
CREATE INDEX marketplace_listings_token ON nft_console.marketplace_listings(account_id,chain_id,collection,token_id);
REVOKE ALL ON nft_console.marketplace_listings FROM PUBLIC;
ALTER TABLE nft_console.marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nft_console.marketplace_listings FORCE ROW LEVEL SECURITY;
GRANT SELECT ON nft_console.marketplace_listings TO nft_console_api;
GRANT INSERT(account_id,id,chain_id,seaport,collection,token_id,seller,order_hash,components,review) ON nft_console.marketplace_listings TO nft_console_api;
GRANT UPDATE(signature,state,submission,observation,settlement,cancel_tx,updated_at) ON nft_console.marketplace_listings TO nft_console_api;
CREATE POLICY marketplace_listings_owner ON nft_console.marketplace_listings TO nft_console_api
  USING(account_id=nft_console.current_account_id() AND nft_console.actor_bound() AND chain_id=nullif(current_setting('nft_console.chain_id',true),'')::bigint AND current_setting('nft_console.console_role',true)='owner')
  WITH CHECK(account_id=nft_console.current_account_id() AND nft_console.actor_bound() AND chain_id=nullif(current_setting('nft_console.chain_id',true),'')::bigint AND current_setting('nft_console.console_role',true)='owner');
CREATE FUNCTION nft_console.guard_marketplace_listing() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.account_id,NEW.id,NEW.chain_id,NEW.seaport,NEW.collection,NEW.token_id,NEW.seller,NEW.order_hash,NEW.components,NEW.review,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.account_id,OLD.id,OLD.chain_id,OLD.seaport,OLD.collection,OLD.token_id,OLD.seller,OLD.order_hash,OLD.components,OLD.review,OLD.created_at)
  THEN RAISE EXCEPTION 'Reviewed listing orders are immutable'; END IF;
  IF OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature THEN RAISE EXCEPTION 'Order signatures are write-once'; END IF;
  IF OLD.state IN('sold','cancelled','superseded') AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'Final listing states are terminal'; END IF;
  IF OLD.settlement IS NOT NULL AND NEW.settlement IS DISTINCT FROM OLD.settlement THEN RAISE EXCEPTION 'Settlement evidence is immutable'; END IF;
  IF NEW.state IN('signed','submission_uncertain','listed','valid_unindexed','verifying') AND NEW.signature IS NULL THEN RAISE EXCEPTION 'A signature is required'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION nft_console.guard_marketplace_listing() FROM PUBLIC;
CREATE TRIGGER immutable_marketplace_listing BEFORE UPDATE ON nft_console.marketplace_listings FOR EACH ROW EXECUTE FUNCTION nft_console.guard_marketplace_listing();
