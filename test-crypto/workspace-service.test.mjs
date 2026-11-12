import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../scripts/migrate.mjs';
import {migrateAuth} from '../scripts/migrate-auth.mjs';
import {ReleaseRepository} from '../console/data/releases.mjs';
import {WorkspaceService} from '../console/workspace/service.mjs';
import * as W from '../console/crypto/workspace.mjs';
import {prepareAttachment,openAttachment} from '../console/crypto/attachments.mjs';

class EmbeddedPool{constructor(db){this.db=db;this.tail=Promise.resolve();}
  async connect(){const p=this.tail;let u;this.tail=new Promise(r=>{u=r;});await p;let done=false;return {query:(...a)=>this.db.query(...a),release:()=>{if(!done){done=true;u();}}};}}
const OWNER='0x'+'11'.repeat(20),OTHER='0x'+'22'.repeat(20),VIEWER='0x'+'33'.repeat(20),chainId=31337;
const owner={wallet:OWNER,role:'owner',chainId},other={wallet:OTHER,role:'owner',chainId},viewer={wallet:VIEWER,role:'viewer',chainId};
const SECRET_TITLE='Unreleased film: The Secret Garden of Androids';

async function newDevice(root){const keys=await W.newDeviceKeys();const cert=W.certifyDevice(root,{deviceId:keys.deviceId,signaturePublicKey:W.unb64(keys.publicKey)});const kp=await W.keyPackageFor(keys,cert);return {keys,cert,kp};}
const register=d=>({deviceId:d.keys.deviceId,certificate:d.cert,keyPackage:d.kp.publicPackage,label:'test'});
/** A device replays the ordered server log into its MLS state (what the browser does on every sync). */
async function sync(svc,actor,dev,root){
  const keys={};let after=dev.after||0;
  for(const m of await svc.log(actor,{deviceId:dev.keys.deviceId,after})){
    after=Number(m.seq);
    if(m.kind==='welcome'){dev.state=await W.joinWorkspace(root.publicKey,m.body,dev.kp);continue;}
    if(!dev.state||m.senderDevice===dev.keys.deviceId||BigInt(m.epoch)<BigInt(W.epochOf(dev.state)))continue;
    const r=await W.receive(dev.state,m.body);dev.state=r.state;if(r.payload?.type==='keys')Object.assign(keys,r.payload.keys);
  }
  dev.after=after;return keys;
}

test('private workspace: ciphertext-only server, multi-device MLS key delivery, revocation, restart, resumable encrypted files',async t=>{
  const db=new PGlite();await db.waitReady;t.after(()=>db.close());
  await migrate(db);const applied=await migrateAuth(db);assert.ok(applied.includes('009_private_workspace.sql'));
  await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const roles=new Map([[OWNER,'owner'],[OTHER,'owner'],[VIEWER,'viewer']]);
  const repo=new ReleaseRepository({pool:new EmbeddedPool(db),knownRoles:()=>roles});
  let svc=new WorkspaceService(repo);
  const root=W.createAccountRoot();
  const A=await newDevice(root),B=await newDevice(root),C=await newDevice(root);

  // Device A creates the workspace and the MLS group; its secrets would live in its local vault.
  await svc.create(owner,{rootPublicKey:root.publicKey,device:register(A)});
  A.state=await W.createWorkspaceGroup(root.publicKey,A.kp);
  await assert.rejects(svc.create(owner,{rootPublicKey:root.publicKey,device:register(A)}),{code:'WORKSPACE_EXISTS'});
  await assert.rejects(svc.overview(viewer).then(()=>svc.putDraft(viewer,W.newId(),{})),{code:'FORBIDDEN'});

  // A saves an encrypted draft.
  const draftId=W.newId(),draftKey=W.newDraftKey();
  const doc={title:SECRET_TITLE,supply:40,works:[{tokenId:'1',title:'Private opening scene'}]};
  const r1=W.encryptDraft(draftKey,{draftId,revision:1,previousHash:null},doc);
  await svc.putDraft(owner,draftId,r1);
  await assert.rejects(svc.putDraft(owner,draftId,{...r1,title:SECRET_TITLE}),{code:'DRAFT_SHAPE'},'plaintext side fields are refused');
  await assert.rejects(svc.putDraft(owner,draftId,{...r1,contentHash:'0'.repeat(64)}),{code:'DRAFT_HASH'});

  // Restart: a fresh service instance over the same database.
  svc=new WorkspaceService(repo);
  assert.equal((await svc.overview(owner)).drafts[0].revision,1);

  // A device certified by a different root cannot even register.
  const foreign=await newDevice(W.createAccountRoot());
  await assert.rejects(svc.requestDevice(owner,register(foreign)),{code:'DEVICE_NOT_AUTHORIZED'});

  // B requests access; A verifies B's key package against the root, commits the Add, sends the draft key.
  await svc.requestDevice(owner,register(B));
  const pending=await svc.device(owner,B.keys.deviceId);assert.equal(pending.status,'pending');
  let add=await W.addDevice(A.state,root.publicKey,pending.keyPackage);
  await svc.commit(owner,{epoch:W.epochOf(A.state),senderDevice:A.keys.deviceId,commit:add.commit,welcome:{targetDevice:B.keys.deviceId,body:add.welcome},activate:B.keys.deviceId});
  A.state=add.state;
  await assert.rejects(svc.commit(owner,{epoch:'0',senderDevice:A.keys.deviceId,commit:add.commit}),{code:'STALE_EPOCH'},'one commit per epoch: no forks');
  let sent=await W.sendToMembers(A.state,{type:'keys',keys:{[draftId]:draftKey}});A.state=sent.state;
  await svc.application(owner,{epoch:sent.epoch,senderDevice:A.keys.deviceId,body:sent.message});
  const bKeys=await sync(svc,owner,B,root);
  assert.equal(bKeys[draftId],draftKey);
  assert.deepEqual(W.decryptDraft(bKeys[draftId],await svc.getDraft(owner,draftId),{draftId}),doc);

  // B edits; a stale or replayed save by A is refused.
  const r2=W.encryptDraft(draftKey,{draftId,revision:2,previousHash:r1.contentHash},{...doc,supply:41});
  await svc.putDraft(owner,draftId,r2);
  const staleA=W.encryptDraft(draftKey,{draftId,revision:2,previousHash:r1.contentHash},{...doc,supply:99});
  await assert.rejects(svc.putDraft(owner,draftId,staleA),{code:'STALE_REVISION'});
  await assert.rejects(svc.putDraft(owner,draftId,r1),{code:'STALE_REVISION'},'replaying revision 1 is refused');

  // Another wallet's session cannot see this workspace (row-level security).
  assert.deepEqual(await svc.overview(other),{exists:false});
  await assert.rejects(svc.getDraft(other,draftId),{code:'NOT_FOUND'});

  // Add C, revoke B, rotate the draft key and re-encrypt: C can read, B cannot obtain the new key.
  await svc.requestDevice(owner,register(C));
  add=await W.addDevice(A.state,root.publicKey,(await svc.device(owner,C.keys.deviceId)).keyPackage);
  await svc.commit(owner,{epoch:W.epochOf(A.state),senderDevice:A.keys.deviceId,commit:add.commit,welcome:{targetDevice:C.keys.deviceId,body:add.welcome},activate:C.keys.deviceId});A.state=add.state;
  const removed=await W.removeDevice(A.state,B.keys.deviceId);
  await svc.commit(owner,{epoch:W.epochOf(A.state),senderDevice:A.keys.deviceId,commit:removed.commit,revoke:B.keys.deviceId});A.state=removed.state;
  const rotated=W.newDraftKey();
  sent=await W.sendToMembers(A.state,{type:'keys',keys:{[draftId]:rotated}});A.state=sent.state;
  await svc.application(owner,{epoch:sent.epoch,senderDevice:A.keys.deviceId,body:sent.message});
  const r3=W.encryptDraft(rotated,{draftId,revision:3,previousHash:r2.contentHash},{...doc,supply:42});
  await svc.putDraft(owner,draftId,r3);
  const cKeys=await sync(svc,owner,C,root);
  assert.equal(cKeys[draftId],rotated);
  assert.equal(W.decryptDraft(cKeys[draftId],await svc.getDraft(owner,draftId)).supply,42);
  await assert.rejects(sync(svc,owner,B,root),'the revoked device cannot process the post-removal epoch');
  const latest=await svc.getDraft(owner,draftId);
  assert.throws(()=>W.decryptDraft(draftKey,latest),/DRAFT_CORRUPT/,'the pre-rotation key cannot open the rotated draft');
  await assert.rejects(svc.application(owner,{epoch:W.epochOf(A.state),senderDevice:B.keys.deviceId,body:sent.message}),{code:'SENDER_NOT_ACTIVE'});
  const overview=await svc.overview(owner);
  assert.deepEqual(Object.fromEntries(overview.devices.map(d=>[d.deviceId,d.status])),{[A.keys.deviceId]:'active',[B.keys.deviceId]:'revoked',[C.keys.deviceId]:'active'});

  // Resumable encrypted file: interrupt after 2 of 4 chunks, resume without re-sending accepted chunks.
  const bytes=new Uint8Array(3*1024*1024+123);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31)&255;
  const prepared=await prepareAttachment(new Blob([bytes]),{parentMessageId:draftId,filename:'secret-cut.mp4',mediaType:'video/mp4',chunkSize:1024*1024});
  const m=prepared.privateManifest,objectId=W.newId();
  const chunks=[];await prepared.encryptTo((i,c)=>{chunks[i]=c;});
  const size=chunks.reduce((s,c)=>s+c.length,0);
  await svc.createObject(owner,{objectId,chunkCount:chunks.length,chunkSize:m.chunk_size_bytes,ciphertextSize:size});
  const sha=c=>createHash('sha256').update(c).digest('hex');
  let uploads=0;const put=async i=>{uploads++;return svc.putChunk(owner,objectId,i,chunks[i],sha(chunks[i]));};
  await put(0);await put(1);
  const status=await svc.objectStatus(owner,objectId);assert.deepEqual(status.received.map(x=>x.index),[0,1]);assert.equal(status.complete,false);
  for(let i=0;i<chunks.length;i++)if(!status.received.some(x=>x.index===i))await put(i);
  assert.equal(uploads,chunks.length,'accepted chunks were not uploaded again');
  assert.equal((await put(0)).duplicate,true);
  await assert.rejects(svc.putChunk(owner,objectId,1,chunks[0],sha(chunks[0])),{code:'CHUNK_CONFLICT'});
  await assert.rejects(svc.putChunk(owner,objectId,2,chunks[2],'0'.repeat(64)),{code:'CHUNK_HASH'});
  assert.equal((await svc.objectStatus(owner,objectId)).complete,true);
  const opened=await openAttachment(m,draftId),out=[];
  const result=await opened.decryptTo(async i=>(await svc.getChunk(owner,objectId,i)).body,(i,p)=>{out[i]=new Uint8Array(p);});
  assert.equal(result.wholeFileVerified,true);
  const restored=Buffer.concat(out.map(x=>Buffer.from(x)));
  assert.equal(restored.length,bytes.length);
  assert.equal(sha(restored),sha(bytes),'decrypted bytes match the original exactly');
  const tampered=new Uint8Array(chunks[3]);tampered[5]^=1;
  await assert.rejects((await openAttachment(m,draftId)).decryptTo(async i=>i===3?tampered:(await svc.getChunk(owner,objectId,i)).body,()=>{}));

  // Server-side compromise view: every stored byte in the workspace tables, as the database owner sees it.
  const dump=JSON.stringify((await db.query(`SELECT row_to_json(x)::text AS j FROM (SELECT * FROM nft_console.workspace_accounts) x UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM nft_console.workspace_devices) x
    UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM nft_console.workspace_log) x UNION ALL SELECT row_to_json(x)::text FROM (SELECT * FROM nft_console.workspace_drafts) x
    UNION ALL SELECT encode(body,'escape') FROM nft_console.workspace_chunks`)).rows);
  for(const secret of [SECRET_TITLE,'Private opening scene','secret-cut.mp4',draftKey,rotated,root.secretKey,A.keys.signKey,m.attachment_key_hex])assert.ok(!dump.includes(secret),'server storage must not contain '+secret.slice(0,12));
});

test('enrollment by fingerprint and full recovery after losing every device',async()=>{
  const db=new PGlite();await db.waitReady;
  try{
    await migrate(db);await migrateAuth(db);
    await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
    const repo=new ReleaseRepository({pool:new EmbeddedPool(db),knownRoles:()=>new Map([[OWNER,'owner']])});
    const svc=new WorkspaceService(repo),root=W.createAccountRoot(),A=await newDevice(root);
    await svc.create(owner,{rootPublicKey:root.publicKey,device:register(A)});A.state=await W.createWorkspaceGroup(root.publicKey,A.kp);
    // New device B: has no root. It publishes its key; A compares the fingerprint and certifies.
    const bKeys=await W.newDeviceKeys();
    await svc.requestEnrollment(owner,{deviceId:bKeys.deviceId,signaturePublicKey:bKeys.publicKey,label:'Laptop'});
    const seen=(await svc.overview(owner)).enrollments[0];
    assert.equal(W.fingerprint(seen.signaturePublicKey),W.fingerprint(bKeys.publicKey));
    const wrongCert=W.certifyDevice(root,{deviceId:bKeys.deviceId,signaturePublicKey:W.unb64((await W.newDeviceKeys()).publicKey)});
    await assert.rejects(svc.certifyEnrollment(owner,bKeys.deviceId,wrongCert),{code:'DEVICE_NOT_AUTHORIZED'},'a certificate for a substituted key is refused');
    await svc.certifyEnrollment(owner,bKeys.deviceId,W.certifyDevice(root,{deviceId:bKeys.deviceId,signaturePublicKey:W.unb64(bKeys.publicKey)}));
    const cert=(await svc.enrollment(owner,bKeys.deviceId)).certificate;
    const B={keys:bKeys,cert,kp:await W.keyPackageFor(bKeys,cert)};
    await svc.requestDevice(owner,register(B));
    const add=await W.addDevice(A.state,root.publicKey,(await svc.device(owner,B.keys.deviceId)).keyPackage);
    await svc.commit(owner,{epoch:'0',senderDevice:A.keys.deviceId,commit:add.commit,welcome:{targetDevice:B.keys.deviceId,body:add.welcome},activate:B.keys.deviceId});
    await sync(svc,owner,B,root);assert.ok(B.state,'B joined via its Welcome');
    // Every device is lost. The recovery backup restores the root and draft keys.
    const draftId=W.newId(),key=W.newDraftKey(),code=W.newRecoveryCode();
    await svc.putDraft(owner,draftId,W.encryptDraft(key,{draftId,revision:1,previousHash:null},{title:'kept'}));
    const backup=await W.createRecoveryBackup(code,{root,draftKeys:{[draftId]:key},accountWallet:OWNER});
    const restored=await W.openRecoveryBackup(code,backup);
    const R=await newDevice(restored.root);
    const forged=W.signReset(W.createAccountRoot(),{wallet:OWNER,chainId,generation:2,deviceId:R.keys.deviceId});
    await assert.rejects(svc.reset(owner,{...forged,device:register(R)}),{code:'RESET_NOT_AUTHORIZED'});
    const stale=W.signReset(restored.root,{wallet:OWNER,chainId,generation:1,deviceId:R.keys.deviceId});
    await assert.rejects(svc.reset(owner,{...stale,device:register(R)}),{code:'RESET_NOT_AUTHORIZED'},'a replayed old-generation reset is refused');
    const signed=W.signReset(restored.root,{wallet:OWNER,chainId,generation:2,deviceId:R.keys.deviceId});
    assert.deepEqual(await svc.reset(owner,{...signed,device:register(R)}),{generation:2,epoch:'0'});
    await assert.rejects(svc.reset(owner,{...signed,device:register(R)}),{code:'RESET_NOT_AUTHORIZED'},'the same reset cannot be replayed');
    const o=await svc.overview(owner);
    assert.deepEqual(o.devices.filter(d=>d.status==='active').map(d=>d.deviceId),[R.keys.deviceId]);
    R.state=await W.createWorkspaceGroup(restored.root.publicKey,R.kp);
    assert.deepEqual(W.decryptDraft(restored.draftKeys[draftId],await svc.getDraft(owner,draftId)),{title:'kept'});
  }finally{await db.close();}
});
