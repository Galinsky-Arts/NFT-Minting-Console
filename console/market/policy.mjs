import {Contract,Interface,getAddress,keccak256,Wallet} from 'ethers';
import {fail} from './config.mjs';
/** Limit Break v5 transfer-validator policy: whitelist ruleset (ID 4 bound as the custom ruleset under
 * ruleset 255) with options 6 (OTC allowed for EIP-7702 delegates and smart wallets), a collection-owned
 * list whitelisting the marketplace conduit. Validators never receive holder operator approval. */
export const RULESET_FIXED_OR_CUSTOM=255,RULESET_WHITELIST=4,RULESET_OPTIONS=6,GLOBAL_OPTIONS=0,LIST_WHITELIST=1,LIST_AUTHORIZERS=2;
export const VALIDATOR_ABI=['function createList(string name) returns (uint48)','function lastListId() view returns (uint48)','function listOwners(uint48) view returns (address)',
  'function addAccountsToList(uint48 id,uint8 listType,address[] accounts)','function applyListToCollection(address collection,uint48 id)',
  'function setRulesetOfCollection(address collection,uint8 rulesetId,address customRuleset,uint8 globalOptions,uint16 rulesetOptions)',
  'function getCollectionSecurityPolicy(address) view returns (tuple(uint8 rulesetId,uint48 listId,address customRuleset,uint8 globalOptions,uint16 rulesetOptions,uint16 tokenType))',
  'function boundRuleset(uint8) view returns (address)','function isRulesetRegistered(address) view returns (bool)','function isAccountInList(uint48 id,uint8 listType,address account) view returns (bool)',
  'function getListAccounts(uint48 id,uint8 listType) view returns (address[])',
  'function validateTransferSim(address collection,address caller,address from,address to,uint256 tokenId) view returns (bool isTransferAllowed,bytes4 errorCode)',
  'event CreatedList(uint256 indexed id,string name)'];
export const COLLECTION_POLICY_ABI=['function owner() view returns (address)','function getTransferValidator() view returns (address)','function setTransferValidator(address)',
  'function isApprovedForAll(address,address) view returns (bool)','function SERIES_SIZE() view returns (uint256)'];
const vIface=new Interface(VALIDATOR_ABI),cIface=new Interface(COLLECTION_POLICY_ABI);
const same=(a,b)=>a&&b&&getAddress(a)===getAddress(b);
/** Read-only inspection of the actual on-chain state. Never trusts registry addresses without code. */
export async function inspectPolicy(provider,{collection,validator,operators,authorizers=[],candidateListId=null}){
  collection=getAddress(collection);
  if(!validator)fail('VALIDATOR_NOT_CONFIGURED');validator=getAddress(validator);
  const [collectionCode,validatorCode]=await Promise.all([provider.getCode(collection),provider.getCode(validator)]);
  if(collectionCode==='0x')fail('COLLECTION_NOT_DEPLOYED');if(validatorCode==='0x')fail('VALIDATOR_NOT_DEPLOYED');
  const c=new Contract(collection,COLLECTION_POLICY_ABI,provider),v=new Contract(validator,VALIDATOR_ABI,provider);
  const [owner,current,whitelistRuleset]=await Promise.all([c.owner(),c.getTransferValidator(),v.boundRuleset(RULESET_WHITELIST)]);
  if(!whitelistRuleset||/^0x0{40}$/i.test(whitelistRuleset)||await provider.getCode(whitelistRuleset)==='0x'||!(await v.isRulesetRegistered(whitelistRuleset)))fail('WHITELIST_RULESET_UNAVAILABLE');
  const p=await v.getCollectionSecurityPolicy(collection);
  const policy={rulesetId:Number(p.rulesetId),listId:p.listId.toString(),customRuleset:getAddress(p.customRuleset),globalOptions:Number(p.globalOptions),rulesetOptions:Number(p.rulesetOptions),tokenType:Number(p.tokenType)};
  // Target list: the one applied to the collection if the OWNER owns it, else a list the OWNER just created.
  const applied=BigInt(policy.listId),appliedOwner=applied>0n?getAddress(await v.listOwners(applied)):null;
  let listId=applied>0n&&same(appliedOwner,owner)?applied:0n;
  if(!listId&&candidateListId!==null){const c=BigInt(candidateListId);if(c>0n&&same(await v.listOwners(c),owner))listId=c;}
  const listOwner=listId>0n?getAddress(await v.listOwners(listId)):appliedOwner,ownsList=listId>0n;
  const whitelisted={},authorized={};
  for(const o of operators)whitelisted[getAddress(o)]=ownsList?await v.isAccountInList(listId,LIST_WHITELIST,o):false;
  for(const a of authorizers)authorized[getAddress(a)]=ownsList?await v.isAccountInList(listId,LIST_AUTHORIZERS,a):false;
  const checks={validatorSet:same(current,validator),listOwnedByCollectionOwner:ownsList,listApplied:ownsList&&applied===listId,
    operatorsWhitelisted:Object.values(whitelisted).every(Boolean),authorizersListed:Object.values(authorized).every(Boolean),
    rulesetConfigured:policy.rulesetId===RULESET_FIXED_OR_CUSTOM&&same(policy.customRuleset,whitelistRuleset)&&policy.globalOptions===GLOBAL_OPTIONS&&policy.rulesetOptions===RULESET_OPTIONS};
  return {collection,validator,validatorCodeHash:keccak256(validatorCode),owner:getAddress(owner),currentValidator:getAddress(current),whitelistRuleset:getAddress(whitelistRuleset),
    policy,targetListId:listId.toString(),listOwner,whitelisted,authorized,checks,configured:Object.values(checks).every(Boolean)};
}
/** The exact OWNER transactions still required, in order. createList yields a list ID only known after
 * its receipt, so the plan stops there and is recomputed from chain state afterwards. */
export function planPolicySteps(state,{operators,authorizers=[],label}){
  const steps=[],listId=BigInt(state.targetListId);
  if(!state.checks.validatorSet)steps.push({id:'set-validator',to:state.collection,data:cIface.encodeFunctionData('setTransferValidator',[state.validator]),
    summary:`Point the collection at transfer validator ${state.validator}.`});
  if(!state.checks.listOwnedByCollectionOwner){steps.push({id:'create-list',to:state.validator,data:vIface.encodeFunctionData('createList',[String(label).slice(0,64)||'NFT Console marketplace list']),
    summary:'Create a marketplace list owned by the collection OWNER.'});return steps.map(s=>({...s,from:state.owner,value:'0x0'}));}
  const missingOps=operators.filter(o=>!state.whitelisted[getAddress(o)]),missingAuth=authorizers.filter(a=>!state.authorized[getAddress(a)]);
  if(missingOps.length)steps.push({id:'whitelist-operators',to:state.validator,data:vIface.encodeFunctionData('addAccountsToList',[listId,LIST_WHITELIST,missingOps]),summary:`Whitelist marketplace operator(s) ${missingOps.join(', ')}.`});
  if(missingAuth.length)steps.push({id:'add-authorizers',to:state.validator,data:vIface.encodeFunctionData('addAccountsToList',[listId,LIST_AUTHORIZERS,missingAuth]),summary:`Add marketplace authorizer(s) ${missingAuth.join(', ')}.`});
  steps.push(...(state.checks.listApplied?[]:[{id:'apply-list',to:state.validator,data:vIface.encodeFunctionData('applyListToCollection',[state.collection,listId]),summary:`Apply list #${listId} to the collection.`}]));
  if(!state.checks.rulesetConfigured)steps.push({id:'set-ruleset',to:state.validator,data:vIface.encodeFunctionData('setRulesetOfCollection',[state.collection,RULESET_FIXED_OR_CUSTOM,state.whitelistRuleset,GLOBAL_OPTIONS,RULESET_OPTIONS]),
    summary:'Select the whitelist ruleset with options 6 (direct wallet, Safe and EIP-7702 transfers stay allowed).'});
  return steps.map(s=>({...s,from:state.owner,value:'0x0'}));
}
export function createdListId(receipt,validator){
  for(const log of receipt.logs){if(!same(log.address,validator))continue;try{const e=vIface.parseLog(log);if(e?.name==='CreatedList')return e.args.id.toString();}catch{/* other events */}}
  fail('LIST_ID_NOT_FOUND');
}
/** Behavioural readback: the configured marketplace operator may transfer and an unlisted contract operator may not. */
export async function simulateMarketplaceTransfer(provider,{validator,collection,operator,from,tokenId}){
  const v=new Contract(validator,VALIDATOR_ABI,provider),probe=Wallet.createRandom().address;
  const [allowed]=await v.validateTransferSim(collection,operator,from,probe,tokenId);
  const [unlisted]=await v.validateTransferSim(collection,'0x000000000000000000000000000000000000dEaD',from,probe,tokenId);
  const [direct]=await v.validateTransferSim(collection,from,from,probe,tokenId);
  return {marketplaceOperatorAllowed:allowed,unlistedOperatorBlocked:!unlisted,directHolderTransferAllowed:direct};
}
