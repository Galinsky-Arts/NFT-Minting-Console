import {Contract,Interface,getAddress,ZeroAddress} from 'ethers';
import {ListingError} from './listing.mjs';

/**
 * OWNER-controlled transfer-policy workflow for the Limit Break CreatorTokenTransferValidator
 * (creator-token-transfer-validator @59adb8b). The approved policy is:
 *   ruleset 255 (fixed/custom) pinned to the validator's registered WHITELIST ruleset, globalOptions 0,
 *   rulesetOptions 6 (allow holder-initiated transfers from EIP-7702 delegates and smart wallets),
 *   on an OWNER-owned list holding the marketplace authorizer (OpenSea signed zone) or, where orders
 *   carry no zone, the marketplace conduit as a whitelisted operator.
 * The validator never receives operator approval over holders' tokens. Every result is read back.
 */
export const POLICY=Object.freeze({rulesetId:255,globalOptions:0,rulesetOptions:6,whitelistRulesetId:4,LIST_WHITELIST:1,LIST_AUTHORIZERS:2});
export const VALIDATOR_ABI=Object.freeze([
  'function boundRuleset(uint8 rulesetId) view returns (address)',
  'function isRulesetRegistered(address ruleset) view returns (bool)',
  'function getCollectionSecurityPolicy(address collection) view returns ((uint8 rulesetId,uint48 listId,address customRuleset,uint8 globalOptions,uint16 rulesetOptions,uint16 tokenType))',
  'function listOwners(uint48 id) view returns (address)',
  'function isAccountInList(uint48 id, uint8 listType, address account) view returns (bool)',
  'function createList(string name) returns (uint48 id)',
  'function applyListToCollection(address collection, uint48 id)',
  'function addAccountsToList(uint48 id, uint8 listType, address[] accounts)',
  'function setRulesetOfCollection(address collection, uint8 rulesetId, address customRuleset, uint8 globalOptions, uint16 rulesetOptions)',
  'event CreatedList(uint256 indexed id, string name)',
]);
const COLLECTION_ABI=['function owner() view returns (address)','function getTransferValidator() view returns (address)','function setTransferValidator(address)','function name() view returns (string)'];
export const validatorInterface=new Interface(VALIDATOR_ABI);
const collectionInterface=new Interface(COLLECTION_ABI);
const fail=(code,detail)=>{const e=new ListingError(code,detail);e.status=409;throw e;};
const addr=(v,code)=>{try{return getAddress(v);}catch{return fail(code);}};

export const POLICY_DISCLOSURE=Object.freeze([
  'Holders can always move their own tokens directly from a regular wallet, an EIP-7702 delegated wallet or a smart wallet such as Safe (options 6). Direct transfers pay no royalty.',
  'Any other operator (a marketplace contract moving a token for a sale) must be on your list or authorized by a listed marketplace authorizer.',
  'You, as the collection OWNER, can later add or remove marketplaces on this list. That changes where holders can sell. The validator never receives approval to move anyone\'s tokens.',
]);

/** Which account the marketplace needs on the list, and in which list type. */
export function marketplaceAccount(market){
  return market.zone&&market.zone!==ZeroAddress?{account:market.zone,listType:POLICY.LIST_AUTHORIZERS,role:'marketplace authorizer (signed zone)'}
    :{account:market.operator,listType:POLICY.LIST_WHITELIST,role:'marketplace operator (conduit)'};
}

/** Reads the actual on-chain state and returns the remaining OWNER transactions, in order. */
export async function inspectPolicy(provider,{collection,owner,validator,market,listId=null,name}){
  collection=addr(collection,'COLLECTION');owner=addr(owner,'OWNER');validator=addr(validator,'VALIDATOR');
  if(await provider.getCode(validator)==='0x')fail('VALIDATOR_NOT_DEPLOYED');
  if(await provider.getCode(collection)==='0x')fail('COLLECTION_NOT_DEPLOYED');
  const c=new Contract(collection,COLLECTION_ABI,provider),v=new Contract(validator,VALIDATOR_ABI,provider);
  const collectionOwner=addr(await c.owner(),'OWNER');
  if(collectionOwner!==owner)fail('NOT_COLLECTION_OWNER',{collectionOwner});
  const whitelist=addr(await v.boundRuleset(POLICY.whitelistRulesetId),'RULESET');
  if(whitelist===ZeroAddress||!await v.isRulesetRegistered(whitelist)||await provider.getCode(whitelist)==='0x')fail('WHITELIST_RULESET_UNAVAILABLE');
  const current=addr(await c.getTransferValidator(),'VALIDATOR');
  const p=await v.getCollectionSecurityPolicy(collection);
  const policy={rulesetId:Number(p.rulesetId),listId:p.listId.toString(),customRuleset:getAddress(p.customRuleset),globalOptions:Number(p.globalOptions),rulesetOptions:Number(p.rulesetOptions)};
  let list=listId!==null&&listId!==undefined?BigInt(listId):(policy.listId!=='0'?BigInt(policy.listId):null);
  let listOwner=null;
  if(list!==null){listOwner=addr(await v.listOwners(list),'LIST');if(listOwner!==owner){if(listId!==null&&listId!==undefined)fail('LIST_NOT_OWNED',{listOwner});list=null;}}
  const need=marketplaceAccount(market);
  const listed=list!==null?await v.isAccountInList(list,need.listType,need.account):false;
  const steps=[];
  if(current!==validator)steps.push({id:'set-validator',label:'Point the collection at the transfer validator',to:collection,data:collectionInterface.encodeFunctionData('setTransferValidator',[validator])});
  if(list===null){
    const label=String(name||'NFT Console marketplace list').slice(0,60);
    steps.push({id:'create-list',label:'Create your marketplace list on the validator',to:validator,data:validatorInterface.encodeFunctionData('createList',[label])});
  }else{
    if(policy.listId!==list.toString())steps.push({id:'apply-list',label:'Apply your list to the collection',to:validator,data:validatorInterface.encodeFunctionData('applyListToCollection',[collection,list])});
    if(!listed)steps.push({id:'add-marketplace',label:`Add the ${need.role} to your list`,to:validator,data:validatorInterface.encodeFunctionData('addAccountsToList',[list,need.listType,[need.account]])});
  }
  const rulesetOk=policy.rulesetId===POLICY.rulesetId&&policy.customRuleset===whitelist&&policy.globalOptions===POLICY.globalOptions&&policy.rulesetOptions===POLICY.rulesetOptions;
  if(!rulesetOk)steps.push({id:'set-ruleset',label:'Set the reviewed whitelist ruleset (255, options 6)',to:validator,data:validatorInterface.encodeFunctionData('setRulesetOfCollection',[collection,POLICY.rulesetId,whitelist,POLICY.globalOptions,POLICY.rulesetOptions])});
  const configured=steps.length===0;
  return Object.freeze({collection,validator,currentValidator:current,whitelistRuleset:whitelist,policy,listId:list===null?null:list.toString(),listOwner,
    marketplace:{...need,listed},configured,steps:steps.map(s=>({...s,value:'0x0'})),disclosure:POLICY_DISCLOSURE,
    expected:{rulesetId:POLICY.rulesetId,customRuleset:whitelist,globalOptions:POLICY.globalOptions,rulesetOptions:POLICY.rulesetOptions}});
}

/**
 * Extracts the new list id from a confirmed createList receipt. Works for direct OWNER transactions and for
 * Safe executions (where the outer transaction targets the Safe): the validator's CreatedList event is read from
 * the receipt and list ownership is proven by the validator's own listOwners record, not by the sender field.
 */
export async function listIdFromReceipt(provider,{hash,owner,validator}){
  const receipt=await provider.getTransactionReceipt(hash);
  if(!receipt)fail('TRANSACTION_PENDING');
  if(receipt.status!==1)fail('TRANSACTION_FAILED');
  const topic=validatorInterface.getEvent('CreatedList').topicHash;
  const logs=receipt.logs.filter(l=>addr(l.address,'VALIDATOR')===addr(validator,'VALIDATOR')&&l.topics[0]===topic);
  if(logs.length!==1)fail('NOT_THE_LIST_TRANSACTION');
  const id=BigInt(logs[0].topics[1]);
  const listOwner=addr(await new Contract(validator,VALIDATOR_ABI,provider).listOwners(id),'LIST');
  if(listOwner!==addr(owner,'OWNER'))fail('NOT_THE_LIST_TRANSACTION');
  return id.toString();
}

/** Safe{Wallet} Transaction Builder batch for the remaining steps (proposal and confirmation happen in the Safe). */
export function safeBatch({chainId,safe,steps,name='NFT Console transfer policy'}){
  return {version:'1.0',chainId:String(chainId),createdAt:Date.now(),
    meta:{name,description:'Generated by NFT Console. Execute in order; the console reads every result back from the chain.',txBuilderVersion:'1.16.5',createdFromSafeAddress:addr(safe,'OWNER')},
    transactions:steps.map(s=>({to:addr(s.to,'TARGET'),value:'0',data:s.data,contractMethod:null,contractInputsValues:null}))};
}
