import {Contract,ZeroAddress} from 'ethers';
import {ListingError,marketplaceProfile,inspectMarketplace} from './listing.mjs';
import {inspectPolicy,listIdFromReceipt,safeBatch} from './transfer-policy.mjs';

const MESSAGES=Object.freeze({
  NOT_COLLECTION_OWNER:'Only the collection OWNER wallet can configure its transfer policy. Sign in with the OWNER wallet (or use its Safe).',
  WHITELIST_RULESET_UNAVAILABLE:'The validator has no registered whitelist ruleset on this network. Nothing was changed.',
  VALIDATOR_NOT_DEPLOYED:'No transfer validator is deployed at the configured address on this network.',
  LIST_NOT_OWNED:'That validator list belongs to a different wallet.',
  NOT_THE_LIST_TRANSACTION:'That transaction is not your createList call on the configured validator.',
  TRANSACTION_PENDING:'The transaction has not confirmed yet.',
  TRANSACTION_FAILED:'The transaction failed on-chain.',
});

/** Validator address: mainnet uses only the reviewed registry value; test networks may override. */
export function validatorAddress(profile,chainId,env){
  const value=chainId!==1&&env.TRANSFER_VALIDATOR_ADDRESS?env.TRANSFER_VALIDATOR_ADDRESS:profile?.validator;
  return value||null;
}

export function installPolicyRoutes(app,requireAction,{provider,chainId,profile,env}){
  let market=null;try{market=profile?.marketplace?marketplaceProfile(profile,chainId,env):null;}catch{market=null;}
  const validator=validatorAddress(profile,chainId,env);
  const wrap=fn=>async(req,res)=>{
    try{
      if(!provider||!market||!validator)return res.status(503).json({code:'POLICY_NOT_CONFIGURED',error:'Transfer-policy setup needs an RPC, a validator and a marketplace profile for this network.'});
      res.json(await fn(req));
    }catch(error){
      if(error instanceof ListingError)return res.status(error.status||409).json({code:error.code,error:MESSAGES[error.code]||'The policy check failed: '+error.code,detail:error.detail??null});
      console.error(JSON.stringify({event:'policy_error',message:String(error?.message||error).slice(0,300)}));
      res.status(503).json({code:'POLICY_UNAVAILABLE',error:'The policy could not be read. Nothing was changed.'});
    }
  };
  const inspect=async(req,listId)=>{
    const m=await inspectMarketplace(provider,market);
    let name='NFT Console marketplace list';
    try{name=`${await new Contract(req.body.collection,['function name() view returns (string)'],provider).name()} marketplace list`;}catch{/* name is cosmetic */}
    const result=await inspectPolicy(provider,{collection:req.body?.collection,owner:req.actor.wallet,validator,market:m,listId,name});
    const isContractOwner=(await provider.getCode(req.actor.wallet))!=='0x';
    return {...result,network:chainId,ownerIsContract:isContractOwner,safeBatch:isContractOwner&&result.steps.length?safeBatch({chainId,safe:req.actor.wallet,steps:result.steps}):null,
      marketplace:{...result.marketplace,name:m.name,zone:m.zone===ZeroAddress?null:m.zone,operator:m.operator}};
  };
  app.post('/api/policy/inspect',requireAction('deploy'),wrap(req=>inspect(req,req.body?.listId??null)));
  app.post('/api/policy/list',requireAction('deploy'),wrap(async req=>{
    const listId=await listIdFromReceipt(provider,{hash:String(req.body?.hash||''),owner:req.actor.wallet,validator});
    return {listId,...await inspect(req,listId)};
  }));
}
