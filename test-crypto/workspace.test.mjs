import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../console/crypto/workspace.mjs';

const PASS='correct horse battery staple';
async function device(root){const keys=await W.newDeviceKeys();const cert=W.certifyDevice(root,{deviceId:keys.deviceId,signaturePublicKey:W.unb64(keys.publicKey)});return {keys,cert,kp:await W.keyPackageFor(keys,cert)};}

test('vault: Argon2id at the RFC 9106 floor, authenticated, versioned, wrong passphrase rejected',async t=>{
  const started=Date.now();
  const {key,sealed}=await W.createVault(PASS,{hello:'world'});
  assert.deepEqual(sealed.kdf.t>=3&&sealed.kdf.m>=65536&&sealed.kdf.p>=4,true);
  assert.deepEqual((await W.openVault(PASS,sealed)).state,{hello:'world'});
  await assert.rejects(W.openVault('wrong passphrase!!',sealed),/VAULT_LOCKED/);
  const next=W.resealVault(key,sealed,{hello:'again'});assert.equal(next.version,2);
  assert.throws(()=>W.openVaultWithKey(key,{...next,version:1}),/VAULT_LOCKED/,'version is authenticated');
  await assert.rejects(W.openVault(PASS,{...sealed,kdf:{...sealed.kdf,m:1024}}),/VAULT_KDF/,'weak KDF parameters are refused');
  await assert.rejects(W.createVault('short',{}),/PASSPHRASE/);
  t.diagnostic(`argon2id unlock+create took ${Date.now()-started} ms`);
});

test('MLS membership is restricted to account-root-certified devices; removed devices lose access',async()=>{
  const root=W.createAccountRoot(),other=W.createAccountRoot();
  const a=await device(root),b=await device(root),c=await device(root),intruder=await device(other);
  let A=await W.createWorkspaceGroup(root.publicKey,a.kp);
  assert.throws(()=>W.inspectKeyPackage(root.publicKey,intruder.kp.publicPackage),/DEVICE_NOT_AUTHORIZED/);
  // A forged certificate (right root key, wrong signature key) is rejected too.
  const forged=await W.keyPackageFor(intruder.keys,{...intruder.cert,root:root.publicKey}).catch(()=>null);
  if(forged)assert.throws(()=>W.inspectKeyPackage(root.publicKey,forged.publicPackage),/DEVICE_NOT_AUTHORIZED/);
  let r=await W.addDevice(A,root.publicKey,b.kp.publicPackage);A=r.state;
  let B=await W.joinWorkspace(root.publicKey,r.welcome,b.kp);
  assert.deepEqual(W.memberDevices(B).sort(),[a.keys.deviceId,b.keys.deviceId].sort());
  // Persist and restore B's group state (as stored inside its vault).
  B=W.loadGroup(W.saveGroup(B),root.publicKey);
  r=await W.addDevice(A,root.publicKey,c.kp.publicPackage);A=r.state;
  B=(await W.receive(B,r.commit)).state;
  let C=await W.joinWorkspace(root.publicKey,r.welcome,c.kp);
  assert.equal(W.epochOf(A),W.epochOf(B));assert.equal(W.epochOf(A),W.epochOf(C));
  const draftKey=W.newDraftKey();
  const sent=await W.sendToMembers(A,{type:'keys',keys:{d1:draftKey}});A=sent.state;
  const gotB=await W.receive(B,sent.message);B=gotB.state;assert.equal(gotB.payload.keys.d1,draftKey);
  const gotC=await W.receive(C,sent.message);C=gotC.state;assert.equal(gotC.payload.keys.d1,draftKey);
  // Revoke B, then deliver a rotated key: C reads it, B cannot.
  const removed=await W.removeDevice(A,b.keys.deviceId);A=removed.state;
  C=(await W.receive(C,removed.commit)).state;
  const rotated=W.newDraftKey();const s2=await W.sendToMembers(A,{type:'keys',keys:{d1:rotated}});A=s2.state;
  assert.equal((await W.receive(C,s2.message)).payload.keys.d1,rotated);
  await assert.rejects(W.receive(B,s2.message));
  assert.ok(!W.memberDevices(A).includes(b.keys.deviceId));
});

test('drafts: authenticated header, hash-chained revisions, corruption and substitution rejected',()=>{
  const key=W.newDraftKey(),draftId=W.newId();
  const r1=W.encryptDraft(key,{draftId,revision:1,previousHash:null},{title:'Private work',supply:40});
  assert.deepEqual(W.decryptDraft(key,r1,{draftId,revision:1}),{title:'Private work',supply:40});
  const r2=W.encryptDraft(key,{draftId,revision:2,previousHash:r1.contentHash},{title:'Revised'});
  assert.throws(()=>W.decryptDraft(key,r2,{revision:1}),/DRAFT_STALE/);
  assert.throws(()=>W.decryptDraft(key,{...r2,revision:3}),/DRAFT_CORRUPT/);
  const flipped={...r2,ciphertext:W.b64(W.unb64(r2.ciphertext).map((x,i)=>i===0?x^1:x))};
  assert.throws(()=>W.decryptDraft(key,flipped),/DRAFT_CORRUPT/);
  assert.throws(()=>W.decryptDraft(W.newDraftKey(),r2),/DRAFT_CORRUPT/);
  assert.ok(!r2.ciphertext.includes('Revised')&&!JSON.stringify(r2).includes('Revised'));
});

test('recovery: random recovery code restores the root and draft keys; wrong code fails',async()=>{
  const root=W.createAccountRoot(),code=W.newRecoveryCode();
  const backup=await W.createRecoveryBackup(code,{root,draftKeys:{d1:W.newDraftKey()},accountWallet:'0x'+'11'.repeat(20)});
  const restored=await W.openRecoveryBackup(code,backup);
  assert.equal(restored.root.publicKey,root.publicKey);
  await assert.rejects(W.openRecoveryBackup(W.newRecoveryCode(),backup),/VAULT_LOCKED/);
  assert.ok(!JSON.stringify(backup).includes(root.secretKey));
});
