import {Contract,Interface,TypedDataEncoder,getAddress,ZeroAddress,verifyTypedData,Signature} from 'ethers';
import {EIP712_TYPES} from './seaport-order.mjs';

/**
 * Chain-generic Seaport 1.6 listing core. Every fact used to enable a signature or to call a
 * listing valid is read independently from the chain here; nothing is trusted from the browser,
 * a saved status, a marketplace API response or a historical address list.
 */
const ZERO32='0x'+'0'.repeat(64);
const MAX=(1n<<256n)-1n;
const MAX_DURATION=180n*86400n;
const OFFER='(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)';
const CONSIDERATION='(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const HEAD=`address offerer,address zone,${OFFER}[] offer,${CONSIDERATION}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey`;
const COMPONENTS=`(${HEAD},uint256 counter)`;
const PARAMETERS=`(${HEAD},uint256 totalOriginalConsiderationItems)`;
export const SEAPORT_ABI=Object.freeze([
  'function information() view returns (string version, bytes32 domainSeparator, address conduitController)',
  'function getCounter(address offerer) view returns (uint256 counter)',
  `function getOrderHash(${COMPONENTS} order) view returns (bytes32 orderHash)`,
  'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
  `function cancel(${COMPONENTS}[] orders) returns (bool cancelled)`,
  `function fulfillOrder((${PARAMETERS} parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)`,
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
  'event OrderCancelled(bytes32 orderHash, address indexed offerer, address indexed zone)',
]);
const CONDUIT_CONTROLLER_ABI=['function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)'];
export const TOKEN_ABI=Object.freeze([
  'function supportsInterface(bytes4) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)',
  'function getTransferValidator() view returns (address)',
  'function getTransferValidationFunction() view returns (bytes4 functionSignature, bool isViewFunction)',
]);
const VALIDATOR=new Interface(['function validateTransfer(address caller, address from, address to, uint256 tokenId) view']);
const ERC1271=['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'];
export const seaportInterface=new Interface(SEAPORT_ABI);
export const tokenInterface=new Interface(TOKEN_ABI);
/** A recipient that is not any party to the order, used only for read-only policy and fill simulations. */
export const PROBE_BUYER='0x00000000000000000000000000000000000B0b01';

export class ListingError extends Error {
  constructor(code,detail){super('Listing check failed: '+code);this.name='ListingError';this.code=code;if(detail)this.detail=detail;}
}
const fail=(code,detail)=>{throw new ListingError(code,detail);};
export function address(value,code='ADDRESS',allowZero=false){
  let a;try{a=getAddress(value);}catch{fail(code);}
  if(!allowZero&&a===ZeroAddress)fail(code);return a;
}
export function uint(value,code='UINT'){
  if(typeof value==='bigint'){if(value<0n||value>MAX)fail(code);return value;}
  if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,77})$/.test(value))fail(code);
  const n=BigInt(value);if(n>MAX)fail(code);return n;
}
const bytes32=(v,code='BYTES32')=>{if(typeof v!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(v))fail(code);return v.toLowerCase();};
async function hasCode(provider,a){return (await provider.getCode(a))!=='0x';}

/** Marketplace profiles come from config/chains.json. Non-mainnet test deployments may override Seaport. */
export function marketplaceProfile(profile,chainId,env={}){
  const m=profile?.marketplace;if(!m)fail('MARKETPLACE_NOT_CONFIGURED');
  const override=chainId!==1&&env.SEAPORT_ADDRESS;
  const seaport=override?env.SEAPORT_ADDRESS:m.seaport;if(!seaport)fail('MARKETPLACE_NOT_CONFIGURED');
  const conduitKey=chainId!==1&&env.SEAPORT_CONDUIT_KEY?env.SEAPORT_CONDUIT_KEY:(m.conduitKey||ZERO32);
  return Object.freeze({chainId,name:m.name,api:m.api||null,apiChain:m.apiChain||null,seaport:address(seaport,'SEAPORT_ADDRESS'),
    conduitKey:bytes32(conduitKey,'CONDUIT_KEY'),zone:address(m.zone||ZeroAddress,'ZONE',true)});
}
export function seaportDomain(chainId,seaport){return {name:'Seaport',version:'1.6',chainId,verifyingContract:address(seaport)};}

/** Proves the configured address is Seaport 1.6 for THIS chain (EIP-712 domain separator) and resolves the operator. */
export async function inspectMarketplace(provider,market,{zone}={}){
  if((await provider.getNetwork()).chainId!==BigInt(market.chainId))fail('WRONG_NETWORK');
  if(!await hasCode(provider,market.seaport))fail('SEAPORT_NOT_DEPLOYED');
  const seaport=new Contract(market.seaport,SEAPORT_ABI,provider);
  let info;try{info=await seaport.information();}catch{fail('SEAPORT_UNVERIFIED');}
  const expected=TypedDataEncoder.hashDomain(seaportDomain(market.chainId,market.seaport));
  if(info.version!=='1.6'||info.domainSeparator.toLowerCase()!==expected.toLowerCase())fail('SEAPORT_UNVERIFIED');
  let operator=market.seaport;
  if(market.conduitKey!==ZERO32){
    const controller=new Contract(address(info.conduitController),CONDUIT_CONTROLLER_ABI,provider);
    const [conduit,exists]=await controller.getConduit(market.conduitKey);
    if(!exists||!await hasCode(provider,conduit))fail('CONDUIT_UNAVAILABLE');operator=address(conduit);
  }
  const selectedZone=address(zone??market.zone,'ZONE',true);
  if(selectedZone!==ZeroAddress&&!await hasCode(provider,selectedZone))fail('ZONE_NOT_DEPLOYED');
  return Object.freeze({...market,operator,zone:selectedZone,conduitController:address(info.conduitController),domainSeparator:expected});
}

/** Reads token ownership, operator approval, ERC-2981 royalty and transfer-policy compatibility. */
export async function inspectToken(provider,{collection,tokenId,seller,operator,priceWei,zone=ZeroAddress}){
  collection=address(collection,'COLLECTION');seller=address(seller,'SELLER');operator=address(operator,'OPERATOR');
  const id=uint(tokenId,'TOKEN_ID'),price=uint(priceWei,'PRICE');
  if(!await hasCode(provider,collection))fail('COLLECTION_NOT_DEPLOYED');
  const token=new Contract(collection,TOKEN_ABI,provider);
  if(!await token.supportsInterface('0x80ac58cd').catch(()=>false))fail('NOT_ERC721');
  let owner;try{owner=address(await token.ownerOf(id));}catch{fail('TOKEN_NOT_MINTED');}
  const approvedForAll=await token.isApprovedForAll(seller,operator);
  const single=approvedForAll?false:address(await token.getApproved(id),'APPROVAL',true)===operator;
  let royalty=null;
  if(await token.supportsInterface('0x2a55205a').catch(()=>false)){
    const [receiver,amount]=await token.royaltyInfo(id,price);
    if(amount>price)fail('ROYALTY_EXCEEDS_PRICE');
    royalty=amount>0n?{recipient:address(receiver,'ROYALTY_RECIPIENT'),amountWei:amount.toString()}:null;
  }
  return Object.freeze({collection,tokenId:id.toString(),owner,sellerOwns:owner===seller,
    approved:approvedForAll||single,approvalKind:approvedForAll?'operator':single?'token':'none',royalty,
    policy:await transferPolicy(provider,{collection,tokenId:id,from:seller,operator,zone})});
}

/** Asks the collection's actual validator whether the Seaport operator may move this token. */
const POLICY_READ=new Interface(['function getCollectionSecurityPolicy(address) view returns ((uint8 rulesetId,uint48 listId,address customRuleset,uint8 globalOptions,uint16 rulesetOptions,uint16 tokenType))','function isAccountInList(uint48 id, uint8 listType, address account) view returns (bool)']);
export async function transferPolicy(provider,{collection,tokenId,from,operator,zone=ZeroAddress}){
  const token=new Contract(collection,TOKEN_ABI,provider);
  let validator;
  try{validator=address(await token.getTransferValidator(),'VALIDATOR',true);}catch{return {status:'not-creator-token',validator:null};}
  if(validator===ZeroAddress)return {status:'no-validator',validator:null};
  if(!await hasCode(provider,validator))return {status:'blocked',validator,detail:'VALIDATOR_NOT_DEPLOYED'};
  const data=VALIDATOR.encodeFunctionData('validateTransfer',[operator,from,PROBE_BUYER,tokenId]);
  try{await provider.call({to:validator,from:collection,data});return {status:'compatible',validator};}
  catch(error){
    const reverted=error?.code==='CALL_EXCEPTION'||typeof error?.data==='string';
    if(!reverted)return {status:'unknown',validator,detail:'VALIDATOR_CALL_FAILED'};
  }
  // Zone-restricted orders: the marketplace zone pre-authorizes each fill through beforeAuthorizedTransfer.
  // That path works only if authorization mode is on (global flag bit 0 clear) and the zone is a listed authorizer.
  if(zone&&zone!==ZeroAddress){
    try{
      const v=new Contract(validator,POLICY_READ,provider);
      const p=await v.getCollectionSecurityPolicy(collection);
      if((Number(p.globalOptions)&1)===0&&await v.isAccountInList(p.listId,2,zone))return {status:'compatible-via-authorizer',validator,authorizer:zone};
    }catch{return {status:'unknown',validator,detail:'VALIDATOR_CALL_FAILED'};}
  }
  return {status:'blocked',validator,detail:'OPERATOR_REJECTED'};
}

/** Splits the price exactly: seller proceeds first, then marketplace fees, then the creator royalty. */
export function splitPayments({priceWei,seller,fees=[],royalty}){
  const price=uint(priceWei,'PRICE');if(price===0n)fail('PRICE');
  if(!Array.isArray(fees)||fees.length>8)fail('FEES');
  const rows=[];let deducted=0n;
  for(const fee of fees){
    const bps=fee?.bps;if(!Number.isSafeInteger(bps)||bps<1||bps>5000)fail('FEES');
    const amount=price*BigInt(bps)/10000n;if(amount===0n)continue;
    rows.push({role:'marketplace-fee',label:String(fee.label||'Marketplace fee').slice(0,80),recipient:address(fee.recipient,'FEES'),amountWei:amount,bps,required:fee.required===true});
    deducted+=amount;
  }
  if(royalty){const amount=uint(royalty.amountWei,'ROYALTY');if(amount>0n){rows.push({role:'creator-royalty',label:'Creator royalty (ERC-2981)',recipient:address(royalty.recipient,'ROYALTY_RECIPIENT'),amountWei:amount,required:false});deducted+=amount;}}
  if(deducted>=price)fail('FEES_EXCEED_PRICE');
  const payments=[{role:'seller-proceeds',label:'Your proceeds',recipient:address(seller,'SELLER'),amountWei:price-deducted},...rows];
  return payments.map(p=>({...p,amountWei:p.amountWei.toString()}));
}

function randomSalt(){
  const b=new Uint8Array(32);globalThis.crypto.getRandomValues(b);
  const s=BigInt('0x'+Buffer.from(b).toString('hex'));return (s===0n?1n:s).toString();
}
/** Builds exact Seaport OrderComponents for one ERC-721 token priced in the native currency. */
export function composeOrder({market,seller,collection,tokenId,payments,counter,startTime,endTime,salt=randomSalt()}){
  const begin=uint(String(startTime),'TIME'),end=uint(String(endTime),'TIME');
  if(end<=begin||end-begin>MAX_DURATION)fail('EXPIRATION');
  if(!Array.isArray(payments)||!payments.length||payments.length>16)fail('PAYMENTS');
  const components={offerer:address(seller,'SELLER'),zone:market.zone,
    offer:[{itemType:2,token:address(collection,'COLLECTION'),identifierOrCriteria:uint(tokenId,'TOKEN_ID').toString(),startAmount:'1',endAmount:'1'}],
    consideration:payments.map(p=>({itemType:0,token:ZeroAddress,identifierOrCriteria:'0',startAmount:uint(p.amountWei,'PAYMENTS').toString(),endAmount:uint(p.amountWei,'PAYMENTS').toString(),recipient:address(p.recipient,'PAYMENTS')})),
    orderType:market.zone===ZeroAddress?0:2,startTime:begin.toString(),endTime:end.toString(),zoneHash:ZERO32,
    salt:uint(salt,'SALT').toString(),conduitKey:market.conduitKey,counter:uint(String(counter),'COUNTER').toString()};
  const domain=seaportDomain(market.chainId,market.seaport);
  return Object.freeze({domain,types:EIP712_TYPES,components,
    orderHash:TypedDataEncoder.hashStruct('OrderComponents',EIP712_TYPES,components).toLowerCase(),
    digest:TypedDataEncoder.hash(domain,EIP712_TYPES,components).toLowerCase()});
}
export function priceOf(components){return components.consideration.reduce((s,c)=>s+uint(c.startAmount),0n);}

/** Strict structural check of components loaded from storage before any reuse. */
export function checkComponents(market,c,expected){
  if(!c||typeof c!=='object'||!Array.isArray(c.offer)||c.offer.length!==1||!Array.isArray(c.consideration)||!c.consideration.length||c.consideration.length>16)fail('ORDER');
  const o=c.offer[0];
  if(o.itemType!==2||o.startAmount!=='1'||o.endAmount!=='1'||c.zoneHash!==ZERO32||c.conduitKey!==market.conduitKey||
     address(c.zone,'ORDER',true)!==market.zone||c.orderType!==(market.zone===ZeroAddress?0:2))fail('ORDER');
  for(const x of c.consideration)if(x.itemType!==0||x.token!==ZeroAddress||x.identifierOrCriteria!=='0'||x.startAmount!==x.endAmount)fail('ORDER');
  if(expected&&(address(c.offerer)!==address(expected.seller)||address(o.token)!==address(expected.collection)||o.identifierOrCriteria!==String(expected.tokenId)))fail('ORDER');
  const rebuilt=composeOrder({market,seller:c.offerer,collection:o.token,tokenId:o.identifierOrCriteria,payments:c.consideration.map(x=>({recipient:x.recipient,amountWei:x.startAmount})),counter:c.counter,startTime:c.startTime,endTime:c.endTime,salt:c.salt});
  return rebuilt;
}

/** Seaport's own getOrderHash must equal the locally computed EIP-712 struct hash. */
export async function onChainOrderHash(provider,market,components){
  const hash=(await new Contract(market.seaport,SEAPORT_ABI,provider).getOrderHash(components)).toLowerCase();
  return hash;
}

/** EOAs: ECDSA recovery. Contract wallets (Safe): ERC-1271 against the exact digest, as Seaport itself checks. */
export async function verifyOrderSignature(provider,plan,signature){
  if(typeof signature!=='string'||!/^0x(?:[0-9a-fA-F]{2}){64,4096}$/.test(signature))fail('BAD_SIGNATURE');
  const offerer=address(plan.components.offerer);
  if(await hasCode(provider,offerer)){
    const wallet=new Contract(offerer,ERC1271,provider);
    let magic;try{magic=await wallet.isValidSignature(plan.digest,signature);}catch{fail('WRONG_SIGNATURE');}
    if(magic!=='0x1626ba7e')fail('WRONG_SIGNATURE');return {kind:'contract',signature:signature.toLowerCase()};
  }
  if(!/^0x[0-9a-fA-F]{130}$/.test(signature))fail('BAD_SIGNATURE');
  let recovered;try{recovered=verifyTypedData(plan.domain,EIP712_TYPES,plan.components,signature);}catch{fail('BAD_SIGNATURE');}
  if(address(recovered)!==offerer)fail('WRONG_SIGNATURE');
  // Reject high-s malleable forms; store the canonical serialization only.
  const sig=Signature.from(signature);return {kind:'eoa',signature:sig.serialized.toLowerCase()};
}

export function orderParameters(components){
  const {counter,...rest}=components;void counter;
  return {...rest,totalOriginalConsiderationItems:String(components.consideration.length)};
}

/** Read-only fill simulation from a non-party buyer. Only meaningful for open (zone-less) orders. */
export async function simulateFill(provider,market,components,signature,buyer){
  if(market.zone!==ZeroAddress)return {status:'not-simulated',detail:'RESTRICTED_ZONE'};
  const value=priceOf(components);
  const data=seaportInterface.encodeFunctionData('fulfillOrder',[{parameters:orderParameters(components),signature},ZERO32]);
  const call={to:market.seaport,from:buyer,data,value:'0x'+value.toString(16)};
  const funded={[buyer]:{balance:'0x'+(value+10n**18n).toString(16)}};
  try{
    const out=await provider.send('eth_call',[call,'latest',funded]);
    return seaportInterface.decodeFunctionResult('fulfillOrder',out)[0]===true?{status:'fillable'}:{status:'not-fillable'};
  }catch(error){
    const msg=String(error?.message||'');
    // A provider that rejects state overrides cannot prove anything either way.
    if(/override|invalid params|unsupported|not supported|too many arguments/i.test(msg)&&!/revert/i.test(msg))return {status:'not-simulated',detail:'STATE_OVERRIDE_UNSUPPORTED'};
    return {status:'not-fillable'};
  }
}

/**
 * Aggregates independent facts about one signed order. State precedence:
 * sold > cancelled > expired > inactive (owner/approval/policy) > valid.
 */
export async function observeOrder(provider,market,{components,signature,orderHash}){
  const seaport=new Contract(market.seaport,SEAPORT_ABI,provider);
  const block=await provider.getBlock('latest');const now=BigInt(block.timestamp);
  const [status,counter]=await Promise.all([seaport.getOrderStatus(orderHash),seaport.getCounter(components.offerer)]);
  const o=components.offer[0],price=priceOf(components);
  const token=await inspectToken(provider,{collection:o.token,tokenId:o.identifierOrCriteria,seller:components.offerer,operator:market.operator,priceWei:price.toString(),zone:market.zone}).catch(e=>({error:e.code||'TOKEN_UNREADABLE'}));
  const facts={observedBlock:block.number,observedAt:new Date(Number(block.timestamp)*1000).toISOString(),
    seaport:{validated:status.isValidated,cancelled:status.isCancelled,totalFilled:status.totalFilled.toString(),totalSize:status.totalSize.toString()},
    counterMatches:counter.toString()===components.counter,started:now>=BigInt(components.startTime),expired:now>=BigInt(components.endTime),
    sellerOwns:token.sellerOwns===true,owner:token.owner||null,approved:token.approved===true,policy:token.policy?.status||'unknown',tokenError:token.error||null};
  let state;
  if(status.totalSize>0n&&status.totalFilled===status.totalSize)state='sold';
  else if(status.isCancelled||!facts.counterMatches)state='cancelled';
  else if(facts.expired)state='expired';
  else if(!facts.sellerOwns||!facts.approved||facts.policy==='blocked'||facts.policy==='unknown'||token.error)state='inactive';
  else state='valid';
  facts.fill=state==='valid'&&signature?await simulateFill(provider,market,components,signature,PROBE_BUYER):{status:'not-simulated'};
  return Object.freeze({state,facts});
}

/** Finds the actual OrderFulfilled settlement and reports exactly who was paid what. */
export async function findSettlement(provider,market,{orderHash,components,fromBlock=0,royaltyRecipient}){
  const topic=seaportInterface.getEvent('OrderFulfilled').topicHash;
  const offererTopic='0x'+components.offerer.slice(2).toLowerCase().padStart(64,'0');
  const logs=await provider.getLogs({address:market.seaport,topics:[topic,offererTopic],fromBlock,toBlock:'latest'});
  for(const log of logs){
    const parsed=seaportInterface.parseLog(log);if(parsed.args.orderHash.toLowerCase()!==orderHash)continue;
    const receipt=await provider.getTransactionReceipt(log.transactionHash);if(!receipt||receipt.status!==1)continue;
    const paid=parsed.args.consideration.map(c=>({itemType:Number(c.itemType),recipient:address(c.recipient),amountWei:c.amount.toString()}));
    const o=components.offer[0];const token=new Contract(o.token,TOKEN_ABI,provider);
    const currentOwner=address(await token.ownerOf(o.identifierOrCriteria));
    const royalty=royaltyRecipient?paid.filter(p=>p.itemType===0&&p.recipient===address(royaltyRecipient)).reduce((s,p)=>s+BigInt(p.amountWei),0n):0n;
    return Object.freeze({transactionHash:log.transactionHash,blockNumber:log.blockNumber,buyer:address(parsed.args.recipient),
      currentOwner,payments:paid,royaltyPaidWei:royalty.toString(),royaltyEvidence:royalty>0n?'paid-in-settlement':'no-royalty-payment-in-settlement'});
  }
  return null;
}

export function approvalTransaction(collection,operator){
  return {to:address(collection),data:tokenInterface.encodeFunctionData('setApprovalForAll',[address(operator),true]),value:'0x0'};
}
export function cancelTransaction(market,components){
  return {to:market.seaport,data:seaportInterface.encodeFunctionData('cancel',[[components]]),value:'0x0'};
}
