const assert = require('node:assert/strict');
const { ethers } = require('hardhat');
const fs = require('node:fs');
const path = require('node:path');
const sp = require('../test-marketplace/fixtures/seaport-1.6.json');
const lb = require('../test-marketplace/fixtures/limitbreak-validator.json');

// Actual upstream Safe 1.4.1 (2-of-3) as collection OWNER, minter and seller: policy setup executed through
// Safe transactions, a Seaport order authorized by Safe owner signatures (ERC-1271), a real sale and a
// Safe-executed cancellation, all verified by the console's own code paths.
describe('Safe 1.4.1 as collection OWNER and marketplace seller', function () {
  this.timeout(180000);
  let P, L, owners, safe, wallet, collection, validator, whitelist, seaport, market;
  const art = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', name), 'utf8'));
  const TX_TYPES = { SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] };
  const packed = async (sign) => ethers.concat((await Promise.all(owners.slice(0, 2).map(async s => ({ a: s.address.toLowerCase(), sig: await sign(s) }))))
    .sort((x, y) => x.a.localeCompare(y.a)).map(x => x.sig));
  async function exec(to, data) {
    const tx = { to, value: 0, data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: await safe.nonce() };
    const sigs = await packed(s => s.signTypedData({ chainId: 31337, verifyingContract: wallet }, TX_TYPES, tx));
    const sent = await safe.connect(owners[2]).execTransaction(tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, sigs);
    const r = await sent.wait(); assert.equal(r.status, 1); return r.hash;
  }

  before(async function () {
    P = await import('../console/marketplace/transfer-policy.mjs');
    L = await import('../console/marketplace/listing.mjs');
    owners = await ethers.getSigners();
    const singleton = await (await ethers.getContractFactory('Safe')).deploy();
    const handler = await (await ethers.getContractFactory('CompatibilityFallbackHandler')).deploy();
    const proxy = await (await ethers.getContractFactory('SafeProxy')).deploy(await singleton.getAddress());
    safe = await ethers.getContractAt('Safe', await proxy.getAddress()); wallet = await proxy.getAddress();
    await (await safe.setup(owners.slice(0, 3).map(x => x.address), 2, ethers.ZeroAddress, '0x', await handler.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress)).wait();
    const f = (a, args = []) => new ethers.ContractFactory(a.abi, a.bytecode, owners[0]).deploy(...args).then(c => c.waitForDeployment());
    await ethers.provider.send('hardhat_setCode', [lb.EOARegistry.address, lb.EOARegistry.runtime]);
    const m1 = await f(lb.ModuleCollectionAndListManagement), m2 = await f(lb.ModuleRulesetBindings);
    validator = await f(lb.Validator, [owners[0].address, lb.EOARegistry.address, await m1.getAddress(), await m2.getAddress(), '', '']);
    whitelist = await f(lb.RulesetWhitelist, [lb.EOARegistry.address]);
    await (await validator.registerRuleset(await whitelist.getAddress())).wait(); await (await validator.bindRuleset(4, await whitelist.getAddress())).wait();
    const controller = await f(sp.ConduitController); seaport = await f(sp.Seaport, [await controller.getAddress()]);
    const key = owners[0].address.toLowerCase() + '0'.repeat(24);
    await (await controller.createConduit(key, owners[0].address)).wait();
    const [conduit] = await controller.getConduit(key); await (await controller.updateChannel(conduit, await seaport.getAddress(), true)).wait();
    market = await L.inspectMarketplace(ethers.provider, { chainId: 31337, seaport: await seaport.getAddress(), conduitKey: key, zone: ethers.ZeroAddress });
    const c = art('NFTCollection.sol/NFTCollection.json');
    collection = await f(c, ['Safe Collection', 'SAFE', 5, 800, wallet, wallet, owners[4].address]);
    await exec(await collection.getAddress(), collection.interface.encodeFunctionData('mintWork', [1, 'Safe work', 'ipfs://s/1', ethers.id('m'), 'ipfs://s/r', ethers.id('r')]));
    await exec(await collection.getAddress(), collection.interface.encodeFunctionData('mintWork', [2, 'Safe work 2', 'ipfs://s/2', ethers.id('m2'), 'ipfs://s/r', ethers.id('r2')]));
  });

  it('configures the reviewed transfer policy through Safe transactions and reads it back', async function () {
    const inspect = listId => P.inspectPolicy(ethers.provider, { collection: collection.target, owner: wallet, validator: validator.target, market, listId, name: 'Safe list' });
    let plan = await inspect(null);
    const batch = P.safeBatch({ chainId: 31337, safe: wallet, steps: plan.steps });
    assert.equal(batch.meta.createdFromSafeAddress, ethers.getAddress(wallet));
    let listId = null;
    for (const step of plan.steps) { const hash = await exec(step.to, step.data); if (step.id === 'create-list') listId = await P.listIdFromReceipt(ethers.provider, { hash, owner: wallet, validator: validator.target }); }
    plan = await inspect(listId);
    for (const step of plan.steps) await exec(step.to, step.data);
    plan = await inspect(null);
    assert.equal(plan.configured, true);
    assert.deepEqual([plan.policy.rulesetId, plan.policy.rulesetOptions, plan.listOwner], [255, 6, ethers.getAddress(wallet)]);
  });

  it('a Seaport order signed by Safe owners (ERC-1271) verifies, fills for real and pays the royalty', async function () {
    const price = ethers.parseEther('3');
    await exec(collection.target, collection.interface.encodeFunctionData('setApprovalForAll', [market.operator, true]));
    const token = await L.inspectToken(ethers.provider, { collection: collection.target, tokenId: '1', seller: wallet, operator: market.operator, priceWei: price.toString() });
    assert.equal(token.policy.status, 'compatible'); assert.equal(token.approved, true);
    const payments = L.splitPayments({ priceWei: price.toString(), seller: wallet, royalty: token.royalty });
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const order = L.composeOrder({ market, seller: wallet, collection: collection.target, tokenId: '1', payments, counter: '0', startTime: now - 5, endTime: now + 3600 });
    const safeSig = await packed(s => s.signTypedData({ chainId: 31337, verifyingContract: wallet }, { SafeMessage: [{ name: 'message', type: 'bytes' }] }, { message: order.digest }));
    const verified = await L.verifyOrderSignature(ethers.provider, order, safeSig);
    assert.equal(verified.kind, 'contract');
    const oneOwner = await owners[0].signTypedData({ chainId: 31337, verifyingContract: wallet }, { SafeMessage: [{ name: 'message', type: 'bytes' }] }, { message: order.digest });
    await assert.rejects(L.verifyOrderSignature(ethers.provider, order, oneOwner), /WRONG_SIGNATURE/, 'below the Safe threshold is refused');
    const seen = await L.observeOrder(ethers.provider, market, { ...order, signature: safeSig });
    assert.equal(seen.state, 'valid'); assert.equal(seen.facts.fill.status, 'fillable');
    const from = await ethers.provider.getBlockNumber();
    await (await seaport.connect(owners[5]).fulfillOrder({ parameters: L.orderParameters(order.components), signature: safeSig }, '0x' + '0'.repeat(64), { value: price })).wait();
    const settled = await L.findSettlement(ethers.provider, market, { orderHash: order.orderHash, components: order.components, fromBlock: from, royaltyRecipient: owners[4].address });
    assert.equal(settled.currentOwner, owners[5].address);
    assert.equal(settled.royaltyPaidWei, (price * 800n / 10000n).toString());
  });

  it('a Safe-executed Seaport cancellation is detected on-chain', async function () {
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const order = L.composeOrder({ market, seller: wallet, collection: collection.target, tokenId: '2', payments: [{ recipient: wallet, amountWei: '1000' }], counter: '0', startTime: now - 5, endTime: now + 3600 });
    const cancel = L.cancelTransaction(market, order.components);
    const hash = await exec(cancel.to, cancel.data);
    const tx = await ethers.provider.getTransaction(hash);
    assert.equal(ethers.getAddress(tx.to), ethers.getAddress(wallet));
    assert.ok(tx.data.toLowerCase().includes(cancel.data.slice(2).toLowerCase()), 'the Safe execution embeds the exact cancel calldata');
    const seen = await L.observeOrder(ethers.provider, market, { ...order, signature: null });
    assert.equal(seen.state, 'cancelled');
  });
});
