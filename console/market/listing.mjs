import {Contract,Interface,TypedDataEncoder,getAddress,verifyTypedData,Signature,Wallet,ZeroAddress,keccak256} from 'ethers';
import {EIP712_TYPES} from '../marketplace/seaport-order.mjs';
import {fail} from './config.mjs';
import {simulateMarketplaceTransfer} from './policy.mjs';
const ORDER_TUPLE='tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)';
const PARAMS_TUPLE='tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)';
export const SEAPORT_ABI=['function getCounter(address) view returns (uint256)','function getOrderStatus(bytes32) view returns (bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)',
  `function getOrderHash(${ORDER_TUPLE}) view returns (bytes32)`,'function information() view returns (string version,bytes32 domainSeparator,address conduitController)',
  `function cancel(${ORDER_TUPLE}[] orders) returns (bool)`,'function incrementCounter() returns (uint256)',
  `function fulfillOrder(tuple(${PARAMS_TUPLE} parameters,bytes signature) order,bytes32 fulfillerConduitKey) payable returns (bool)`,
  'event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,tuple(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,tuple(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)',
  'event OrderCancelled(bytes32 orderHash,address indexed offerer,address indexed zone)'];
export const CONDUIT_CONTROLLER_ABI=['function getConduit(bytes32) view returns (address conduit,bool exists)','function getChannelStatus(address conduit,address channel) view returns (bool)'];
const NFT_ABI=['function ownerOf(uint256) view returns (address)','function isApprovedForAll(address,address) view returns (bool)','function getApproved(uint256) view returns (address)',
  'function royaltyInfo(uint256,uint256) view returns (address,uint256)','function getTransferValidator() view returns (address)','function setApprovalForAll(address,bool)',
  'function name() view returns (string)','function symbol() view returns (string)','function ROYALTY_RECIPIENT() view returns (address)','function CREATOR_ROYALTY_BPS() view returns (uint96)'];
export const seaportIface=new Interface(SEAPORT_ABI),nftIface=new Interface(NFT_ABI);
const MAX_DURATION=180n*86400n;
export const domainFor=market=>({name:'Seaport',version:market.seaportVersion,chainId:market.chainId,verifyingContract:market.seaport});
export const orderHashOf=parameters=>TypedDataEncoder.from(EIP712_TYPES).hash(parameters);
/** Independently verifies the Seaport deployment, its EIP-712 domain and the marketplace conduit channel. */
export async function verifyMarketInfrastructure(provider,market){
  if((await provider.getNetwork()).chainId!==BigInt(market.chainId))fail('WRONG_NETWORK');
  if(await provider.getCode(market.seaport)==='0x')fail('SEAPORT_NOT_DEPLOYED');
  const s=new Contract(market.seaport,SEAPORT_ABI,provider),[version,separator,controller]=await s.information();
  if(version!==market.seaportVersion)fail('SEAPORT_VERSION_MISMATCH');
  if(separator!==TypedDataEncoder.hashDomain(domainFor(market)))fail('SEAPORT_DOMAIN_MISMATCH');
  if(getAddress(controller)!==market.conduitController)fail('CONDUIT_CONTROLLER_MISMATCH');
  const cc=new Contract(controller,CONDUIT_CONTROLLER_ABI,provider),[conduit,exists]=await cc.getConduit(market.conduitKey);
  if(!exists||!(await cc.getChannelStatus(conduit,market.seaport)))fail('CONDUIT_NOT_OPEN');
  return {conduit:getAddress(conduit),seaportCodeHash:keccak256(await provider.getCode(market.seaport)),domainSeparator:separator};
}
/** Facts about one token read from chain at this moment: ownership, approvals, royalty, policy compatibility, counter. */
export async function inspectToken(provider,market,{collection,tokenId,seller,priceWei=10n**18n}){
  collection=getAddress(collection);const infra=await verifyMarketInfrastructure(provider,market);
  const nft=new Contract(collection,NFT_ABI,provider),s=new Contract(market.seaport,SEAPORT_ABI,provider);
  let owner;try{owner=getAddress(await nft.ownerOf(tokenId));}catch{fail('TOKEN_NOT_MINTED');}
  const [approvedAll,approved,[royaltyRecipient,royaltyAmount],validator,counter,name,symbol]=await Promise.all([nft.isApprovedForAll(owner,infra.conduit),nft.getApproved(tokenId),nft.royaltyInfo(tokenId,priceWei),
    nft.getTransferValidator(),s.getCounter(owner),nft.name(),nft.symbol()]);
  let policy={validator:getAddress(validator),code:false,marketplaceOperatorAllowed:null};
  if(!/^0x0{40}$/i.test(validator)&&await provider.getCode(validator)!=='0x'){
    try{policy={...policy,code:true,...await simulateMarketplaceTransfer(provider,{validator,collection,operator:infra.conduit,from:owner,tokenId})};}
    catch{policy={...policy,code:true,marketplaceOperatorAllowed:null,error:'POLICY_SIMULATION_UNAVAILABLE'};}
  }else policy={...policy,marketplaceOperatorAllowed:true,note:'No validator code at the configured address: transfers are unrestricted.'};
  return {chainId:market.chainId,collection,name,symbol,tokenId:String(tokenId),owner,sellerIsOwner:seller?getAddress(seller)===owner:null,conduit:infra.conduit,
    approval:{conduitApprovedForAll:approvedAll,tokenApproval:getAddress(approved)===infra.conduit},
    royalty:{recipient:getAddress(royaltyRecipient),bpsAtPrice:priceWei>0n?Number(royaltyAmount*10000n/priceWei):0},counter:counter.toString(),policy,infrastructure:infra};
}
/** Splits a gross price into exact consideration items; seller receives the remainder. */
export function feeSchedule({priceWei,seller,royalty,marketplaceFees}){
  const gross=BigInt(priceWei);if(gross<=0n)fail('PRICE_REQUIRED');
  const payments=[],seen=new Set();let fees=0n;
  for(const f of marketplaceFees){const amount=gross*BigInt(f.bps)/10000n;if(amount>0n){payments.push({role:f.role||'marketplace',recipient:getAddress(f.recipient),bps:f.bps,amountWei:amount.toString(),required:f.required!==false});fees+=amount;}seen.add(f.role);}
  if(royalty&&royalty.bps>0&&!seen.has('royalty')){const amount=gross*BigInt(royalty.bps)/10000n;if(amount>0n){payments.push({role:'royalty',recipient:getAddress(royalty.recipient),bps:royalty.bps,amountWei:amount.toString(),required:true});fees+=amount;}}
  if(fees>=gross)fail('FEES_EXCEED_PRICE');
  return [{role:'seller',recipient:getAddress(seller),bps:null,amountWei:(gross-fees).toString(),required:true},...payments];
}
export function buildOrder(market,{seller,collection,tokenId,payments,counter,startTime,endTime,conduitKey=market.conduitKey,salt}){
  const begin=BigInt(startTime),end=BigInt(endTime);if(end<=begin||end-begin>MAX_DURATION)fail('EXPIRATION_INVALID');
  if(!salt){const b=new Uint8Array(32);globalThis.crypto.getRandomValues(b);salt=BigInt('0x'+Buffer.from(b).toString('hex')).toString();}
  const parameters={offerer:getAddress(seller),zone:ZeroAddress,offer:[{itemType:2,token:getAddress(collection),identifierOrCriteria:String(tokenId),startAmount:'1',endAmount:'1'}],
    consideration:payments.map(p=>({itemType:0,token:ZeroAddress,identifierOrCriteria:'0',startAmount:p.amountWei,endAmount:p.amountWei,recipient:getAddress(p.recipient)})),
    orderType:0,startTime:begin.toString(),endTime:end.toString(),zoneHash:'0x'+'0'.repeat(64),salt,conduitKey,counter:String(counter),totalOriginalConsiderationItems:payments.length};
  const domain=domainFor(market);
  return {domain,types:EIP712_TYPES,primaryType:'OrderComponents',parameters,orderHash:orderHashOf(parameters),digest:TypedDataEncoder.hash(domain,EIP712_TYPES,parameters)};
}
/** Signature must recover to the seller over the exact persisted order and domain. Returns the 65-byte form. */
export function verifyOrderSignature(order,signature){
  if(typeof signature!=='string'||!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature))fail('SIGNATURE_INVALID');
  let recovered;try{recovered=verifyTypedData(order.domain,EIP712_TYPES,order.parameters,signature);}catch{fail('SIGNATURE_INVALID');}
  if(getAddress(recovered)!==getAddress(order.parameters.offerer))fail('SIGNATURE_WRONG_SIGNER');
  return Signature.from(signature).serialized;
}
const components=p=>({...p,counter:p.counter});
/** Every independent on-chain fact required before an order can be considered fillable. */
export async function verifyOrderOnChain(provider,market,order,{now=Math.floor(Date.now()/1000)}={}){
  const p=order.parameters,facts={},problems=[];
  const infra=await verifyMarketInfrastructure(provider,market);
  const s=new Contract(market.seaport,SEAPORT_ABI,provider),nft=new Contract(p.offer[0].token,NFT_ABI,provider),id=p.offer[0].identifierOrCriteria;
  const chainHash=await s.getOrderHash(components(p));facts.orderHashMatchesSeaport=chainHash===order.orderHash;if(!facts.orderHashMatchesSeaport)problems.push('ORDER_HASH_MISMATCH');
  const [validated,cancelled,filled,size]=await s.getOrderStatus(order.orderHash);facts.status={validated,cancelled,totalFilled:filled.toString(),totalSize:size.toString()};
  if(cancelled)problems.push('CANCELLED');if(filled>0n&&filled===size)problems.push('FILLED');
  facts.counterCurrent=(await s.getCounter(p.offerer)).toString()===String(p.counter);if(!facts.counterCurrent)problems.push('COUNTER_INCREMENTED');
  let owner=null;try{owner=getAddress(await nft.ownerOf(id));}catch{/* burned */}
  facts.sellerOwnsToken=owner===getAddress(p.offerer);facts.currentOwner=owner;if(!facts.sellerOwnsToken)problems.push('SELLER_NO_LONGER_OWNS');
  facts.conduitMatches=p.conduitKey===market.conduitKey;facts.approved=await nft.isApprovedForAll(p.offerer,infra.conduit)||getAddress(await nft.getApproved(id))===infra.conduit;if(!facts.approved)problems.push('APPROVAL_MISSING');
  facts.active=BigInt(p.startTime)<=BigInt(now)&&BigInt(now)<BigInt(p.endTime);if(BigInt(now)>=BigInt(p.endTime))problems.push('EXPIRED');else if(!facts.active)problems.push('NOT_STARTED');
  try{verifyOrderSignature(order,order.signature);facts.signatureValid=true;}catch{facts.signatureValid=false;problems.push('SIGNATURE_INVALID');}
  const validator=await nft.getTransferValidator();
  if(!/^0x0{40}$/i.test(validator)&&await provider.getCode(validator)!=='0x'){
    try{const sim=await simulateMarketplaceTransfer(provider,{validator,collection:p.offer[0].token,operator:infra.conduit,from:p.offerer,tokenId:id});facts.policyAllowsMarketplace=sim.marketplaceOperatorAllowed;}
    catch{facts.policyAllowsMarketplace=null;}
    if(facts.policyAllowsMarketplace!==true)problems.push(facts.policyAllowsMarketplace===false?'POLICY_BLOCKS_MARKETPLACE':'POLICY_UNVERIFIED');
  }else facts.policyAllowsMarketplace=true;
  const [rr,ra]=await nft.royaltyInfo(id,p.consideration.reduce((a,c)=>a+BigInt(c.startAmount),0n));
  facts.royaltyConsideration=p.consideration.some(c=>getAddress(c.recipient)===getAddress(rr)&&BigInt(c.startAmount)>=ra);
  return {facts,problems,fillable:problems.length===0,checkedAt:new Date(now*1000).toISOString(),block:await provider.getBlockNumber()};
}
/** Settlement evidence for a filled order: buyer, every payment actually transferred by Seaport, royalty paid. */
export async function inspectSale(provider,market,order,{fromBlock,royaltyRecipient}){
  const topic=seaportIface.getEvent('OrderFulfilled').topicHash,offerer='0x'+order.parameters.offerer.slice(2).toLowerCase().padStart(64,'0');
  const logs=await provider.getLogs({address:market.seaport,topics:[topic,offerer],fromBlock,toBlock:'latest'});
  for(const log of logs){const e=seaportIface.parseLog(log);if(e.args.orderHash!==order.orderHash)continue;
    const payments=e.args.consideration.filter(c=>Number(c.itemType)===0).map(c=>({recipient:getAddress(c.recipient),amountWei:c.amount.toString()}));
    const receipt=await provider.getTransactionReceipt(log.transactionHash);if(!receipt||receipt.status!==1)continue;
    const royaltyPaid=royaltyRecipient?payments.filter(x=>x.recipient===getAddress(royaltyRecipient)).reduce((a,x)=>a+BigInt(x.amountWei),0n):0n;
    return {transactionHash:log.transactionHash,blockNumber:log.blockNumber,buyer:getAddress(e.args.recipient),payments,royaltyPaidWei:royaltyPaid.toString(),royaltyRecipient:royaltyRecipient||null};
  }
  return null;
}
export function cancelTransaction(market,order){return {to:market.seaport,from:order.parameters.offerer,value:'0x0',data:seaportIface.encodeFunctionData('cancel',[[components(order.parameters)]])};}
export function approvalTransaction(collection,seller,conduit){return {to:getAddress(collection),from:getAddress(seller),value:'0x0',data:nftIface.encodeFunctionData('setApprovalForAll',[conduit,true])};}
export const randomProbe=()=>Wallet.createRandom().address;
