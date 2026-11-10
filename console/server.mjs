import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ethers} from 'ethers';
import {FACTORY_VERSION,reconcileDeployment} from './deployment.mjs';
import {AuthError,createAuthService,rolesFromEnvironment} from './auth/core.mjs';
import {installAuthRoutes} from './auth/http.mjs';
import {createWalletVerifier} from './auth/wallet.mjs';
import {createPersistence} from './data/persistence.mjs';
import {installReleaseRoutes} from './data/http.mjs';
import {installJournalRoutes} from './operations/http.mjs';
import {publicLaunchMode} from './launch/mode.mjs';
import {LaunchJournal} from './launch/journal.mjs';
import {loadCollectionArtifact} from './launch/artifacts.mjs';
import {installLaunchRoutes} from './launch/http.mjs';
import {installCostQuoteRoutes} from './launch/quote.mjs';
import {installPublicationWorkbench} from './publication/workbench-http.mjs';
import {checkPublicationSchema} from './publication/workbench-schema.mjs';
import {localMintMode} from './operations/local-mode.mjs';
import {marketConfig} from './market/config.mjs';
import {MarketStore} from './market/store.mjs';
import {OpenSeaMarketplace} from './market/marketplaces.mjs';
import {installMarketRoutes} from './market/http.mjs';
import {installPrivateRoutes} from './private/http.mjs';
import {PrivateStore} from './private/store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const chainRegistry=JSON.parse(fs.readFileSync(path.join(root,'config/chains.json'),'utf8'));
const blockedFeatures=Object.freeze([
  {id:'private-workspace',milestones:['NFT-10','NFT-11','NFT-12'],description:'Low-level attachment encryption is implemented; private draft editing, recovery and ciphertext object storage integration remain unfinished.'},
  {id:'explicit-publication',milestones:['NFT-13','NFT-19','NFT-20'],description:'Reviewed public browser/CLI uploads and exact-byte readback are implemented. Encrypted-draft declassification, private storage and large resumable transfers remain separate unfinished work.'},
  {id:'release-experience',milestones:['NFT-14','NFT-16','NFT-17','NFT-18'],description:'Encrypted saved releases, private media editing and the complete rights workflow remain unfinished.'},
  {id:'verified-chain-workflow',milestones:['NFT-21','NFT-22','NFT-23','NFT-24','NFT-25'],description:'The public EOA deployment/mint flow is browser-tested. Automated validator-policy provisioning and live production transaction evidence remain outstanding.'},
  {id:'marketplace',milestones:['NFT-26','NFT-27','NFT-28','NFT-29'],description:'Seaport order signing and OpenSea submission components exist. The complete user flow, active-listing verification and real-sale checks remain unfinished.'},
  {id:'production-evidence',milestones:['NFT-30','NFT-31','NFT-32','NFT-33','NFT-34','NFT-35','NFT-36'],description:'Durable database and first-run setup are implemented. Live runtime configuration, a verified user mint and real-sale acceptance remain separate checks. External human review is deferred by owner policy.'},
]);
const closed=(res,code,error)=>res.status(409).json({code,error,productionReady:false});
export function createApp({env=process.env,authService,launchContentOptions,marketplaceOverride}={}) {
  const app=express(),production=env.NODE_ENV==='production';
  if(production&&(env.NFT_PUBLIC_LAUNCH!=='1'||authService))throw new Error('Production startup is blocked without the configured public launch scope and durable authentication.');
  const port=Number(env.PORT||3000);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid PORT.');
  const chainId=Number(env.CHAIN_ID||11155111),profile=chainRegistry.chains[String(chainId)];
  if(!profile)throw new Error('Unsupported CHAIN_ID.');
  const origin=env.PUBLIC_ORIGIN||`http://localhost:${port}`,roles=rolesFromEnvironment(env);
  const localMint=localMintMode(env,chainId,origin);
  const publicLaunch=publicLaunchMode(env,chainId,origin,roles);
  if(launchContentOptions&&!(env.NODE_ENV==='test'&&env.NFT_UI_FIXTURE==='1'&&chainId===31337&&origin.startsWith('http://127.0.0.1:')))throw new Error('Content transport injection is limited to the disposable browser fixture.');
  const launchArtifact=publicLaunch?loadCollectionArtifact():null;
  if(marketplaceOverride&&!(env.NODE_ENV==='test'&&chainId===31337))throw new Error('Marketplace injection is limited to disposable local tests.');
  const market=marketConfig(env,chainId);
  const marketplace=marketplaceOverride||(market.openseaApi&&env.OPENSEA_API_KEY?new OpenSeaMarketplace({apiKey:env.OPENSEA_API_KEY,base:market.openseaApi.base,chain:market.openseaApi.chain}):null);
  const factoryValue=env.DEPLOYMENT_FACTORY_ADDRESS||'';
  if(factoryValue&&!ethers.isAddress(factoryValue))throw new Error('Invalid DEPLOYMENT_FACTORY_ADDRESS.');
  const factoryAddress=factoryValue?ethers.getAddress(factoryValue):null;
  const persistence=createPersistence({env,origin,chainId,roles});
  let provider,auth;
  try {
    if(env.RPC_URL){const request=new ethers.FetchRequest(env.RPC_URL);request.timeout=8000;provider=new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});}
    auth=authService||createAuthService({origin,chainId,production,roles:()=>roles,...(persistence?{store:persistence.store}:{}),checksumAddress:ethers.getAddress,verifyWallet:provider?createWalletVerifier(provider):async()=>{throw new AuthError(503,'unavailable');},audit:record=>console.info(JSON.stringify(record))});
    if(auth.origin!==origin||auth.chainId!==chainId)throw new Error('Authentication realm does not match server configuration.');
  }catch(error){provider?.destroy();void persistence?.close();throw error;}
  const launchJournal=persistence&&publicLaunch?new LaunchJournal(persistence.repository):null;
  const marketStore=persistence?new MarketStore(persistence.repository):null,privateStore=persistence?new PrivateStore(persistence.repository):null;
  const ready=(persistence?.ready||Promise.resolve()).then(()=>marketStore?.checkSchema()).then(()=>launchJournal?.checkSchema()).then(()=>launchJournal&&env.PINATA_JWT?checkPublicationSchema(persistence.repository):undefined);
  app.disable('x-powered-by');app.set('trust proxy',false);
  app.use((_req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'${launchJournal&&env.PINATA_JWT?' https://uploads.pinata.cloud':''}; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    if(auth.origin.startsWith('https:'))res.setHeader('Strict-Transport-Security','max-age=31536000');next();
  });
  app.use('/api',(_req,res,next)=>{ready.then(()=>next(),()=>res.status(503).json({error:'Configured database authorization is unavailable. No memory fallback is permitted.',code:'database_unavailable'}));});
  app.use('/api/launch/mint',express.json({limit:'1536kb',strict:true}));
  app.use('/api/launch/quote',express.json({limit:'8mb',strict:true}));
  app.use('/api/private/records',express.json({limit:'1600kb',strict:true}));
  app.use('/api/private/blobs/:id/chunks/:index',express.raw({type:'application/octet-stream',limit:'8300kb'}));
  app.use(express.json({limit:'64kb',strict:true}));
  const requireAction=installAuthRoutes(app,auth,{production});
  if(persistence){installReleaseRoutes(app,requireAction,persistence.repository);installJournalRoutes(app,requireAction,persistence.journal,provider);}
  if(launchJournal){installLaunchRoutes(app,requireAction,{journal:launchJournal,provider,artifact:launchArtifact,enabled:publicLaunch,chainId,contentOptions:launchContentOptions});installCostQuoteRoutes(app,requireAction,{journal:launchJournal,provider,artifact:launchArtifact,enabled:publicLaunch,chainId,contentOptions:launchContentOptions});}
  if(marketStore){installMarketRoutes(app,requireAction,{store:marketStore,provider,market,marketplace});installPrivateRoutes(app,requireAction,{store:privateStore});}
  if(launchJournal&&env.PINATA_JWT)installPublicationWorkbench(app,requireAction,{repository:persistence.repository,jwt:env.PINATA_JWT,contentOptions:launchContentOptions});
  app.get('/api/config',(_req,res)=>res.json({chainId,chainSlug:profile.slug,chainName:profile.name,production:profile.production,deploymentFactory:factoryAddress,pinningReady:false,pinningConfigured:Boolean(env.PINATA_JWT),loginConfigured:roles.size>0&&Boolean(provider),validator:env.TRANSFER_VALIDATOR_ADDRESS||profile.validator,signedZone:env.OPENSEA_SIGNED_ZONE||profile.signedZone,productionReady:false,authStore:persistence?'postgresql':'development-memory',capabilities:{publicPublication:Boolean(launchJournal&&env.PINATA_JWT),publicLaunch,localMint,mintJournal:Boolean(persistence),privateDrafts:Boolean(privateStore),privateWorkspace:Boolean(privateStore),transferPolicy:Boolean(marketStore&&market.available&&market.validator&&provider),marketplace:marketStore&&market.available&&marketplace?marketplace.name:null,opaqueReleaseApi:Boolean(persistence),publish:false,mint:false,list:Boolean(marketStore&&market.available&&marketplace),deploy:chainId!==1&&Boolean(factoryAddress)}}));
  app.get('/api/health',(_req,res)=>res.json({ok:true,productionReady:false}));
  app.get('/api/launch-readiness',requireAction('read'),(_req,res)=>res.json({productionReady:false,mintingEvidence:'not-verified',listingEvidence:'not-verified',blockers:blockedFeatures,authentication:'software-integration-accepted',storage:persistence?'durable-configured-not-production-accepted':'development-memory',note:'These are software gates, not a live wallet inventory or security certification.'}));
  app.get('/api/artifact',requireAction('deploy'),(_req,res)=>{
    if(chainId===1)return closed(res,'mainnet_gated','Mainnet deployment is disabled until the reviewed production gates pass.');
    try{
      const collection=JSON.parse(fs.readFileSync(path.join(root,'artifacts/contracts/NFTCollection.sol/NFTCollection.json'),'utf8'));
      const factory=JSON.parse(fs.readFileSync(path.join(root,'artifacts/contracts/NFTCollectionFactory.sol/NFTCollectionFactory.json'),'utf8'));
      res.json({collection:{abi:collection.abi,bytecode:collection.bytecode,creationCodeId:ethers.keccak256(collection.bytecode)},factory:{abi:factory.abi,bytecode:factory.bytecode,address:factoryAddress,version:FACTORY_VERSION}});
    }catch{res.status(503).json({error:'Contract build missing. Run the pinned compile gate.',code:'build_required'});}
  });
  app.get('/api/deployment/:releaseId',requireAction('read'),async(req,res)=>{
    try{
      if(!/^0x[0-9a-fA-F]{64}$/.test(req.params.releaseId))return res.status(400).json({error:'Invalid release identifier.'});
      if(req.query.requester&&String(req.query.requester).toLowerCase()!==req.actor.wallet)return res.status(403).json({error:'Deployment lookup is bound to the signed-in wallet.'});
      if(!factoryAddress||!provider)return res.status(503).json({error:'Rehearsal factory or RPC is not configured.'});
      res.json(await reconcileDeployment(provider,{factory:factoryAddress,chainId,releaseId:req.params.releaseId,requester:req.actor.wallet}));
    }catch{res.status(503).json({error:'Deployment could not be verified. No transaction was sent.'});}
  });
  app.post('/api/prepare',requireAction('publish'),(_req,res)=>closed(res,'publication_gated','Public upload is disabled until the private workspace and explicit publication review are accepted. No artwork was pinned.'));
  app.get('/api/preflight',requireAction('read'),(_req,res)=>closed(res,'mint_preflight_gated','Complete validator-policy, bytecode, exact-token and rights preflight is not accepted. Do not mint from this prototype.'));
  app.get('/api/opensea-url',requireAction('read'),(req,res)=>{
    const address=String(req.query.contract||''),id=String(req.query.id||'');
    if(!ethers.isAddress(address)||!/^[1-9][0-9]{0,77}$/.test(id)||BigInt(id)>(1n<<256n)-1n)return res.status(400).json({error:'Invalid NFT identifier.'});
    res.json({url:`https://opensea.io/assets/${profile.slug}/${address}/${id}`,status:'link-only',listingVerified:false});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.'}));
  app.use('/legacy',express.static(path.join(root,'console/public')));
  app.use('/vendor',express.static(path.join(root,'node_modules/ethers/dist')));
  const uiDir=path.join(root,'console/dist');
  app.use(express.static(uiDir));
  app.get('/',(_req,res)=>res.status(503).type('text/plain').send('The console interface build is missing. Run npm run build before starting the app. No signing or publishing is available.'));
  app.use((error,_req,res,_next)=>{void _next;const status=error.type==='entity.too.large'?413:error.type==='entity.parse.failed'?400:500;res.status(status).json({error:status===413?'Request body is too large.':'Request could not be processed.'});});
  app.locals.ready=ready;
  app.locals.close=async()=>{provider?.destroy();await persistence?.close();};
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const app=createApp();
  try{await app.locals.ready;}catch{await app.locals.close();throw new Error('Database authorization startup failed. Check restricted role provisioning and migrations.');}
  const server=app.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.info('NFT Console listening; capabilities are reported by /api/config.'));
  const stop=()=>server.close(()=>{app.locals.close().then(()=>process.exit(0),()=>process.exit(1));});
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
