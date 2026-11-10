import {createHash} from 'node:crypto';
export class PrivateError extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new PrivateError(code,status);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const uuid=v=>{if(typeof v!=='string'||!UUID.test(v))fail('INVALID_ID',400);return v;};
export function b64(v,min,max){
  if(typeof v!=='string'||v.length>Math.ceil(max/3)*4+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(v))fail('INVALID_ENCODING',400);
  const b=Buffer.from(v,'base64');if(b.length<min||b.length>max||b.toString('base64')!==v)fail('INVALID_ENCODING',400);return b;
}
const enc=b=>Buffer.from(b).toString('base64');
const device=r=>({id:r.id,label:r.label,state:r.state,publicKey:enc(r.public_key),wrappedEpoch:r.wrapped_epoch,approvedBy:r.approved_by,createdAt:r.created_at,revokedAt:r.revoked_at});
/**
 * Ciphertext-only persistence for the end-to-end encrypted workspace. The server cannot verify wrapped keys
 * (it never holds the workspace key); clients authenticate every envelope and compare device fingerprints.
 */
export class PrivateStore{
  constructor(repository,{quotaBytes=Number(process.env.PRIVATE_STORAGE_QUOTA_BYTES||400*1024*1024)}={}){this.repository=repository;this.quota=quotaBytes;}
  tx(actor,fn){if(!['owner','editor'].includes(actor.role))fail('EDITOR_REQUIRED',403);return this.repository.transaction(actor,null,fn);}
  async lock(c,a){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,880151))',[a]);}
  async workspace(actor,deviceId){return this.tx(actor,async(c,a)=>{
    const w=(await c.query('SELECT key_epoch,recovery_wrap,updated_at FROM nft_console.private_workspaces WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows[0];
    if(!w)return {exists:false,devices:[]};
    const devices=(await c.query('SELECT * FROM nft_console.private_devices WHERE account_id=$1 AND chain_id=$2 ORDER BY created_at',[a,actor.chainId])).rows;
    const mine=deviceId?devices.find(d=>d.id===deviceId):null;
    return {exists:true,keyEpoch:w.key_epoch,recoveryWrap:enc(w.recovery_wrap),devices:devices.map(device),
      device:mine?{...device(mine),wrappedKey:mine.state==='active'&&mine.wrapped_key?enc(mine.wrapped_key):null}:null};
  });}
  async create(actor,{deviceId,label,publicKey,wrappedKey,recoveryWrap}){return this.tx(actor,async(c,a)=>{
    await this.lock(c,a);
    if((await c.query('SELECT 1 FROM nft_console.private_workspaces WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows.length)fail('WORKSPACE_EXISTS');
    await c.query('INSERT INTO nft_console.private_workspaces(account_id,chain_id,key_epoch,recovery_wrap) VALUES($1,$2,1,$3)',[a,actor.chainId,recoveryWrap]);
    await c.query("INSERT INTO nft_console.private_devices(account_id,chain_id,id,label,public_key,state,wrapped_key,wrapped_epoch) VALUES($1,$2,$3,$4,$5,'active',$6,1)",[a,actor.chainId,deviceId,label,publicKey,wrappedKey]);
    return {keyEpoch:1};
  });}
  async requestDevice(actor,{deviceId,label,publicKey}){return this.tx(actor,async(c,a)=>{
    await this.lock(c,a);
    const n=(await c.query("SELECT count(*)::int n FROM nft_console.private_devices WHERE account_id=$1 AND chain_id=$2 AND state<>'revoked'",[a,actor.chainId])).rows[0].n;if(n>=20)fail('DEVICE_LIMIT');
    await c.query("INSERT INTO nft_console.private_devices(account_id,chain_id,id,label,public_key,state) VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING",[a,actor.chainId,deviceId,label,publicKey]);
    const r=(await c.query('SELECT * FROM nft_console.private_devices WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,deviceId])).rows[0];
    if(!r||!Buffer.from(r.public_key).equals(publicKey))fail('DEVICE_CONFLICT');return device(r);
  });}
  async activate(actor,{deviceId,approverId,wrappedKey,keyEpoch,viaRecovery}){return this.tx(actor,async(c,a)=>{
    await this.lock(c,a);
    const w=(await c.query('SELECT key_epoch FROM nft_console.private_workspaces WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows[0];if(!w)fail('WORKSPACE_MISSING',404);
    if(w.key_epoch!==keyEpoch)fail('STALE_KEY_EPOCH');
    if(!viaRecovery){const ap=(await c.query("SELECT 1 FROM nft_console.private_devices WHERE account_id=$1 AND chain_id=$2 AND id=$3 AND state='active'",[a,actor.chainId,approverId])).rows[0];if(!ap)fail('APPROVER_NOT_ACTIVE',403);}
    const r=await c.query("UPDATE nft_console.private_devices SET state='active',wrapped_key=$4,wrapped_epoch=$5,approved_by=$6 WHERE account_id=$1 AND chain_id=$2 AND id=$3 AND state='pending' RETURNING *",[a,actor.chainId,deviceId,wrappedKey,keyEpoch,viaRecovery?null:approverId]);
    if(!r.rows[0])fail('DEVICE_NOT_PENDING');return device(r.rows[0]);
  });}
  /** Revocation rotates the workspace key atomically: new epoch, new recovery wrap, a wrap for every remaining
   * active device and a re-sealed copy of every record. Any omission aborts the whole rotation. */
  async revoke(actor,{deviceId,keyEpoch,recoveryWrap,wraps,records}){return this.tx(actor,async(c,a)=>{
    await this.lock(c,a);
    const w=(await c.query('SELECT key_epoch FROM nft_console.private_workspaces WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows[0];if(!w)fail('WORKSPACE_MISSING',404);
    if(keyEpoch!==w.key_epoch+1)fail('STALE_KEY_EPOCH');
    const target=(await c.query("UPDATE nft_console.private_devices SET state='revoked',revoked_at=clock_timestamp(),wrapped_key=NULL WHERE account_id=$1 AND chain_id=$2 AND id=$3 AND state<>'revoked' RETURNING id",[a,actor.chainId,deviceId])).rows[0];
    if(!target)fail('DEVICE_NOT_FOUND',404);
    const active=(await c.query("SELECT id FROM nft_console.private_devices WHERE account_id=$1 AND chain_id=$2 AND state='active'",[a,actor.chainId])).rows.map(r=>r.id).sort();
    if(!active.length)fail('LAST_DEVICE');
    if(JSON.stringify(wraps.map(x=>x.deviceId).sort())!==JSON.stringify(active))fail('ROTATION_INCOMPLETE');
    for(const x of wraps)await c.query('UPDATE nft_console.private_devices SET wrapped_key=$4,wrapped_epoch=$5 WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,x.deviceId,x.wrappedKey,keyEpoch]);
    await c.query("UPDATE nft_console.private_devices SET state='revoked',revoked_at=clock_timestamp() WHERE account_id=$1 AND chain_id=$2 AND state='pending'",[a,actor.chainId]);
    const existing=(await c.query('SELECT id,revision FROM nft_console.private_records WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows;
    const byId=new Map(records.map(r=>[r.id,r]));if(byId.size!==existing.length||existing.some(r=>!byId.has(r.id)))fail('ROTATION_INCOMPLETE');
    for(const r of existing){const n=byId.get(r.id);if(n.expectedRevision!==r.revision)fail('RECORD_CHANGED');
      await c.query('UPDATE nft_console.private_records SET revision=revision+1,key_epoch=$4,envelope=$5,updated_at=clock_timestamp() WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,r.id,keyEpoch,n.envelope]);}
    await c.query('UPDATE nft_console.private_workspaces SET key_epoch=$3,recovery_wrap=$4,updated_at=clock_timestamp() WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId,keyEpoch,recoveryWrap]);
    return {keyEpoch,revoked:deviceId};
  });}
  async replaceRecovery(actor,{keyEpoch,recoveryWrap}){return this.tx(actor,async(c,a)=>{
    const r=await c.query('UPDATE nft_console.private_workspaces SET recovery_wrap=$4,updated_at=clock_timestamp() WHERE account_id=$1 AND chain_id=$2 AND key_epoch=$3 RETURNING key_epoch',[a,actor.chainId,keyEpoch,recoveryWrap]);
    if(!r.rows[0])fail('STALE_KEY_EPOCH');return {keyEpoch};
  });}
  async records(actor){return this.tx(actor,async(c,a)=>(await c.query('SELECT id,kind,revision,key_epoch,archived,octet_length(envelope) AS bytes,created_at,updated_at FROM nft_console.private_records WHERE account_id=$1 AND chain_id=$2 ORDER BY updated_at DESC LIMIT 500',[a,actor.chainId])).rows
    .map(r=>({id:r.id,kind:r.kind,revision:r.revision,keyEpoch:r.key_epoch,archived:r.archived,bytes:r.bytes,createdAt:r.created_at,updatedAt:r.updated_at})));}
  async record(actor,id){return this.tx(actor,async(c,a)=>{const r=(await c.query('SELECT * FROM nft_console.private_records WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,id])).rows[0];
    if(!r)fail('NOT_FOUND',404);return {id:r.id,kind:r.kind,revision:r.revision,keyEpoch:r.key_epoch,archived:r.archived,envelope:enc(r.envelope),updatedAt:r.updated_at};});}
  async putRecord(actor,id,{kind,expectedRevision,keyEpoch,envelope,archived=false}){return this.tx(actor,async(c,a)=>{
    await this.lock(c,a);
    const w=(await c.query('SELECT key_epoch FROM nft_console.private_workspaces WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows[0];if(!w)fail('WORKSPACE_MISSING',404);
    if(w.key_epoch!==keyEpoch)fail('STALE_KEY_EPOCH');
    if(expectedRevision===0){
      const n=(await c.query('SELECT count(*)::int n FROM nft_console.private_records WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows[0].n;if(n>=500)fail('RECORD_LIMIT');
      const r=await c.query('INSERT INTO nft_console.private_records(account_id,chain_id,id,kind,revision,key_epoch,envelope,archived) VALUES($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING revision',[a,actor.chainId,id,kind,keyEpoch,envelope,archived]);
      if(!r.rows[0])fail('RECORD_CHANGED');return {id,revision:1};
    }
    const r=await c.query('UPDATE nft_console.private_records SET revision=revision+1,key_epoch=$5,envelope=$6,archived=$7,updated_at=clock_timestamp() WHERE account_id=$1 AND chain_id=$2 AND id=$3 AND revision=$4 AND kind=$8 RETURNING revision',[a,actor.chainId,id,expectedRevision,keyEpoch,envelope,archived,kind]);
    if(!r.rows[0])fail('RECORD_CHANGED');return {id,revision:r.rows[0].revision};
  });}
  async createBlob(actor,{id,chunkCount,ciphertextBytes}){return this.tx(actor,async(c,a)=>{
    await this.lock(c,a);
    if(!(await c.query('SELECT 1 FROM nft_console.private_workspaces WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows.length)fail('WORKSPACE_MISSING',404);
    await c.query('DELETE FROM nft_console.private_blobs WHERE account_id=$1 AND chain_id=$2 AND NOT complete AND expires_at<clock_timestamp()',[a,actor.chainId]);
    const used=(await c.query('SELECT coalesce(sum(ciphertext_bytes),0)::bigint b FROM nft_console.private_blobs WHERE account_id=$1 AND chain_id=$2',[a,actor.chainId])).rows[0].b;
    const existing=(await c.query('SELECT chunk_count,ciphertext_bytes FROM nft_console.private_blobs WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,id])).rows[0];
    if(existing){if(existing.chunk_count!==chunkCount||Number(existing.ciphertext_bytes)!==ciphertextBytes)fail('BLOB_CONFLICT');return this.blobRows(c,a,actor,id);}
    if(Number(used)+ciphertextBytes>this.quota)fail('STORAGE_QUOTA_EXCEEDED',413);
    await c.query("INSERT INTO nft_console.private_blobs(account_id,chain_id,id,chunk_count,ciphertext_bytes,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '7 days')",[a,actor.chainId,id,chunkCount,ciphertextBytes]);
    return this.blobRows(c,a,actor,id);
  });}
  async blobRows(c,a,actor,id){
    const b=(await c.query('SELECT * FROM nft_console.private_blobs WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,id])).rows[0];if(!b)fail('NOT_FOUND',404);
    const chunks=(await c.query('SELECT index,sha256,octet_length(bytes) AS bytes FROM nft_console.private_blob_chunks WHERE account_id=$1 AND chain_id=$2 AND blob_id=$3 ORDER BY index',[a,actor.chainId,id])).rows;
    return {id,chunkCount:b.chunk_count,ciphertextBytes:Number(b.ciphertext_bytes),complete:b.complete,chunks:chunks.map(x=>({index:x.index,sha256:x.sha256,bytes:x.bytes}))};
  }
  async blob(actor,id){return this.tx(actor,(c,a)=>this.blobRows(c,a,actor,id));}
  /** Idempotent: an identical retransmission is acknowledged without storing a duplicate; different bytes for an accepted index are refused. */
  async putChunk(actor,id,index,bytes){const sha256=createHash('sha256').update(bytes).digest('hex');return this.tx(actor,async(c,a)=>{
    const b=(await c.query('SELECT * FROM nft_console.private_blobs WHERE account_id=$1 AND chain_id=$2 AND id=$3 FOR UPDATE',[a,actor.chainId,id])).rows[0];if(!b)fail('NOT_FOUND',404);
    if(b.complete)fail('BLOB_COMPLETE');if(!Number.isInteger(index)||index<0||index>=b.chunk_count)fail('INVALID_INDEX',400);
    const prior=(await c.query('SELECT sha256 FROM nft_console.private_blob_chunks WHERE account_id=$1 AND chain_id=$2 AND blob_id=$3 AND index=$4',[a,actor.chainId,id,index])).rows[0];
    if(prior){if(prior.sha256!==sha256)fail('CHUNK_CONFLICT');return {index,sha256,duplicate:true};}
    const stored=(await c.query('SELECT coalesce(sum(octet_length(bytes)),0)::bigint n FROM nft_console.private_blob_chunks WHERE account_id=$1 AND chain_id=$2 AND blob_id=$3',[a,actor.chainId,id])).rows[0].n;
    if(Number(stored)+bytes.length>Number(b.ciphertext_bytes))fail('BLOB_SIZE_EXCEEDED',413);
    await c.query('INSERT INTO nft_console.private_blob_chunks(account_id,chain_id,blob_id,index,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6)',[a,actor.chainId,id,index,sha256,bytes]);
    return {index,sha256,duplicate:false};
  });}
  async completeBlob(actor,id){return this.tx(actor,async(c,a)=>{
    const s=await this.blobRows(c,a,actor,id);if(s.complete)return s;
    if(s.chunks.length!==s.chunkCount||s.chunks.reduce((t,x)=>t+x.bytes,0)!==s.ciphertextBytes)fail('BLOB_INCOMPLETE');
    await c.query('UPDATE nft_console.private_blobs SET complete=true WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,id]);return {...s,complete:true};
  });}
  async chunk(actor,id,index){return this.tx(actor,async(c,a)=>{const r=(await c.query('SELECT bytes FROM nft_console.private_blob_chunks WHERE account_id=$1 AND chain_id=$2 AND blob_id=$3 AND index=$4',[a,actor.chainId,id,index])).rows[0];if(!r)fail('NOT_FOUND',404);return r.bytes;});}
  async deleteBlob(actor,id){return this.tx(actor,async(c,a)=>{await c.query('DELETE FROM nft_console.private_blobs WHERE account_id=$1 AND chain_id=$2 AND id=$3',[a,actor.chainId,id]);return {deleted:id};});}
}
