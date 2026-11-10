import {getAddress} from 'ethers';
import {MarketError} from './config.mjs';
/**
 * Marketplace adapters. Contract: fees(collection) -> {known, fees:[{role,recipient,bps,required}]};
 * submit(order) -> {orderHash} (throws MarketError with .definitive=true on a clear rejection);
 * lookup(orderHash) -> {found, active, detail}. A response never establishes a listing on its own:
 * the HTTP layer combines it with independent on-chain verification.
 */
export class MarketplaceError extends MarketError{constructor(code,definitive){super(code);this.definitive=definitive;}}
const MAX=262144;
async function readJson(response){
  if(response.status>=300&&response.status<400)throw new MarketplaceError('MARKETPLACE_REDIRECT',false);
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw new MarketplaceError('MARKETPLACE_CONTENT_TYPE',false);
  const reader=response.body.getReader(),chunks=[];let size=0;
  for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>MAX){await reader.cancel().catch(()=>{});throw new MarketplaceError('MARKETPLACE_RESPONSE_TOO_LARGE',false);}chunks.push(n.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new MarketplaceError('MARKETPLACE_JSON',false);}
}
export class OpenSeaMarketplace{
  #key;#fetch;#base;#chain;#timeout;
  constructor({apiKey,base,chain,fetchImpl=globalThis.fetch,timeoutMs=12000}){
    if(typeof apiKey!=='string'||apiKey.length<8||/[\s\u0000-\u001f]/.test(apiKey))throw new MarketError('OPENSEA_KEY_MISSING',503);
    if(!['https://api.opensea.io/api/v2','https://testnets-api.opensea.io/api/v2'].includes(base)||!['ethereum','sepolia'].includes(chain))throw new MarketError('OPENSEA_CONFIG',500);
    this.name='opensea';this.#key=apiKey;this.#fetch=fetchImpl;this.#base=base;this.#chain=chain;this.#timeout=timeoutMs;
  }
  async #request(method,path,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.#timeout);
    try{
      const response=await this.#fetch(this.#base+path,{method,redirect:'manual',credentials:'omit',signal:controller.signal,
        headers:{Accept:'application/json','X-API-KEY':this.#key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
      return response;
    }catch{throw new MarketplaceError(controller.signal.aborted?'MARKETPLACE_TIMEOUT':'MARKETPLACE_NETWORK',false);}finally{clearTimeout(timer);}
  }
  async fees(collection){
    const contract=await this.#request('GET',`/chain/${this.#chain}/contract/${getAddress(collection)}`);
    if(contract.status===404)return {known:false,reason:'COLLECTION_NOT_INDEXED',fees:[]};
    if(!contract.ok)return {known:false,reason:'MARKETPLACE_UNAVAILABLE',fees:[]};
    const slug=(await readJson(contract)).collection;if(typeof slug!=='string'||!/^[a-z0-9_-]{1,200}$/i.test(slug))return {known:false,reason:'COLLECTION_NOT_INDEXED',fees:[]};
    const col=await this.#request('GET',`/collections/${slug}`);if(!col.ok)return {known:false,reason:'MARKETPLACE_UNAVAILABLE',fees:[]};
    const data=await readJson(col),fees=[];
    for(const f of Array.isArray(data.fees)?data.fees:[]){
      const bps=Math.round(Number(f.fee)*100);if(!Number.isInteger(bps)||bps<0||bps>10000)return {known:false,reason:'FEES_UNPARSEABLE',fees:[]};
      if(f.required)fees.push({role:'marketplace',recipient:getAddress(f.recipient),bps,required:true});
    }
    return {known:true,slug,fees,source:`${this.#base}/collections/${slug}`};
  }
  async submit(order){
    const response=await this.#request('POST',`/orders/${this.#chain}/seaport/listings`,{parameters:order.parameters,signature:order.signature,protocol_address:order.domain.verifyingContract});
    if(response.status===429)throw new MarketplaceError('MARKETPLACE_RATE_LIMITED',false);
    if(response.status>=500||response.status===409)throw new MarketplaceError('MARKETPLACE_UNCERTAIN',false);
    if(!response.ok){let detail='';try{detail=JSON.stringify(await readJson(response)).slice(0,500);}catch{/* ignore */}const e=new MarketplaceError('MARKETPLACE_REJECTED',true);e.detail=detail;throw e;}
    const data=await readJson(response),hash=String(data?.order?.order_hash||data?.order_hash||'').toLowerCase();
    if(!/^0x[0-9a-f]{64}$/.test(hash))throw new MarketplaceError('MARKETPLACE_UNCERTAIN',false);
    return {orderHash:hash};
  }
  async lookup(orderHash,protocol){
    const response=await this.#request('GET',`/orders/chain/${this.#chain}/protocol/${getAddress(protocol)}/${orderHash}`);
    if(response.status===404)return {found:false,active:false};
    if(!response.ok)throw new MarketplaceError('MARKETPLACE_UNAVAILABLE',false);
    const o=(await readJson(response)).order||{};
    const hash=String(o.order_hash||'').toLowerCase();if(hash!==orderHash.toLowerCase())return {found:false,active:false,detail:{mismatch:true}};
    const active=!o.cancelled&&!o.finalized&&!o.marked_invalid;
    return {found:true,active,detail:{cancelled:Boolean(o.cancelled),finalized:Boolean(o.finalized),markedInvalid:Boolean(o.marked_invalid),currentPrice:o.current_price??null,expirationTime:o.expiration_time??null},
      url:`https://${this.#chain==='ethereum'?'':'testnets.'}opensea.io/item/${this.#chain}/${getAddress(o.protocol_data?.parameters?.offer?.[0]?.token||'0x0000000000000000000000000000000000000001')}/${o.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria??''}`};
  }
}
/** Synthetic, in-memory order book for disposable local tests ONLY (chain 31337, NODE_ENV=test). Never proof of a real listing. */
export class FixtureMarketplace{
  constructor({feeRecipient=null,feeBps=0}={}){this.name='fixture';this.orders=new Map();this.feeRecipient=feeRecipient;this.feeBps=feeBps;this.failNext=null;}
  async fees(){return {known:true,synthetic:true,fees:this.feeRecipient&&this.feeBps?[{role:'marketplace',recipient:this.feeRecipient,bps:this.feeBps,required:true}]:[]};}
  async submit(order){
    if(this.failNext==='uncertain'){this.failNext=null;this.orders.set(order.orderHash,order);throw new MarketplaceError('MARKETPLACE_UNCERTAIN',false);}
    if(this.failNext==='reject'){this.failNext=null;throw new MarketplaceError('MARKETPLACE_REJECTED',true);}
    this.orders.set(order.orderHash,order);return {orderHash:order.orderHash};
  }
  async lookup(orderHash){const o=this.orders.get(orderHash);return o?{found:true,active:!o.cancelled,synthetic:true,detail:{synthetic:true}}:{found:false,active:false};}
}
