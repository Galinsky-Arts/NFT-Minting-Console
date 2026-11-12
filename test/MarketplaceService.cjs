const { expect } = require('chai');
const { ethers } = require('hardhat');
const fixture = require('../test-marketplace/fixtures/seaport-1.6.json');

// End-to-end listing service: real PostgreSQL migrations/RLS/triggers (embedded PGlite), real Seaport 1.6,
// real NFTCollection and policy validator on Hardhat. The OpenSea double below is a unit-test fixture only:
// it is NOT evidence that any real OpenSea listing exists.
describe('Listing service (database + real Seaport)', function () {
  this.timeout(180000);
  let S, L, db, repo, owner, seller, buyer, royaltyRecipient, stranger, seaport, collection, validator, conduitKey, actor, chainId;
  const PRICE = ethers.parseEther('0.5');

  class EmbeddedPool {
    constructor(d) { this.db = d; this.tail = Promise.resolve(); }
    async connect() { const p = this.tail; let u; this.tail = new Promise(r => { u = r; }); await p; let done = false; return { query: (...a) => this.db.query(...a), release: () => { if (!done) { done = true; u(); } } }; }
  }

  before(async function () {
    S = await import('../console/marketplace/listing-service.mjs');
    L = await import('../console/marketplace/listing.mjs');
    const { PGlite } = await import('@electric-sql/pglite');
    const { migrate } = await import('../scripts/migrate.mjs');
    const { migrateAuth } = await import('../scripts/migrate-auth.mjs');
    const { ReleaseRepository } = await import('../console/data/releases.mjs');
    [owner, seller, buyer, royaltyRecipient, stranger] = await ethers.getSigners();
    chainId = 31337;
    db = new PGlite(); await db.waitReady;
    await migrate(db); const applied = await migrateAuth(db);
    expect(applied).to.include('008_marketplace_listings.sql');
    await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
    const roles = new Map([[seller.address.toLowerCase(), 'owner'], [stranger.address.toLowerCase(), 'viewer']]);
    repo = new ReleaseRepository({ pool: new EmbeddedPool(db), knownRoles: () => roles });
    actor = { wallet: seller.address.toLowerCase(), role: 'owner', chainId };
    const controller = await new ethers.ContractFactory(fixture.ConduitController.abi, fixture.ConduitController.bytecode, owner).deploy();
    seaport = await new ethers.ContractFactory(fixture.Seaport.abi, fixture.Seaport.bytecode, owner).deploy(await controller.getAddress());
    conduitKey = owner.address.toLowerCase() + '0'.repeat(24);
    await (await controller.createConduit(conduitKey, owner.address)).wait();
    const [conduit] = await controller.getConduit(conduitKey);
    await (await controller.updateChannel(conduit, await seaport.getAddress(), true)).wait();
    collection = await (await ethers.getContractFactory('NFTCollection')).deploy('Service Test', 'SVC', 20, 500, owner.address, seller.address, royaltyRecipient.address);
    validator = await (await ethers.getContractFactory('TestPolicyValidator')).deploy();
    await (await collection.connect(owner).setTransferValidator(await validator.getAddress())).wait();
    for (const id of [1, 2, 3]) await (await collection.connect(seller).mintWork(id, 'W' + id, 'ipfs://m' + id, ethers.id('m' + id), 'ipfs://r' + id, ethers.id('r' + id))).wait();
    this.conduit = conduit;
  });
  after(async () => { await db?.close(); });

  function service(opensea = null) {
    return new S.ListingService({ repository: repo, provider: ethers.provider, chainId,
      profile: { marketplace: { name: opensea ? 'OpenSea (test double)' : 'Local Seaport', api: opensea ? 'opensea' : null, seaport: null, conduitKey, zone: null } },
      env: { SEAPORT_ADDRESS: seaport.target, SEAPORT_CONDUIT_KEY: conduitKey }, opensea });
  }
  const signTyped = (t) => seller.signTypedData(t.domain, { OrderComponents: t.types.OrderComponents, OfferItem: t.types.OfferItem, ConsiderationItem: t.types.ConsiderationItem }, t.message);

  it('refuses to prepare while the transfer policy blocks the marketplace operator', async function () {
    const svc = service();
    await expect(svc.prepare(actor, { collection: collection.target, tokenId: '1', priceWei: PRICE.toString(), durationDays: 7 })).to.be.rejectedWith('POLICY_BLOCKS_MARKETPLACE');
    await (await validator.setOperator(this.conduit, true)).wait();
  });

  it('prepares, requires approval, verifies signature and reaches valid_unindexed (never "listed") without a marketplace', async function () {
    const svc = service();
    await expect(svc.prepare({ ...actor, wallet: stranger.address.toLowerCase() }, { collection: collection.target, tokenId: '1', priceWei: '1', durationDays: 7 })).to.be.rejected;
    const prepared = await svc.prepare(actor, { collection: collection.target, tokenId: '1', priceWei: PRICE.toString(), durationDays: 7 });
    expect(prepared.listing.state).to.equal('prepared');
    expect(prepared.approvalTransaction).to.not.equal(null);
    expect(prepared.listing.review.payments.map(p => p.role)).to.deep.equal(['seller-proceeds', 'creator-royalty']);
    expect(prepared.listing.review.payments[1].amountWei).to.equal((PRICE * 500n / 10000n).toString());
    await expect(svc.prepare(actor, { collection: collection.target, tokenId: '1', priceWei: PRICE.toString(), durationDays: 7 })).to.be.fulfilled; // supersedes the unsigned one
    const again = (await svc.list(actor)).filter(l => l.tokenId === '1');
    expect(again.map(l => l.state).sort()).to.deep.equal(['prepared', 'superseded']);
    const current = again.find(l => l.state === 'prepared');
    const fresh = await svc.get(actor, current.id);
    // Wrong signer is rejected and nothing is stored.
    const typed = { domain: L.seaportDomain(chainId, seaport.target), types: (await import('../console/marketplace/seaport-order.mjs')).EIP712_TYPES, message: (await db.query('SELECT components FROM nft_console.marketplace_listings WHERE id=$1', [fresh.id])).rows[0].components };
    await expect(svc.sign(actor, fresh.id, await stranger.signTypedData(typed.domain, { OrderComponents: typed.types.OrderComponents, OfferItem: typed.types.OfferItem, ConsiderationItem: typed.types.ConsiderationItem }, typed.message))).to.be.rejectedWith('WRONG_SIGNATURE');
    expect((await svc.get(actor, fresh.id)).state).to.equal('prepared');
    // Signed before approval: stored but inactive, never submitted.
    let result = await svc.sign(actor, fresh.id, await signTyped(typed));
    expect(result.state).to.equal('inactive');
    expect(result.observation.chain.approved).to.equal(false);
    await (await seller.sendTransaction(prepared.approvalTransaction)).wait();
    result = await svc.submit(actor, fresh.id);
    expect(result.state).to.equal('valid_unindexed');
    expect(result.observation.chain.fill.status).to.equal('fillable');
    await expect(svc.prepare(actor, { collection: collection.target, tokenId: '1', priceWei: '1', durationDays: 7 })).to.be.rejectedWith('ACTIVE_LISTING_EXISTS');
    this.listing = { id: fresh.id, typed };
  });

  it('database triggers keep reviewed orders immutable and signatures write-once', async function () {
    await expect(repo.transaction(actor, null, (c, a) => c.query("UPDATE nft_console.marketplace_listings SET signature='0x" + '00'.repeat(65) + "' WHERE account_id=$1 AND id=$2", [a, this.listing.id]))).to.be.rejected;
    await expect(repo.transaction(actor, null, (c, a) => c.query("UPDATE nft_console.marketplace_listings SET review='{}'::jsonb WHERE account_id=$1 AND id=$2", [a, this.listing.id]))).to.be.rejected;
    const viewer = { wallet: stranger.address.toLowerCase(), role: 'viewer', chainId };
    await expect(service().list(viewer)).to.be.rejectedWith('OWNER_REQUIRED');
  });

  it('records a real sale with settlement and royalty evidence, then becomes terminal', async function () {
    const svc = service();
    const row = (await db.query('SELECT components,signature FROM nft_console.marketplace_listings WHERE id=$1', [this.listing.id])).rows[0];
    await (await seaport.connect(buyer).fulfillOrder({ parameters: L.orderParameters(row.components), signature: row.signature }, '0x' + '0'.repeat(64), { value: PRICE })).wait();
    const sold = await svc.verify(actor, this.listing.id);
    expect(sold.state).to.equal('sold');
    expect(sold.settlement.buyer).to.equal(buyer.address);
    expect(sold.settlement.royaltyPaidWei).to.equal(sold.settlement.expectedRoyaltyWei);
    expect(sold.settlement.royaltyEvidence).to.equal('paid-in-settlement');
    await expect(svc.cancelPlan(actor, this.listing.id)).to.be.rejectedWith('LISTING_FINAL');
  });

  it('cancels on-chain through the wallet, rejecting a transaction that is not the exact cancel', async function () {
    const svc = service();
    const p = await svc.prepare(actor, { collection: collection.target, tokenId: '2', priceWei: PRICE.toString(), durationDays: 3 });
    const message = (await db.query('SELECT components FROM nft_console.marketplace_listings WHERE id=$1', [p.listing.id])).rows[0].components;
    const signed = await svc.sign(actor, p.listing.id, await signTyped({ ...p.typedData, message }));
    expect(signed.state).to.equal('valid_unindexed');
    const plan = await svc.cancelPlan(actor, p.listing.id);
    const wrong = await seller.sendTransaction({ to: stranger.address, value: 1 });
    await expect(svc.recordCancel(actor, p.listing.id, wrong.hash)).to.be.rejectedWith('NOT_THE_CANCEL_TRANSACTION');
    const tx = await seller.sendTransaction(plan.transaction); await tx.wait();
    const cancelled = await svc.recordCancel(actor, p.listing.id, tx.hash);
    expect(cancelled.state).to.equal('cancelled');
  });

  it('marketplace path: uncertain submission is recovered by hash lookup, only the identical order is re-posted, and listed requires an exact ACTIVE match', async function () {
    const posted = []; let store = null; let mode = 'timeout';
    const fake = {
      read: {
        getNFT: async () => ({ apiResponse: { nft: { collection: 'svc-test' } } }),
        getCollection: async () => ({ apiResponse: { fees: [{ fee: '2.5', recipient: owner.address, required: true }, { fee: 5, recipient: royaltyRecipient.address, required: true }, { fee: 1, recipient: stranger.address, required: false }], required_zone: null, opensea_url: 'https://opensea.io/collection/svc-test' } }),
        getOrder: async ({ hash }) => { if (!store || store.order_hash !== hash) { const e = new Error('nf'); e.code = 'NOT_FOUND'; throw e; } return { apiResponse: { order: store } }; },
      },
      post: { submit: async ({ order }) => {
        posted.push(JSON.stringify(order));
        if (mode === 'timeout') { const { ListingTransportError } = await import('../console/marketplace/post-listing.mjs'); throw new ListingTransportError('TIMEOUT'); }
        const hash = L.composeOrder({ market: { ...(await L.inspectMarketplace(ethers.provider, { chainId, seaport: seaport.target, conduitKey, zone: ethers.ZeroAddress })) }, seller: order.parameters.offerer, collection: order.parameters.offer[0].token, tokenId: order.parameters.offer[0].identifierOrCriteria, payments: order.parameters.consideration.map(c => ({ recipient: c.recipient, amountWei: c.startAmount })), counter: order.parameters.counter, startTime: order.parameters.startTime, endTime: order.parameters.endTime, salt: order.parameters.salt }).orderHash;
        store = { order_hash: hash, status: 'ACTIVE', remaining_quantity: 1, protocol_data: { parameters: order.parameters, signature: order.signature }, price: { current: { value: order.parameters.consideration.reduce((s, c) => s + BigInt(c.startAmount), 0n).toString() } } };
        return { orderHash: hash };
      } },
    };
    const svc = service(fake);
    const p = await svc.prepare(actor, { collection: collection.target, tokenId: '3', priceWei: PRICE.toString(), durationDays: 30 });
    expect(p.listing.review.payments.map(x => [x.role, x.amountWei])).to.deep.equal([
      ['seller-proceeds', (PRICE - PRICE * 250n / 10000n - PRICE * 500n / 10000n).toString()],
      ['marketplace-fee', (PRICE * 250n / 10000n).toString()],
      ['creator-royalty', (PRICE * 500n / 10000n).toString()]]);
    const message = (await db.query('SELECT components FROM nft_console.marketplace_listings WHERE id=$1', [p.listing.id])).rows[0].components;
    const first = await svc.sign(actor, p.listing.id, await signTyped({ ...p.typedData, message }));
    expect(first.state).to.equal('submission_uncertain');
    mode = 'accept';
    const recovered = await svc.verify(actor, p.listing.id);
    expect(recovered.state).to.equal('listed');
    expect(posted.length).to.equal(2);
    expect(posted[0]).to.equal(posted[1]);
    expect(recovered.observation.marketplace).to.deep.include({ status: 'ACTIVE', matches: true });
    // A marketplace record that differs from the reviewed order is never accepted as the listing.
    store.protocol_data.parameters = { ...store.protocol_data.parameters, endTime: '1' };
    expect((await svc.verify(actor, p.listing.id)).state).to.equal('inactive');
  });
});
