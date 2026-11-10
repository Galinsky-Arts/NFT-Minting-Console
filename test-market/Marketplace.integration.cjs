const {expect} = require('chai');
const hre = require('hardhat');
const {deployMarketStack, deployCollection} = require('./fixture.cjs');
const H = n => hre.ethers.sha256(hre.ethers.toUtf8Bytes(n));
describe('Real Seaport 1.6 + Limit Break v5 validator marketplace workflow', function () {
  this.timeout(120000);
  let m, owner, minter, royalty, buyer, other, fee, stack, collection, policy, listing;
  before(async () => {
    [owner, minter, royalty, buyer, other, fee] = await hre.ethers.getSigners();
    policy = await import('../console/market/policy.mjs'); listing = await import('../console/market/listing.mjs');
    stack = await deployMarketStack(hre, owner); m = stack.market;
    collection = await deployCollection(hre, owner, {owner: owner.address, minter: minter.address, royalty: royalty.address});
    const works = [1, 2, 3].map(i => ({tokenId: i, title: 'Work ' + i, metadataURI: 'ipfs://bafy' + i, mediaHash: H('m' + i), rightsURI: 'ipfs://bafr' + i, rightsHash: H('r' + i)}));
    await (await collection.connect(minter).mintWorksBatch(works)).wait();
  });
  async function runSteps(steps, signer) {
    const receipts = [];
    for (const s of steps) { expect(s.from).to.equal(signer.address); receipts.push(await (await signer.sendTransaction({to: s.to, data: s.data})).wait()); }
    return receipts;
  }
  it('plans, executes and reads back the whitelist ruleset-255 / options-6 policy fail-closed', async () => {
    const addr = await collection.getAddress(), args = {collection: addr, validator: m.validator, operators: [stack.conduit]};
    let state = await policy.inspectPolicy(hre.ethers.provider, args);
    expect(state.configured).to.equal(false);
    let steps = policy.planPolicySteps(state, {...args, label: 'Market Test list'});
    expect(steps.map(s => s.id)).to.deep.equal(['set-validator', 'create-list']);
    await expect(minter.sendTransaction({to: steps[0].to, data: steps[0].data})).to.be.reverted; // only OWNER
    const receipts = await runSteps(steps, owner);
    const listId = policy.createdListId(receipts.at(-1), m.validator);
    state = await policy.inspectPolicy(hre.ethers.provider, {...args, candidateListId: listId});
    steps = policy.planPolicySteps(state, args);
    expect(steps.map(s => s.id)).to.deep.equal(['whitelist-operators', 'apply-list', 'set-ruleset']);
    await runSteps(steps, owner);
    state = await policy.inspectPolicy(hre.ethers.provider, args);
    expect(state.configured).to.equal(true);
    expect(state.policy).to.include({rulesetId: 255, rulesetOptions: 6, globalOptions: 0});
    expect(state.policy.customRuleset).to.equal(stack.whitelist);
    expect(policy.planPolicySteps(state, args)).to.deep.equal([]);
    const sim = await policy.simulateMarketplaceTransfer(hre.ethers.provider, {validator: m.validator, collection: addr, operator: stack.conduit, from: minter.address, tokenId: 1});
    expect(sim).to.deep.equal({marketplaceOperatorAllowed: true, unlistedOperatorBlocked: true, directHolderTransferAllowed: true});
    // Validator holds no blanket operator approval over holders.
    expect(await collection.isApprovedForAll(minter.address, m.validator)).to.equal(false);
  });
  async function signedListing(tokenId, priceWei, seller = minter) {
    const facts = await listing.inspectToken(hre.ethers.provider, m, {collection: await collection.getAddress(), tokenId, seller: seller.address, priceWei});
    expect(facts.sellerIsOwner).to.equal(true);
    if (!facts.approval.conduitApprovedForAll) { const tx = listing.approvalTransaction(facts.collection, seller.address, facts.conduit); await (await seller.sendTransaction({to: tx.to, data: tx.data})).wait(); }
    const payments = listing.feeSchedule({priceWei, seller: seller.address, royalty: {recipient: facts.royalty.recipient, bps: facts.royalty.bpsAtPrice}, marketplaceFees: [{role: 'marketplace', recipient: fee.address, bps: 250}]});
    const now = (await hre.ethers.provider.getBlock('latest')).timestamp;
    const order = listing.buildOrder(m, {seller: seller.address, collection: facts.collection, tokenId, payments, counter: facts.counter, startTime: now - 60, endTime: now + 86400});
    order.signature = listing.verifyOrderSignature(order, await seller.signTypedData(order.domain, order.types, order.parameters));
    return {order, payments, facts};
  }
  it('signs, verifies and settles a real Seaport sale with royalty evidence', async () => {
    const price = hre.ethers.parseEther('1');
    const {order, payments, facts} = await signedListing(1, price);
    expect(facts.policy.marketplaceOperatorAllowed).to.equal(true);
    expect(payments.map(p => [p.role, p.amountWei])).to.deep.equal([['seller', '915000000000000000'], ['marketplace', '25000000000000000'], ['royalty', '60000000000000000']]);
    const check = await listing.verifyOrderOnChain(hre.ethers.provider, m, order, {now: (await hre.ethers.provider.getBlock('latest')).timestamp});
    expect(check.problems).to.deep.equal([]); expect(check.facts.royaltyConsideration).to.equal(true);
    // A forged signature by another wallet is rejected.
    expect(() => listing.verifyOrderSignature(order, '0x' + '11'.repeat(65))).to.throw();
    const before = await hre.ethers.provider.getBlockNumber();
    const royaltyBefore = await hre.ethers.provider.getBalance(royalty.address), feeBefore = await hre.ethers.provider.getBalance(fee.address);
    await (await stack.seaport.connect(buyer).fulfillOrder({parameters: order.parameters, signature: order.signature}, '0x' + '0'.repeat(64), {value: price})).wait();
    expect(await collection.ownerOf(1)).to.equal(buyer.address);
    const sale = await listing.inspectSale(hre.ethers.provider, m, order, {fromBlock: before, royaltyRecipient: royalty.address});
    expect(sale.buyer).to.equal(buyer.address); expect(sale.royaltyPaidWei).to.equal('60000000000000000');
    expect(await hre.ethers.provider.getBalance(royalty.address) - royaltyBefore).to.equal(60000000000000000n);
    expect(await hre.ethers.provider.getBalance(fee.address) - feeBefore).to.equal(25000000000000000n);
    const after = await listing.verifyOrderOnChain(hre.ethers.provider, m, order);
    expect(after.problems).to.include('FILLED'); expect(after.problems).to.include('SELLER_NO_LONGER_OWNS');
  });
  it('cancels on-chain and invalidates; a replacement order at a new price stays independent', async () => {
    const {order} = await signedListing(2, hre.ethers.parseEther('2'));
    const tx = listing.cancelTransaction(m, order);
    await expect(other.sendTransaction({to: tx.to, data: tx.data})).to.be.reverted; // only offerer may cancel
    await (await minter.sendTransaction({to: tx.to, data: tx.data})).wait();
    expect((await listing.verifyOrderOnChain(hre.ethers.provider, m, order)).problems).to.include('CANCELLED');
    const {order: replacement} = await signedListing(2, hre.ethers.parseEther('1.5'));
    expect(replacement.orderHash).to.not.equal(order.orderHash);
    expect((await listing.verifyOrderOnChain(hre.ethers.provider, m, replacement)).problems).to.deep.equal([]);
    await expect(stack.seaport.connect(buyer).fulfillOrder({parameters: order.parameters, signature: order.signature}, '0x' + '0'.repeat(64), {value: hre.ethers.parseEther('2')})).to.be.reverted;
  });
  it('a permitted direct wallet transfer invalidates the listing and produces no royalty evidence', async () => {
    const {order} = await signedListing(3, hre.ethers.parseEther('1'));
    const before = await hre.ethers.provider.getBlockNumber();
    await (await collection.connect(minter).transferFrom(minter.address, other.address, 3)).wait();
    const check = await listing.verifyOrderOnChain(hre.ethers.provider, m, order);
    expect(check.problems).to.include('SELLER_NO_LONGER_OWNS');
    expect(await listing.inspectSale(hre.ethers.provider, m, order, {fromBlock: before, royaltyRecipient: royalty.address})).to.equal(null);
  });
  it('revoked approval and an incremented counter are detected', async () => {
    const {order} = await signedListing(2, hre.ethers.parseEther('3'));
    await (await collection.connect(minter).setApprovalForAll(stack.conduit, false)).wait();
    expect((await listing.verifyOrderOnChain(hre.ethers.provider, m, order)).problems).to.include('APPROVAL_MISSING');
    await (await stack.seaport.connect(minter).incrementCounter()).wait();
    expect((await listing.verifyOrderOnChain(hre.ethers.provider, m, order)).problems).to.include('COUNTER_INCREMENTED');
  });
  it('an unlisted operator contract cannot move tokens even with holder approval', async () => {
    expect((await policy.simulateMarketplaceTransfer(hre.ethers.provider, {validator: m.validator, collection: await collection.getAddress(), operator: stack.conduit, from: buyer.address, tokenId: 1})).unlistedOperatorBlocked).to.equal(true);
  });
});
