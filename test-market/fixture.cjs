// Disposable local marketplace stack: real Seaport 1.6 (npm seaport-core@1.6.6) and the pinned
// Limit Break v5 transfer validator. Never used against a public network.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const json = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
async function deployMarketStack(hre, deployer) {
  const {ContractFactory, Contract, getAddress} = hre.ethers;
  if (Number(await hre.network.provider.send('eth_chainId')) !== 31337) throw new Error('Local chain only.');
  const deploy = async (art, args = []) => { const c = await new ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
  const v = name => json(`artifacts-validator/${name}.json`);
  const eoa = json('artifacts-validator/EOARegistryRuntime.json');
  await hre.network.provider.send('hardhat_setCode', [eoa.address, eoa.runtime]);
  const mgmt = await deploy(v('ModuleCollectionAndListManagement')), bindings = await deploy(v('ModuleRulesetBindings'));
  const validator = await deploy(v('CreatorTokenTransferValidator'), [deployer.address, eoa.address, await mgmt.getAddress(), await bindings.getAddress(), 'CreatorTokenTransferValidator', '5']);
  const whitelist = await deploy(v('RulesetWhitelist'), [eoa.address]), vanilla = await deploy(v('RulesetVanilla'));
  for (const r of [whitelist, vanilla]) await (await validator.registerRuleset(await r.getAddress())).wait();
  await (await validator.bindRuleset(0, await whitelist.getAddress())).wait();
  await (await validator.bindRuleset(1, await vanilla.getAddress())).wait();
  await (await validator.bindRuleset(4, await whitelist.getAddress())).wait();
  const controller = await deploy(json('artifacts-market/seaport-core/src/conduit/ConduitController.sol/ConduitController.json'));
  const seaport = await deploy(json('artifacts-market/seaport-core/src/Seaport.sol/Seaport.json'), [await controller.getAddress()]);
  const conduitKey = deployer.address.toLowerCase() + '000000000000000000000001';
  await (await controller.createConduit(conduitKey, deployer.address)).wait();
  const [conduit] = await controller.getConduit(conduitKey);
  await (await controller.updateChannel(conduit, await seaport.getAddress(), true)).wait();
  const market = {chainId: 31337, slug: 'hardhat', available: true, seaport: getAddress(await seaport.getAddress()), seaportVersion: '1.6', conduitController: getAddress(await controller.getAddress()), conduitKey, validator: getAddress(await validator.getAddress()), signedZone: null, marketplace: 'fixture', openseaFeeRecipient: null};
  return {market, validator, seaport, controller, conduit: getAddress(conduit), whitelist: getAddress(await whitelist.getAddress())};
}
async function deployCollection(hre, signer, {name = 'Market Test', symbol = 'MKT', supply = 20, bps = 600, owner, minter, royalty}) {
  const art = json('artifacts/contracts/NFTCollection.sol/NFTCollection.json');
  const c = await new hre.ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(name, symbol, supply, bps, owner, minter, royalty);
  await c.waitForDeployment(); return c;
}
module.exports = {deployMarketStack, deployCollection};
