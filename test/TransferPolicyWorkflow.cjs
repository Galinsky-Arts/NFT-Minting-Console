const { expect } = require('chai');
const { ethers } = require('hardhat');
const seaportFixture = require('../test-marketplace/fixtures/seaport-1.6.json');
const lb = require('../test-marketplace/fixtures/limitbreak-validator.json');

// The OWNER policy workflow against the REAL Limit Break CreatorTokenTransferValidator (pinned commit,
// canonical source build) and real Seaport 1.6: plan -> wallet steps -> on-chain readback -> real sale.
describe('Transfer-policy workflow (real Limit Break validator + real Seaport)', function () {
  this.timeout(180000);
  let P, L, deployer, owner, minter, buyer, outsider, validator, whitelist, collection, seaport, market;

  before(async function () {
    P = await import('../console/marketplace/transfer-policy.mjs');
    L = await import('../console/marketplace/listing.mjs');
    [deployer, owner, minter, buyer, outsider] = await ethers.getSigners();
    await ethers.provider.send('hardhat_setCode', [lb.EOARegistry.address, lb.EOARegistry.runtime]);
    const f = (x, s = deployer) => new ethers.ContractFactory(x.abi, x.bytecode, s);
    const m1 = await f(lb.ModuleCollectionAndListManagement).deploy();
    const m2 = await f(lb.ModuleRulesetBindings).deploy();
    validator = await f(lb.Validator).deploy(deployer.address, lb.EOARegistry.address, await m1.getAddress(), await m2.getAddress(), '', '');
    whitelist = await f(lb.RulesetWhitelist).deploy(lb.EOARegistry.address);
    await (await validator.registerRuleset(await whitelist.getAddress())).wait();
    await (await validator.bindRuleset(4, await whitelist.getAddress())).wait();
    const controller = await f(seaportFixture.ConduitController).deploy();
    seaport = await f(seaportFixture.Seaport).deploy(await controller.getAddress());
    const key = deployer.address.toLowerCase() + '0'.repeat(24);
    await (await controller.createConduit(key, deployer.address)).wait();
    const [conduit] = await controller.getConduit(key);
    await (await controller.updateChannel(conduit, await seaport.getAddress(), true)).wait();
    market = await L.inspectMarketplace(ethers.provider, { chainId: 31337, seaport: await seaport.getAddress(), conduitKey: key, zone: ethers.ZeroAddress });
    collection = await (await ethers.getContractFactory('NFTCollection')).deploy('Policy Test', 'POL', 10, 700, owner.address, minter.address, owner.address);
    for (const id of [1, 2, 3]) await (await collection.connect(minter).mintWork(id, 'W', 'ipfs://m', ethers.id('m' + id), 'ipfs://r', ethers.id('r' + id))).wait();
  });

  const inspect = (listId = null, who = owner) => P.inspectPolicy(ethers.provider, { collection: collection.target, owner: who.address, validator: validator.target, market, listId, name: 'Policy Test list' });

  it('only the collection OWNER can plan the policy', async function () {
    await expect(inspect(null, outsider)).to.be.rejectedWith('NOT_COLLECTION_OWNER');
  });

  it('plans, executes and reads back the reviewed policy exactly (ruleset 255, whitelist, options 6)', async function () {
    let plan = await inspect();
    expect(plan.configured).to.equal(false);
    expect(plan.steps.map(s => s.id)).to.deep.equal(['set-validator', 'create-list', 'set-ruleset']);
    for (const step of plan.steps.filter(s => s.id !== 'create-list')) await (await owner.sendTransaction({ to: step.to, data: step.data })).wait();
    const create = plan.steps.find(s => s.id === 'create-list');
    const tx = await owner.sendTransaction({ to: create.to, data: create.data }); await tx.wait();
    await expect(P.listIdFromReceipt(ethers.provider, { hash: tx.hash, owner: outsider.address, validator: validator.target })).to.be.rejectedWith('NOT_THE_LIST_TRANSACTION');
    const listId = await P.listIdFromReceipt(ethers.provider, { hash: tx.hash, owner: owner.address, validator: validator.target });
    plan = await inspect(listId);
    expect(plan.steps.map(s => s.id)).to.deep.equal(['apply-list', 'add-marketplace']);
    for (const step of plan.steps) await (await owner.sendTransaction({ to: step.to, data: step.data })).wait();
    plan = await inspect();
    expect(plan.configured).to.equal(true);
    expect(plan.policy).to.deep.include({ rulesetId: 255, listId, customRuleset: await whitelist.getAddress(), globalOptions: 0, rulesetOptions: 6 });
    expect(plan.listOwner).to.equal(owner.address);
    expect(plan.marketplace).to.deep.include({ account: market.operator, listType: 1, listed: true });
    // A list someone else owns can never be adopted.
    const other = await validator.connect(outsider).createList('not yours'); const r = await other.wait();
    const otherId = await P.listIdFromReceipt(ethers.provider, { hash: r.hash, owner: outsider.address, validator: validator.target });
    await expect(inspect(otherId)).to.be.rejectedWith('LIST_NOT_OWNED');
  });

  it('the real validator now allows the marketplace conduit, blocks other operators and never holds approval', async function () {
    const token = await L.inspectToken(ethers.provider, { collection: collection.target, tokenId: '1', seller: minter.address, operator: market.operator, priceWei: '1000' });
    expect(token.policy.status).to.equal('compatible');
    const blocked = await L.transferPolicy(ethers.provider, { collection: collection.target, tokenId: 1n, from: minter.address, operator: outsider.address });
    expect(blocked.status).to.equal('blocked');
    expect(await collection.isApprovedForAll(minter.address, validator.target)).to.equal(false);
    // A non-listed operator with approval still cannot move the token.
    await (await collection.connect(minter).setApprovalForAll(outsider.address, true)).wait();
    await expect(collection.connect(outsider).transferFrom(minter.address, outsider.address, 3)).to.be.reverted;
    await (await collection.connect(minter).setApprovalForAll(outsider.address, false)).wait();
    // Holders keep direct transfers (OTC) under options 6.
    await (await collection.connect(minter).transferFrom(minter.address, buyer.address, 3)).wait();
    expect(await collection.ownerOf(3)).to.equal(buyer.address);
  });

  it('a real Seaport sale settles through the real validator with royalty paid', async function () {
    const price = ethers.parseEther('2');
    const token = await L.inspectToken(ethers.provider, { collection: collection.target, tokenId: '1', seller: minter.address, operator: market.operator, priceWei: price.toString() });
    const payments = L.splitPayments({ priceWei: price.toString(), seller: minter.address, royalty: token.royalty });
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const order = L.composeOrder({ market, seller: minter.address, collection: collection.target, tokenId: '1', payments, counter: '0', startTime: now - 10, endTime: now + 3600 });
    const signature = await minter.signTypedData(order.domain, { OrderComponents: order.types.OrderComponents, OfferItem: order.types.OfferItem, ConsiderationItem: order.types.ConsiderationItem }, order.components);
    await (await minter.sendTransaction(L.approvalTransaction(collection.target, market.operator))).wait();
    const seen = await L.observeOrder(ethers.provider, market, { ...order, signature });
    expect(seen.state).to.equal('valid');
    expect(seen.facts.fill.status).to.equal('fillable');
    const from = await ethers.provider.getBlockNumber();
    await (await seaport.connect(buyer).fulfillOrder({ parameters: L.orderParameters(order.components), signature }, '0x' + '0'.repeat(64), { value: price })).wait();
    const settlement = await L.findSettlement(ethers.provider, market, { orderHash: order.orderHash, components: order.components, fromBlock: from, royaltyRecipient: owner.address });
    expect(settlement.currentOwner).to.equal(buyer.address);
    expect(settlement.royaltyPaidWei).to.equal((price * 700n / 10000n).toString());
  });

  it('zone-restricted orders are compatible only when the zone is a listed authorizer', async function () {
    const zone = await seaport.getAddress(); // any deployed contract stands in for an authorizer address here
    const before = await L.transferPolicy(ethers.provider, { collection: collection.target, tokenId: 1n, from: buyer.address, operator: outsider.address, zone });
    expect(before.status).to.equal('blocked');
    const plan = await inspect();
    await (await validator.connect(owner).addAccountsToList(plan.listId, 2, [zone])).wait();
    const after = await L.transferPolicy(ethers.provider, { collection: collection.target, tokenId: 1n, from: buyer.address, operator: outsider.address, zone });
    expect(after.status).to.equal('compatible-via-authorizer');
  });

  it('fails closed when the policy is changed away from the reviewed configuration', async function () {
    await (await validator.connect(owner).setRulesetOfCollection(collection.target, 255, await whitelist.getAddress(), 0, 0)).wait();
    const plan = await inspect();
    expect(plan.configured).to.equal(false);
    expect(plan.steps.map(s => s.id)).to.deep.equal(['set-ruleset']);
  });
});
