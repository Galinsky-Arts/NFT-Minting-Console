import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {launchCases} from './launch-cases.mjs';
import {journalCases} from './journal-cases.mjs';
import pg from 'pg';
import {migrate} from '../scripts/migrate.mjs';
import {migrateAuth} from '../scripts/migrate-auth.mjs';
import {PostgresAuthStore} from '../console/auth/postgres.mjs';
import {createAuthService,AuthError} from '../console/auth/core.mjs';
import {ReleaseRepository} from '../console/data/releases.mjs';
import {databaseOptions} from '../console/data/pool.mjs';
class EmbeddedPool {
  constructor(db){this.db=db;this.tail=Promise.resolve();}
  async connect(){const previous=this.tail;let unlock;this.tail=new Promise(resolve=>{unlock=resolve;});await previous;let released=false;return {query:(...args)=>this.db.query(...args),release:()=>{if(!released){released=true;unlock();}}};}
}
const W='0x'+'11'.repeat(20),E='0x'+'22'.repeat(20),O='0x'+'33'.repeat(20),chainId=11155111,origin='https://database-test.example';
const roles=new Map([[W,'owner'],[E,'editor'],[O,'owner']]);
const owner={wallet:W,role:'owner',chainId},editor={wallet:E,role:'editor',chainId};
const handle=()=>randomBytes(32).toString('hex'),envelope=id=>({id,ciphertext:randomBytes(32).toString('base64'),nonce:randomBytes(12).toString('base64')});
const code=value=>error=>error.code===value;
test('durable store and release API repository against PostgreSQL',async t=>{
  const native=process.env.NFT_POSTGRES_TEST==='1';let db,pool;
  if(native){
    const url=process.env.TEST_DATABASE_URL_UNPOOLED;
    if(!url||process.env.NFT_TEST_DISPOSABLE_DATABASE!=='yes'||new URL(url).hostname.includes('-pooler'))throw new Error('Native tests require an EMPTY disposable TEST_DATABASE_URL_UNPOOLED and NFT_TEST_DISPOSABLE_DATABASE=yes.');
    const options=databaseOptions(url);db=new pg.Client(options);await db.connect();pool=new pg.Pool({...options,max:8});
    t.after(async()=>{await pool.end();await db.end();});
  }else{db=new PGlite();await db.waitReady;pool=new EmbeddedPool(db);t.after(async()=>db.close());}
  assert.equal((await db.query("SELECT to_regclass('nft_console.releases') AS name")).rows[0].name,null,'Refusing to alter a nonempty application database.');
  const baseline=await migrate(db),authorization=await migrateAuth(db);
  await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const store=new PostgresAuthStore({pool,origin,chainId,roles,errorFactory:(status,value)=>new AuthError(status,value)});
  const repo=new ReleaseRepository({pool,knownRoles:()=>roles});
  t.diagnostic(native?'Native PostgreSQL through pg; synthetic data only.':'Embedded PostgreSQL; serialized connection leases, not a native pg-driver claim.');
  await t.test('baseline and authorization migrations are checksum-bound and repeatable',async()=>{
    assert.deepEqual(baseline,['001_release_model.sql']);assert.deepEqual(authorization,['001_auth_store.sql','002_release_rbac.sql','003_mint_journal.sql','004_public_launch_journal.sql','005_launch_nonce_resolution.sql','006_browser_installation.sql','007_publication_workbench.sql','008_market_policy_private_workspace.sql']);
    assert.deepEqual(await migrate(db),[]);assert.deepEqual(await migrateAuth(db),[]);
    const directory=await mkdtemp(path.join(os.tmpdir(),'nft-auth-migration-'));
    try{
      for(const name of authorization)await writeFile(path.join(directory,name),await readFile(new URL('../db/auth-migrations/'+name,import.meta.url)));
      const first=await readFile(path.join(directory,authorization[0]),'utf8');await writeFile(path.join(directory,authorization[0]),first+'\n-- modified history');
      await assert.rejects(migrateAuth(db,directory),/migration changed/);await writeFile(path.join(directory,authorization[0]),first);
      await writeFile(path.join(directory,'008_failure.sql'),'CREATE TABLE nft_console_auth.rollback_fixture(id integer); SELECT deliberately_missing_function();');
      await assert.rejects(migrateAuth(db,directory));assert.equal((await db.query("SELECT to_regclass('nft_console_auth.rollback_fixture') AS name")).rows[0].name,null);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  await t.test('20 adversarial SQL assertions pass and fixtures roll back',async()=>{
    const sql=await readFile(new URL('./postgres-acceptance.sql',import.meta.url),'utf8');
    const results=typeof db.exec==='function'?await db.exec(sql):await db.query(sql);
    assert.equal(results.at(-1).rows[0].passed_checks,20);
  });
  await t.test('API role cannot assume identity or ACL-definer privileges',async()=>{
    const result=await db.query("SELECT pg_has_role('nft_console_api','nft_console_identity','SET') AS identity,pg_has_role('nft_console_api','nft_console_acl_reader','SET') AS acl");
    assert.deepEqual(result.rows[0],{identity:false,acl:false});
  });
  await t.test('two store instances have one nonce winner',async()=>{
    const now=Date.now(),id=handle(),binding=handle();await store.putChallenge(id,{wallet:W,chainId,origin,message:'synthetic',issuedAt:now,expiresAt:now+28800000,challengeExpiresAt:now+300000,bindingHash:binding});
    const second=new PostgresAuthStore({pool,origin,chainId,roles});assert.equal(await second.consumeChallenge(id,handle()),null);
    const results=await Promise.all([store.consumeChallenge(id,binding),second.consumeChallenge(id,binding)]);assert.equal(results.filter(Boolean).length,1);
  });
  await t.test('authentication survives service recreation and logout stays final',async()=>{
    const auth=()=>createAuthService({origin,chainId,roles:()=>roles,store:new PostgresAuthStore({pool,origin,chainId,roles}),checksumAddress:x=>x,verifyWallet:async()=>({valid:true,kind:'eoa'})});
    const first=auth(),challenge=await first.challenge({wallet:W,chainId,origin,ip:'fixture'});
    const login=await first.verify({wallet:W,chainId,origin,ip:'fixture',signature:'0xabcd',challengeId:challenge.response.challengeId,message:challenge.response.message,binding:challenge.binding});
    const second=auth();assert.equal((await second.authenticate({token:login.token,ip:'fixture'})).wallet,W);
    await second.logout({token:login.token,csrf:login.response.csrf,origin,ip:'fixture'});await assert.rejects(first.authenticate({token:login.token,ip:'fixture'}),code('session_required'));
  });
  await t.test('shared quotas and final session deletion are enforced',async()=>{
    const key=handle(),results=await Promise.allSettled(Array.from({length:8},()=>store.limitRequest(key,3)));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,3);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='rate_limited').length,5);
    const id=handle(),now=Date.now();await store.putSession(id,{wallet:W,chainId,origin,kind:'eoa',expiresAt:now+100000,idleExpiresAt:now+50000});await store.deleteSession(id);
    assert.equal(await store.touchSession(id,now+80000),false);assert.equal(await store.getSession(id),null);
  });
  await t.test('mismatched role maps fail closed',async()=>{await assert.rejects(new PostgresAuthStore({pool,origin,chainId,roles:new Map([[W,'owner']])}).sweep(),code('unavailable'));await store.sweep();});
  const id=randomUUID(),draft=envelope(id);
  await t.test('creation is idempotent and other accounts cannot read it',async()=>{
    assert.equal((await repo.create(owner,draft)).created,true);assert.equal((await repo.create(owner,draft)).created,false);
    await assert.rejects(repo.create(owner,envelope(id)),code('release_conflict'));await assert.rejects(repo.get(editor,id),code('release_not_found'));
  });
  await t.test('grant enables exact, revision-checked edits but not permission administration',async()=>{
    await repo.permission(owner,id,E,'editor');assert.equal((await repo.get(editor,id)).ciphertext,draft.ciphertext);
    const next=envelope(id),update={ciphertext:next.ciphertext,nonce:next.nonce,expectedRevision:'1'};
    assert.equal((await repo.update(editor,id,update)).revision,'2');assert.equal((await repo.update(editor,id,update)).changed,false);
    await assert.rejects(repo.update(editor,id,{ciphertext:draft.ciphertext,nonce:draft.nonce,expectedRevision:'1'}),code('release_conflict'));
    await assert.rejects(repo.permission(editor,id,O,'viewer'),code('forbidden'));
  });
  await t.test('revocation works after removal from login allowlist and is idempotent',async()=>{
    roles.delete(E);await repo.permission(owner,id,E,null);await repo.permission(owner,id,E,null);roles.set(E,'editor');
    await assert.rejects(repo.get(editor,id),code('release_not_found'));
    const history=await repo.permissionHistory(owner,id);assert.equal(history.events.length,2);assert.equal(history.events[0].new_permission,null);
  });
  await t.test('inventory is isolated and pooled transaction context does not leak',async()=>{
    await repo.create({wallet:O,role:'owner',chainId},envelope(randomUUID()));assert.deepEqual((await repo.list(owner)).items.map(row=>row.id),[id]);assert.deepEqual((await repo.list(editor)).items,[]);
    const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE nft_console_api');assert.equal((await client.query('SELECT id FROM nft_console.releases')).rows.length,0);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  await journalCases(t,repo,owner,{wallet:O,role:'owner',chainId});
  await launchCases(t,repo,owner,{wallet:O,role:'owner',chainId});
});
