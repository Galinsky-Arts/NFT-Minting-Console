import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../console/runtime.mjs';
const production={NODE_ENV:'production',NFT_SETUP_ENABLED:'1',PUBLIC_ORIGIN:'https://installation.example',CHAIN_ID:'1',RPC_URL:'https://rpc.example',DATABASE_URL:'postgres://unused@db.example/unused'};
test('unclaimed production startup validates launch acknowledgment before accepting enrollment',async()=>{
  await assert.rejects(createRuntime({env:production}),/launch scope/);
  await assert.rejects(createRuntime({env:{...production,NFT_PUBLIC_LAUNCH:'1'}}),/launch scope/);
});
test('a wrong RPC network blocks setup before reading or claiming an owner and closes resources',async()=>{
  let reads=0,poolClosed=0,providerClosed=0;
  await assert.rejects(createRuntime({env:{NODE_ENV:'test',NFT_SETUP_ENABLED:'1',PUBLIC_ORIGIN:'http://127.0.0.1:4140',CHAIN_ID:'31337',RPC_URL:'http://127.0.0.1:4141',NFT_SETUP_CODE:'a'.repeat(64)},testDependencies:{pool:{end:async()=>{poolClosed++;}},store:{owner:async()=>{reads++;return null;}},provider:{getNetwork:async()=>({chainId:1n}),destroy:()=>{providerClosed++;}}}}),/RPC network/);
  assert.equal(reads,0);assert.equal(poolClosed,1);assert.equal(providerClosed,1);
});
const degraded={NODE_ENV:'test',NFT_SETUP_ENABLED:'1',PUBLIC_ORIGIN:'http://127.0.0.1:4142',CHAIN_ID:'31337',NFT_SETUP_CODE:'b'.repeat(64)};
async function serve(app,fn){const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{await fn(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));await app.locals.close();}}
test('missing RPC_URL starts a clearly degraded runtime that verifies the database but keeps enrollment and chain routes closed',async()=>{
  let reads=0,poolClosed=0;
  for(const RPC_URL of [undefined,'','   ']){
    const app=await createRuntime({env:{...degraded,RPC_URL},testDependencies:{pool:{end:async()=>{poolClosed++;}},store:{owner:async()=>{reads++;return null;}},provider:{getNetwork:async()=>{throw new Error('provider must not be used');}}}});
    assert.equal(app.locals.degraded,true);
    await serve(app,async base=>{
      const health=await fetch(base+'/api/health');assert.equal(health.status,200);
      assert.deepEqual(await health.json(),{ok:true,degraded:true,chainConfigured:false,setupRequired:true,productionReady:false});
      assert.equal(health.headers.get('cache-control'),'no-store');assert.match(health.headers.get('content-security-policy'),/default-src 'self'/);
      const status=await (await fetch(base+'/api/setup/status')).json();
      assert.deepEqual(status,{version:1,required:true,chainId:31337,chainName:status.chainName,databaseVerified:true,codeConfigured:true,runtimeReady:false,fullProductReady:false,chainConfigured:false});
      const config=await (await fetch(base+'/api/config')).json();
      assert.equal(config.chainConfigured,false);assert.equal(config.loginConfigured,false);assert.ok(Object.values(config.capabilities).every(v=>v===false));
      for(const [method,route] of [['POST','/api/setup/challenge'],['POST','/api/setup/claim'],['GET','/api/auth/session'],['POST','/api/auth/challenge'],['GET','/api/marketplace'],['POST','/api/policy/inspect'],['GET','/api/workspace']]){
        const res=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:method==='POST'?JSON.stringify({setupCode:'b'.repeat(64)}):undefined});
        assert.equal(res.status,503,route);assert.equal((await res.json()).code,'chain_not_configured');
      }
    });
  }
  assert.equal(reads,3);assert.equal(poolClosed,3);
});
test('degraded runtime reports an already registered administrator and fails closed when the database is unavailable',async()=>{
  const app=await createRuntime({env:degraded,testDependencies:{pool:{end:async()=>{}},store:{owner:async()=>'0x'+'1'.repeat(40)}}});
  await serve(app,async base=>{
    assert.equal((await (await fetch(base+'/api/health')).json()).setupRequired,false);
    const status=await (await fetch(base+'/api/setup/status')).json();assert.equal(status.required,false);assert.equal(status.codeConfigured,false);assert.equal(status.chainConfigured,false);
  });
  let closed=0;
  await assert.rejects(createRuntime({env:degraded,testDependencies:{pool:{end:async()=>{closed++;}},store:{owner:async()=>{throw new Error('relation does not exist');}}}}),/relation does not exist/);
  assert.equal(closed,1);
});
test('a present but malformed or non-HTTPS RPC_URL is still a startup error, not degraded mode',async()=>{
  await assert.rejects(createRuntime({env:{...degraded,RPC_URL:'not a url'},testDependencies:{pool:{end:async()=>{}},store:{owner:async()=>null}}}),/Configure RPC_URL/);
  await assert.rejects(createRuntime({env:{...degraded,RPC_URL:'http://rpc.example'},testDependencies:{pool:{end:async()=>{}},store:{owner:async()=>null}}}),/HTTPS RPC URL/);
});
test('degraded mode still enforces the production launch scope',async()=>{
  await assert.rejects(createRuntime({env:{NODE_ENV:'production',NFT_SETUP_ENABLED:'1',PUBLIC_ORIGIN:'https://installation.example',CHAIN_ID:'11155111',DATABASE_URL:'postgres://unused@db.example/unused'}}),/launch scope/);
});
