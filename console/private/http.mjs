import {PrivateError,uuid,b64} from './store.mjs';
const fail=(code,status=400)=>{throw new PrivateError(code,status);};
function exact(body,keys,optional=[]){
  if(!body||typeof body!=='object'||Array.isArray(body))fail('INVALID_INPUT');
  for(const k of Object.keys(body))if(!keys.includes(k)&&!optional.includes(k))fail('INVALID_INPUT');
  for(const k of keys)if(!(k in body))fail('INVALID_INPUT');
}
const label=v=>{if(typeof v!=='string'||!v.trim()||v.length>80||/[\u0000-\u001f\u007f]/.test(v))fail('INVALID_LABEL');return v.trim();};
const int=(v,min,max)=>{if(!Number.isInteger(v)||v<min||v>max)fail('INVALID_NUMBER');return v;};
const pub=v=>{const k=b64(v,65,65);if(k[0]!==4)fail('INVALID_PUBLIC_KEY');return k;};
const WRAP=[60,512];
/** Encrypted private workspace API. Requests carry only public keys, wrapped keys and ciphertext. */
export function installPrivateRoutes(app,requireAction,{store}){
  const wrap=fn=>async(req,res)=>{
    try{
      if(['POST','PUT'].includes(req.method)&&!req.path.includes('/chunks/')&&!/^application\/json(?:\s*;|$)/i.test(req.get('Content-Type')||''))return res.status(415).json({error:'Use a JSON request.'});
      await fn(req,res);
    }catch(e){const code=e instanceof PrivateError?e.code:'PRIVATE_STORAGE_UNAVAILABLE';if(!(e instanceof PrivateError))console.error(JSON.stringify({event:'private.error',message:String(e?.message||'').slice(0,200)}));
      res.status(e instanceof PrivateError?e.status:503).json({code,error:messages[code]||`Private workspace request stopped (${code}).`});}
  };
  const R=requireAction('read');
  app.get('/api/private/workspace',R,wrap(async(req,res)=>res.json(await store.workspace(req.actor,req.query.device===undefined?null:uuid(String(req.query.device))))));
  app.post('/api/private/workspace',R,wrap(async(req,res)=>{exact(req.body,['deviceId','label','publicKey','wrappedKey','recoveryWrap']);
    res.json(await store.create(req.actor,{deviceId:uuid(req.body.deviceId),label:label(req.body.label),publicKey:pub(req.body.publicKey),wrappedKey:b64(req.body.wrappedKey,...WRAP),recoveryWrap:b64(req.body.recoveryWrap,40,512)}));}));
  app.post('/api/private/devices',R,wrap(async(req,res)=>{exact(req.body,['deviceId','label','publicKey']);
    res.json(await store.requestDevice(req.actor,{deviceId:uuid(req.body.deviceId),label:label(req.body.label),publicKey:pub(req.body.publicKey)}));}));
  app.post('/api/private/devices/:id/approve',R,wrap(async(req,res)=>{exact(req.body,['approverId','wrappedKey','keyEpoch']);
    res.json(await store.activate(req.actor,{deviceId:uuid(req.params.id),approverId:uuid(req.body.approverId),wrappedKey:b64(req.body.wrappedKey,...WRAP),keyEpoch:int(req.body.keyEpoch,1,1e6),viaRecovery:false}));}));
  app.post('/api/private/devices/:id/recover',R,wrap(async(req,res)=>{exact(req.body,['wrappedKey','keyEpoch']);
    res.json(await store.activate(req.actor,{deviceId:uuid(req.params.id),wrappedKey:b64(req.body.wrappedKey,...WRAP),keyEpoch:int(req.body.keyEpoch,1,1e6),viaRecovery:true}));}));
  app.post('/api/private/devices/:id/revoke',R,wrap(async(req,res)=>{exact(req.body,['keyEpoch','recoveryWrap','wraps','records']);
    const {wraps,records}=req.body;if(!Array.isArray(wraps)||wraps.length>20||!Array.isArray(records)||records.length>500)fail('INVALID_INPUT');
    res.json(await store.revoke(req.actor,{deviceId:uuid(req.params.id),keyEpoch:int(req.body.keyEpoch,2,1e6),recoveryWrap:b64(req.body.recoveryWrap,40,512),
      wraps:wraps.map(w=>{exact(w,['deviceId','wrappedKey']);return {deviceId:uuid(w.deviceId),wrappedKey:b64(w.wrappedKey,...WRAP)};}),
      records:records.map(r=>{exact(r,['id','expectedRevision','envelope']);return {id:uuid(r.id),expectedRevision:int(r.expectedRevision,1,1e6),envelope:b64(r.envelope,60,1048576)};})}));}));
  app.post('/api/private/recovery',R,wrap(async(req,res)=>{exact(req.body,['keyEpoch','recoveryWrap']);res.json(await store.replaceRecovery(req.actor,{keyEpoch:int(req.body.keyEpoch,1,1e6),recoveryWrap:b64(req.body.recoveryWrap,40,512)}));}));
  app.get('/api/private/records',R,wrap(async(req,res)=>res.json({items:await store.records(req.actor)})));
  app.get('/api/private/records/:id',R,wrap(async(req,res)=>res.json(await store.record(req.actor,uuid(req.params.id)))));
  app.put('/api/private/records/:id',R,wrap(async(req,res)=>{exact(req.body,['kind','expectedRevision','keyEpoch','envelope'],['archived']);
    if(!['release','configuration'].includes(req.body.kind))fail('INVALID_KIND');if(req.body.archived!==undefined&&typeof req.body.archived!=='boolean')fail('INVALID_INPUT');
    res.json(await store.putRecord(req.actor,uuid(req.params.id),{kind:req.body.kind,expectedRevision:int(req.body.expectedRevision,0,1e6),keyEpoch:int(req.body.keyEpoch,1,1e6),envelope:b64(req.body.envelope,60,1048576),archived:req.body.archived===true}));}));
  app.post('/api/private/blobs',R,wrap(async(req,res)=>{exact(req.body,['id','chunkCount','ciphertextBytes']);
    res.json(await store.createBlob(req.actor,{id:uuid(req.body.id),chunkCount:int(req.body.chunkCount,1,262144),ciphertextBytes:int(req.body.ciphertextBytes,16,4398046511104)}));}));
  app.get('/api/private/blobs/:id',R,wrap(async(req,res)=>res.json(await store.blob(req.actor,uuid(req.params.id)))));
  app.put('/api/private/blobs/:id/chunks/:index',R,wrap(async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||req.body.length<16)fail('INVALID_CHUNK');
    res.json(await store.putChunk(req.actor,uuid(req.params.id),Number(req.params.index),req.body));}));
  app.get('/api/private/blobs/:id/chunks/:index',R,wrap(async(req,res)=>{
    const bytes=await store.chunk(req.actor,uuid(req.params.id),int(Number(req.params.index),0,262143));res.type('application/octet-stream').send(Buffer.from(bytes));}));
  app.post('/api/private/blobs/:id/complete',R,wrap(async(req,res)=>{exact(req.body,[]);res.json(await store.completeBlob(req.actor,uuid(req.params.id)));}));
  app.post('/api/private/blobs/:id/delete',R,wrap(async(req,res)=>{exact(req.body,[]);res.json(await store.deleteBlob(req.actor,uuid(req.params.id)));}));
}
const messages={STALE_KEY_EPOCH:'The workspace key changed on another device. Reload to unlock with the current key.',RECORD_CHANGED:'This draft was saved elsewhere. Reload before saving again.',
  CHUNK_CONFLICT:'The server already holds different bytes for this file part. The upload was stopped to protect encryption integrity.',STORAGE_QUOTA_EXCEEDED:'Private storage quota reached.',
  WORKSPACE_EXISTS:'A private workspace already exists for this wallet. Use device approval or recovery instead.',EDITOR_REQUIRED:'Viewer access cannot use the private workspace.'};
