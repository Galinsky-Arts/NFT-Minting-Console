/**
 * Private release workspace cryptography (client-only; runs in the browser and in Node tests).
 * Selected E2EESA profiles (docs/E2EESA_APPLICABILITY.md):
 *  - secret-software-vault@0.1.0: Argon2id v0x13 (RFC 9106 second recommended option as the floor)
 *    + XChaCha20-Poly1305 authenticated vault, explicit local unlock.
 *  - identity-account-root@0.1.0: a client-held Ed25519 account root certifies each device's MLS
 *    signature key. Wallet login is separate and never derives these keys.
 *  - group-mls-rfc9420@0.1.0: RFC 9420 MLS (ts-mls, suite 1) delivers draft keys to authorized devices
 *    only; every MLS credential must carry a valid account-root certificate (custom AuthenticationService).
 *  - attachment-chunked-aead@0.1.0: files use ./attachments.mjs.
 * Reviewed libraries only (noble, ts-mls); no custom primitives. Not independently audited.
 */
import * as MLS from 'ts-mls';
import {argon2idAsync} from '@noble/hashes/argon2';
import {sha256} from '@noble/hashes/sha256';
import {xchacha20poly1305} from '@noble/ciphers/chacha.js';
import {ed25519} from '@noble/curves/ed25519.js';

export const VAULT_PROFILE='secret-software-vault@0.1.0';
export const MLS_PROFILE='group-mls-rfc9420@0.1.0';
export const MLS_SUITE='MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
export const ARGON2_FLOOR=Object.freeze({t:3,p:4,m:65536});
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
export class WorkspaceCryptoError extends Error{constructor(code){super('Private workspace: '+code);this.code=code;this.name='WorkspaceCryptoError';}}
const fail=code=>{throw new WorkspaceCryptoError(code);};
export const random=n=>globalThis.crypto.getRandomValues(new Uint8Array(n));
export const b64=u=>{let s='';for(const x of u)s+=String.fromCharCode(x);return btoa(s);};
export const unb64=s=>{if(typeof s!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))fail('ENCODING');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
export const hex=u=>Array.from(u,x=>x.toString(16).padStart(2,'0')).join('');
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
const ID=/^[0-9a-f]{32}$/;
export const newId=()=>hex(random(16));

/* ------------------------------ local vault ------------------------------ */
function checkKdf(kdf){
  if(!kdf||kdf.alg!=='argon2id'||kdf.v!==0x13||!Number.isSafeInteger(kdf.t)||!Number.isSafeInteger(kdf.m)||!Number.isSafeInteger(kdf.p)||
     kdf.t<ARGON2_FLOOR.t||kdf.m<ARGON2_FLOOR.m||kdf.p<ARGON2_FLOOR.p||kdf.t>10||kdf.m>1048576||kdf.p>16)fail('VAULT_KDF');
  const salt=unb64(kdf.salt);if(salt.length!==16)fail('VAULT_KDF');return salt;
}
export async function deriveVaultKey(passphrase,kdf){
  if(typeof passphrase!=='string'||[...passphrase].length<12||passphrase.length>1024)fail('PASSPHRASE');
  const salt=checkKdf(kdf);
  return argon2idAsync(enc.encode(passphrase.normalize('NFKC')),salt,{t:kdf.t,m:kdf.m,p:kdf.p,dkLen:32,version:0x13,asyncTick:20});
}
const vaultAad=s=>enc.encode(canonical({format:s.format,profile:s.profile,vaultId:s.vaultId,version:s.version,kdf:s.kdf}));
function seal(key,head,state){
  const nonce=random(24);const body={...head,nonce:b64(nonce)};
  body.ciphertext=b64(xchacha20poly1305(key,nonce,vaultAad(body)).encrypt(enc.encode(canonical(state))));return body;
}
export async function createVault(passphrase,state){
  const kdf={alg:'argon2id',v:0x13,...ARGON2_FLOOR,salt:b64(random(16))};
  const key=await deriveVaultKey(passphrase,kdf);
  return {key,sealed:seal(key,{format:'nft-console-vault/1',profile:VAULT_PROFILE,vaultId:newId(),version:1,kdf},state)};
}
export function openVaultWithKey(key,sealed){
  if(!sealed||sealed.format!=='nft-console-vault/1'||sealed.profile!==VAULT_PROFILE||!ID.test(sealed.vaultId)||!Number.isSafeInteger(sealed.version)||sealed.version<1)fail('VAULT_FORMAT');
  checkKdf(sealed.kdf);
  let plain;try{plain=xchacha20poly1305(key,unb64(sealed.nonce),vaultAad(sealed)).decrypt(unb64(sealed.ciphertext));}catch{fail('VAULT_LOCKED');}
  return JSON.parse(dec.decode(plain));
}
export async function openVault(passphrase,sealed){
  checkKdf(sealed?.kdf);const key=await deriveVaultKey(passphrase,sealed.kdf);
  return {key,state:openVaultWithKey(key,sealed)};
}
/** Re-encrypts under the same unlocked key with a strictly increasing version (local rollback signal). */
export function resealVault(key,sealed,state){
  return seal(key,{format:sealed.format,profile:sealed.profile,vaultId:sealed.vaultId,version:sealed.version+1,kdf:sealed.kdf},state);
}

/* ------------------------------ account root ----------------------------- */
export function createAccountRoot(){
  const secretKey=ed25519.utils.randomSecretKey();return {secretKey:b64(secretKey),publicKey:b64(ed25519.getPublicKey(secretKey))};
}
const certBytes=c=>enc.encode('nft-console-device-cert/1\n'+canonical({deviceId:c.deviceId,signaturePublicKey:c.signaturePublicKey,issuedAt:c.issuedAt,root:c.root}));
export function certifyDevice(root,{deviceId,signaturePublicKey,issuedAt=new Date().toISOString()}){
  if(!ID.test(deviceId))fail('DEVICE_ID');
  const cert={v:1,deviceId,signaturePublicKey:b64(signaturePublicKey),issuedAt,root:root.publicKey};
  return {...cert,signature:b64(ed25519.sign(certBytes(cert),unb64(root.secretKey)))};
}
export function verifyDeviceCert(rootPublicKey,cert,signaturePublicKey){
  try{
    if(!cert||cert.v!==1||!ID.test(cert.deviceId)||cert.root!==rootPublicKey)return false;
    if(signaturePublicKey&&cert.signaturePublicKey!==b64(signaturePublicKey))return false;
    return ed25519.verify(unb64(cert.signature),certBytes(cert),unb64(rootPublicKey));
  }catch{return false;}
}
const certFromCredential=c=>{try{return c?.credentialType==='basic'?JSON.parse(dec.decode(c.identity)):null;}catch{return null;}};
export function rootAuthService(rootPublicKey){
  return {async validateCredential(credential,signaturePublicKey){return verifyDeviceCert(rootPublicKey,certFromCredential(credential),signaturePublicKey);}};
}
export const clientConfig=rootPublicKey=>({keyRetentionConfig:MLS.defaultKeyRetentionConfig,lifetimeConfig:MLS.defaultLifetimeConfig,
  keyPackageEqualityConfig:MLS.defaultKeyPackageEqualityConfig,paddingConfig:MLS.defaultPaddingConfig,authService:rootAuthService(rootPublicKey)});

/* --------------------------------- MLS ---------------------------------- */
let suite;export const mlsSuite=async()=>suite||(suite=await MLS.getCiphersuiteImpl(MLS.getCiphersuiteFromName(MLS_SUITE)));
const wire=m=>b64(MLS.encodeMlsMessage(m));
function unwire(s,kind){const m=MLS.decodeMlsMessage(unb64(s),0)?.[0];if(!m||m.wireformat!==kind)fail('MLS_MESSAGE');return m;}

/** A new device creates its signature key; the public half must be certified by the account root. */
export async function newDeviceKeys(){
  const impl=await mlsSuite();const k=await impl.signature.keygen();
  return {deviceId:newId(),signKey:b64(k.signKey),publicKey:b64(k.publicKey)};
}
export async function keyPackageFor(device,cert){
  const impl=await mlsSuite();
  if(cert.deviceId!==device.deviceId||cert.signaturePublicKey!==device.publicKey)fail('CERTIFICATE');
  const kp=await MLS.generateKeyPackageWithKey({credentialType:'basic',identity:enc.encode(canonical(cert))},MLS.defaultCapabilities(),MLS.defaultLifetime,[],
    {signKey:unb64(device.signKey),publicKey:unb64(device.publicKey)},impl);
  return {publicPackage:wire({keyPackage:kp.publicPackage,wireformat:'mls_key_package',version:'mls10'}),privatePackage:kp.privatePackage,keyPackage:kp.publicPackage};
}
export const saveGroup=state=>b64(MLS.encodeGroupState(state));
export function loadGroup(saved,rootPublicKey){
  const decoded=MLS.decodeGroupState(unb64(saved),0);if(!decoded)fail('GROUP_STATE');
  return {...decoded[0],clientConfig:clientConfig(rootPublicKey)};
}
export const epochOf=state=>BigInt(state.groupContext.epoch).toString();
export async function createWorkspaceGroup(rootPublicKey,kp){
  const impl=await mlsSuite();
  return MLS.createGroup(random(16),kp.keyPackage,kp.privatePackage,[],impl,clientConfig(rootPublicKey));
}
/** Verifies a pending device's key package against the account root before any Add is committed. */
export function inspectKeyPackage(rootPublicKey,encoded){
  const m=unwire(encoded,'mls_key_package');const leaf=m.keyPackage.leafNode;
  const cert=certFromCredential(leaf.credential);
  if(!verifyDeviceCert(rootPublicKey,cert,leaf.signaturePublicKey))fail('DEVICE_NOT_AUTHORIZED');
  return {keyPackage:m.keyPackage,deviceId:cert.deviceId,cert};
}
export async function addDevice(state,rootPublicKey,encodedKeyPackage){
  const impl=await mlsSuite();const {keyPackage,deviceId}=inspectKeyPackage(rootPublicKey,encodedKeyPackage);
  if(memberDevices(state).includes(deviceId))fail('ALREADY_MEMBER');
  const r=await MLS.createCommit({state,cipherSuite:impl},{extraProposals:[{proposalType:'add',add:{keyPackage}}],ratchetTreeExtension:true});
  r.consumed?.forEach(MLS.zeroOutUint8Array);
  return {state:r.newState,commit:wire(r.commit),welcome:wire({welcome:r.welcome,wireformat:'mls_welcome',version:'mls10'}),epoch:epochOf(r.newState),deviceId};
}
export async function removeDevice(state,deviceId){
  const impl=await mlsSuite();const leaf=leafOf(state,deviceId);if(leaf===null)fail('NOT_A_MEMBER');
  const r=await MLS.createCommit({state,cipherSuite:impl},{extraProposals:[{proposalType:'remove',remove:{removed:leaf}}]});
  r.consumed?.forEach(MLS.zeroOutUint8Array);return {state:r.newState,commit:wire(r.commit),epoch:epochOf(r.newState)};
}
export async function joinWorkspace(rootPublicKey,welcome,kp){
  const impl=await mlsSuite();const m=unwire(welcome,'mls_welcome');
  return MLS.joinGroup(m.welcome,kp.keyPackage,kp.privatePackage,MLS.emptyPskIndex,impl,undefined,undefined,clientConfig(rootPublicKey));
}
export function memberDevices(state){
  return state.ratchetTree.flatMap(n=>n?.nodeType==='leaf'?[certFromCredential(n.leaf.credential)?.deviceId]:[]).filter(Boolean);
}
function leafOf(state,deviceId){
  for(let i=0;i<state.ratchetTree.length;i+=2){const n=state.ratchetTree[i];if(n?.nodeType==='leaf'&&certFromCredential(n.leaf.credential)?.deviceId===deviceId)return i/2;}
  return null;
}
/** Encrypts a workspace control message (draft keys) to the current authorized members only. */
export async function sendToMembers(state,payload){
  const impl=await mlsSuite();const r=await MLS.createApplicationMessage(state,enc.encode(canonical(payload)),impl);
  r.consumed?.forEach(MLS.zeroOutUint8Array);
  return {state:r.newState,message:wire({privateMessage:r.privateMessage,wireformat:'mls_private_message',version:'mls10'}),epoch:epochOf(state)};
}
/** Processes a commit or application message from the ordered log. Returns the payload for application messages. */
export async function receive(state,encoded){
  const impl=await mlsSuite();const m=MLS.decodeMlsMessage(unb64(encoded),0)?.[0];
  if(!m)fail('MLS_MESSAGE');
  const r=m.wireformat==='mls_private_message'?await MLS.processPrivateMessage(state,m.privateMessage,MLS.emptyPskIndex,impl)
    :m.wireformat==='mls_public_message'?await MLS.processPublicMessage(state,m.publicMessage,MLS.emptyPskIndex,impl):fail('MLS_MESSAGE');
  r.consumed?.forEach(MLS.zeroOutUint8Array);
  return {state:r.newState,payload:r.kind==='applicationMessage'?JSON.parse(dec.decode(r.message)):null};
}

/* -------------------------------- drafts -------------------------------- */
export const newDraftKey=()=>b64(random(32));
const draftAad=h=>enc.encode(canonical({format:'nft-console-draft/1',draftId:h.draftId,revision:h.revision,previousHash:h.previousHash}));
export function encryptDraft(keyB64,{draftId,revision,previousHash},document){
  if(!ID.test(draftId)||!Number.isSafeInteger(revision)||revision<1||!(previousHash===null||/^[0-9a-f]{64}$/.test(previousHash)))fail('DRAFT_HEADER');
  const nonce=random(24),head={draftId,revision,previousHash};
  const ciphertext=xchacha20poly1305(unb64(keyB64),nonce,draftAad(head)).encrypt(enc.encode(canonical(document)));
  const sealed={...head,nonce:b64(nonce),ciphertext:b64(ciphertext)};
  return {...sealed,contentHash:hex(sha256(enc.encode(canonical(sealed))))};
}
export function decryptDraft(keyB64,sealed,expected={}){
  if(expected.draftId&&sealed.draftId!==expected.draftId)fail('DRAFT_SUBSTITUTED');
  if(expected.revision&&sealed.revision!==expected.revision)fail('DRAFT_STALE');
  const {contentHash,...rest}=sealed;
  if(hex(sha256(enc.encode(canonical(rest))))!==contentHash)fail('DRAFT_CORRUPT');
  try{return JSON.parse(dec.decode(xchacha20poly1305(unb64(keyB64),unb64(sealed.nonce),draftAad(sealed)).decrypt(unb64(sealed.ciphertext))));}
  catch{return fail('DRAFT_CORRUPT');}
}

/* ------------------------------- recovery ------------------------------- */
/** backup-user-secret: a fresh random recovery code (never a wallet secret) protects the root and draft keys. */
export function newRecoveryCode(){const words=hex(random(20)).match(/.{5}/g);return words.join('-');}
export async function createRecoveryBackup(code,{root,draftKeys,accountWallet}){
  const {sealed}=await createVault(code,{kind:'recovery',root,draftKeys,accountWallet,createdAt:new Date().toISOString()});
  return {...sealed,format:'nft-console-vault/1',purpose:'recovery'};
}
export async function openRecoveryBackup(code,backup){
  const {state}=await openVault(code,backup);if(state.kind!=='recovery'||!state.root?.secretKey)fail('RECOVERY_FORMAT');return state;
}

/** Short human-comparable fingerprint of a device signature key (shown on both devices before certifying). */
export function fingerprint(publicKeyB64){return hex(sha256(unb64(publicKeyB64))).slice(0,20).match(/.{4}/g).join(' ').toUpperCase();}
export function signReset(root,{wallet,chainId,generation,deviceId}){
  const reset={type:'nft-console-workspace-reset/1',wallet:wallet.toLowerCase(),chainId,generation,deviceId,issuedAt:new Date().toISOString()};
  return {reset,signature:b64(ed25519.sign(enc.encode(canonical(reset)),unb64(root.secretKey)))};
}
