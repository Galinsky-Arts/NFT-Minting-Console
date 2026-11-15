import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {getAddress,hexlify,toUtf8Bytes} from 'ethers';
import {api,ApiError} from './api';
import {Notice} from './components';
import {useWallets} from './auth';
import type {WalletChoice} from './auth';
import {readSetupStatus,readSetupChallenge} from './setup-model';
import type {SetupChallenge,SetupStatus} from './setup-model';
export function SetupGate({children}:{children:ReactNode}){
  const [status,setStatus]=useState<SetupStatus|null|undefined>(undefined),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();api('/api/setup/status',{signal:c.signal}).then(v=>{if(!c.signal.aborted)setStatus(readSetupStatus(v));}).catch(e=>{if(c.signal.aborted)return;if(e instanceof ApiError&&e.status===404)setStatus(null);else setError('The installation could not be checked. Reload after the service is available.');});return()=>c.abort();},[]);
  if(error)return <main id="main-content" tabIndex={-1} className="main-content"><h1>Installation check unavailable</h1><Notice error>{error}</Notice><button className="button primary" onClick={()=>location.reload()}>Reload</button></main>;
  if(status===undefined)return <main id="main-content" tabIndex={-1} className="main-content"><p role="status">Checking installation...</p></main>;
  if(status?.chainConfigured===false)return <ChainNotConfigured status={status}/>;
  return status?.required?<SetupWizard status={status}/>:children;
}
/** Degraded hosting: the database is verified but no RPC endpoint is configured, so nothing chain-bound can run.
 * Tells the owner exactly which hosting variable to add, then how to finish registration. */
interface Blocked { action: string; envVar: string; need: string }
function ChainNotConfigured({status}:{status:SetupStatus}){
  const heading=useRef<HTMLHeadingElement>(null),[blocked,setBlocked]=useState<Blocked[]>([]),[copied,setCopied]=useState('');
  useEffect(()=>{heading.current?.focus();const c=new AbortController();api('/api/status',{signal:c.signal}).then(v=>{const list=(v as {blockedActions?:unknown}).blockedActions;if(!c.signal.aborted&&Array.isArray(list))setBlocked(list.filter((b):b is Blocked=>!!b&&typeof b.envVar==='string'&&/^[A-Z_]{1,40}$/.test(b.envVar)&&typeof b.action==='string'&&typeof b.need==='string').slice(0,10));}).catch(()=>{});return()=>c.abort();},[]);
  const copy=async(name:string)=>{try{await navigator.clipboard.writeText(name);setCopied(`Copied ${name}.`);}catch{setCopied(`Copy failed. Type ${name} manually.`);}};
  const optional=blocked.filter(b=>b.envVar!=='RPC_URL');
  return <main id="main-content" tabIndex={-1} className="main-content setup-wizard chain-setup"><span className="eyebrow">INSTALLATION NOT READY</span><h1 ref={heading} tabIndex={-1}>Blockchain connection not configured</h1>
    <Notice>This installation is running in a limited mode because the hosting environment variable <code>RPC_URL</code> is not set. Administrator registration, sign-in, minting and marketplace features are disabled. No wallet request or transaction can be made from this page.</Notice>
    <section className="panel" aria-labelledby="fix-heading"><h2 id="fix-heading">Add RPC_URL to finish setup</h2>
      <ol className="setup-steps">
        <li>Get an HTTPS JSON-RPC endpoint for <strong>{status.chainName}</strong> (chain ID {status.chainId}) from an Ethereum node provider such as Alchemy or Infura. Use the full URL, starting with <code>https://</code>.</li>
        <li>Open your hosting dashboard. On Render: <strong>nft-minting-console</strong> service, then <strong>Environment</strong>, then <strong>Add Environment Variable</strong>.</li>
        <li>Enter the key <code>RPC_URL</code> <button type="button" className="text-button" onClick={()=>void copy('RPC_URL')} aria-label="Copy name RPC_URL">Copy name</button> and paste the endpoint as its value. Keep it private; it is never shown in this interface.</li>
        <li>Save. The service restarts automatically. Then reload this page.</li>
        {status.required&&<li>Register your administrator wallet: enter the value of <code>NFT_SETUP_CODE</code> from the same Environment page when this site asks for the installation setup code.</li>}
      </ol>
      <p role="status" aria-live="polite" className="muted">{copied}</p>
      <button type="button" className="button primary" onClick={()=>location.reload()}>Reload after saving</button>
    </section>
    <section className="panel" aria-labelledby="status-heading"><h2 id="status-heading">Installation status</h2><dl className="preview-grid"><div><dt>Site</dt><dd>{location.origin}</dd></div><div><dt>Network</dt><dd className="network-badge">{status.chainName} / {status.chainId}</dd></div><div><dt>Database</dt><dd>{status.databaseVerified?'Restricted database verified':'Database setup required'}</dd></div><div><dt>Administrator</dt><dd>{status.required?'Not registered yet':'Registered'}</dd></div></dl>
      {optional.length>0&&<><h3>Also not configured (optional for now)</h3><ul className="setup-optional">{optional.map(b=><li key={b.envVar}><code>{b.envVar}</code>: {b.need}. Needed for: {b.action}.</li>)}</ul></>}
    </section>
    <footer className="workspace-footer">NFT Console / Development build. Limited mode is not an operational or security readiness claim.</footer>
  </main>;
}
function SetupWizard({status}:{status:SetupStatus}){
  const wallets=useWallets(),[code,setCode]=useState(''),[choice,setChoice]=useState<WalletChoice|null>(null),[wallet,setWallet]=useState(''),[challenge,setChallenge]=useState<SetupChallenge|null>(null),[approved,setApproved]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[registered,setRegistered]=useState(false);
  const epoch=useRef(0),running=useRef(false),lifetime=useRef<AbortController|null>(null);
  useEffect(()=>{const c=new AbortController();lifetime.current=c;return()=>{c.abort();epoch.current++;};},[]);
  useEffect(()=>{if(!choice)return;const changed=()=>{epoch.current++;setChallenge(null);setApproved(false);setWallet('');setChoice(null);setError('Your wallet or network changed. Reconnect before registering.');};for(const name of ['accountsChanged','chainChanged','disconnect'])choice.provider.on?.(name,changed);return()=>{for(const name of ['accountsChanged','chainChanged','disconnect'])choice.provider.removeListener?.(name,changed);};},[choice]);
  const active=(version:number)=>version===epoch.current&&!lifetime.current?.signal.aborted;
  async function run(label:string,fn:(version:number)=>Promise<void>){if(running.current)return;running.current=true;const version=++epoch.current;setBusy(label);setError('');try{await fn(version);}catch(e){if(active(version))setError(e instanceof ApiError?e.message:'The wallet or registration request did not complete. Check the selected network and retry. No transaction was sent.');}finally{running.current=false;if(!lifetime.current?.signal.aborted)setBusy('');}}
  async function account(selected:WalletChoice,request=false){const accounts=await selected.provider.request({method:request?'eth_requestAccounts':'eth_accounts'}),network=await selected.provider.request({method:'eth_chainId'});if(typeof network!=='string'||BigInt(network)!==BigInt(status.chainId))throw new Error('Wrong network');if(!Array.isArray(accounts)||typeof accounts[0]!=='string')throw new Error('Wallet unavailable');return getAddress(accounts[0]);}
  const select=(selected:WalletChoice)=>run('Connecting the selected wallet',async version=>{const address=await account(selected,true);if(active(version)){setChoice(selected);setWallet(address);setChallenge(null);setApproved(false);}});
  const prepare=()=>run('Preparing administrator registration',async version=>{
    if(!choice)return;
    const connected=await account(choice);
    // Every wallet await can synchronously emit account/network/disconnect events.
    // Recheck the operation epoch AFTER the await, before any server mutation.
    if(!active(version))return;
    if(connected!==wallet)throw new Error('Wallet changed');
    const value=await api('/api/setup/challenge',{method:'POST',body:{setupCode:code,wallet,chainId:status.chainId},signal:lifetime.current?.signal});
    if(!active(version))return;
    const checked=readSetupChallenge(value,{origin:location.origin,wallet,chainId:status.chainId});
    setChallenge(checked);setApproved(false);
  });
  const register=()=>run('Review the registration message in your wallet',async version=>{
    if(!choice||!challenge||!approved)return;
    const connected=await account(choice);
    if(!active(version))return;
    if(connected!==wallet)throw new Error('Wallet changed');
    readSetupChallenge(challenge,{origin:location.origin,wallet,chainId:status.chainId});
    const signature=await choice.provider.request({method:'personal_sign',params:[hexlify(toUtf8Bytes(challenge.message)),wallet]});
    if(!active(version))return;
    if(typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature))throw new Error('Invalid signature');
    const signingAccount=await account(choice);
    if(!active(version))return;
    if(signingAccount!==wallet)throw new Error('Wallet changed');
    const value=await api('/api/setup/claim',{method:'POST',body:{setupCode:code,challengeId:challenge.challengeId,signature},signal:lifetime.current?.signal}) as {registered?:boolean;transactionSent?:boolean};
    if(value.registered!==true||value.transactionSent!==false)throw new Error('Registration unverified');
    if(active(version)){setCode('');setChallenge(null);setRegistered(true);}
  });
  return <main id="main-content" tabIndex={-1} className="main-content setup-wizard"><span className="eyebrow">FIRST-RUN ADMINISTRATOR SETUP</span><h1>Make this your NFT workspace</h1><p>Register your administrator directly in this interface. You do not need to send a wallet address in chat. The installation setup code prevents someone else from claiming this site.</p>
    <section className="panel"><h2>1. Verify the installation</h2><dl className="preview-grid"><div><dt>Site</dt><dd>{location.origin}</dd></div><div><dt>Network</dt><dd className="network-badge">{status.chainName} / {status.chainId}</dd></div><div><dt>Database</dt><dd>{status.databaseVerified?'Restricted database verified':'Database setup required'}</dd></div></dl><p>In your existing Render service, open Environment and copy <strong>NFT_SETUP_CODE</strong> into the field below. This code is separate from your wallet seed, Pinata JWT and Alchemy key. It is used only for this first registration, stays out of URLs, and is never saved in browser storage.</p><div className="field"><label htmlFor="installation-code">Installation setup code</label><input id="installation-code" type="password" autoComplete="off" maxLength={64} value={code} disabled={!!busy||registered} onChange={e=>{setCode(e.target.value);setChallenge(null);setApproved(false);}}/><small>64 hexadecimal characters from NFT_SETUP_CODE. Never enter a seed phrase or private key.</small></div></section>
    <section className="panel"><h2>2. Select your administrator wallet</h2><p>Use a directly controlled Ethereum account and select the displayed network in your wallet. Connecting requests your public address only; it does not transfer funds.</p>{wallets.length?wallets.map(item=><button key={item.id} className="button secondary" disabled={!!busy||registered} onClick={()=>void select(item)}>Connect {item.name}</button>):<Notice>No wallet is detected. Open this site in a wallet-enabled browser or your wallet's browser, then reload.</Notice>}{wallet&&<p className="mono address-full">{wallet}</p>}<button className="button primary" disabled={!!busy||registered||!wallet||!/^[a-f0-9]{64}$/.test(code)} onClick={()=>void prepare()}>Prepare administrator registration</button></section>
    {challenge&&<section className="panel"><h2>3. Review and sign the registration</h2><pre className="public-json" tabIndex={0}>{challenge.message}</pre><label className="review-checkbox"><input type="checkbox" checked={approved} disabled={!!busy} onChange={e=>setApproved(e.target.checked)}/><span>I control this installation and want this wallet to be its administrator. This signature does not authorize a mint or asset transfer.</span></label><button className="button primary" disabled={!!busy||!approved} onClick={()=>void register()}>Register administrator with wallet signature</button></section>}
    {busy&&<p role="status">{busy}</p>}{error&&<Notice error>{error}</Notice>}{registered&&<section className="panel"><h2>Administrator registered</h2><p>Your registration is saved in the installation database. Reload and connect the same wallet to sign in normally. Collection ownership, minter and royalty settings are chosen separately when you create a collection.</p><button className="button primary" onClick={()=>location.reload()}>Open my workspace</button></section>}
    <footer className="workspace-footer">NFT Console / Development build. First-run setup does not certify completion of the whole platform.</footer>
  </main>;
}
