const { expect } = require('chai');
const { ethers } = require('hardhat');
const fixture = require('../test-marketplace/fixtures/seaport-1.6.json');

// Real EVM integration: canonical Seaport 1.6 source build, real ConduitController/Conduit,
// the project's NFTCollection and a whitelist-style policy validator. No mocked return values.
describe('Seaport listing core (real Seaport 1.6 on Hardhat)', function () {
  this.timeout(120000);
  let L, owner, seller, buyer, feeRecipient, royaltyRecipient, stranger;
  let seaport, controller, conduit, conduitKey, collection, validator, market;
  const ZERO32 = '0x' + '0'.repeat(64);
  const PRICE = ethers.parseEther('1');

  before(async function () {
    L = await import('../console/marketplace/listing.mjs');
    [owner, seller, buyer, feeRecipient, royaltyRecipient, stranger] = await ethers.getSigners();
    controller = await new ethers.ContractFactory(fixture.ConduitController.abi, fixture.ConduitController.bytecode, owner).deploy();
    await controller.waitForDeployment();
    seaport = await new ethers.ContractFactory(fixture.Seaport.abi, fixture.Seaport.bytecode, owner).deploy(await controller.getAddress());
    await seaport.waitForDeployment();
    conduitKey = owner.address.toLowerCase() + '0'.repeat(24);
    await (await controller.createConduit(conduitKey, owner.address)).wait();
    [conduit] = await controller.getConduit(conduitKey);
    await (await controller.updateChannel(conduit, await seaport.getAddress(), true)).wait();
    collection = await (await ethers.getContractFactory('NFTCollection')).deploy('Listing Test', 'LST', 10, 600, owner.address, seller.address, royaltyRecipient.address);
    await collection.waitForDeployment();
    validator = await (await ethers.getContractFactory('TestPolicyValidator')).deploy();
    await (await collection.connect(owner).setTransferValidator(await validator.getAddress())).wait();
    for (const id of [1, 2, 3, 4]) {
      await (await collection.connect(seller).mintWork(id, 'Work ' + id, 'ipfs://bafy' + id, ethers.id('m' + id), 'ipfs://rights' + id, ethers.id('r' + id))).wait();
    }
    market = await L.inspectMarketplace(ethers.provider, { chainId: 31337, name: 'Local', api: null, seaport: await seaport.getAddress(), conduitKey, zone: ethers.ZeroAddress });
  });

  function profile() { return { chainId: 31337, name: 'Local', api: null, seaport: market.seaport, conduitKey, zone: ethers.ZeroAddress }; }
  async function plan(tokenId, { price = PRICE, fees = [{ recipient: feeRecipient.address, bps: 250, label: 'Marketplace fee', required: true }], end = 86400 } = {}) {
    const token = await L.inspectToken(ethers.provider, { collection: await collection.getAddress(), tokenId: String(tokenId), seller: seller.address, operator: market.operator, priceWei: price.toString() });
    const payments = L.splitPayments({ priceWei: price.toString(), seller: seller.address, fees, royalty: token.royalty });
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const counter = await seaport.getCounter(seller.address);
    return { token, payments, order: L.composeOrder({ market, seller: seller.address, collection: await collection.getAddress(), tokenId: String(tokenId), payments, counter: counter.toString(), startTime: now - 60, endTime: now + end }) };
  }
  const sign = (o, who = seller) => who.signTypedData(o.domain, { OrderComponents: o.types.OrderComponents, OfferItem: o.types.OfferItem, ConsiderationItem: o.types.ConsiderationItem }, o.components);

  it('verifies Seaport 1.6 by its on-chain EIP-712 domain and resolves the real conduit', async function () {
    expect(market.operator).to.equal(ethers.getAddress(conduit));
    await expect(L.inspectMarketplace(ethers.provider, { ...profile(), seaport: await collection.getAddress() })).to.be.rejectedWith('SEAPORT_UNVERIFIED');
    await expect(L.inspectMarketplace(ethers.provider, { ...profile(), chainId: 1 })).to.be.rejectedWith('WRONG_NETWORK');
    await expect(L.inspectMarketplace(ethers.provider, { ...profile(), conduitKey: stranger.address.toLowerCase() + '0'.repeat(24) })).to.be.rejectedWith('CONDUIT_UNAVAILABLE');
  });

  it('reads the real transfer policy: blocked until the conduit is whitelisted, never via holder approval', async function () {
    let t = await L.inspectToken(ethers.provider, { collection: await collection.getAddress(), tokenId: '1', seller: seller.address, operator: market.operator, priceWei: PRICE.toString() });
    expect(t.policy.status).to.equal('blocked');
    expect(t.approved).to.equal(false);
    await (await validator.setOperator(market.operator, true)).wait();
    t = await L.inspectToken(ethers.provider, { collection: await collection.getAddress(), tokenId: '1', seller: seller.address, operator: market.operator, priceWei: PRICE.toString() });
    expect(t.policy.status).to.equal('compatible');
    expect(t.sellerOwns).to.equal(true);
    expect(t.royalty).to.deep.equal({ recipient: royaltyRecipient.address, amountWei: (PRICE * 600n / 10000n).toString() });
    expect(await collection.isApprovedForAll(seller.address, await validator.getAddress())).to.equal(false);
  });

  it('splits price exactly and rejects fee totals that consume the price', function () {
    const p = L.splitPayments({ priceWei: '1000', seller: seller.address, fees: [{ recipient: feeRecipient.address, bps: 250 }], royalty: { recipient: royaltyRecipient.address, amountWei: '60' } });
    expect(p.map(x => [x.role, x.amountWei])).to.deep.equal([['seller-proceeds', '915'], ['marketplace-fee', '25'], ['creator-royalty', '60']]);
    expect(() => L.splitPayments({ priceWei: '100', seller: seller.address, fees: [{ recipient: feeRecipient.address, bps: 5000 }], royalty: { recipient: royaltyRecipient.address, amountWei: '50' } })).to.throw('FEES_EXCEED_PRICE');
    expect(() => L.splitPayments({ priceWei: '0', seller: seller.address })).to.throw('PRICE');
  });

  it('matches Seaport getOrderHash, verifies the wallet signature and rejects tampering', async function () {
    const { order } = await plan(1);
    expect(await L.onChainOrderHash(ethers.provider, market, order.components)).to.equal(order.orderHash);
    const signature = await sign(order);
    expect((await L.verifyOrderSignature(ethers.provider, order, signature)).kind).to.equal('eoa');
    await expect(L.verifyOrderSignature(ethers.provider, order, await sign(order, stranger))).to.be.rejectedWith('WRONG_SIGNATURE');
    const changed = L.composeOrder({ market, seller: seller.address, collection: await collection.getAddress(), tokenId: '1', payments: order.components.consideration.map((c, i) => ({ recipient: c.recipient, amountWei: i === 0 ? '1' : c.startAmount })), counter: order.components.counter, startTime: order.components.startTime, endTime: order.components.endTime, salt: order.components.salt });
    await expect(L.verifyOrderSignature(ethers.provider, changed, signature)).to.be.rejectedWith('WRONG_SIGNATURE');
    expect(() => L.checkComponents(market, { ...order.components, conduitKey: ZERO32 })).to.throw('ORDER');
  });

  it('verifies ERC-1271 contract-wallet signatures against the exact digest', async function () {
    const key = ethers.Wallet.createRandom();
    const wallet = await (await ethers.getContractFactory('AuthWalletFixture')).deploy(key.address);
    const order = L.composeOrder({ market, seller: await wallet.getAddress(), collection: await collection.getAddress(), tokenId: '1', payments: [{ recipient: await wallet.getAddress(), amountWei: '5' }], counter: '0', startTime: 1, endTime: 1000 });
    const raw = key.signingKey.sign(order.digest).serialized;
    expect((await L.verifyOrderSignature(ethers.provider, order, raw)).kind).to.equal('contract');
    await (await wallet.setSigner(stranger.address)).wait();
    await expect(L.verifyOrderSignature(ethers.provider, order, raw)).to.be.rejectedWith('WRONG_SIGNATURE');
  });

  it('observes inactive before approval, valid and fillable after, then the real sale and royalty settlement', async function () {
    const { order, payments } = await plan(1);
    const signature = (await L.verifyOrderSignature(ethers.provider, order, await sign(order))).signature;
    let seen = await L.observeOrder(ethers.provider, market, { ...order, signature });
    expect(seen.state).to.equal('inactive');
    expect(seen.facts.approved).to.equal(false);
    const tx = L.approvalTransaction(await collection.getAddress(), market.operator);
    await (await seller.sendTransaction(tx)).wait();
    seen = await L.observeOrder(ethers.provider, market, { ...order, signature });
    expect(seen.state).to.equal('valid');
    expect(seen.facts.fill.status).to.equal('fillable');
    const from = await ethers.provider.getBlockNumber();
    const before = await ethers.provider.getBalance(royaltyRecipient.address);
    await (await seaport.connect(buyer).fulfillOrder({ parameters: L.orderParameters(order.components), signature }, ZERO32, { value: PRICE })).wait();
    seen = await L.observeOrder(ethers.provider, market, { ...order, signature });
    expect(seen.state).to.equal('sold');
    const settlement = await L.findSettlement(ethers.provider, market, { orderHash: order.orderHash, components: order.components, fromBlock: from, royaltyRecipient: royaltyRecipient.address });
    expect(settlement.buyer).to.equal(buyer.address);
    expect(settlement.currentOwner).to.equal(buyer.address);
    const royalty = payments.find(p => p.role === 'creator-royalty');
    expect(settlement.royaltyPaidWei).to.equal(royalty.amountWei);
    expect(settlement.royaltyEvidence).to.equal('paid-in-settlement');
    expect(await ethers.provider.getBalance(royaltyRecipient.address) - before).to.equal(BigInt(royalty.amountWei));
  });

  it('a blocked policy makes a signed order inactive and unfillable', async function () {
    const { order } = await plan(2);
    const signature = await sign(order);
    await (await validator.setOperator(market.operator, false)).wait();
    const seen = await L.observeOrder(ethers.provider, market, { ...order, signature });
    expect(seen.state).to.equal('inactive');
    expect(seen.facts.policy).to.equal('blocked');
    await (await validator.setOperator(market.operator, true)).wait();
    expect((await L.observeOrder(ethers.provider, market, { ...order, signature })).state).to.equal('valid');
  });

  it('on-chain cancellation is detected and the order can no longer fill', async function () {
    const { order } = await plan(2);
    const signature = await sign(order);
    await (await seller.sendTransaction(L.cancelTransaction(market, order.components))).wait();
    const seen = await L.observeOrder(ethers.provider, market, { ...order, signature });
    expect(seen.state).to.equal('cancelled');
    expect(seen.facts.fill.status).to.equal('not-simulated');
    await expect(seaport.connect(buyer).fulfillOrder({ parameters: L.orderParameters(order.components), signature }, ZERO32, { value: PRICE })).to.be.reverted;
  });

  it('expiry and direct wallet transfers are reported without claiming any royalty', async function () {
    const { order } = await plan(3, { end: 120 });
    const signature = await sign(order);
    await ethers.provider.send('evm_increaseTime', [600]);
    await ethers.provider.send('evm_mine', []);
    expect((await L.observeOrder(ethers.provider, market, { ...order, signature })).state).to.equal('expired');
    const fresh = (await plan(4)).order;
    const freshSig = await sign(fresh);
    const from = await ethers.provider.getBlockNumber();
    await (await collection.connect(seller).transferFrom(seller.address, stranger.address, 4)).wait();
    const seen = await L.observeOrder(ethers.provider, market, { ...fresh, signature: freshSig });
    expect(seen.state).to.equal('inactive');
    expect(seen.facts.sellerOwns).to.equal(false);
    expect(await L.findSettlement(ethers.provider, market, { orderHash: fresh.orderHash, components: fresh.components, fromBlock: from, royaltyRecipient: royaltyRecipient.address })).to.equal(null);
  });
});
