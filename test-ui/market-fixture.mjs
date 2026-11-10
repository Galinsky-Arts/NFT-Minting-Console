import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {Transaction,getAddress} from 'ethers';
import {testWallets} from './fixtures.mjs';
const require=createRequire(import.meta.url);
const {deployMarketStack,deployCollection}=require('../test-market/fixture.cjs');
const H=n=>'0x'+Buffer.from(n.padEnd(32,'_').slice(0,32)).toString('hex');
/** Disposable local market: real Seaport 1.6, real LB v5 validator, one collection per market test wallet.
 * The loopback bridge accepts only signed transactions from those wallets to those contracts, plus a buyer fill. */
export async function startMarketFixture(hre){
  if(process.env.NFT_UI_FIXTURE!=='1'||BigInt(await hre.network.provider.send('eth_chainId'))!==31337n)throw new Error('Disposable market fixture only.');
  const signers=await hre.ethers.getSigners(),deployer=signers[19],buyer=signers[18];
  const stack=await deployMarketStack(hre,deployer),contexts=new Map();
  for(const index of [8,9]){
    const s=signers[index];if(s.address!==testWallets[index].address)throw new Error('Unexpected market signer.');
    const c=await deployCollection(hre,s,{name:'Market Browser '+index,symbol:'MKB',supply:20,bps:600,owner:s.address,minter:s.address,royalty:testWallets[2].address});
    await (await c.mintWorksBatch([1,2,3].map(t=>({tokenId:t,title:`Market work ${t}`,metadataURI:`ipfs://bafkreimarket${index}x${t}`,mediaHash:H('m'+t),rightsURI:'ipfs://bafkreirights',rightsHash:H('r'+t)})))).wait();
    contexts.set(index,{collection:getAddress(await c.getAddress())});
  }
  const allowedTo=index=>new Set([contexts.get(index).collection,stack.market.validator,stack.market.seaport].map(a=>a.toLowerCase()));
  const reads=new Set(['eth_chainId','eth_blockNumber','eth_getCode','eth_call','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getTransactionCount','eth_estimateGas','eth_gasPrice','eth_getBalance']);
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='POST'||req.headers.origin||req.headers['x-nft-test']!=='disposable-local-only')throw new Error('Denied');
      const chunks=[];for await(const c of req)chunks.push(c);const {method,params=[]}=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result;
      if(method==='market_context'){const index=params[0];if(!contexts.has(index))throw new Error('Unknown');result={...contexts.get(index),seaport:stack.market.seaport,validator:stack.market.validator,conduit:stack.conduit};}
      else if(method==='market_buy'){
        const order=params[0],value=order.parameters.consideration.reduce((a,c)=>a+BigInt(c.startAmount),0n);
        const tx=await stack.seaport.connect(buyer).fulfillOrder({parameters:{...order.parameters,totalOriginalConsiderationItems:order.parameters.consideration.length},signature:order.signature},'0x'+'0'.repeat(64),{value});
        result=(await tx.wait()).hash;
      }else if(method==='eth_sendRawTransaction'){
        const tx=Transaction.from(params[0]),index=[8,9].find(i=>testWallets[i].address.toLowerCase()===tx.from?.toLowerCase());
        if(index===undefined||!tx.to||!allowedTo(index).has(tx.to.toLowerCase())||tx.value!==0n||tx.chainId!==31337n)throw new Error('Only market fixture transactions are accepted.');
        result=await hre.network.provider.send(method,params);await hre.network.provider.send('evm_mine');
      }else if(reads.has(method))result=await hre.network.provider.send(method,params);
      else throw new Error('Unsupported');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result}));
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(e.message).slice(0,300)}));}
  });
  server.listen(4179,'127.0.0.1');await once(server,'listening');
  return {market:stack.market,stop:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
