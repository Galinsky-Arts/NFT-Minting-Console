import http from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {ContractFactory,Contract,Interface,Transaction,getAddress} from 'ethers';
import {testWallets} from './fixtures.mjs';

/**
 * Disposable marketplace fixture: the REAL Limit Break validator (pinned source build), real Seaport 1.6 and
 * one NFTCollection per browser project. The signing relay only accepts raw transactions from the two
 * marketplace test wallets to these exact contracts, with zero value. A buyer helper fills an order with a
 * Hardhat signer so the browser can observe a genuine on-chain sale.
 */
export const MARKETPLACE_WALLETS=[8,9];
export const MARKETPLACE_PORT=4178;
export async function startMarketplaceFixture(hre){
  if(process.env.NFT_UI_FIXTURE!=='1'||hre.network.name!=='hardhat'||BigInt(await hre.network.provider.send('eth_chainId'))!==31337n)throw new Error('Disposable marketplace fixture only.');
  const lb=JSON.parse(await readFile(new URL('../test-marketplace/fixtures/limitbreak-validator.json',import.meta.url),'utf8'));
  const sp=JSON.parse(await readFile(new URL('../test-marketplace/fixtures/seaport-1.6.json',import.meta.url),'utf8'));
  const collectionArtifact=JSON.parse(await readFile(new URL('../artifacts/contracts/NFTCollection.sol/NFTCollection.json',import.meta.url),'utf8'));
  const signers=await hre.ethers.getSigners();const deployer=signers[0],buyer=signers[1];
  for(const i of MARKETPLACE_WALLETS)if(signers[i].address!==testWallets[i].address)throw new Error('Unexpected fixture signer.');
  const deploy=async(a,args=[],s=deployer)=>{const c=await new ContractFactory(a.abi,a.bytecode,s).deploy(...args);await c.waitForDeployment();return c;};
  await hre.network.provider.send('hardhat_setCode',[lb.EOARegistry.address,lb.EOARegistry.runtime]);
  const m1=await deploy(lb.ModuleCollectionAndListManagement),m2=await deploy(lb.ModuleRulesetBindings);
  const validator=await deploy(lb.Validator,[deployer.address,lb.EOARegistry.address,await m1.getAddress(),await m2.getAddress(),'','']);
  const whitelist=await deploy(lb.RulesetWhitelist,[lb.EOARegistry.address]);
  await (await validator.registerRuleset(await whitelist.getAddress())).wait();
  await (await validator.bindRuleset(4,await whitelist.getAddress())).wait();
  const controller=await deploy(sp.ConduitController);const seaport=await deploy(sp.Seaport,[await controller.getAddress()]);
  const conduitKey=deployer.address.toLowerCase()+'0'.repeat(24);
  await (await controller.createConduit(conduitKey,deployer.address)).wait();
  const [conduit]=await controller.getConduit(conduitKey);
  await (await controller.updateChannel(conduit,await seaport.getAddress(),true)).wait();
  const collections={};
  for(const i of MARKETPLACE_WALLETS){
    const w=signers[i];
    const c=await deploy(collectionArtifact,['Marketplace UI '+i,'MUI',10,500,w.address,w.address,testWallets[1].address],w);
    for(const id of [1,2])await (await c.mintWork(id,'Market work '+id,'ipfs://bafymarket/'+id+'.json','0x'+'ab'.repeat(32),'ipfs://bafymarket/rights.md','0x'+'cd'.repeat(32))).wait();
    collections[i]=getAddress(await c.getAddress());
  }
  const targets=new Set([await validator.getAddress(),await seaport.getAddress(),...Object.values(collections)].map(a=>a.toLowerCase()));
  const allowedSenders=new Set(MARKETPLACE_WALLETS.map(i=>testWallets[i].address.toLowerCase()));
  const seaportIface=new Interface(sp.Seaport.abi);
  const reads=new Set(['eth_chainId','eth_blockNumber','eth_getCode','eth_call','eth_getTransactionReceipt','eth_getTransactionCount','eth_estimateGas','eth_gasPrice','eth_getBalance','eth_getTransactionByHash']);
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='POST'||req.headers.origin||req.headers['x-nft-test']!=='disposable-local-only')throw new Error('Denied');
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>131072)throw new Error('Too large');chunks.push(chunk);}
      const {method,params=[]}=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result;
      if(method==='fixture_marketplace'){
        const i=params[0];if(!MARKETPLACE_WALLETS.includes(i))throw new Error('Unsupported');
        result={collection:collections[i],validator:await validator.getAddress(),seaport:await seaport.getAddress(),conduit:getAddress(conduit)};
      }else if(method==='fixture_fill'){
        const [parameters,signature]=params;
        const value=parameters.consideration.reduce((s,c)=>s+BigInt(c.startAmount),0n);
        const tx=await seaport.connect(buyer).fulfillOrder({parameters,signature},'0x'+'0'.repeat(64),{value});const r=await tx.wait();
        result={hash:r.hash,buyer:buyer.address};
      }else if(method==='eth_sendRawTransaction'){
        const tx=Transaction.from(params[0]);
        if(!tx.signature||tx.chainId!==31337n||tx.value!==0n||!tx.to||!allowedSenders.has(tx.from.toLowerCase())||!targets.has(tx.to.toLowerCase())||tx.gasLimit>12000000n)throw new Error('Only marketplace fixture transactions are accepted.');
        if(tx.to.toLowerCase()===(await seaport.getAddress()).toLowerCase()&&seaportIface.parseTransaction({data:tx.data})?.name!=='cancel')throw new Error('Only Seaport cancellation is relayed.');
        result=await hre.network.provider.send(method,params);await hre.network.provider.send('evm_mine');
      }else if(reads.has(method))result=await hre.network.provider.send(method,params);
      else throw new Error('Unsupported');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result}));
    }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Disposable marketplace fixture request rejected.'}));}
  });
  server.listen(MARKETPLACE_PORT,'127.0.0.1');await once(server,'listening');
  return {env:{SEAPORT_ADDRESS:await seaport.getAddress(),SEAPORT_CONDUIT_KEY:conduitKey,TRANSFER_VALIDATOR_ADDRESS:await validator.getAddress()},
    stop:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
void Contract;
