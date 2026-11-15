import {createHash} from 'node:crypto';
import {verifyDeviceCert,canonical,unb64} from '../crypto/workspace.mjs';
import {ed25519} from '@noble/curves/ed25519.js';

/**
 * Ciphertext-only private workspace store. The server never sees plaintext, content keys or root secrets:
 * it verifies public device certificates, orders MLS handshake/application messages (one commit per epoch),
 * chains sealed draft revisions and stores encrypted chunks. All rows expire after 30 days without writes.
 */
export class WorkspaceError extends Error{constructor(status,code,message){super(message||code);this.status=status;this.code=code;}}
const bad=(code,message)=>{throw new WorkspaceError(400,code,message);};
const conflict=(code,message)=>{throw new WorkspaceError(409,code,message);};
const missing=()=>{throw new WorkspaceError(404,'NOT_FOUND','Not found in your private workspace.');};
const ID=/^[0-9a-f]{32}$/,B64=/^[A-Za-z0-9+/]+={0,2}$/,HEX64=/^[0-9a-f]{64}$/;
const SEALED_KEYS=['ciphertext','contentHash','draftId','nonce','previousHash','revision'];
function sealedDraft(v,draftId){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==SEALED_KEYS.join())bad('DRAFT_SHAPE','Only sealed draft fields are accepted.');
  if(v.draftId!==draftId||!Number.isSafeInteger(v.revision)||v.revision<1||!(v.previousHash===null||HEX64.test(v.previousHash))||
     typeof v.nonce!=='string'||!B64.test(v.nonce)||typeof v.ciphertext!=='string'||!B64.test(v.ciphertext)||!HEX64.test(v.contentHash))bad('DRAFT_SHAPE');
  const {contentHash,...rest}=v;
  if(createHash('sha256').update(canonical(rest)).digest('hex')!==contentHash)bad('DRAFT_HASH','The draft hash does not match its sealed bytes.');
  return v;
}
function device(v,root){
  if(!v||!ID.test(v.deviceId)||typeof v.keyPackage!=='string'||!B64.test(v.keyPackage)||v.keyPackage.length>16384)bad('DEVICE_SHAPE');
  if(!verifyDeviceCert(root,v.certificate)||v.certificate.deviceId!==v.deviceId)conflict('DEVICE_NOT_AUTHORIZED','This device is not certified by your workspace account root.');
  return {deviceId:v.deviceId,certificate:v.certificate,keyPackage:v.keyPackage,label:String(v.label||'').slice(0,80)};
}
const mls=v=>{if(typeof v!=='string'||!B64.test(v)||v.length>262144)bad('MLS_SHAPE');return v;};

export class WorkspaceService{
  constructor(repository){this.repository=repository;}
  #tx(actor,fn){if(!['owner','editor'].includes(actor.role))throw new WorkspaceError(403,'FORBIDDEN','Private workspaces are available to owners and editors.');
    return this.repository.transaction(actor,null,async(client,account)=>{await client.query("SET LOCAL statement_timeout = 20000");return fn(client,account);});}
  async #account(client,account,lock=false){
    const r=await client.query(`SELECT root_public_key,epoch,generation FROM nft_console.workspace_accounts WHERE account_id=$1${lock?' FOR UPDATE':''}`,[account]);
    return r.rows[0]||null;
  }
  async #purge(client,account){
    await client.query('DELETE FROM nft_console.workspace_log WHERE account_id=$1 AND expires_at<clock_timestamp()',[account]);
    await client.query('DELETE FROM nft_console.workspace_drafts WHERE account_id=$1 AND expires_at<clock_timestamp()',[account]);
    await client.query('DELETE FROM nft_console.workspace_objects WHERE account_id=$1 AND expires_at<clock_timestamp()',[account]);
  }
  async overview(actor){return this.#tx(actor,async(client,account)=>{
    const w=await this.#account(client,account);if(!w)return {exists:false};
    await this.#purge(client,account);
    const d=await client.query('SELECT device_id,certificate,label,status,created_at,updated_at FROM nft_console.workspace_devices WHERE account_id=$1 ORDER BY created_at',[account]);
    const drafts=await client.query('SELECT draft_id,revision,content_hash,updated_at,expires_at FROM nft_console.workspace_drafts WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 200',[account]);
    const e=await client.query('SELECT device_id,signature_public_key,label,certificate IS NOT NULL AS certified,created_at FROM nft_console.workspace_enrollments WHERE account_id=$1 AND expires_at>clock_timestamp() ORDER BY created_at',[account]);
    return {exists:true,rootPublicKey:w.root_public_key,epoch:String(w.epoch),generation:w.generation,
      enrollments:e.rows.map(r=>({deviceId:r.device_id,signaturePublicKey:r.signature_public_key,label:r.label,certified:r.certified,createdAt:r.created_at})),
      devices:d.rows.map(r=>({deviceId:r.device_id,certificate:r.certificate,label:r.label,status:r.status,createdAt:r.created_at})),
      drafts:drafts.rows.map(r=>({draftId:r.draft_id,revision:r.revision,contentHash:r.content_hash,updatedAt:r.updated_at,expiresAt:r.expires_at})),
      retention:'Ciphertext expires 30 days after its last update. Keep your encrypted backup for longer-term recovery.'};
  });}
  /** First device: pins the account root (trust on first use) and becomes the sole MLS member at epoch 0. */
  async create(actor,{rootPublicKey,device:first}){
    if(typeof rootPublicKey!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(rootPublicKey))bad('ROOT_SHAPE');
    const d=device(first,rootPublicKey);
    return this.#tx(actor,async(client,account)=>{
      if(await this.#account(client,account))conflict('WORKSPACE_EXISTS','A private workspace already exists for this wallet. Enroll this device instead.');
      await client.query('INSERT INTO nft_console.workspace_accounts(account_id,chain_id,root_public_key) VALUES($1,$2,$3)',[account,actor.chainId,rootPublicKey]);
      await client.query("INSERT INTO nft_console.workspace_devices(account_id,device_id,certificate,key_package,label,status) VALUES($1,$2,$3,$4,$5,'active')",[account,d.deviceId,d.certificate,d.keyPackage,d.label]);
      return {created:true,epoch:'0'};
    });
  }
  /** Step 1 (new device): publish only its signature public key; both screens show its fingerprint. */
  async requestEnrollment(actor,{deviceId,signaturePublicKey,label}){
    if(!ID.test(deviceId)||typeof signaturePublicKey!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(signaturePublicKey))bad('ENROLLMENT_SHAPE');
    return this.#tx(actor,async(client,account)=>{
      if(!await this.#account(client,account))missing();
      await client.query('DELETE FROM nft_console.workspace_enrollments WHERE account_id=$1 AND expires_at<clock_timestamp()',[account]);
      const n=await client.query('SELECT count(*)::int AS n FROM nft_console.workspace_enrollments WHERE account_id=$1',[account]);if(n.rows[0].n>=10)conflict('TOO_MANY_ENROLLMENTS');
      const r=await client.query('INSERT INTO nft_console.workspace_enrollments(account_id,device_id,signature_public_key,label) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING device_id',[account,deviceId,signaturePublicKey,String(label||'').slice(0,80)]);
      if(!r.rows.length)conflict('ENROLLMENT_EXISTS');return {deviceId,status:'awaiting-certificate'};
    });
  }
  /** Step 2 (existing device holding the account root): attach a root certificate for exactly that key. */
  async certifyEnrollment(actor,deviceId,certificate){
    if(!ID.test(deviceId))missing();
    return this.#tx(actor,async(client,account)=>{
      const w=await this.#account(client,account);if(!w)missing();
      const r=await client.query('SELECT signature_public_key FROM nft_console.workspace_enrollments WHERE account_id=$1 AND device_id=$2 AND expires_at>clock_timestamp() AND certificate IS NULL',[account,deviceId]);
      if(!r.rows[0])missing();
      if(!verifyDeviceCert(w.root_public_key,certificate,unb64(r.rows[0].signature_public_key))||certificate.deviceId!==deviceId)conflict('DEVICE_NOT_AUTHORIZED');
      await client.query('UPDATE nft_console.workspace_enrollments SET certificate=$3 WHERE account_id=$1 AND device_id=$2',[account,deviceId,certificate]);return {certified:true};
    });
  }
  async enrollment(actor,deviceId){if(!ID.test(deviceId))missing();return this.#tx(actor,async(client,account)=>{
    const r=await client.query('SELECT certificate FROM nft_console.workspace_enrollments WHERE account_id=$1 AND device_id=$2 AND expires_at>clock_timestamp()',[account,deviceId]);
    if(!r.rows[0])missing();return {certificate:r.rows[0].certificate};
  });}
  /**
   * Recovery after every device is lost: the account root (restored from the user's recovery backup) signs a
   * reset. All devices are revoked, the MLS log restarts in a new generation with the restoring device alone.
   */
  async reset(actor,{reset,signature,device:first}){
    return this.#tx(actor,async(client,account)=>{
      const w=await this.#account(client,account,true);if(!w)missing();
      const ok=reset&&reset.type==='nft-console-workspace-reset/1'&&reset.wallet===actor.wallet.toLowerCase()&&reset.chainId===actor.chainId&&reset.generation===w.generation+1&&
        typeof reset.issuedAt==='string'&&Math.abs(Date.now()-Date.parse(reset.issuedAt))<10*60*1000&&reset.deviceId===first?.deviceId;
      let valid=false;try{valid=ok&&ed25519.verify(unb64(signature),new TextEncoder().encode(canonical(reset)),unb64(w.root_public_key));}catch{valid=false;}
      if(!valid)conflict('RESET_NOT_AUTHORIZED','The reset must be signed by your workspace account root (from your recovery backup).');
      const d=device(first,w.root_public_key);
      await client.query('DELETE FROM nft_console.workspace_log WHERE account_id=$1',[account]);
      await client.query("UPDATE nft_console.workspace_devices SET status='revoked',updated_at=clock_timestamp() WHERE account_id=$1 AND status<>'revoked'",[account]);
      await client.query('DELETE FROM nft_console.workspace_enrollments WHERE account_id=$1',[account]);
      await client.query('UPDATE nft_console.workspace_accounts SET generation=generation+1,epoch=0 WHERE account_id=$1',[account]);
      const existing=await client.query('SELECT 1 FROM nft_console.workspace_devices WHERE account_id=$1 AND device_id=$2',[account,d.deviceId]);
      if(existing.rows.length)conflict('DEVICE_EXISTS','Use a fresh device identity for recovery.');
      await client.query("INSERT INTO nft_console.workspace_devices(account_id,device_id,certificate,key_package,label,status) VALUES($1,$2,$3,$4,$5,'active')",[account,d.deviceId,d.certificate,d.keyPackage,d.label]);
      return {generation:w.generation+1,epoch:'0'};
    });
  }
  async requestDevice(actor,body){return this.#tx(actor,async(client,account)=>{
    const w=await this.#account(client,account);if(!w)missing();const d=device(body,w.root_public_key);
    const existing=await client.query('SELECT status FROM nft_console.workspace_devices WHERE account_id=$1 AND device_id=$2',[account,d.deviceId]);
    if(existing.rows[0])conflict('DEVICE_EXISTS','This device is already registered ('+existing.rows[0].status+').');
    await client.query("INSERT INTO nft_console.workspace_devices(account_id,device_id,certificate,key_package,label,status) VALUES($1,$2,$3,$4,$5,'pending')",[account,d.deviceId,d.certificate,d.keyPackage,d.label]);
    return {deviceId:d.deviceId,status:'pending'};
  });}
  async device(actor,deviceId){if(!ID.test(deviceId))missing();return this.#tx(actor,async(client,account)=>{
    const r=await client.query('SELECT device_id,certificate,key_package,status FROM nft_console.workspace_devices WHERE account_id=$1 AND device_id=$2',[account,deviceId]);
    if(!r.rows[0])missing();return {deviceId:r.rows[0].device_id,certificate:r.rows[0].certificate,keyPackage:r.rows[0].key_package,status:r.rows[0].status};
  });}
  /**
   * Appends one MLS commit for exactly the current epoch (forks are impossible: one commit per epoch) with an
   * optional Welcome for a newly added device and the matching device status changes, atomically.
   */
  async commit(actor,{epoch,senderDevice,commit,welcome,activate,revoke}){
    if(!/^(0|[1-9][0-9]{0,17})$/.test(String(epoch))||!ID.test(senderDevice))bad('COMMIT_SHAPE');
    mls(commit);if(welcome)mls(welcome.body);
    if(activate&&(!ID.test(activate)||welcome?.targetDevice!==activate))bad('COMMIT_SHAPE');if(revoke&&!ID.test(revoke))bad('COMMIT_SHAPE');
    return this.#tx(actor,async(client,account)=>{
      const w=await this.#account(client,account,true);if(!w)missing();
      if(String(w.epoch)!==String(epoch))conflict('STALE_EPOCH','Another device changed the workspace first. Sync and retry.');
      const sender=await client.query('SELECT status FROM nft_console.workspace_devices WHERE account_id=$1 AND device_id=$2',[account,senderDevice]);
      if(sender.rows[0]?.status!=='active')conflict('SENDER_NOT_ACTIVE');
      const next=await client.query('SELECT coalesce(max(seq),0)+1 AS seq FROM nft_console.workspace_log WHERE account_id=$1',[account]);let seq=Number(next.rows[0].seq);
      await client.query("INSERT INTO nft_console.workspace_log(account_id,seq,epoch,kind,sender_device,body) VALUES($1,$2,$3,'commit',$4,$5)",[account,seq++,epoch,senderDevice,commit]);
      if(activate){
        const u=await client.query("UPDATE nft_console.workspace_devices SET status='active',updated_at=clock_timestamp() WHERE account_id=$1 AND device_id=$2 AND status='pending' RETURNING device_id",[account,activate]);
        if(!u.rows.length)conflict('DEVICE_NOT_PENDING');
        await client.query("INSERT INTO nft_console.workspace_log(account_id,seq,epoch,kind,sender_device,target_device,body) VALUES($1,$2,$3,'welcome',$4,$5,$6)",[account,seq++,BigInt(epoch)+1n,senderDevice,activate,welcome.body]);
      }
      if(revoke){
        const u=await client.query("UPDATE nft_console.workspace_devices SET status='revoked',updated_at=clock_timestamp() WHERE account_id=$1 AND device_id=$2 AND status<>'revoked' RETURNING device_id",[account,revoke]);
        if(!u.rows.length)conflict('DEVICE_NOT_REVOCABLE');
      }
      await client.query('UPDATE nft_console.workspace_accounts SET epoch=epoch+1 WHERE account_id=$1',[account]);
      return {epoch:String(BigInt(epoch)+1n)};
    });
  }
  async application(actor,{epoch,senderDevice,body}){
    if(!ID.test(senderDevice))bad('MESSAGE_SHAPE');mls(body);
    return this.#tx(actor,async(client,account)=>{
      const w=await this.#account(client,account,true);if(!w)missing();
      if(String(w.epoch)!==String(epoch))conflict('STALE_EPOCH','Sync your device before sending.');
      const sender=await client.query('SELECT status FROM nft_console.workspace_devices WHERE account_id=$1 AND device_id=$2',[account,senderDevice]);
      if(sender.rows[0]?.status!=='active')conflict('SENDER_NOT_ACTIVE');
      const next=await client.query('SELECT coalesce(max(seq),0)+1 AS seq FROM nft_console.workspace_log WHERE account_id=$1',[account]);
      await client.query("INSERT INTO nft_console.workspace_log(account_id,seq,epoch,kind,sender_device,body) VALUES($1,$2,$3,'application',$4,$5)",[account,next.rows[0].seq,epoch,senderDevice,body]);
      return {seq:String(next.rows[0].seq)};
    });
  }
  /** Ordered log for one device: all commits/application messages plus Welcomes addressed to it. */
  async log(actor,{deviceId,after=0}){
    if(!ID.test(deviceId)||!Number.isSafeInteger(Number(after))||Number(after)<0)bad('LOG_QUERY');
    return this.#tx(actor,async(client,account)=>{
      const r=await client.query("SELECT seq,epoch,kind,sender_device,target_device,body FROM nft_console.workspace_log WHERE account_id=$1 AND seq>$2 AND (kind<>'welcome' OR target_device=$3) AND expires_at>clock_timestamp() ORDER BY seq LIMIT 200",[account,Number(after),deviceId]);
      return r.rows.map(x=>({seq:String(x.seq),epoch:String(x.epoch),kind:x.kind,senderDevice:x.sender_device,body:x.body}));
    });
  }
  async putDraft(actor,draftId,sealed){
    if(!ID.test(draftId))bad('DRAFT_ID');const v=sealedDraft(sealed,draftId);
    return this.#tx(actor,async(client,account)=>{
      if(!await this.#account(client,account))missing();
      if(v.revision===1){
        if(v.previousHash!==null)bad('DRAFT_SHAPE');
        const r=await client.query('INSERT INTO nft_console.workspace_drafts(account_id,draft_id,revision,content_hash,sealed) VALUES($1,$2,1,$3,$4) ON CONFLICT DO NOTHING RETURNING draft_id',[account,draftId,v.contentHash,v]);
        if(!r.rows.length){const cur=await client.query('SELECT content_hash FROM nft_console.workspace_drafts WHERE account_id=$1 AND draft_id=$2',[account,draftId]);if(cur.rows[0]?.content_hash!==v.contentHash)conflict('STALE_REVISION','A newer version of this draft exists. Reload before saving.');}
      }else{
        const r=await client.query("UPDATE nft_console.workspace_drafts SET revision=$3,content_hash=$4,sealed=$5,updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 days' WHERE account_id=$1 AND draft_id=$2 AND revision=$3-1 AND content_hash=$6 RETURNING draft_id",[account,draftId,v.revision,v.contentHash,v,v.previousHash]);
        if(!r.rows.length){const cur=await client.query('SELECT content_hash,revision FROM nft_console.workspace_drafts WHERE account_id=$1 AND draft_id=$2',[account,draftId]);
          if(cur.rows[0]?.content_hash===v.contentHash)return {revision:v.revision,contentHash:v.contentHash,unchanged:true};
          conflict('STALE_REVISION','A newer version of this draft exists. Reload before saving.');}
      }
      return {revision:v.revision,contentHash:v.contentHash};
    });
  }
  async getDraft(actor,draftId){if(!ID.test(draftId))missing();return this.#tx(actor,async(client,account)=>{
    const r=await client.query('SELECT sealed FROM nft_console.workspace_drafts WHERE account_id=$1 AND draft_id=$2 AND expires_at>clock_timestamp()',[account,draftId]);
    if(!r.rows[0])missing();return r.rows[0].sealed;
  });}
  async deleteDraft(actor,draftId){if(!ID.test(draftId))missing();return this.#tx(actor,async(client,account)=>{
    await client.query('DELETE FROM nft_console.workspace_drafts WHERE account_id=$1 AND draft_id=$2',[account,draftId]);return {deleted:true};
  });}
  async createObject(actor,{objectId,chunkCount,chunkSize,ciphertextSize}){
    if(!ID.test(objectId)||!Number.isSafeInteger(chunkCount)||!Number.isSafeInteger(chunkSize)||!Number.isSafeInteger(ciphertextSize))bad('OBJECT_SHAPE');
    return this.#tx(actor,async(client,account)=>{
      if(!await this.#account(client,account))missing();
      const used=await client.query('SELECT coalesce(sum(ciphertext_size),0)::bigint AS n FROM nft_console.workspace_objects WHERE account_id=$1 AND expires_at>clock_timestamp()',[account]);
      if(BigInt(used.rows[0].n)+BigInt(ciphertextSize)>5n*1024n**3n)conflict('STORAGE_QUOTA','The private workspace storage quota (5 GiB) would be exceeded.');
      const r=await client.query('INSERT INTO nft_console.workspace_objects(account_id,object_id,chunk_count,chunk_size,ciphertext_size) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING object_id',[account,objectId,chunkCount,chunkSize,ciphertextSize]);
      if(!r.rows.length){const cur=await client.query('SELECT chunk_count,chunk_size,ciphertext_size FROM nft_console.workspace_objects WHERE account_id=$1 AND object_id=$2',[account,objectId]);
        const c=cur.rows[0];if(c.chunk_count!==chunkCount||c.chunk_size!==chunkSize||Number(c.ciphertext_size)!==ciphertextSize)conflict('OBJECT_MISMATCH');}
      return this.#status(client,account,objectId);
    });
  }
  async #status(client,account,objectId){
    const o=await client.query('SELECT chunk_count FROM nft_console.workspace_objects WHERE account_id=$1 AND object_id=$2 AND expires_at>clock_timestamp()',[account,objectId]);if(!o.rows[0])missing();
    const c=await client.query('SELECT chunk_index,sha256 FROM nft_console.workspace_chunks WHERE account_id=$1 AND object_id=$2 ORDER BY chunk_index',[account,objectId]);
    return {objectId,chunkCount:o.rows[0].chunk_count,received:c.rows.map(r=>({index:r.chunk_index,sha256:r.sha256})),complete:c.rows.length===o.rows[0].chunk_count};
  }
  async objectStatus(actor,objectId){if(!ID.test(objectId))missing();return this.#tx(actor,(client,account)=>this.#status(client,account,objectId));}
  /** Idempotent chunk write: the same index and hash is accepted again; a different body for a stored index is refused. */
  async putChunk(actor,objectId,index,body,claimedSha){
    if(!ID.test(objectId)||!Number.isSafeInteger(index)||index<0||!(body instanceof Uint8Array)||!body.length||body.length>8388624)bad('CHUNK_SHAPE');
    const sha=createHash('sha256').update(body).digest('hex');if(claimedSha!==sha)bad('CHUNK_HASH','The chunk bytes do not match their declared SHA-256.');
    return this.#tx(actor,async(client,account)=>{
      const o=await client.query('SELECT chunk_count,chunk_size FROM nft_console.workspace_objects WHERE account_id=$1 AND object_id=$2 AND expires_at>clock_timestamp()',[account,objectId]);
      if(!o.rows[0])missing();if(index>=o.rows[0].chunk_count||body.length>o.rows[0].chunk_size+16)bad('CHUNK_RANGE');
      const r=await client.query('INSERT INTO nft_console.workspace_chunks(account_id,object_id,chunk_index,sha256,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING chunk_index',[account,objectId,index,sha,Buffer.from(body)]);
      if(!r.rows.length){const cur=await client.query('SELECT sha256 FROM nft_console.workspace_chunks WHERE account_id=$1 AND object_id=$2 AND chunk_index=$3',[account,objectId,index]);if(cur.rows[0]?.sha256!==sha)conflict('CHUNK_CONFLICT');return {index,sha256:sha,duplicate:true};}
      return {index,sha256:sha};
    });
  }
  async getChunk(actor,objectId,index){if(!ID.test(objectId)||!Number.isSafeInteger(index))missing();return this.#tx(actor,async(client,account)=>{
    const r=await client.query('SELECT c.body,c.sha256 FROM nft_console.workspace_chunks c JOIN nft_console.workspace_objects o USING(account_id,object_id) WHERE c.account_id=$1 AND c.object_id=$2 AND c.chunk_index=$3 AND o.expires_at>clock_timestamp()',[account,objectId,index]);
    if(!r.rows[0])missing();return {body:new Uint8Array(r.rows[0].body),sha256:r.rows[0].sha256};
  });}
}
