#!/usr/bin/env node
/**
 * NFT-22 rehearsal orchestration: `npm run rehearse:sepolia`.
 *
 *  1. Local: runs the disposable Hardhat factory -> deploy -> mint rehearsal end to end (fixture keys, chain 31337).
 *  2. Sepolia preflight (read-only): only when RPC_URL is set. Checks chain 11155111, head freshness, fees, the
 *     owner's public wallet balance and, if DEPLOYMENT_FACTORY_ADDRESS is set, the deployed factory's exact identity.
 *  3. Signing (opt-in, owner only): `--sign-factory` serves a page on 127.0.0.1 that asks the owner's own browser
 *     wallet to deploy the factory. This script holds no key and cannot send a transaction itself; it refuses to run
 *     if any private key or mnemonic is present in its environment.
 *  4. Evidence: `--verify-tx HASH[,HASH...] [--write]` reads receipts of transactions the owner signed in the app and
 *     records them under docs/evidence/.
 */
import {spawn} from 'node:child_process';
import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';

export const SEPOLIA=11155111n;
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const FACTORY_VERSION=ethers.id('nft-console.collection-factory.v2');
const SECRET_NAME=/(PRIVATE_?KEY|MNEMONIC|SEED_?PHRASE|SECRET_?PHRASE)/i;
const HASH=/^0x[0-9a-fA-F]{64}$/;

/** The rehearsal must never be able to sign: refuse any signing material in the environment. */
export function assertNoSigningMaterial(env){
  const found=Object.keys(env).filter(k=>SECRET_NAME.test(k)&&String(env[k]||'').trim());
  if(found.length)throw new Error(`Refusing to run: signing material present in the environment (${found.join(', ')}). Sepolia transactions are signed only in the owner's wallet.`);
}

export function rpcFrom(value){
  let url;try{url=new URL(String(value||''));}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('RPC_URL must be an HTTPS URL without embedded credentials.');
  return url.href;
}

async function loadArtifacts(root=ROOT){
  const read=async name=>JSON.parse(await readFile(path.join(root,`artifacts/contracts/${name}.sol/${name}.json`),'utf8'));
  const [factory,collection]=await Promise.all([read('NFTCollectionFactory'),read('NFTCollection')]);
  return {factory,collection,creationCodeId:ethers.keccak256(collection.bytecode)};
}

/** Read-only Sepolia checks. Uses only eth_chainId, eth_getBlockByNumber, eth_feeHistory/gasPrice, eth_getBalance, eth_getCode, eth_call, eth_estimateGas. */
export async function sepoliaPreflight(provider,{wallet,factoryAddress,artifacts,now=Date.now()}={}){
  const checks=[],add=(id,status,detail)=>checks.push({id,status,detail});
  const network=await provider.getNetwork();
  if(network.chainId!==SEPOLIA){add('chain','fail',`RPC_URL is chain ${network.chainId}, not Sepolia (11155111). Nothing else was checked.`);return {ok:false,checks};}
  add('chain','pass','Ethereum Sepolia (11155111)');
  const block=await provider.getBlock('latest');const age=Math.round(now/1000-Number(block.timestamp));
  add('head',age<300?'pass':'fail',`block ${block.number}, ${age}s old`);
  const fees=await provider.getFeeData();const maxFee=fees.maxFeePerGas??fees.gasPrice??0n;
  add('fees','pass',`max fee ${ethers.formatUnits(maxFee,'gwei')} gwei`);
  let balance=null;
  if(wallet){
    if(!ethers.isAddress(wallet))add('wallet','fail','OWNER_WALLET is not an address (give the public address only).');
    else{balance=await provider.getBalance(wallet);add('wallet-balance',balance>0n?'pass':'fail',`${ethers.formatEther(balance)} SepoliaETH${balance>0n?'':' - get test ETH from a Sepolia faucet'}`);}
  }else add('wallet-balance','not-checked','Set OWNER_WALLET to your public address to check test-ETH balance.');
  if(factoryAddress){
    if(!ethers.isAddress(factoryAddress)){add('factory','fail','DEPLOYMENT_FACTORY_ADDRESS is not an address.');}
    else{
      const code=await provider.getCode(factoryAddress);
      if(code==='0x')add('factory','fail','No contract at DEPLOYMENT_FACTORY_ADDRESS on Sepolia.');
      else{
        const f=new ethers.Contract(factoryAddress,['function FACTORY_VERSION() view returns(bytes32)','function COLLECTION_CREATION_CODE_ID() view returns(bytes32)'],provider);
        const [version,codeId]=await Promise.all([f.FACTORY_VERSION(),f.COLLECTION_CREATION_CODE_ID()]);
        const runtimeOk=artifacts?ethers.keccak256(code)===ethers.keccak256(artifacts.factory.deployedBytecode):null;
        add('factory',version===FACTORY_VERSION&&(!artifacts||codeId===artifacts.creationCodeId)&&runtimeOk!==false?'pass':'fail',
          `version ${version===FACTORY_VERSION?'v2':'MISMATCH'}, collection code ${!artifacts?'unchecked':codeId===artifacts.creationCodeId?'matches this build':'MISMATCH'}, runtime bytecode ${runtimeOk===null?'unchecked':runtimeOk?'matches this build':'MISMATCH'}`);
      }
    }
  }else if(artifacts){
    let gas=null;try{gas=await provider.estimateGas({from:wallet&&ethers.isAddress(wallet)?wallet:undefined,data:artifacts.factory.bytecode});}catch{/* reported below */}
    add('factory','owner-action',gas?`Not deployed yet. Factory deployment ≈ ${gas} gas ≈ ${ethers.formatEther(gas*maxFee)} SepoliaETH at the current max fee. Run with --sign-factory.`:'Not deployed yet. Run with --sign-factory.');
    if(gas&&balance!==null&&balance<gas*maxFee)add('factory-funding','fail','Wallet balance is below the estimated factory deployment fee.');
  }
  return {ok:checks.every(c=>c.status!=='fail'),checks};
}

/** Reads receipts for owner-signed transactions; never sends anything. */
export async function verifyReceipts(provider,hashes){
  const network=await provider.getNetwork();
  if(network.chainId!==SEPOLIA)throw new Error('Receipts can only be recorded from Sepolia.');
  const out=[];
  for(const hash of hashes){
    if(!HASH.test(hash))throw new Error('Not a transaction hash: '+hash);
    const [tx,receipt]=await Promise.all([provider.getTransaction(hash),provider.getTransactionReceipt(hash)]);
    if(!tx||!receipt){out.push({hash,status:'not-found'});continue;}
    out.push({hash,status:receipt.status===1?'success':'reverted',from:tx.from,to:tx.to,contractAddress:receipt.contractAddress??null,blockNumber:receipt.blockNumber,
      gasUsed:receipt.gasUsed.toString(),effectiveGasPrice:(receipt.gasPrice??0n).toString(),logs:receipt.logs.length,explorer:`https://sepolia.etherscan.io/tx/${hash}`});
  }
  return out;
}

/** Wallet-signing page for the factory deployment. Contains only public bytecode; the wallet does the signing. */
export function signerPage({bytecode,nonce}){
  if(!/^0x[0-9a-f]+$/i.test(bytecode)||!/^[0-9a-f]{32}$/.test(nonce))throw new Error('bad page inputs');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deploy factory on Sepolia</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}button{font-size:1rem;padding:.6rem 1rem}#log{white-space:pre-wrap}</style>
<h1>Deploy the NFT Console factory on Sepolia</h1>
<p>Your browser wallet will ask you to approve one contract-creation transaction on <b>Sepolia (test network)</b>. It costs test ETH only. Nothing is signed unless you approve it in your wallet.</p>
<button id="go">Connect wallet and deploy</button><p id="log" role="status" aria-live="polite"></p>
<script>
const data=${JSON.stringify(bytecode)},log=t=>document.getElementById('log').textContent=t;
document.getElementById('go').onclick=async()=>{try{
  if(!window.ethereum)return log('No browser wallet found. Open this page in a browser with your wallet extension.');
  const [from]=await ethereum.request({method:'eth_requestAccounts'});
  if(await ethereum.request({method:'eth_chainId'})!=='0xaa36a7'){await ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0xaa36a7'}]});}
  if(await ethereum.request({method:'eth_chainId'})!=='0xaa36a7')return log('Switch your wallet to Sepolia and try again.');
  log('Approve the transaction in your wallet…');
  const hash=await ethereum.request({method:'eth_sendTransaction',params:[{from,data}]});
  await fetch('/tx',{method:'POST',headers:{'content-type':'application/json','x-rehearsal-nonce':${JSON.stringify(nonce)}},body:JSON.stringify({hash})});
  log('Sent: '+hash+'\\nReturn to the terminal; it is waiting for the receipt.');
}catch(e){log('Not sent: '+(e&&e.message||e));}};
</script></html>`;
}

/** Serves the signing page on loopback only and resolves with the hash the owner's wallet returned. */
export function serveSigner({bytecode,port=0,onListen=()=>{}}){
  const nonce=ethers.hexlify(ethers.randomBytes(16)).slice(2);
  return new Promise((resolve,reject)=>{
    const server=http.createServer((req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");return res.end(signerPage({bytecode,nonce}));}
      if(req.method==='POST'&&req.url==='/tx'&&req.headers['x-rehearsal-nonce']===nonce){
        let body='';req.on('data',c=>{body+=c;if(body.length>256)req.destroy();});
        req.on('end',()=>{let hash;try{hash=JSON.parse(body).hash;}catch{/* invalid */}
          if(!HASH.test(String(hash))){res.statusCode=400;return res.end();}
          res.end('ok');server.close();resolve(hash);});
        return;
      }
      res.statusCode=404;res.end();
    });
    server.on('error',reject);
    server.listen(port,'127.0.0.1',()=>onListen(`http://127.0.0.1:${server.address().port}/`,server));
  });
}

function runLocal(){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(ROOT,'node_modules/hardhat/internal/cli/cli.js'),'run','scripts/rehearse-mints.cjs'],{cwd:ROOT,stdio:['ignore','inherit','inherit'],env:{...process.env,RPC_URL:''}});
    child.on('exit',code=>resolve(code===0));
  });
}

function args(argv){const o={};for(let i=0;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))continue;const k=a.slice(2);o[k]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;}return o;}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await import('dotenv/config');
  const a=args(process.argv.slice(2)),env=process.env,report={startedAt:new Date().toISOString(),local:null,sepolia:null};
  try{
    assertNoSigningMaterial(env);
    if(!a['skip-local']){console.log('== 1/3 Local Hardhat rehearsal (disposable chain 31337, fixture keys) ==');report.local=await runLocal()?'pass':'fail';if(report.local==='fail')throw new Error('Local rehearsal failed.');}
    const rpc=rpcFrom(a.rpc||env.RPC_URL);
    if(!rpc){
      report.sepolia={status:'owner-input-required',detail:'RPC_URL is not set, so no Sepolia request was made. See docs/SEPOLIA_REHEARSAL.md.'};
      console.log('== 2/3 Sepolia preflight skipped: set RPC_URL (an HTTPS Sepolia endpoint) to run it. ==');
    }else{
      console.log('== 2/3 Sepolia read-only preflight ==');
      const request=new ethers.FetchRequest(rpc);request.timeout=15000;
      const provider=new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1});
      try{
        const artifacts=await loadArtifacts().catch(()=>null);
        const pre=await sepoliaPreflight(provider,{wallet:env.OWNER_WALLET,factoryAddress:a.factory||env.DEPLOYMENT_FACTORY_ADDRESS,artifacts});
        for(const c of pre.checks)console.log(`  [${c.status}] ${c.id}: ${c.detail}`);
        report.sepolia={status:pre.ok?'preflight-pass':'preflight-fail',checks:pre.checks};
        if(a['sign-factory']){
          if(!pre.ok)throw new Error('Fix the failed preflight checks before signing.');
          if(!artifacts)throw new Error('Compile first (npm run compile).');
          console.log('== 3/3 Owner signing: factory deployment ==');
          const hash=await serveSigner({bytecode:artifacts.factory.bytecode,port:Number(a.port||0),onListen:url=>console.log(`  Open ${url} in the browser that has your wallet, then approve the transaction there.`)});
          console.log('  Wallet returned '+hash+'; waiting for the receipt (read-only)…');
          const receipt=await provider.waitForTransaction(hash,1,600000);
          const [record]=await verifyReceipts(provider,[hash]);report.factoryDeployment=record;
          if(receipt?.status!==1||!receipt.contractAddress)throw new Error('The factory deployment did not succeed.');
          const check=await sepoliaPreflight(provider,{wallet:env.OWNER_WALLET,factoryAddress:receipt.contractAddress,artifacts});
          if(!check.ok)throw new Error('Deployed factory failed identity checks.');
          console.log(`  Factory verified at ${receipt.contractAddress}. Set DEPLOYMENT_FACTORY_ADDRESS=${receipt.contractAddress} in Render, then continue in the app.`);
        }
        if(a['verify-tx']){
          report.receipts=await verifyReceipts(provider,String(a['verify-tx']).split(',').map(s=>s.trim()).filter(Boolean));
          for(const r of report.receipts)console.log(`  ${r.hash} ${r.status} ${r.explorer||''}`);
        }
      }finally{provider.destroy();}
    }
    report.finishedAt=new Date().toISOString();
    if(a.write&&(report.receipts||report.factoryDeployment)){
      const dir=path.join(ROOT,'docs/evidence');await mkdir(dir,{recursive:true});
      const file=path.join(dir,`sepolia-rehearsal-${report.startedAt.slice(0,10)}.json`);
      await writeFile(file,JSON.stringify(report,null,2)+'\n');console.log('  Evidence written to '+path.relative(ROOT,file));
    }
    console.log(JSON.stringify({local:report.local,sepolia:report.sepolia?.status}));
    if(report.sepolia?.status==='preflight-fail')process.exitCode=1;
  }catch(error){console.error('Rehearsal stopped: '+(error.message||error));process.exitCode=1;}
}
