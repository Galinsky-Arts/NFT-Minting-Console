/**
 * Server-side OpenSea READ-ONLY transport. A response is not a verified listing.
 * This file deliberately has no order-posting, approval, signing or retry API.
 */
export class OpenSeaReadError extends Error {
  constructor(code) {
    super('OpenSea read-only inspection failed: '+code);
    this.name='OpenSeaReadError';this.code=code;
  }
}
function reject(code){throw new OpenSeaReadError(code);}
function address(value) {
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value)||
      /^0x0{40}$/i.test(value))reject('INVALID_ADDRESS');
  return value.toLowerCase();
}
function orderHash(value) {
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(value)||
      /^0x0{64}$/i.test(value))reject('INVALID_ORDER_HASH');
  return value.toLowerCase();
}
function tokenId(value) {
  if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,77})$/.test(value)||
      BigInt(value)>(1n<<256n)-1n)reject('INVALID_TOKEN_ID');
  return value;
}
function slug(value) {
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value))reject('INVALID_SLUG');
  return value;
}
function immutableResponse(bytes){
  let parsed;
  try{
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    parsed=JSON.parse(decoded,(_key,value,context)=>{
      if(typeof value==='number'&&!Number.isSafeInteger(value)){
        const source=context?.source;
        // Fee percentages such as 2.5 arrive as JSON doubles: keep the exact source text, never a rounded float.
        if(Number.isFinite(value)&&!Number.isInteger(value)&&typeof source==='string'&&/^(?:0|[1-9][0-9]{0,8})\.[0-9]{1,8}$/.test(source))return source;
        if(!Number.isFinite(value)||!Number.isInteger(value))reject('UNSAFE_JSON_NUMBER');
        if(typeof source!=='string'||!/^(?:0|[1-9][0-9]{0,77})$/.test(source))reject('UNSAFE_JSON_NUMBER');
        return source;
      }
      return value;
    });
  }catch(e){if(e instanceof OpenSeaReadError)throw e;reject('INVALID_JSON');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))reject('INVALID_JSON');
  return Object.freeze({apiResponse:parsed,listingVerified:false,chainVerified:false,feesVerified:false});
}
export class OpenSeaReadOnlyClient {
  #key;#fetch;#timeout;
  constructor({apiKey,fetchImpl=globalThis.fetch,timeoutMs=12000}={}) {
    if(typeof window!=='undefined')reject('SERVER_ONLY');
    if(typeof apiKey!=='string'||apiKey.length<8||apiKey.length>512||
       /[\s\u0000-\u001f\u007f]/u.test(apiKey))reject('NOT_CONFIGURED');
    if(typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)reject('INVALID_TRANSPORT');
    this.#key=apiKey;this.#fetch=fetchImpl;this.#timeout=timeoutMs;
  }
  async #get(path,signal){
    if(signal?.aborted)reject('CANCELLED');
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,this.#timeout);
    try{
      const response=await this.#fetch('https://api.opensea.io/api/v2'+path,{
        method:'GET',redirect:'manual',credentials:'omit',
        headers:{Accept:'application/json','X-API-KEY':this.#key},
        signal:controller.signal,
      });
      if(controller.signal.aborted)reject(signal?.aborted?'CANCELLED':'TIMEOUT');
      if(!response||typeof response.status!=='number')reject('INVALID_RESPONSE');
      if(response.status>=300&&response.status<400)reject('REDIRECT_REFUSED');
      if(response.status===404)reject('NOT_FOUND');
      if(response.status===429)reject('RATE_LIMITED');
      if(!response.ok)reject('HTTP_UNAVAILABLE');
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||''))reject('INVALID_CONTENT_TYPE');
      const announced=response.headers.get('content-length');
      if(announced!==null&&(!/^[0-9]+$/.test(announced)||BigInt(announced)>262144n))reject('TOO_LARGE');
      if(!response.body||typeof response.body.getReader!=='function')reject('NO_BODY');
      const reader=response.body.getReader(),chunks=[];
      let count=0;
      try{
        for(;;){
          const next=await reader.read();
          if(next.done)break;
          if(!(next.value instanceof Uint8Array))reject('INVALID_BODY');
          count+=next.value.byteLength;
          if(count>262144){await reader.cancel().catch(()=>{});reject('TOO_LARGE');}
          chunks.push(next.value);
        }
      }finally{reader.releaseLock();}
      if(controller.signal.aborted)reject(signal?.aborted?'CANCELLED':'TIMEOUT');
      const bytes=new Uint8Array(count);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return immutableResponse(bytes);
    }catch(e){
      if(e instanceof OpenSeaReadError)throw e;
      if(controller.signal.aborted)reject(signal?.aborted?'CANCELLED':'TIMEOUT');
      reject('NETWORK_UNAVAILABLE');
    }finally{
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
    }
  }
  /** API observation only; caller must separately verify Seaport on-chain state. */
  async getOrder({chain='ethereum',protocol,hash,signal}={}) {
    if(chain!=='ethereum')reject('UNSUPPORTED_CHAIN');
    return this.#get('/orders/chain/ethereum/protocol/'+address(protocol)+'/'+orderHash(hash),signal);
  }
  async getNFT({chain='ethereum',collection,id,signal}={}) {
    if(chain!=='ethereum')reject('UNSUPPORTED_CHAIN');
    return this.#get('/chain/ethereum/contract/'+address(collection)+'/nfts/'+tokenId(id),signal);
  }
  async getCollection({name,signal}={}) {
    return this.#get('/collections/'+slug(name),signal);
  }
}
