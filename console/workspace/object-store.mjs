import {createHash,createHmac} from 'node:crypto';

/**
 * Optional S3-compatible store for the private workspace's client-encrypted chunks (NFT-12).
 *
 * The server only ever handles ciphertext: chunks are AES-GCM sealed in the browser before upload, so this
 * adapter stores opaque bytes. PostgreSQL remains the default and keeps the chunk index/hash metadata even
 * when bodies live in the bucket. Requests are signed with AWS Signature Version 4 (path-style URLs), which
 * works with AWS S3, Cloudflare R2, Backblaze B2, MinIO and other S3-compatible services. No SDK is needed.
 */
export class ObjectStoreError extends Error{constructor(message,status){super(message);this.status=status;}}

const sha256Hex=b=>createHash('sha256').update(b).digest('hex');
const hmac=(k,v)=>createHmac('sha256',k).update(v).digest();
const enc=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const encPath=p=>p.split('/').map(enc).join('/');
const KEY_PART=/^[0-9a-f-]{1,64}$/;

/** Reads PRIVATE_STORAGE_* configuration. Returns null for the default PostgreSQL driver. */
export function objectStoreFromEnv(env=process.env,{fetchImpl}={}){
  const driver=String(env.PRIVATE_STORAGE_DRIVER||'postgres').trim().toLowerCase();
  if(driver==='postgres'||driver==='')return null;
  if(driver!=='s3')throw new Error('PRIVATE_STORAGE_DRIVER must be "postgres" (default) or "s3".');
  const missing=['PRIVATE_STORAGE_ENDPOINT','PRIVATE_STORAGE_BUCKET','PRIVATE_STORAGE_REGION','PRIVATE_STORAGE_ACCESS_KEY_ID','PRIVATE_STORAGE_SECRET_ACCESS_KEY'].filter(k=>!String(env[k]||'').trim());
  if(missing.length)throw new Error('S3 private storage is selected but these settings are missing: '+missing.join(', '));
  return new S3ObjectStore({endpoint:env.PRIVATE_STORAGE_ENDPOINT,bucket:env.PRIVATE_STORAGE_BUCKET,region:env.PRIVATE_STORAGE_REGION,
    accessKeyId:env.PRIVATE_STORAGE_ACCESS_KEY_ID,secretAccessKey:env.PRIVATE_STORAGE_SECRET_ACCESS_KEY,prefix:env.PRIVATE_STORAGE_PREFIX,
    serverSideEncryption:env.PRIVATE_STORAGE_SSE,allowInsecureLocal:env.NODE_ENV==='test',fetchImpl});
}

export class S3ObjectStore{
  constructor({endpoint,bucket,region,accessKeyId,secretAccessKey,prefix='nft-console/workspace/',serverSideEncryption,allowInsecureLocal=false,fetchImpl=globalThis.fetch,now=()=>new Date()}){
    const url=new URL(endpoint);
    const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.search||url.hash)throw new Error('PRIVATE_STORAGE_ENDPOINT must be a plain origin without credentials.');
    if(url.protocol!=='https:'&&!(allowInsecureLocal&&local&&url.protocol==='http:'))throw new Error('PRIVATE_STORAGE_ENDPOINT must use HTTPS.');
    if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))throw new Error('PRIVATE_STORAGE_BUCKET is not a valid bucket name.');
    if(!/^[a-z0-9-]{2,32}$/.test(region))throw new Error('PRIVATE_STORAGE_REGION is not valid (use "auto" for R2).');
    if(prefix&&!/^[A-Za-z0-9/_-]{1,128}\/$/.test(prefix))throw new Error('PRIVATE_STORAGE_PREFIX must end with "/" and use letters, digits, "_", "-" or "/".');
    if(serverSideEncryption&&!['AES256','aws:kms'].includes(serverSideEncryption))throw new Error('PRIVATE_STORAGE_SSE must be AES256 or aws:kms when set.');
    this.base=url.origin+url.pathname.replace(/\/$/,'');this.host=url.host;this.bucket=bucket;this.region=region;
    this.credentials={accessKeyId,secretAccessKey};this.prefix=prefix||'';this.sse=serverSideEncryption||null;this.fetch=fetchImpl;this.now=now;
  }
  get driver(){return 's3';}
  /** Object key for one chunk. The hash in the key means a racing different body can never overwrite an accepted one. */
  chunkKey(account,objectId,index,sha){
    for(const part of [account,objectId,sha])if(!KEY_PART.test(String(part)))throw new ObjectStoreError('Invalid object key component.',400);
    if(!Number.isSafeInteger(index)||index<0)throw new ObjectStoreError('Invalid chunk index.',400);
    return `${this.prefix}${account}/${objectId}/${index}-${sha}`;
  }
  objectPrefix(account,objectId){
    for(const part of [account,objectId])if(!KEY_PART.test(String(part)))throw new ObjectStoreError('Invalid object key component.',400);
    return `${this.prefix}${account}/${objectId}/`;
  }
  #sign(method,key,query,headers,payloadHash){
    const date=this.now(),amz=date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''),day=amz.slice(0,8);
    const path='/'+encPath(this.bucket)+(key?'/'+encPath(key):'');
    const all={...headers,host:this.host,'x-amz-content-sha256':payloadHash,'x-amz-date':amz};
    const names=Object.keys(all).map(n=>n.toLowerCase()).sort();
    const lower=Object.fromEntries(Object.entries(all).map(([k,v])=>[k.toLowerCase(),String(v).trim()]));
    const qs=Object.keys(query).sort().map(k=>enc(k)+'='+enc(query[k])).join('&');
    const canonical=[method,new URL(this.base).pathname.replace(/\/$/,'')+path,qs,names.map(n=>n+':'+lower[n]+'\n').join(''),names.join(';'),payloadHash].join('\n');
    const scope=`${day}/${this.region}/s3/aws4_request`;
    const toSign=['AWS4-HMAC-SHA256',amz,scope,sha256Hex(canonical)].join('\n');
    const k=hmac(hmac(hmac(hmac('AWS4'+this.credentials.secretAccessKey,day),this.region),'s3'),'aws4_request');
    const signature=createHmac('sha256',k).update(toSign).digest('hex');
    const out={...lower};delete out.host;
    out.authorization=`AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return {url:this.base+path+(qs?'?'+qs:''),headers:out};
  }
  async #request(method,key,{query={},body,headers={}}={}){
    const payload=body?Buffer.from(body.buffer,body.byteOffset,body.byteLength):Buffer.alloc(0);
    const signed=this.#sign(method,key,query,headers,sha256Hex(payload));
    let res;
    try{res=await this.fetch(signed.url,{method,headers:signed.headers,body:body?payload:undefined,signal:AbortSignal.timeout(30000)});}
    catch{throw new ObjectStoreError('The private object store could not be reached.',503);}
    return res;
  }
  async put(key,body,sha){
    const headers={'content-type':'application/octet-stream','content-length':String(body.byteLength),'x-amz-meta-sha256':sha};
    if(this.sse)headers['x-amz-server-side-encryption']=this.sse;
    const res=await this.#request('PUT',key,{body,headers});
    if(!res.ok)throw new ObjectStoreError('The private object store refused the encrypted chunk ('+res.status+').',503);
  }
  async get(key){
    const res=await this.#request('GET',key);
    if(res.status===404)return null;
    if(!res.ok)throw new ObjectStoreError('The private object store could not return the encrypted chunk ('+res.status+').',503);
    return new Uint8Array(await res.arrayBuffer());
  }
  async delete(key){
    const res=await this.#request('DELETE',key);
    if(!res.ok&&res.status!==404)throw new ObjectStoreError('The private object store could not delete a chunk ('+res.status+').',503);
  }
  async list(prefix){
    const keys=[];let token;
    do{
      const query={'list-type':'2',prefix};if(token)query['continuation-token']=token;
      const res=await this.#request('GET','',{query});
      if(!res.ok)throw new ObjectStoreError('The private object store could not list chunks ('+res.status+').',503);
      const xml=await res.text();
      for(const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g))keys.push(m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"));
      token=/<IsTruncated>true<\/IsTruncated>/.test(xml)?(xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)||[])[1]:undefined;
    }while(token);
    return keys;
  }
  /** Removes every stored chunk under an object's prefix (deletion and retention expiry). */
  async deletePrefix(prefix){
    if(!prefix.startsWith(this.prefix)||!prefix.endsWith('/'))throw new ObjectStoreError('Refusing to delete outside the workspace prefix.',400);
    const keys=await this.list(prefix);
    for(const key of keys)await this.delete(key);
    return keys.length;
  }
}
