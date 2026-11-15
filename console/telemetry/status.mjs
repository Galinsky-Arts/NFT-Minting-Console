/**
 * NFT-35 local telemetry: bounded in-process request metrics and a public, source-backed status report.
 * No external telemetry account, no request bodies, query strings, wallet addresses, IPs or secrets are recorded.
 * Values that need an authenticated session or an external service are reported as not measured, never guessed.
 */
const BUCKETS=[50,100,250,500,1000,2500,5000];
const COMMIT=/^[0-9a-f]{7,40}$/;
/** Collapse paths into a small fixed set so metrics cardinality stays bounded and identifiers never leak. */
export function routeGroup(path){
  if(typeof path!=='string'||!path.startsWith('/api/'))return 'static';
  const seg=path.slice(5).split('/')[0];
  return /^[a-z][a-z-]{0,31}$/.test(seg)?'/api/'+seg:'/api/other';
}
export function createTelemetry({now=()=>Date.now(),log=line=>console.info(line)}={}){
  const startedAt=now(),groups=new Map();
  let total=0,serverErrors=0;
  const record=(group,status,ms)=>{
    total++;if(status>=500)serverErrors++;
    if(!groups.has(group)&&groups.size>=64)group='/api/other';
    const g=groups.get(group)||{requests:0,status:{'2xx':0,'3xx':0,'4xx':0,'5xx':0},latencyMs:Object.fromEntries([...BUCKETS.map(b=>['le'+b,0]),['inf',0]])};
    g.requests++;const cls=`${Math.min(5,Math.max(2,Math.floor(status/100)))}xx`;g.status[cls]++;
    const bucket=BUCKETS.find(b=>ms<=b);g.latencyMs[bucket?'le'+bucket:'inf']++;groups.set(group,g);
  };
  return {
    middleware(req,res,next){
      const start=now(),group=routeGroup(req.path);
      res.on('finish',()=>{const ms=now()-start;record(group,res.statusCode,ms);
        if(res.statusCode>=500)log(JSON.stringify({event:'http.server_error',route:group,method:req.method,status:res.statusCode,ms}));});
      next();
    },
    record,
    snapshot(){return {startedAt:new Date(startedAt).toISOString(),uptimeSeconds:Math.floor((now()-startedAt)/1000),requests:total,serverErrors,
      routes:Object.fromEntries([...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,structuredClone(v)]))};},
  };
}
/** Owner actions still needed, by environment variable NAME only (never values). */
export function blockedActions(env,chainId){
  const out=[];
  if(!String(env.RPC_URL??'').trim())out.push({action:'Administrator registration, sign-in, deployment, minting and marketplace',envVar:'RPC_URL',need:'HTTPS JSON-RPC endpoint for the configured network'});
  if(!env.PINATA_JWT)out.push({action:'Public IPFS publication of final artwork, rights and metadata',envVar:'PINATA_JWT',need:'Pinata JWT (backend only)'});
  if(chainId===1&&!env.OPENSEA_API_KEY)out.push({action:'OpenSea listing submission and verification',envVar:'OPENSEA_API_KEY',need:'OpenSea API key'});
  return out;
}
export function statusReport({telemetry,env,chainId,chainName,mode,databaseVerified,setupRequired}){
  const commit=String(env.RENDER_GIT_COMMIT||env.SOURCE_COMMIT||'').toLowerCase();
  return {version:1,service:'nft-console',mode,commit:COMMIT.test(commit)?commit:null,
    environment:{nodeEnv:env.NODE_ENV==='production'?'production':env.NODE_ENV==='test'?'test':'development',chainId,chainName,chainConfigured:Boolean(String(env.RPC_URL??'').trim()),
      pinningConfigured:Boolean(env.PINATA_JWT),openSeaConfigured:Boolean(env.OPENSEA_API_KEY)},
    database:{verified:databaseVerified===true},setup:{required:setupRequired===true},
    blockedActions:blockedActions(env,chainId),
    notMeasured:['token and listing counts (require an authenticated session)','CI and pull-request state (see GitHub)','external security review (deferred; not claimed)'],
    metrics:telemetry.snapshot()};
}
