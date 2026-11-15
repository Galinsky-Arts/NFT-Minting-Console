const assert = require('node:assert/strict');
const { ethers } = require('hardhat');

describe('Live collection inventory (read-only, ported from #62)', function () {
  let I, owner, minter, holder, collection;
  const h = s => ethers.keccak256(ethers.toUtf8Bytes(s));
  before(async function () {
    I = await import('../console/collections/inventory.mjs');
    [owner, minter, holder] = await ethers.getSigners();
    collection = await (await ethers.getContractFactory('NFTCollection')).deploy('Inventory Test', 'INV', 150, 600, owner.address, minter.address, owner.address);
    await collection.waitForDeployment();
    const c = collection.connect(minter);
    await (await c.mintWork(1, 'First work', 'ipfs://meta-1', h('media-1'), 'ipfs://rights', h('rights'))).wait();
    await (await c.mintWork(3, 'Third work', 'ipfs://meta-3', h('media-3'), 'ipfs://rights', h('rights'))).wait();
    await (await c.mintWork(120, 'Second page', 'ipfs://meta-120', h('media-120'), 'ipfs://rights', h('rights'))).wait();
  });

  it('reads immutable settings and only minted tokens, page by page, at one block', async function () {
    const inv = await I.readCollectionInventory(ethers.provider, (await collection.getAddress()).toLowerCase(), { chainId: 31337 });
    assert.equal(inv.collection, await collection.getAddress());
    assert.deepEqual([inv.name, inv.symbol, inv.seriesSize, inv.totalMinted, inv.remainingSupply, inv.royaltyBps, inv.mintingClosed], ['Inventory Test', 'INV', '150', '3', '147', 600, false]);
    assert.equal(inv.owner, owner.address); assert.equal(inv.minter, minter.address); assert.equal(inv.royaltyRecipient, owner.address);
    assert.deepEqual(inv.tokens.map(t => t.tokenId), ['1', '3']); assert.equal(inv.hasMore, true); assert.equal(inv.pageSize, 100);
    assert.equal(inv.tokens[0].title, 'First work'); assert.equal(inv.tokens[0].metadataURI, 'ipfs://meta-1'); assert.equal(inv.tokens[0].mediaSHA256, h('media-1'));
    assert.equal(inv.tokens[0].rightsSHA256, h('rights')); assert.equal(typeof inv.block, 'number');
    const second = await I.readCollectionInventory(ethers.provider, await collection.getAddress(), { page: 1 });
    assert.deepEqual(second.tokens.map(t => t.tokenId), ['120']); assert.equal(second.hasMore, false);
  });

  it('fails closed for invalid input, empty addresses and non-collection contracts', async function () {
    const code = async (p, ...a) => { try { await I.readCollectionInventory(ethers.provider, ...a); return 'ok'; } catch (e) { assert.ok(e instanceof I.InventoryError); return e.code; } };
    assert.equal(await code(null, 'not-an-address'), 'INVALID_ADDRESS');
    assert.equal(await code(null, await collection.getAddress(), { page: -1 }), 'INVALID_PAGE');
    assert.equal(await code(null, await collection.getAddress(), { page: 1.5 }), 'INVALID_PAGE');
    assert.equal(await code(null, holder.address), 'COLLECTION_NOT_DEPLOYED');
    const other = await (await ethers.getContractFactory('TestPolicyValidator')).deploy();
    assert.equal(await code(null, await other.getAddress()), 'NOT_AN_NFT_CONSOLE_COLLECTION');
  });
});
