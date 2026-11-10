import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../scripts/migrate.mjs';
import {migrateAuth} from '../scripts/migrate-auth.mjs';
import {ReleaseRepository} from '../console/data/releases.mjs';
import {PrivateStore} from '../console/private/store.mjs';
import {installPrivateRoutes} from '../console/private/http.mjs';
import {PrivateWorkspace,memoryDeviceStore,fingerprint,unb64,b64} from '../console/crypto/private-workspace.mjs';

class EmbeddedPool{constructor(db){this.db=db;this.tail=Promise.resolve();}
  async connect(){const p=this.tail;let u;this.tail=new Promise(r=>{u=r;});await p;let done=false;return {query:(...a)=>this.db.query(...a),release:()=>{if(!done){done=true;u();}}};}}
const A='0x'+'a1'.repeat(20),X='0x'+'b2'.repeat(20),chainId=11155111;
const roles=new Map([[A,'owner'],[X,'owner']]);
const MARK='PRIVATE-PLAINTEXT-MARKER-7f3a';

async function server(pool,wallet){
  const app=express();app.use('/api/private/records',express.json({limit:'1600kb'}));app.use('/api/private/blobs/:id/chunks/:index',express.raw({type:'application/octet-stream',limit:'8300kb'}));app.use(express.json());
  installPrivateRoutes(app,()=>(req,_res,next)=>{req.actor={wallet,role:'owner',chainId};next();},{store:new PrivateStore(new ReleaseRepository({pool,knownRoles:()=>roles}),{quotaBytes:64*1024*1024})});
  const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));return {url:`http://127.0.0.1:${s.address().port}`,close:()=>new Promise(r=>s.close(r))};
}
function transport(base,hooks={}){
  return async(path,{method='GET',body,raw,binary,signal}={})=>{
    if(hooks.before)await hooks.before(path,method);
    const r=await fetch(base+path,{method,signal,headers:raw?{'Content-Type':'application/octet-stream'}:body?{'Content-Type':'application/json'}:{},body:raw||(body?JSON.stringify(body):undefined)});
    if(binary&&r.ok)return r.arrayBuffer();
    let json=await r.json();if(hooks.after)json=await hooks.after(path,method,json);
    if(!r.ok){const e=new Error(json.code);e.code=json.code;throw e;}return json;
  };
}
const file=(bytes,name,type)=>new File([bytes],name,{type});
const sha=b=>createHash('sha256').update(b).digest('hex');

test('end-to-end encrypted private workspace: ciphertext-only server, devices, recovery, revocation, resume',async t=>{
  const db=new PGlite();await db.waitReady;t.after(()=>db.close());
  await migrate(db);await migrateAuth(db);await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const pool=new EmbeddedPool(db);let srv=await server(pool,A);t.after(()=>srv.close());
  const storeA=memoryDeviceStore(),storeB=memoryDeviceStore(),storeC=memoryDeviceStore();
  const image=new Uint8Array([...Buffer.from(MARK),...randomBytes(300*1024)]),video=new Uint8Array([...Buffer.from(MARK),...randomBytes(3*1024*1024+123)]);
  const recordId=crypto.randomUUID();
  let wsA=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:storeA});
  const {recoveryCode}=await wsA.create('Studio laptop');
  assert.match(recoveryCode,/^[A-Z0-9]{4}(-[A-Z0-9]{1,4}){12}$/);
  const img=await wsA.uploadFile(file(image,'art.png','image/png'),{recordId,chunkSize:64*1024});
  const draft={title:'Unreleased '+MARK,description:'Private rights notes '+MARK,works:[{tokenId:'1',file:img}],rights:'Schedule A draft '+MARK};
  assert.equal(await wsA.save(recordId,'release',draft,0),1);

  await t.test('server storage holds no plaintext, keys or recovery code',async()=>{
    const dump=JSON.stringify((await db.query(`SELECT encode(envelope,'escape') e FROM nft_console.private_records UNION ALL SELECT encode(bytes,'escape') FROM nft_console.private_blob_chunks
      UNION ALL SELECT encode(recovery_wrap,'escape') FROM nft_console.private_workspaces UNION ALL SELECT coalesce(encode(wrapped_key,'escape'),'') FROM nft_console.private_devices`)).rows);
    assert.ok(!dump.includes(MARK));assert.ok(!dump.includes(recoveryCode.replaceAll('-','')));
    const manifestKey=img.manifest.attachment_key_hex;assert.ok(!dump.includes(manifestKey));
  });
  await t.test('restart: a new server process and reloaded client unlock and verify content',async()=>{
    await srv.close();srv=await server(pool,A);
    wsA=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:storeA});
    await assert.rejects(()=>wsA.load(recordId),{code:'LOCKED'});
    await wsA.unlock();const loaded=await wsA.load(recordId);assert.equal(loaded.title,draft.title);
    const blob=await wsA.downloadFile(loaded.works[0].file,recordId);assert.equal(sha(Buffer.from(await blob.arrayBuffer())),sha(image));
  });
  await t.test('second device needs fingerprint-confirmed approval from an unlocked device',async()=>{
    const wsB=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:storeB});
    const {deviceId,fingerprint:fp}=await wsB.requestAccess('Phone');
    await assert.rejects(()=>wsB.unlock(),{code:'DEVICE_NOT_APPROVED'});
    const pending=(await wsA.status()).devices.find(d=>d.id===deviceId);
    await assert.rejects(()=>wsA.approve(pending,'0000-0000-0000-0000-0000'),{code:'FINGERPRINT_MISMATCH'});
    // A malicious server substituting its own public key is caught by the fingerprint comparison.
    const attackerKey=(await (await import('../console/crypto/private-workspace.mjs')).createDeviceKeys()).publicKey;
    await assert.rejects(()=>wsA.approve({...pending,publicKey:b64(attackerKey)},fp),{code:'FINGERPRINT_MISMATCH'});
    await wsA.approve(pending,fp);await wsB.unlock();assert.equal((await wsB.load(recordId)).rights,draft.rights);
  });
  await t.test('recovery code restores access on a fresh browser; a wrong code cannot',async()=>{
    const bad=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:memoryDeviceStore()});
    await assert.rejects(()=>bad.recover(recoveryCode.replace(/^..../,'ZZZZ'),'Bad'),{code:'RECOVERY_CODE_INCORRECT'});
    const wsC=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:storeC});
    await wsC.recover(recoveryCode,'Recovered desktop');assert.equal((await wsC.load(recordId)).title,draft.title);
  });
  await t.test('revocation rotates the key, re-seals records and retires the old recovery code',async()=>{
    const wsB=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:storeB});
    const b=await wsB.device();const before=(await db.query('SELECT envelope FROM nft_console.private_records')).rows[0].envelope;
    const {recoveryCode:fresh,keyEpoch}=await wsA.revoke(b.id);assert.equal(keyEpoch,2);
    await assert.rejects(()=>wsB.unlock(),{code:'DEVICE_REVOKED'});
    assert.notDeepEqual((await db.query('SELECT envelope FROM nft_console.private_records')).rows[0].envelope,before);
    const wsC=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:storeC});await wsC.unlock();assert.equal((await wsC.load(recordId)).title,draft.title);
    const old=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:memoryDeviceStore()});
    await assert.rejects(()=>old.recover(recoveryCode,'Old'),{code:'RECOVERY_CODE_INCORRECT'});
    const again=new PrivateWorkspace({request:transport(srv.url),wallet:A,chainId,deviceStore:memoryDeviceStore()});await again.recover(fresh,'New');
    // The revoked device cannot be reactivated.
    await assert.rejects(()=>transport(srv.url)(`/api/private/devices/${b.id}/recover`,{method:'POST',body:{keyEpoch:2,wrappedKey:b64(randomBytes(142))}}),{code:'DEVICE_NOT_PENDING'});
  });
  await t.test('tampering, substitution, stale writes and rollback are rejected',async()=>{
    const r=await wsA.load(recordId);
    await assert.rejects(()=>wsA.save(recordId,'release',r,r._revision-1),{code:'RECORD_CHANGED'});
    const rev=await wsA.save(recordId,'release',{...r,title:'v2'},r._revision);
    const oldEnvelope=(await db.query('SELECT envelope FROM nft_console.private_records WHERE id=$1',[recordId])).rows[0].envelope;
    await wsA.save(recordId,'release',{...r,title:'v3'},rev);
    // Server replays the previous revision as current: the client's high-water mark catches it.
    const replay=new PrivateWorkspace({request:transport(srv.url,{after:async(p,m,j)=>p===`/api/private/records/${recordId}`&&m==='GET'?{...j,revision:rev,envelope:b64(new Uint8Array(oldEnvelope))}:j}),wallet:A,chainId,deviceStore:storeA});
    await replay.unlock();await assert.rejects(()=>replay.load(recordId),{code:'ROLLBACK_DETECTED'});
    // Server lies about the revision number of an older envelope: AEAD binding fails.
    const relabel=new PrivateWorkspace({request:transport(srv.url,{after:async(p,m,j)=>p===`/api/private/records/${recordId}`&&m==='GET'?{...j,envelope:b64(new Uint8Array(oldEnvelope))}:j}),wallet:A,chainId,deviceStore:storeA});
    await relabel.unlock();await assert.rejects(()=>relabel.load(recordId),{code:'RECORD_AUTHENTICATION_FAILED'});
    const other=crypto.randomUUID();await wsA.save(other,'configuration',{name:'Preset'},0);
    const swap=new PrivateWorkspace({request:transport(srv.url,{after:async(p,m,j)=>p===`/api/private/records/${other}`&&m==='GET'?{...j,id:recordId}:j}),wallet:A,chainId,deviceStore:storeA});
    await swap.unlock();await assert.rejects(()=>swap.load(other),{code:'RECORD_SUBSTITUTED'});
    const env=new Uint8Array((await db.query('SELECT envelope FROM nft_console.private_records WHERE id=$1',[other])).rows[0].envelope);env[40]^=1;
    await db.query('UPDATE nft_console.private_records SET envelope=$2,revision=revision+1 WHERE id=$1',[other,Buffer.from(env)]);
    await assert.rejects(()=>wsA.load(other),{code:'RECORD_AUTHENTICATION_FAILED'});
  });
  await t.test('interrupted large upload resumes without re-sending accepted chunks; integrity enforced',async()=>{
    let puts=0,failAfter=3;const counting={before:async(p,m)=>{if(m==='PUT'&&p.includes('/chunks/')){if(failAfter--<=0)throw Object.assign(new Error('network down'),{code:'NETWORK'});puts++;}}};
    const ws=new PrivateWorkspace({request:transport(srv.url,counting),wallet:A,chainId,deviceStore:storeA});await ws.unlock();
    let saved=null;const controller=new AbortController();
    await assert.rejects(()=>ws.uploadFile(file(video,'film.mp4','video/mp4'),{recordId,chunkSize:256*1024,onProgress:p=>{if(p.phase==='prepared')saved={manifest:p.manifest,blobId:p.blobId};},signal:controller.signal}));
    assert.equal(puts,3);assert.ok(saved);
    const status=await transport(srv.url)(`/api/private/blobs/${saved.blobId}`);assert.equal(status.chunks.length,3);assert.equal(status.complete,false);
    // Resuming with a different file is refused before any encryption.
    await assert.rejects(()=>ws.uploadFile(file(new Uint8Array(video.length),'film.mp4','video/mp4'),{recordId,resume:saved}));
    puts=0;failAfter=1e9;
    const done=await ws.uploadFile(file(video,'film.mp4','video/mp4'),{recordId,resume:saved});
    assert.equal(puts,saved.manifest.chunk_count-3,'only missing chunks are uploaded');
    const back=await ws.downloadFile(done,recordId);assert.equal(sha(Buffer.from(await back.arrayBuffer())),sha(video));
    // Different bytes for an accepted chunk index are refused (no silent overwrite / nonce reuse exposure).
    await assert.rejects(()=>transport(srv.url)(`/api/private/blobs/${saved.blobId}/chunks/0`,{method:'PUT',raw:randomBytes(64)}),{code:'BLOB_COMPLETE'});
    await assert.rejects(()=>db.query("UPDATE nft_console.private_blob_chunks SET bytes=set_byte(bytes,10,0) WHERE blob_id=$1 AND index=2",[saved.blobId]));
    // Simulate storage-level corruption below the application (trigger bypassed by the database superuser).
    await db.query('ALTER TABLE nft_console.private_blob_chunks DISABLE TRIGGER guard_chunk');
    await db.query("UPDATE nft_console.private_blob_chunks SET bytes=set_byte(bytes,10,get_byte(bytes,10) # 1) WHERE blob_id=$1 AND index=2",[saved.blobId]);
    await db.query('ALTER TABLE nft_console.private_blob_chunks ENABLE TRIGGER guard_chunk');
    await assert.rejects(()=>ws.downloadFile(done,recordId));
  });
  await t.test('another account cannot read or write this workspace',async()=>{
    const intruder=await server(pool,X);t.after(()=>intruder.close());const req=transport(intruder.url);
    assert.equal((await req('/api/private/workspace')).exists,false);
    assert.deepEqual((await req('/api/private/records')).items,[]);
    await assert.rejects(()=>req(`/api/private/records/${recordId}`),{code:'NOT_FOUND'});
    await assert.rejects(()=>req(`/api/private/records/${recordId}`,{method:'PUT',body:{kind:'release',expectedRevision:1,keyEpoch:1,envelope:b64(randomBytes(80))}}),{code:'WORKSPACE_MISSING'});
  });
  void unb64;void fingerprint;
});
