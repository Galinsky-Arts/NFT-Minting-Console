import {getAddress,ZeroAddress} from 'ethers';
import {OpenSeaReadOnlyClient} from './read-only.mjs';
import {OpenSeaSignedListingTransport,ListingTransportError} from './post-listing.mjs';
import {orderParameters,priceOf,ListingError} from './listing.mjs';

/**
 * OpenSea adapter (Ethereum mainnet only: OpenSea's current API lists no testnets).
 * Every value read here is an observation that is cross-checked against the reviewed order
 * and the chain; an API acceptance never by itself makes anything "Listed".
 */
const fail=(code,detail)=>{throw new ListingError(code,detail);};

/** Exact percentage text ("2.5", 1, "0.25") to basis points; rejects anything finer than 1 bps. */
export function percentToBps(value){
  const text=typeof value==='number'?String(value):value;
  if(typeof text!=='string'||!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,8})?$/.test(text))fail('FEE_FORMAT');
  const [whole,frac='']=text.split('.');
  if(frac.length>2&&/[1-9]/.test(frac.slice(2)))fail('FEE_PRECISION');
  const bps=Number(whole)*100+Number((frac+'00').slice(0,2));
  if(!Number.isSafeInteger(bps)||bps<0||bps>10000)fail('FEE_FORMAT');return bps;
}

export function createOpenSea({apiKey,fetchImpl}={}){
  if(!apiKey)return null;
  return Object.freeze({read:new OpenSeaReadOnlyClient({apiKey,fetchImpl}),post:new OpenSeaSignedListingTransport({apiKey,fetchImpl})});
}

/** Required marketplace fees and required zone for the token's OpenSea collection. */
export async function openSeaListingTerms(client,{collection,tokenId,royalty}){
  const nft=(await client.read.getNFT({collection,id:String(tokenId)})).apiResponse?.nft;
  const slug=nft?.collection;if(typeof slug!=='string'||!slug)fail('OPENSEA_COLLECTION_UNKNOWN');
  const details=(await client.read.getCollection({name:slug})).apiResponse;
  if(!Array.isArray(details?.fees))fail('OPENSEA_FEES_UNAVAILABLE');
  const fees=[];const royaltyRecipient=royalty?getAddress(royalty.recipient):null;let creatorFeeBps=0;
  for(const f of details.fees){
    if(f?.required!==true)continue;
    const recipient=getAddress(f.recipient),bps=percentToBps(f.fee);if(bps===0)continue;
    // A required creator fee to the same recipient as ERC-2981 is the royalty itself, not an extra fee.
    if(royaltyRecipient&&recipient===royaltyRecipient){creatorFeeBps+=bps;continue;}
    fees.push({recipient,bps,label:'OpenSea fee',required:true});
  }
  const zone=details.required_zone?getAddress(details.required_zone):null;
  return Object.freeze({slug,fees,creatorFeeBps,requiredZone:zone&&zone!==ZeroAddress?zone:null,openseaUrl:typeof details.opensea_url==='string'?details.opensea_url:null});
}

/** Posts the exact reviewed, signed order. Ambiguous outcomes are reported as uncertain, never retried here. */
export async function submitToOpenSea(client,market,{components,signature,review}){
  try{
    const out=await client.post.submit({chain:'ethereum',protocolAddress:market.seaport,order:{parameters:{...orderParameters(components),counter:components.counter},signature},review:{...review,approved:true}});
    return {outcome:'accepted',orderHash:out.orderHash};
  }catch(e){
    if(!(e instanceof ListingTransportError))throw e;
    if(['TIMEOUT','NETWORK','UNCERTAIN_DUPLICATE','RESPONSE','JSON','CONTENT_TYPE','ORDER_HASH','TOO_LARGE','RATE_LIMITED'].includes(e.code))return {outcome:'uncertain',code:e.code};
    return {outcome:'rejected',code:e.code};
  }
}

const lower=v=>typeof v==='string'?v.toLowerCase():v;
const str=v=>typeof v==='number'?String(v):v;
/** OpenSea's stored order must equal the reviewed components field for field. */
export function sameOrder(apiParams,c){
  if(!apiParams||typeof apiParams!=='object')return false;
  const scalar=['offerer','zone','zoneHash','salt','conduitKey','startTime','endTime','counter'];
  for(const k of scalar)if(lower(str(apiParams[k]))!==lower(str(c[k])))return false;
  if(Number(apiParams.orderType)!==c.orderType)return false;
  const items=(a,b,keys)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>keys.every(k=>lower(str(x?.[k]))===lower(str(b[i][k]))));
  return items(apiParams.offer,c.offer,['itemType','token','identifierOrCriteria','startAmount','endAmount'])&&
    items(apiParams.consideration,c.consideration,['itemType','token','identifierOrCriteria','startAmount','endAmount','recipient']);
}

/** Marketplace observation of one order hash. 'absent' means OpenSea has no record of this exact order. */
export async function observeOpenSea(client,market,{orderHash,components}){
  let order;
  try{order=(await client.read.getOrder({protocol:market.seaport,hash:orderHash})).apiResponse?.order;}
  catch(e){if(e?.code==='NOT_FOUND')return {status:'absent'};return {status:'unavailable',code:e?.code||'READ_FAILED'};}
  if(!order||lower(order.order_hash)!==orderHash)return {status:'unavailable',code:'HASH_MISMATCH'};
  const matches=sameOrder(order.protocol_data?.parameters,components);
  const priceOk=order.price?.current?.value===undefined||String(order.price.current.value)===priceOf(components).toString();
  return {status:typeof order.status==='string'?order.status:'UNKNOWN',matches:matches&&priceOk,remainingQuantity:order.remaining_quantity??null};
}
