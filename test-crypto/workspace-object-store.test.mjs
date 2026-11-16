import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../scripts/migrate.mjs';
import {migrateAuth} from '../scripts/migrate-auth.mjs';
import {ReleaseRepository} from '../console/data/releases.mjs';
import {WorkspaceService} from '../console/workspace/service.mjs';
import {S3ObjectStore,objectStoreFromEnv} from '../console/workspace/object-store.mjs';
import * as W from '../console/crypto/workspace.mjs';
import {prepareAttachment,openAttachment} from '../console/crypto/attachments.mjs';

class EmbeddedPool{constructor(db){this.db=db;this.tail=Promise.resolve();}
  async connect(){const p=this.tail;let u;this.tail=new Promise(r=>{u=r;});await p;let done=false;return {query:(...a)=>this.db.query(...a),release:()=>{if(!done){done=true;u();}}};}}
const OWNER='0x'+'11'.repeat(20),OTHER='0x'+'22'.repeat(20),chainId=31337;
const owner={wallet:OWNER,role:'owner',chainId},other={wallet:OTHER,role:'owner',chainId};
const sha=b=>createHash('sha256').update(b).digest('hex');
const ACCESS='TESTACCESSKEY0000001',SECRET='test-secret-not-a-real-credential';

/**
 * In-process S3 fake. It independently re-derives the SigV4 signature for every request and refuses
 * anything unsigned, mis-signed or whose payload hash does not match, so the adapter is exercised as a
 * real S3-compatible service would exercise it.
 */
function fakeS3(){
  const objects=new Map(),requests=[];
  const h=(k,v)=>createHmac('sha256',k).update(v).digest();
  const server=http.createServer((req,res)=>{
    const parts=[];req.on('data',c=>parts.push(c));req.on('end',()=>{
      const body=Buffer.concat(parts),url=new URL(req.url,'http://x');requests.push({method:req.method,path:url.pathname});
      const auth=String(req.headers.authorization||''),m=auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
      if(!m||m[1]!==ACCESS){res.statusCode=403;return res.end('<Error>AccessDenied</Error>');}
      if(req.headers['x-amz-content-sha256']!==sha(body)){res.statusCode=400;return res.end('<Error>XAmzContentSHA256Mismatch</Error>');}
      const signed=m[4].split(';');
      const q=[...url.searchParams.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
      const canonical=[req.method,url.pathname,q,signed.map(n=>n+':'+String(req.headers[n]).trim()+'\n').join(''),m[4],req.headers['x-amz-content-sha256']].join('\n');
      const scope=`${m[2]}/${m[3]}/s3/aws4_request`;
      const sts=['AWS4-HMAC-SHA256',req.headers['x-amz-date'],scope,sha(canonical)].join('\n');
      const key=h(h(h(h('AWS4'+SECRET,m[2]),m[3]),'s3'),'aws4_request');
      if(createHmac('sha256',key).update(sts).digest('hex')!==m[5]){res.statusCode=403;return res.end('<Error>SignatureDoesNotMatch</Error>');}
      const [,bucket,...rest]=url.pathname.split('/');const k=decodeURIComponent(rest.join('/'));
      if(bucket!=='private-chunks'){res.statusCode=404;return res.end('<Error>NoSuchBucket</Error>');}
      if(req.method==='PUT'){objects.set(k,body);return res.end();}
      if(req.method==='GET'&&k){if(!objects.has(k)){res.statusCode=404;return res.end('<Error>NoSuchKey</Error>');}return res.end(objects.get(k));}
      if(req.method==='DELETE'){objects.delete(k);res.statusCode=204;return res.end();}
      if(req.method==='GET'&&url.searchParams.get('list-type')==='2'){
        const prefix=url.searchParams.get('prefix')||'',all=[...objects.keys()].filter(x=>x.startsWith(prefix)).sort();
        const start=Number(url.searchParams.get('continuation-token')||0),page=all.slice(start,start+2),more=start+2<all.length;
        return res.end(`<ListBucketResult>${page.map(x=>`<Contents><Key>${x}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more?`<NextContinuationToken>${start+2}</NextContinuationToken>`:''}</ListBucketResult>`);
      }
      res.statusCode=400;res.end();
    });
  });
  return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,objects,requests,endpoint:`http://127.0.0.1:${server.address().port}`})));
}

async function newDevice(root){const keys=await W.newDeviceKeys();const cert=W.certifyDevice(root,{deviceId:keys.deviceId,signaturePublicKey:W.unb64(keys.publicKey)});const kp=await W.keyPackageFor(keys,cert);return {keys,cert,kp};}
const register=d=>({deviceId:d.keys.deviceId,certificate:d.cert,keyPackage:d.kp.publicPackage,label:'test'});

test('environment selects PostgreSQL by default and validates S3 settings',()=>{
  assert.equal(objectStoreFromEnv({}),null);
  assert.equal(objectStoreFromEnv({PRIVATE_STORAGE_DRIVER:'postgres'}),null);
  assert.throws(()=>objectStoreFromEnv({PRIVATE_STORAGE_DRIVER:'gcs'}),/postgres/);
  assert.throws(()=>objectStoreFromEnv({PRIVATE_STORAGE_DRIVER:'s3',PRIVATE_STORAGE_BUCKET:'b1x'}),/PRIVATE_STORAGE_ENDPOINT.*PRIVATE_STORAGE_SECRET_ACCESS_KEY/);
  const full={PRIVATE_STORAGE_DRIVER:'s3',PRIVATE_STORAGE_ENDPOINT:'https://acct.r2.cloudflarestorage.com',PRIVATE_STORAGE_BUCKET:'private-chunks',PRIVATE_STORAGE_REGION:'auto',PRIVATE_STORAGE_ACCESS_KEY_ID:ACCESS,PRIVATE_STORAGE_SECRET_ACCESS_KEY:SECRET};
  assert.equal(objectStoreFromEnv(full).driver,'s3');
  assert.throws(()=>objectStoreFromEnv({...full,PRIVATE_STORAGE_ENDPOINT:'http://storage.example.com'}),/HTTPS/);
  assert.throws(()=>objectStoreFromEnv({...full,PRIVATE_STORAGE_ENDPOINT:'https://user:pw@storage.example.com'}),/credentials/);
  assert.throws(()=>objectStoreFromEnv({...full,PRIVATE_STORAGE_SSE:'none'}),/SSE/);
});

test('S3 driver: ciphertext-only bodies outside PostgreSQL, resumable idempotent writes, integrity, deletion and retention',async t=>{
  const s3=await fakeS3();t.after(()=>s3.server.close());
  const db=new PGlite();await db.waitReady;t.after(()=>db.close());
  await migrate(db);assert.ok((await migrateAuth(db)).includes('010_workspace_object_store.sql'));
  await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const repo=new ReleaseRepository({pool:new EmbeddedPool(db),knownRoles:()=>new Map([[OWNER,'owner'],[OTHER,'owner']])});
  const store=new S3ObjectStore({endpoint:s3.endpoint,bucket:'private-chunks',region:'auto',accessKeyId:ACCESS,secretAccessKey:SECRET,allowInsecureLocal:true});
  const errors=[];const svc=new WorkspaceService(repo,{objectStore:store,log:{error:m=>errors.push(m)}});
  const root=W.createAccountRoot(),A=await newDevice(root);
  await svc.create(owner,{rootPublicKey:root.publicKey,device:register(A)});
  assert.equal((await svc.overview(owner)).storage,'s3');

  const secretName='secret-cut-for-s3.mp4',parent=W.newId(),plain=randomBytes(3*1024*1024+517);
  const prepared=await prepareAttachment(new Blob([plain]),{parentMessageId:parent,filename:secretName,mediaType:'video/mp4',chunkSize:1024*1024});
  const m=prepared.privateManifest,chunks=[];await prepared.encryptTo((i,c)=>{chunks[i]=c;});
  const objectId=W.newId();
  await svc.createObject(owner,{objectId,chunkCount:chunks.length,chunkSize:m.chunk_size_bytes,ciphertextSize:chunks.reduce((s,c)=>s+c.length,0)});
  // Interrupted upload, then resume only the missing chunks.
  await svc.putChunk(owner,objectId,0,chunks[0],sha(chunks[0]));await svc.putChunk(owner,objectId,1,chunks[1],sha(chunks[1]));
  const status=await svc.objectStatus(owner,objectId);assert.deepEqual(status.received.map(x=>x.index),[0,1]);
  const putsBefore=s3.requests.filter(r=>r.method==='PUT').length;
  assert.equal((await svc.putChunk(owner,objectId,1,chunks[1],sha(chunks[1]))).duplicate,true);
  assert.equal(s3.requests.filter(r=>r.method==='PUT').length,putsBefore,'an accepted chunk is not uploaded again');
  await assert.rejects(svc.putChunk(owner,objectId,1,chunks[2],sha(chunks[2])),{code:'CHUNK_CONFLICT'});
  for(let i=2;i<chunks.length;i++)await svc.putChunk(owner,objectId,i,chunks[i],sha(chunks[i]));
  assert.equal((await svc.objectStatus(owner,objectId)).complete,true);

  // PostgreSQL holds only index/hash metadata; bodies are in the bucket and are ciphertext.
  const rows=(await db.query('SELECT chunk_index,storage,body FROM nft_console.workspace_chunks ORDER BY chunk_index')).rows;
  assert.equal(rows.length,chunks.length);assert.ok(rows.every(r=>r.storage==='s3'&&r.body===null));
  assert.equal(s3.objects.size,chunks.length);
  const stored=Buffer.concat([...s3.objects.values()]);
  assert.ok(!stored.includes(plain.subarray(0,64)),'no plaintext in object storage');
  assert.ok(!stored.toString('latin1').includes(secretName));
  for(const k of s3.objects.keys())assert.match(k,/^nft-console\/workspace\/[0-9a-f-]{36}\/[0-9a-f]{32}\/\d+-[0-9a-f]{64}$/);

  // Round trip through the server returns the exact original after client decryption.
  const opened=await openAttachment(m,parent),out=[];
  await opened.decryptTo(async i=>(await svc.getChunk(owner,objectId,i)).body,(i,p)=>{out[i]=new Uint8Array(p);});
  assert.equal(sha(Buffer.concat(out.map(x=>Buffer.from(x)))),sha(plain));

  // Another account cannot read or delete it.
  await assert.rejects(svc.getChunk(other,objectId,0),{code:'NOT_FOUND'});
  await assert.rejects(svc.deleteObject(other,objectId),{code:'NOT_FOUND'});

  // Tampering in the bucket is detected server-side before bytes are returned.
  const firstKey=[...s3.objects.keys()].find(k=>/\/0-/.test(k));const good=s3.objects.get(firstKey);
  s3.objects.set(firstKey,Buffer.from(good).fill(7,0,4));
  await assert.rejects(svc.getChunk(owner,objectId,0),{code:'CHUNK_INTEGRITY'});
  s3.objects.delete(firstKey);await assert.rejects(svc.getChunk(owner,objectId,0),{code:'CHUNK_MISSING'});
  s3.objects.set(firstKey,good);

  // Explicit deletion removes metadata and every bucket object for that file.
  await svc.deleteObject(owner,objectId);
  assert.equal(s3.objects.size,0);await assert.rejects(svc.objectStatus(owner,objectId),{code:'NOT_FOUND'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM nft_console.workspace_chunks')).rows[0].n,0);

  // Retention: an object past its 30-day expiry is purged from PostgreSQL and the bucket on next access.
  const old=W.newId();
  await svc.createObject(owner,{objectId:old,chunkCount:1,chunkSize:m.chunk_size_bytes,ciphertextSize:chunks[0].length});
  await svc.putChunk(owner,old,0,chunks[0],sha(chunks[0]));assert.equal(s3.objects.size,1);
  await db.query("UPDATE nft_console.workspace_objects SET expires_at=clock_timestamp()-interval '1 second' WHERE object_id=$1",[old]);
  await assert.rejects(svc.getChunk(owner,old,0),{code:'NOT_FOUND'},'expired ciphertext is never served');
  await svc.overview(owner);
  assert.equal(s3.objects.size,0,'expired ciphertext removed from object storage');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM nft_console.workspace_objects')).rows[0].n,0);

  // A storage outage after commit is logged without leaking details, and never silently claimed as deleted data.
  const keep=W.newId();
  await svc.createObject(owner,{objectId:keep,chunkCount:1,chunkSize:m.chunk_size_bytes,ciphertextSize:chunks[0].length});
  await svc.putChunk(owner,keep,0,chunks[0],sha(chunks[0]));
  const broken=new WorkspaceService(repo,{objectStore:new S3ObjectStore({endpoint:s3.endpoint,bucket:'private-chunks',region:'auto',accessKeyId:ACCESS,secretAccessKey:'wrong',allowInsecureLocal:true}),log:{error:x=>errors.push(x)}});
  await assert.rejects(broken.getChunk(owner,keep,0),{status:503});
  await broken.deleteObject(owner,keep);
  assert.equal(errors.length,1);assert.match(errors[0],/workspace_object_cleanup_failed/);assert.ok(!errors[0].includes('wrong'));
  assert.equal(s3.objects.size,1,'orphan remains for the bucket lifecycle rule to expire');
});

test('PostgreSQL driver keeps working after migration 010 (default path unchanged)',async t=>{
  const db=new PGlite();await db.waitReady;t.after(()=>db.close());
  await migrate(db);await migrateAuth(db);
  await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const repo=new ReleaseRepository({pool:new EmbeddedPool(db),knownRoles:()=>new Map([[OWNER,'owner']])});
  const svc=new WorkspaceService(repo);const root=W.createAccountRoot(),A=await newDevice(root);
  await svc.create(owner,{rootPublicKey:root.publicKey,device:register(A)});
  assert.equal((await svc.overview(owner)).storage,'postgres');
  const objectId=W.newId(),body=randomBytes(65552);
  await svc.createObject(owner,{objectId,chunkCount:1,chunkSize:65536,ciphertextSize:body.length});
  await svc.putChunk(owner,objectId,0,body,sha(body));
  assert.equal(sha((await svc.getChunk(owner,objectId,0)).body),sha(body));
  assert.equal((await db.query('SELECT storage FROM nft_console.workspace_chunks')).rows[0].storage,'postgres');
  await svc.deleteObject(owner,objectId);await assert.rejects(svc.objectStatus(owner,objectId),{code:'NOT_FOUND'});
});

test('gigabyte-class encrypted file streams through the S3 driver with bounded server memory',async t=>{
  // The fake keeps only each chunk's hash, so memory growth measures the server path, not the fake's storage.
  const s3=await fakeS3();t.after(()=>s3.server.close());
  const put=s3.objects.set.bind(s3.objects);s3.objects.set=(k,v)=>put(k,Buffer.from(sha(v)));
  const db=new PGlite();await db.waitReady;t.after(()=>db.close());
  await migrate(db);await migrateAuth(db);
  await db.query('GRANT nft_console_api,nft_console_auth_service,nft_console_identity TO CURRENT_USER WITH INHERIT FALSE');
  const repo=new ReleaseRepository({pool:new EmbeddedPool(db),knownRoles:()=>new Map([[OWNER,'owner']])});
  const svc=new WorkspaceService(repo,{objectStore:new S3ObjectStore({endpoint:s3.endpoint,bucket:'private-chunks',region:'auto',accessKeyId:ACCESS,secretAccessKey:SECRET,allowInsecureLocal:true})});
  const root=W.createAccountRoot(),A=await newDevice(root);
  await svc.create(owner,{rootPublicKey:root.publicKey,device:register(A)});
  const CHUNK=8*1024*1024,BODY=CHUNK+16,COUNT=127,objectId=W.newId();   // 127 x (8 MiB + GCM tag) = 0.99 GiB of ciphertext
  await svc.createObject(owner,{objectId,chunkCount:COUNT,chunkSize:CHUNK,ciphertextSize:COUNT*BODY});
  const body=randomBytes(BODY);globalThis.gc?.();const before=process.memoryUsage();let peak=0;
  for(let i=0;i<COUNT;i++){
    body.writeUInt32BE(i,0);   // distinct opaque ciphertext per chunk without allocating a new buffer
    await svc.putChunk(owner,objectId,i,body,sha(body));
    if(i%16===0){const m=process.memoryUsage();peak=Math.max(peak,m.rss-before.rss);}
  }
  assert.equal((await svc.objectStatus(owner,objectId)).complete,true);
  assert.equal(s3.objects.size,COUNT);
  t.diagnostic(`RSS growth over ${COUNT} chunks: ${Math.round(peak/1048576)} MiB`);
  assert.ok(peak<384*1024*1024,`RSS growth ${Math.round(peak/1048576)} MiB stays far below the ~1 GiB file size`);
  await svc.deleteObject(owner,objectId);assert.equal(s3.objects.size,0);
});
