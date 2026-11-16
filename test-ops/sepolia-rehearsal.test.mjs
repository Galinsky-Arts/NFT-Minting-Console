/* global fetch, setTimeout */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
import {assertNoSigningMaterial,rpcFrom,sepoliaPreflight,verifyReceipts,serveSigner,signerPage,SEPOLIA} from '../scripts/rehearse-sepolia.mjs';

const VERSION=ethers.id('nft-console.collection-factory.v2'),CODE_ID=ethers.id('collection-code'),RUNTIME='0x6080604052';
const artifacts={factory:{bytecode:'0x60806040',deployedBytecode:RUNTIME},creationCodeId:CODE_ID};
const iface=new ethers.Interface(['function FACTORY_VERSION() view returns(bytes32)','function COLLECTION_CREATION_CODE_ID() view returns(bytes32)']);
const WALLET='0x'+'ab'.repeat(20),FACTORY='0x'+'cd'.repeat(20);

/** Read-only fake: any attempt to send or sign fails the test. */
function fakeProvider({chainId=SEPOLIA,code=RUNTIME,version=VERSION,codeId=CODE_ID,balance=10n**18n,receipts={}}={}){
  const used=[];
  const p={
    used,
    getNetwork:async()=>{used.push('chainId');return {chainId};},
    getBlock:async()=>{used.push('block');return {number:7000000,timestamp:BigInt(Math.floor(Date.now()/1000)-12)};},
    getFeeData:async()=>({maxFeePerGas:2_000_000_000n,gasPrice:null}),
    getBalance:async()=>{used.push('balance');return balance;},
    getCode:async()=>{used.push('code');return code;},
    estimateGas:async()=>{used.push('estimate');return 3_000_000n;},
    call:async tx=>{used.push('call');const f=iface.parseTransaction({data:tx.data});return iface.encodeFunctionResult(f.name,[f.name==='FACTORY_VERSION'?version:codeId]);},
    resolveName:async n=>n,
    getTransaction:async h=>receipts[h]?{from:WALLET,to:null}:null,
    getTransactionReceipt:async h=>receipts[h]||null,
    sendTransaction:()=>{throw new Error('must never send');},
    broadcastTransaction:()=>{throw new Error('must never broadcast');}
  };
  p.provider=p;
  return p;
}

test('refuses any signing material and non-HTTPS RPC URLs',()=>{
  assert.throws(()=>assertNoSigningMaterial({DEPLOYER_PRIVATE_KEY:'0xabc'}),/signing material.*DEPLOYER_PRIVATE_KEY/);
  assert.throws(()=>assertNoSigningMaterial({MNEMONIC:'test test'}),/MNEMONIC/);
  assert.doesNotThrow(()=>assertNoSigningMaterial({PRIVATE_KEY:'',RPC_URL:'https://x',OWNER_WALLET:WALLET}));
  assert.equal(rpcFrom(''),null);assert.equal(rpcFrom(undefined),null);
  assert.throws(()=>rpcFrom('http://rpc.example'),/HTTPS/);assert.throws(()=>rpcFrom('https://u:p@rpc.example'),/credentials/);
  assert.equal(rpcFrom('https://sepolia.example/v3/abc'),'https://sepolia.example/v3/abc');
});

test('preflight stops on a non-Sepolia RPC before any other request',async()=>{
  const p=fakeProvider({chainId:1n});
  const r=await sepoliaPreflight(p,{wallet:WALLET,factoryAddress:FACTORY,artifacts});
  assert.equal(r.ok,false);assert.deepEqual(p.used,['chainId']);
});

test('preflight without a factory estimates deployment cost read-only and asks for the owner action',async()=>{
  const p=fakeProvider();
  const r=await sepoliaPreflight(p,{wallet:WALLET,artifacts});
  assert.equal(r.ok,true);
  assert.equal(r.checks.find(c=>c.id==='factory').status,'owner-action');
  assert.match(r.checks.find(c=>c.id==='factory').detail,/--sign-factory/);
  const poor=await sepoliaPreflight(fakeProvider({balance:1n}),{wallet:WALLET,artifacts});
  assert.equal(poor.ok,false);assert.ok(poor.checks.some(c=>c.id==='factory-funding'&&c.status==='fail'));
});

test('preflight verifies a deployed factory identity exactly',async()=>{
  assert.equal((await sepoliaPreflight(fakeProvider(),{wallet:WALLET,factoryAddress:FACTORY,artifacts})).ok,true);
  for(const bad of [{code:'0x'},{version:ethers.id('v1')},{codeId:ethers.id('other')},{code:'0x60806041'}]){
    const r=await sepoliaPreflight(fakeProvider(bad),{wallet:WALLET,factoryAddress:FACTORY,artifacts});
    assert.equal(r.ok,false,JSON.stringify(bad));
  }
});

test('receipts are read and classified, never sent',async()=>{
  const h1='0x'+'11'.repeat(32),h2='0x'+'22'.repeat(32),h3='0x'+'33'.repeat(32);
  const receipt=(status)=>({status,contractAddress:status?FACTORY:null,blockNumber:5,gasUsed:21000n,gasPrice:3n,logs:[{}]});
  const r=await verifyReceipts(fakeProvider({receipts:{[h1]:receipt(1),[h2]:receipt(0)}}),[h1,h2,h3]);
  assert.deepEqual(r.map(x=>x.status),['success','reverted','not-found']);
  assert.equal(r[0].explorer,`https://sepolia.etherscan.io/tx/${h1}`);
  await assert.rejects(verifyReceipts(fakeProvider(),['0x1234']),/Not a transaction hash/);
  await assert.rejects(verifyReceipts(fakeProvider({chainId:1n}),[h1]),/only be recorded from Sepolia/);
});

test('signing page is loopback-only, wallet-signed and accepts only a nonce-bound hash',async()=>{
  assert.throws(()=>signerPage({bytecode:'0x60;alert(1)',nonce:'0'.repeat(32)}));
  let url,server;
  const pending=serveSigner({bytecode:'0x6080',onListen:(u,s)=>{url=u;server=s;}});
  while(!url)await new Promise(r=>setTimeout(r,10));
  assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.equal(server.address().address,'127.0.0.1');
  const html=await (await fetch(url)).text();
  assert.match(html,/eth_sendTransaction/);assert.match(html,/0xaa36a7/);assert.ok(!/private|mnemonic/i.test(html));
  const nonce=html.match(/'x-rehearsal-nonce':"([0-9a-f]{32})"/)[1];
  assert.equal((await fetch(url+'tx',{method:'POST',body:JSON.stringify({hash:'0x'+'aa'.repeat(32)})})).status,404,'no nonce, no effect');
  assert.equal((await fetch(url+'tx',{method:'POST',headers:{'x-rehearsal-nonce':nonce},body:JSON.stringify({hash:'nope'})})).status,400);
  const hash='0x'+'ab'.repeat(32);
  await fetch(url+'tx',{method:'POST',headers:{'x-rehearsal-nonce':nonce},body:JSON.stringify({hash})});
  assert.equal(await pending,hash);
});
