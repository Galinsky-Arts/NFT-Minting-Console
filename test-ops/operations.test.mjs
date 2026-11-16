import test from 'node:test';
import assert from 'node:assert/strict';
import {backupName,neonClient,snapshot,list,verify,prune,restorePlan,schemaCheck} from '../scripts/neon-backup.mjs';
import {probe,reconcile,LABEL,TITLE} from '../scripts/uptime-check.mjs';

const json=(status,body)=>({ok:status<300,status,text:async()=>JSON.stringify(body),json:async()=>body});

function fakeNeon(){
  const branches=[{id:'br-main',name:'main',default:true,created_at:'2026-11-15T18:35:04Z',current_state:'ready'}];
  const calls=[];
  const fetchImpl=async(url,init)=>{
    const route=url.replace('https://console.neon.tech/api/v2','');calls.push({method:init.method,route,auth:init.headers.authorization,body:init.body&&JSON.parse(init.body)});
    if(init.method==='GET'&&route.includes('/schema'))return json(200,{sql:`-- dump ${Math.random()}\n\\restrict ${Math.random()}\nCREATE TABLE a();\nCREATE TABLE b();\n`});
    if(init.method==='GET'&&/\/branches$/.test(route))return json(200,{branches});
    if(init.method==='POST'&&/\/branches$/.test(route)){const b={id:'br-'+branches.length,name:JSON.parse(init.body).branch.name,parent_id:JSON.parse(init.body).branch.parent_id,parent_lsn:'0/1A2B',created_at:new Date(Date.UTC(2026,10,16,branches.length)).toISOString(),current_state:'ready'};branches.push(b);return json(201,{branch:b,endpoints:[]});}
    if(init.method==='DELETE'){const i=branches.findIndex(b=>route.endsWith('/'+b.id));branches.splice(i,1);return json(200,{});}
    return json(404,{message:'nope'});
  };
  return {branches,calls,call:neonClient({apiKey:'k-test',fetchImpl})};
}

test('backup names are dated, labelled and safe',()=>{
  assert.equal(backupName(new Date('2026-11-16T01:02:03Z')),'backup-2026-11-16-0102');
  assert.equal(backupName(new Date('2026-11-16T01:02:03Z'),'Restore Drill!'),'backup-2026-11-16-0102-restore-drill');
});

test('snapshot creates a compute-less child of the default branch; prune only removes labelled backups',async()=>{
  const n=fakeNeon();
  const s=await snapshot(n.call,{project:'p1',label:'drill',now:new Date('2026-11-16T01:00:00Z')});
  assert.equal(s.parentBranchName,'main');assert.equal(s.backupBranchName,'backup-2026-11-16-0100-drill');assert.equal(s.computeEndpoints,0);
  const post=n.calls.find(c=>c.method==='POST');assert.deepEqual(post.body,{branch:{parent_id:'br-main',name:'backup-2026-11-16-0100-drill'}});assert.equal(post.auth,'Bearer k-test');
  await assert.rejects(snapshot(n.call,{project:'p1',label:'drill',now:new Date('2026-11-16T01:00:00Z')}),/already exists/);
  for(let h=2;h<=6;h++)await snapshot(n.call,{project:'p1',label:'weekly',now:new Date(Date.UTC(2026,10,16,h))});
  assert.equal((await list(n.call,{project:'p1'})).length,6);
  assert.equal((await verify(n.call,{project:'p1',name:s.backupBranchName})).ok,true);
  await assert.rejects(verify(n.call,{project:'p1',name:'main'}),/not found/,'the production branch is never treated as a backup');
  await assert.rejects(prune(n.call,{project:'p1',keep:2}),/--label is required/);
  const dry=await prune(n.call,{project:'p1',keep:2,label:'weekly'});
  assert.equal(dry.wouldDelete.length,3);assert.equal(n.calls.filter(c=>c.method==='DELETE').length,0,'dry run deletes nothing');
  const done=await prune(n.call,{project:'p1',keep:2,label:'weekly',confirm:true});
  assert.equal(done.deleted.length,3);
  assert.ok(n.branches.some(b=>b.name==='main')&&n.branches.some(b=>b.name===s.backupBranchName),'main and the drill backup survive');
  assert.deepEqual(await schemaCheck(n.call,{project:'p1',name:s.backupBranchName}),{backup:s.backupBranchName,production:'main',database:'neondb',backupTables:2,productionTables:2,identical:true});
  assert.match(restorePlan({project:'p1',name:s.backupBranchName}),/preserve_under_name/);
});

test('Neon API errors are explicit and hint at the key on 401',async()=>{
  const call=neonClient({apiKey:'',fetchImpl:async()=>json(401,{message:'unauthorized'})});
  await assert.rejects(call('GET','/projects/x/branches'),/401.*NEON_API_KEY/);
});

function fakeGitHub(initial=[]){
  const issues=initial.map(x=>({...x})),calls=[];let next=100;
  const gh=async(method,route,body)=>{calls.push({method,route,body});
    if(method==='GET')return issues.filter(i=>i.state==='open');
    if(method==='POST'&&route==='/issues'){const i={number:next++,state:'open',title:body.title,labels:body.labels};issues.push(i);return i;}
    if(method==='POST')return {};
    if(method==='PATCH'){const i=issues.find(x=>route.endsWith('/'+x.number));i.state=body.state;return i;}
  };
  return {gh,issues,calls};
}

test('uptime: opens one issue on failure, comments while down, closes on recovery',async()=>{
  const g=fakeGitHub();
  const down={up:false,status:502,reason:'HTTP 502',attempt:3};
  assert.deepEqual(await reconcile(g.gh,down),{action:'opened',issue:100});
  assert.equal(g.issues[0].title,TITLE);assert.deepEqual(g.issues[0].labels,[LABEL]);
  assert.deepEqual(await reconcile(g.gh,down),{action:'commented',issue:100});
  assert.equal(g.issues.length,1,'no duplicate issues');
  const r=await reconcile(g.gh,{up:true,status:200,mode:'degraded',ms:900});
  assert.equal(r.action,'closed');assert.equal(g.issues[0].state,'closed');
  assert.equal((await reconcile(g.gh,{up:true,status:200,mode:'degraded',ms:5})).action,'none');
});

test('uptime probe: degraded but answering is up; errors and non-JSON are down after retries',async()=>{
  const wait=async()=>{};
  const ok=await probe('https://x/api/status',{wait,fetchImpl:async()=>({status:200,text:async()=>JSON.stringify({mode:'degraded'})})});
  assert.equal(ok.up,true);assert.equal(ok.mode,'degraded');
  let n=0;const cold=await probe('https://x/api/status',{wait,fetchImpl:async()=>{if(++n<3)throw new Error('ECONNRESET');return {status:200,text:async()=>'{"mode":"active"}'};}});
  assert.equal(cold.up,true);assert.equal(cold.attempt,3);
  const html=await probe('https://x/api/status',{wait,fetchImpl:async()=>({status:200,text:async()=>'<html>'})});
  assert.equal(html.up,false);assert.equal(html.reason,'response was not JSON');
  const bad=await probe('https://x/api/status',{wait,fetchImpl:async()=>({status:503,text:async()=>'{}'})});
  assert.equal(bad.up,false);assert.equal(bad.reason,'HTTP 503');
});
