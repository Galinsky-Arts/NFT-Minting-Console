import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {FetchRequest,JsonRpcProvider} from 'ethers';
import {createApp} from './server.mjs';
import {canonicalOrigin} from './auth/core.mjs';
import {databaseOptions,GuardedDatabasePool} from './data/pool.mjs';
import {InstallationStore,SetupError} from './setup/store.mjs';
import {installSetupRoutes} from './setup/http.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const registry=JSON.parse(readFileSync(path.join(root,'config/chains.json'),'utf8'));
/** Boot the normal app only after a durable, proof-of-control administrator claim.
 * An unclaimed installation exposes only the setup UI, not an unauthenticated admin API. */
export async function createRuntime({env=process.env,testDependencies}={}){
  if(testDependencies&&env.NODE_ENV!=='test')throw new Error('Runtime dependency injection is test-only.');
  if(env.NFT_SETUP_ENABLED!=='1')return createApp({env});
  if(['ADMIN_WALLETS','EDITOR_WALLETS','VIEWER_WALLETS'].some(key=>env[key]?.trim()))throw new Error('Use either browser enrollment or explicit environment wallet roles, not both.');
  if(env.DATABASE_URL_UNPOOLED)throw new Error('Migration credentials must not be present in the application environment.');
  const production=env.NODE_ENV==='production',origin=canonicalOrigin(env.PUBLIC_ORIGIN,production),chainId=Number(env.CHAIN_ID),profile=registry.chains[String(chainId)];
  if(!profile||(!production&&env.NODE_ENV!=='test')||(chainId===31337&&env.NODE_ENV!=='test'))throw new Error('Browser enrollment requires an explicit supported production or test environment.');
  if(production&&(env.NFT_PUBLIC_LAUNCH!=='1'||(chainId===1&&env.NFT_MAINNET_ACK!=='ethereum-mainnet-real-fees')))throw new Error('Configure the public launch scope before administrator enrollment.');
  if(!String(env.RPC_URL??'').trim())return createChainUnconfiguredRuntime({env,testDependencies,origin,chainId,profile});
  let rpc;try{rpc=new URL(env.RPC_URL);}catch{throw new Error('Configure RPC_URL before enabling browser enrollment.');}
  if(rpc.username||rpc.password||(!['https:'].includes(rpc.protocol)&&!(env.NODE_ENV==='test'&&rpc.origin.startsWith('http://127.0.0.1:'))))throw new Error('Use an HTTPS RPC URL.');
  let pool=testDependencies?.pool;
  if(!pool){const raw=new pg.Pool(databaseOptions(env.DATABASE_URL));raw.on('error',()=>console.error('Installation database connection failed.'));pool=new GuardedDatabasePool(raw);}
  const store=testDependencies?.store||new InstallationStore({pool,origin,chainId});
  const request=new FetchRequest(rpc.href);request.timeout=8000;
  const provider=testDependencies?.provider||new JsonRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});
  const factory=testDependencies?.createApp||createApp;
  let active=null,activating=null,closed=false;
  async function activate(){
    if(active)return true;if(closed)throw new SetupError('SETUP_UNAVAILABLE',503);
    if(activating)return activating;
    activating=(async()=>{
      const owner=await store.owner();if(!owner)return false;
      const candidate=factory({env:{...env,ADMIN_WALLETS:owner}});
      try{await candidate.locals.ready;if(closed)throw new Error('Runtime closed');active=candidate;return true;}
      catch(error){await candidate.locals.close?.();throw error;}
    })();
    try{return await activating;}finally{activating=null;}
  }
  try{
    if((await provider.getNetwork()).chainId!==BigInt(chainId))throw new Error('The configured RPC network does not match CHAIN_ID.');
    const owner=await store.owner();
    if(!owner&&!/^[a-f0-9]{64}$/.test(env.NFT_SETUP_CODE||''))throw new Error('Set a randomly generated 64-character NFT_SETUP_CODE in the hosting environment.');
    const app=hardenedApp(origin);
    const setup=express();setup.disable('x-powered-by');
    installSetupRoutes(setup,{store,provider,origin,chainId,setupCode:env.NFT_SETUP_CODE,onClaimed:activate});
    setup.get('/api/config',(_req,res)=>res.json({chainId,chainName:profile.name,production:profile.production,productionReady:false,loginConfigured:false,pinningConfigured:Boolean(env.PINATA_JWT),authStore:'postgresql',capabilities:{opaqueReleaseApi:false,deploy:false,mintJournal:false,localMint:false,publicLaunch:false}}));
    setup.get('/api/auth/session',(_req,res)=>res.status(401).json({code:'session_required',error:'Register the installation administrator first.'}));
    setup.get('/api/health',(_req,res)=>res.json({ok:true,setupRequired:true,productionReady:false}));
    setup.use('/api',(_req,res)=>res.status(409).json({code:'setup_required',error:'Register the installation administrator before using the console.'}));
    setup.use(express.static(path.join(root,'console/dist')));
    setup.get('/',(_req,res)=>res.status(503).type('text/plain').send('Build the console interface before completing administrator setup.'));
    app.use(async(req,res,next)=>{
      try{
        const registered=await activate();
        if(req.path==='/api/setup/status'&&req.method==='GET')return res.json({version:1,required:!registered,chainId,chainName:profile.name,databaseVerified:true,codeConfigured:!registered&&Boolean(env.NFT_SETUP_CODE),runtimeReady:registered,fullProductReady:false});
        (active||setup)(req,res,next);
      }catch{res.status(503).json({code:'installation_unavailable',error:'The installation database or runtime could not be verified. No development-memory fallback is permitted.'});}
    });
    app.use((error,_req,res,_next)=>{void _next;res.status(error.type==='entity.too.large'?413:400).json({code:'invalid_setup_input',error:'The setup request could not be processed.'});});
    app.locals.ready=activate();
    app.locals.close=async()=>{closed=true;await activating?.catch(()=>{});await active?.locals.close?.();provider.destroy?.();await pool.end();};
    await app.locals.ready;return app;
  }catch(error){provider.destroy?.();await pool.end();throw error;}
}
function hardenedApp(origin){
  const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
  app.use((_req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(origin.startsWith('https:'))res.setHeader('Strict-Transport-Security','max-age=31536000');next();
  });
  return app;
}
/** Clearly degraded start when the operator has not supplied RPC_URL yet.
 * The restricted database is still verified, but administrator enrollment, sign-in and every chain or
 * marketplace route stay closed: proof-of-control registration needs the RPC network/code checks, and
 * nothing may fall back to an unverified chain view. /api/health reports degraded:true. */
async function createChainUnconfiguredRuntime({env,testDependencies,origin,chainId,profile}){
  let pool=testDependencies?.pool;
  if(!pool){const raw=new pg.Pool(databaseOptions(env.DATABASE_URL));raw.on('error',()=>console.error('Installation database connection failed.'));pool=new GuardedDatabasePool(raw);}
  const store=testDependencies?.store||new InstallationStore({pool,origin,chainId});
  try{
    const registered=Boolean(await store.owner());
    const blocker='The blockchain RPC connection (RPC_URL) is not configured. Administrator registration, sign-in, minting and marketplace features stay disabled until the operator sets an HTTPS RPC_URL for this network.';
    const app=hardenedApp(origin);
    app.get('/api/health',(_req,res)=>res.json({ok:true,degraded:true,chainConfigured:false,setupRequired:!registered,productionReady:false}));
    app.get('/api/setup/status',(_req,res)=>res.json({version:1,required:!registered,chainId,chainName:profile.name,databaseVerified:true,codeConfigured:!registered&&/^[a-f0-9]{64}$/.test(env.NFT_SETUP_CODE||''),runtimeReady:false,fullProductReady:false,chainConfigured:false}));
    app.get('/api/config',(_req,res)=>res.json({chainId,chainName:profile.name,production:profile.production,productionReady:false,chainConfigured:false,loginConfigured:false,pinningConfigured:false,authStore:'postgresql',capabilities:{opaqueReleaseApi:false,deploy:false,mintJournal:false,localMint:false,publicLaunch:false}}));
    app.use('/api',(_req,res)=>res.status(503).json({code:'chain_not_configured',error:blocker}));
    app.use(express.static(path.join(root,'console/dist')));
    app.get('/',(_req,res)=>res.status(503).type('text/plain').send(blocker));
    app.locals.degraded=true;app.locals.ready=Promise.resolve(registered);
    app.locals.close=async()=>{await pool.end();};
    console.warn('NFT Console started in degraded mode: RPC_URL is not configured, so enrollment, sign-in and chain features are disabled.');
    return app;
  }catch(error){await pool.end();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  let app;
  try{app=await createRuntime();await app.locals.ready;}
  catch{console.error('NFT Console startup failed. Verify database migrations, restricted credentials, RPC/network and setup configuration. Secrets were not logged.');process.exit(1);}
  const server=app.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.info('NFT Console runtime listening; setup and capabilities are reported by the interface.'));
  const stop=()=>server.close(()=>app.locals.close().then(()=>process.exit(0),()=>process.exit(1)));
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
