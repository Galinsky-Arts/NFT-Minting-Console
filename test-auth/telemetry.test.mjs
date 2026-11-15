import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelemetry,routeGroup,statusReport,blockedActions} from '../console/telemetry/status.mjs';
import {createRuntime} from '../console/runtime.mjs';

test('route groups are bounded and never carry identifiers or query strings',()=>{
  assert.equal(routeGroup('/api/workspace/drafts/abc'),'/api/workspace');
  assert.equal(routeGroup('/api/collections/0x'+'a'.repeat(40)),'/api/collections');
  assert.equal(routeGroup('/api/0xdeadbeef'),'/api/other');
  assert.equal(routeGroup('/assets/index.js'),'static');
  const t=createTelemetry({log:()=>{}});for(let i=0;i<200;i++)t.record('/api/r'+'x'.repeat(i%40),200,1);
  assert.ok(Object.keys(t.snapshot().routes).length<=65);
});
test('metrics count status classes, latency buckets and log 5xx as structured lines without paths',()=>{
  let clock=1000;const logs=[];const t=createTelemetry({now:()=>clock,log:l=>logs.push(l)});
  const fire=(path,status,ms)=>{const handlers={};const res={statusCode:status,on:(e,f)=>{handlers[e]=f;}};t.middleware({path,method:'GET'},res,()=>{});clock+=ms;handlers.finish();};
  fire('/api/health',200,10);fire('/api/workspace/drafts/secret-id',503,3000);fire('/x',404,60);
  const s=t.snapshot();
  assert.equal(s.requests,3);assert.equal(s.serverErrors,1);
  assert.equal(s.routes['/api/health'].status['2xx'],1);assert.equal(s.routes['/api/health'].latencyMs.le50,1);
  assert.equal(s.routes['/api/workspace'].status['5xx'],1);assert.equal(s.routes['/api/workspace'].latencyMs.le5000,1);
  assert.equal(s.routes.static.status['4xx'],1);
  assert.equal(logs.length,1);assert.deepEqual(JSON.parse(logs[0]),{event:'http.server_error',route:'/api/workspace',method:'GET',status:503,ms:3000});
  assert.ok(!logs[0].includes('secret-id'));
});
test('status report names missing env vars but never exposes configured values',()=>{
  const env={NODE_ENV:'production',RPC_URL:'https://rpc.example/key-SECRET1',PINATA_JWT:'SECRET2',OPENSEA_API_KEY:'SECRET3',DATABASE_URL:'postgres://u:SECRET4@h/d',NFT_SETUP_CODE:'SECRET5',RENDER_GIT_COMMIT:'60691E82c87798bd21965af8de40196395c76b35'};
  const r=statusReport({telemetry:createTelemetry(),env,chainId:1,chainName:'Ethereum',mode:'active',databaseVerified:true,setupRequired:false});
  assert.ok(!/SECRET/.test(JSON.stringify(r)));assert.deepEqual(r.blockedActions,[]);assert.equal(r.commit,'60691e82c87798bd21965af8de40196395c76b35');
  assert.equal(statusReport({telemetry:createTelemetry(),env:{RENDER_GIT_COMMIT:'not a sha; drop'},chainId:1,mode:'active'}).commit,null);
  assert.deepEqual(blockedActions({},11155111).map(b=>b.envVar),['RPC_URL','PINATA_JWT']);
  assert.deepEqual(blockedActions({RPC_URL:'https://x'},1).map(b=>b.envVar),['PINATA_JWT','OPENSEA_API_KEY']);
});
test('degraded runtime serves /api/status with the RPC_URL blocker and live request metrics',async()=>{
  const app=await createRuntime({env:{NODE_ENV:'test',NFT_SETUP_ENABLED:'1',PUBLIC_ORIGIN:'http://127.0.0.1:4143',CHAIN_ID:'31337',NFT_SETUP_CODE:'c'.repeat(64)},testDependencies:{pool:{end:async()=>{}},store:{owner:async()=>null}}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    await fetch(base+'/api/health');await fetch(base+'/api/marketplace');
    const res=await fetch(base+'/api/status');assert.equal(res.status,200);const s=await res.json();
    assert.equal(s.mode,'degraded');assert.equal(s.environment.chainConfigured,false);assert.equal(s.setup.required,true);assert.equal(s.database.verified,true);
    assert.equal(s.blockedActions[0].envVar,'RPC_URL');
    assert.equal(s.metrics.routes['/api/health'].status['2xx'],1);assert.equal(s.metrics.routes['/api/marketplace'].status['5xx'],1);
    assert.match(res.headers.get('content-security-policy'),/default-src 'self'/);
  }finally{await new Promise(r=>server.close(r));await app.locals.close();}
});
