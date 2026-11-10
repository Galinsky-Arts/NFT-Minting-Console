import {Contract,getAddress,isAddress} from 'ethers';
import {MarketError,fail} from './config.mjs';
import {MarketplaceError} from './marketplaces.mjs';
import {inspectPolicy,planPolicySteps,createdListId} from './policy.mjs';
import {inspectToken,feeSchedule,buildOrder,verifyOrderSignature,verifyOrderOnChain,inspectSale,cancelTransaction,approvalTransaction,verifyMarketInfrastructure} from './listing.mjs';
const UINT=/^(?:0|[1-9][0-9]{0,77})$/,HASH=/^0x[0-9a-fA-F]{64}$/;
function exact(body,keys,optional=[]){
  if(!body||typeof body!=='object'||Array.isArray(body))fail('INVALID_INPUT',400);
  for(const k of Object.keys(body))if(!keys.includes(k)&&!optional.includes(k))fail('INVALID_INPUT',400);
  for(const k of keys)if(!(k in body))fail('INVALID_INPUT',400);
}
const address=v=>{if(typeof v!=='string'||!isAddress(v))fail('INVALID_ADDRESS',400);return getAddress(v);};
const uintText=(v,code='INVALID_NUMBER')=>{if(typeof v!=='string'||!UINT.test(v))fail(code,400);return v;};
const TERMINAL=new Set(['sold','replaced']);
/**
 * Marketplace listing, owner approval/cancel and transfer-policy routes. Every success state is derived from
 * fresh chain reads plus (for "listed") an independent marketplace lookup; wallet output is never trusted alone.
 */
export function installMarketRoutes(app,requireAction,{store,provider,market,marketplace}){
  const wrap=fn=>async(req,res)=>{
    try{
      if(req.method==='POST'&&!/^application\/json(?:\s*;|$)/i.test(req.get('Content-Type')||''))return res.status(415).json({error:'Use a JSON request.'});
      if(!provider)fail('RPC_NOT_CONFIGURED',503);
      await fn(req,res);
    }catch(e){
      const code=e instanceof MarketError?e.code:e?.code==='CALL_EXCEPTION'?'CHAIN_CALL_REVERTED':'MARKET_UNAVAILABLE';
      if(!(e instanceof MarketError))console.error(JSON.stringify({event:'market.error',code,message:String(e?.shortMessage||e?.message||'').slice(0,300)}));
      res.status(e instanceof MarketError?e.status:503).json({code,error:messages[code]||`Marketplace step stopped (${code}). Nothing was signed or submitted by this step.`});
    }
  };
  const requireMarket=()=>{if(!market.available)fail('MARKET_NOT_CONFIGURED',409);return market;};
  const sellerMust=(actor,owner)=>{if(getAddress(actor.wallet)!==getAddress(owner))fail('SIGNED_IN_WALLET_NOT_OWNER',403);};

  app.get('/api/market/status',requireAction('read'),wrap(async(_req,res)=>{
    if(!market.available)return res.json({available:false,reason:market.reason,chainId:market.chainId,marketplace:null,validator:market.validator});
    let infrastructure=null,problem=null;try{infrastructure=await verifyMarketInfrastructure(provider,market);}catch(e){problem=e.code||'MARKET_UNAVAILABLE';}
    res.json({available:!problem,problem,chainId:market.chainId,seaport:market.seaport,conduitKey:market.conduitKey,infrastructure,validator:market.validator,
      marketplace:marketplace?.name||null,marketplaceSynthetic:marketplace?.name==='fixture',currency:'ETH'});
  }));
  app.post('/api/market/inspect',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['collection','tokenId','priceWei']);const m=requireMarket();
    const collection=address(req.body.collection),tokenId=uintText(req.body.tokenId),priceWei=BigInt(uintText(req.body.priceWei));
    const facts=await inspectToken(provider,m,{collection,tokenId,seller:req.actor.wallet,priceWei:priceWei||10n**18n});
    const fees=marketplace?await marketplace.fees(collection).catch(()=>({known:false,reason:'MARKETPLACE_UNAVAILABLE',fees:[]})):{known:false,reason:'MARKETPLACE_NOT_CONFIGURED',fees:[]};
    let payments=null;if(fees.known&&priceWei>0n)payments=feeSchedule({priceWei,seller:facts.owner,royalty:{recipient:facts.royalty.recipient,bps:facts.royalty.bpsAtPrice},marketplaceFees:fees.fees});
    const blockers=[];
    if(!facts.sellerIsOwner)blockers.push('SIGNED_IN_WALLET_NOT_OWNER');
    if(!facts.approval.conduitApprovedForAll&&!facts.approval.tokenApproval)blockers.push('APPROVAL_REQUIRED');
    if(facts.policy.marketplaceOperatorAllowed!==true)blockers.push(facts.policy.marketplaceOperatorAllowed===false?'POLICY_BLOCKS_MARKETPLACE':'POLICY_UNVERIFIED');
    if(!marketplace)blockers.push('MARKETPLACE_NOT_CONFIGURED');else if(!fees.known)blockers.push('MARKETPLACE_FEES_UNKNOWN');
    res.json({facts,fees,payments,blockers,marketplace:marketplace?.name||null});
  }));
  app.post('/api/market/approval',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['collection','tokenId']);const m=requireMarket(),collection=address(req.body.collection);
    const facts=await inspectToken(provider,m,{collection,tokenId:uintText(req.body.tokenId),seller:req.actor.wallet});sellerMust(req.actor,facts.owner);
    if(facts.approval.conduitApprovedForAll)fail('ALREADY_APPROVED');
    const tx=approvalTransaction(collection,facts.owner,facts.conduit);
    res.json(await store.createAction(req.actor,'approval',{collection,operator:facts.conduit,owner:facts.owner,purpose:'Allow the Seaport marketplace conduit to transfer this collection’s tokens when one of your signed orders is filled.'},tx));
  }));
  app.post('/api/market/listings',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['collection','tokenId','priceWei','durationDays','feeAcknowledgement'],['replaces']);const m=requireMarket();if(!marketplace)fail('MARKETPLACE_NOT_CONFIGURED');
    const collection=address(req.body.collection),tokenId=uintText(req.body.tokenId),priceWei=BigInt(uintText(req.body.priceWei));
    const days=req.body.durationDays;if(!Number.isInteger(days)||days<1||days>180)fail('INVALID_DURATION',400);
    if(priceWei<10n**12n)fail('PRICE_TOO_LOW',400);
    const facts=await inspectToken(provider,m,{collection,tokenId,seller:req.actor.wallet,priceWei});sellerMust(req.actor,facts.owner);
    if(!facts.approval.conduitApprovedForAll&&!facts.approval.tokenApproval)fail('APPROVAL_REQUIRED');
    if(facts.policy.marketplaceOperatorAllowed!==true)fail(facts.policy.marketplaceOperatorAllowed===false?'POLICY_BLOCKS_MARKETPLACE':'POLICY_UNVERIFIED');
    const fees=await marketplace.fees(collection);if(!fees.known)fail('MARKETPLACE_FEES_UNKNOWN');
    const payments=feeSchedule({priceWei,seller:facts.owner,royalty:{recipient:facts.royalty.recipient,bps:facts.royalty.bpsAtPrice},marketplaceFees:fees.fees});
    // The fee acknowledgement must equal the exact payment split the user reviewed (stale review => refuse).
    if(JSON.stringify(req.body.feeAcknowledgement)!==JSON.stringify(payments.map(p=>[p.role,p.recipient,p.amountWei])))fail('REVIEW_STALE');
    let replaces=null;if(req.body.replaces!==undefined){const old=await store.getListing(req.actor,req.body.replaces);if(getAddress(old.collection)!==collection||old.tokenId!==tokenId)fail('REPLACEMENT_MISMATCH',400);replaces=old.id;}
    const block=await provider.getBlock('latest'),start=block.timestamp-60;
    const order=buildOrder(m,{seller:facts.owner,collection,tokenId,payments,counter:facts.counter,startTime:start,endTime:block.timestamp+days*86400});
    const review={priceWei:priceWei.toString(),currency:'ETH',payments,royalty:facts.royalty,marketplace:marketplace.name,marketplaceFeeSource:fees.source||null,synthetic:Boolean(fees.synthetic),
      policy:facts.policy,counter:facts.counter,expiresAt:new Date(Number(order.parameters.endTime)*1000).toISOString(),
      disclosure:'The royalty shown is included in this order and is paid only if this exact order is filled. ERC-2981 does not enforce royalties on other sale paths or direct transfers.'};
    const row=await store.createListing(req.actor,{collection,tokenId,seller:facts.owner,order,review,marketplace:marketplace.name,preparedBlock:block.number,replaces});
    res.json({...row,typedData:{domain:order.domain,types:order.types,primaryType:'OrderComponents',message:order.parameters}});
  }));
  app.get('/api/market/listings',requireAction('deploy'),wrap(async(req,res)=>{
    const collection=req.query.collection===undefined?null:address(String(req.query.collection));res.json({items:await store.listListings(req.actor,{collection})});
  }));
  app.get('/api/market/listings/:id',requireAction('deploy'),wrap(async(req,res)=>{const row=await store.getListing(req.actor,req.params.id);res.json({...row,events:await store.events(req.actor,row.id)});}));
  app.post('/api/market/listings/:id/signature',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['signature']);const row=await store.getListing(req.actor,req.params.id);if(row.state!=='prepared')fail('LISTING_NOT_PREPARED');
    const signature=verifyOrderSignature(row.order,req.body.signature).toLowerCase();
    res.json(await store.updateListing(req.actor,row.id,row.revision,{state:'signed',signature},'signed',{signer:row.seller}));
  }));
  app.post('/api/market/listings/:id/submit',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,[]);let row=await store.getListing(req.actor,req.params.id);
    if(!['signed','submission_uncertain'].includes(row.state))fail('LISTING_NOT_SUBMITTABLE');if(!marketplace||marketplace.name!==row.marketplace)fail('MARKETPLACE_NOT_CONFIGURED');
    const order={...row.order,signature:row.signature};
    const check=await verifyOrderOnChain(provider,market,order);if(!check.fillable)fail('ORDER_NOT_FILLABLE_'+check.problems[0]);
    // An uncertain earlier attempt is reconciled by looking up this exact order hash first; the same signed
    // order (identical hash) is the only thing ever resubmitted, so no duplicate order can be created.
    if(row.state==='submission_uncertain'){const seen=await marketplace.lookup(row.orderHash,market.seaport).catch(()=>null);
      if(seen?.found)return res.json(await store.updateListing(req.actor,row.id,row.revision,{state:'submitted',submission:{...row.submission,reconciled:true,reconciledAt:new Date().toISOString()}},'submission-reconciled'));}
    row=await store.updateListing(req.actor,row.id,row.revision,{state:'submitting',submission:{attempts:(row.submission?.attempts||0)+1,startedAt:new Date().toISOString()}},'submitting');
    try{
      const result=await marketplace.submit(order);
      if(result.orderHash!==row.orderHash)return res.json(await store.updateListing(req.actor,row.id,row.revision,{state:'attention',submission:{...row.submission,mismatch:result.orderHash}},'submission-mismatch'));
      res.json(await store.updateListing(req.actor,row.id,row.revision,{state:'submitted',submission:{...row.submission,acceptedAt:new Date().toISOString(),apiOrderHash:result.orderHash}},'submitted'));
    }catch(e){
      const definitive=e instanceof MarketplaceError&&e.definitive;
      res.json(await store.updateListing(req.actor,row.id,row.revision,{state:definitive?'rejected':'submission_uncertain',submission:{...row.submission,error:e.code||'MARKETPLACE_UNAVAILABLE',detail:e.detail||null,at:new Date().toISOString()}},definitive?'rejected':'submission-uncertain'));
    }
  }));
  app.post('/api/market/listings/:id/verify',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,[]);const row=await store.getListing(req.actor,req.params.id);if(TERMINAL.has(row.state)||row.state==='prepared')return res.json(row);
    if(!row.signature)fail('LISTING_NOT_SIGNED');
    const order={...row.order,signature:row.signature},check=await verifyOrderOnChain(provider,market,order);
    let state=row.state,sale=null,marketplaceObservation=null;
    if(check.problems.includes('FILLED')||check.problems.includes('SELLER_NO_LONGER_OWNS'))sale=await inspectSale(provider,market,order,{fromBlock:row.preparedBlock,royaltyRecipient:row.review.royalty?.recipient});
    if(sale)state='sold';
    else if(check.problems.includes('CANCELLED'))state=row.replaces?'cancelled':'cancelled';
    else if(check.problems.includes('EXPIRED'))state='expired';
    else if(check.problems.length)state=check.problems.every(p=>p==='POLICY_UNVERIFIED')?'attention':'invalid';
    else if(['submitted','submission_uncertain','indexing_pending','listed','attention','invalid'].includes(row.state)){
      try{marketplaceObservation=await marketplace.lookup(row.orderHash,market.seaport);}catch(e){marketplaceObservation={error:e.code||'MARKETPLACE_UNAVAILABLE'};}
      state=marketplaceObservation?.found&&marketplaceObservation.active?'listed':row.state==='submission_uncertain'?'submission_uncertain':'indexing_pending';
    }
    const verification={...check,marketplace:marketplaceObservation,listedEvidence:state==='listed'?{chainFillable:true,marketplaceActive:true,synthetic:Boolean(marketplaceObservation?.synthetic)}:null};
    const changes={state,verification};if(sale)changes.sale={...sale,royaltyExpectedWei:row.review.payments.find(p=>p.role==='royalty')?.amountWei||'0'};
    const updated=await store.updateListing(req.actor,row.id,row.revision,changes,'verified',{state,problems:check.problems});
    if(updated.replaces&&['listed','indexing_pending'].includes(state)){
      const old=await store.getListing(req.actor,updated.replaces).catch(()=>null);
      if(old&&old.state==='cancelled')await store.updateListing(req.actor,old.id,old.revision,{state:'replaced'},'replaced',{by:updated.id}).catch(()=>{});
    }
    res.json(updated);
  }));
  app.post('/api/market/listings/:id/cancel',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,[]);const row=await store.getListing(req.actor,req.params.id);if(!row.signature||TERMINAL.has(row.state)||['cancelled','expired'].includes(row.state))fail('LISTING_NOT_CANCELLABLE');
    sellerMust(req.actor,row.seller);
    res.json(await store.createAction(req.actor,'cancel',{collection:row.collection,listingId:row.id,orderHash:row.orderHash,purpose:'Cancel this signed order on Seaport so it can never be filled.'},cancelTransaction(market,row.order)));
  }));

  const COLLECTION_ABI=['function name() view returns (string)','function symbol() view returns (string)','function SERIES_SIZE() view returns (uint256)','function totalMinted() view returns (uint256)',
    'function mintingClosed() view returns (bool)','function owner() view returns (address)','function MINTER() view returns (address)','function ROYALTY_RECIPIENT() view returns (address)',
    'function CREATOR_ROYALTY_BPS() view returns (uint96)','function getTransferValidator() view returns (address)','function ownerOf(uint256) view returns (address)','function tokenURI(uint256) view returns (string)',
    'function workTitle(uint256) view returns (string)','function mediaSHA256(uint256) view returns (bytes32)','function rightsURI(uint256) view returns (string)','function rightsSHA256(uint256) view returns (bytes32)'];
  /** Live inventory read straight from the collection contract (immutable settings + every minted token). */
  app.get('/api/collections/:address',requireAction('read'),wrap(async(req,res)=>{
    const collection=address(req.params.address),code=await provider.getCode(collection);if(code==='0x')fail('COLLECTION_NOT_DEPLOYED',404);
    const c=new Contract(collection,COLLECTION_ABI,provider);
    let info;try{const [name,symbol,size,minted,closed,owner,minter,royaltyRecipient,bps,validator]=await Promise.all([c.name(),c.symbol(),c.SERIES_SIZE(),c.totalMinted(),c.mintingClosed(),c.owner(),c.MINTER(),c.ROYALTY_RECIPIENT(),c.CREATOR_ROYALTY_BPS(),c.getTransferValidator()]);
      info={collection,chainId:market.chainId,name,symbol,seriesSize:size.toString(),totalMinted:minted.toString(),mintingClosed:closed,owner,minter,royaltyRecipient,royaltyBps:Number(bps),validator};}
    catch{fail('NOT_AN_NFT_CONSOLE_COLLECTION',409);}
    const page=Math.max(0,Number.parseInt(String(req.query.page||'0'),10)||0),size=BigInt(info.seriesSize),start=BigInt(page*100)+1n,end=size<start+99n?size:start+99n,tokens=[];
    for(let id=start;id<=end&&tokens.length<Number(info.totalMinted);id+=20n){
      const ids=[];for(let j=id;j<=end&&j<id+20n;j++)ids.push(j);
      const rows=await Promise.all(ids.map(async t=>{try{const [holder,uri,title,media,rights,rightsHash]=await Promise.all([c.ownerOf(t),c.tokenURI(t),c.workTitle(t),c.mediaSHA256(t),c.rightsURI(t),c.rightsSHA256(t)]);
        return {tokenId:t.toString(),owner:holder,metadataURI:uri,title,mediaSHA256:media,rightsURI:rights,rightsSHA256:rightsHash};}catch{return null;}}));
      tokens.push(...rows.filter(Boolean));
    }
    res.json({...info,remainingSupply:(size-BigInt(info.totalMinted)).toString(),page,tokens,readAt:new Date().toISOString(),block:await provider.getBlockNumber()});
  }));
  async function policyState(actor,collection){
    const m=requireMarket();if(!m.validator)fail('VALIDATOR_NOT_CONFIGURED');
    const infra=await verifyMarketInfrastructure(provider,m),operators=[infra.conduit],authorizers=m.signedZone?[m.signedZone]:[];
    const actions=await store.listActions(actor,{kind:'policy',collection});
    const created=actions.find(a=>a.state==='verified'&&a.result?.listId);
    const state=await inspectPolicy(provider,{collection,validator:m.validator,operators,authorizers,candidateListId:created?.result?.listId??null});
    return {state,steps:planPolicySteps(state,{operators,authorizers,label:'NFT Console marketplace list'}),actions,operators,authorizers};
  }
  app.post('/api/policy/inspect',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['collection']);const {state,steps,actions,operators,authorizers}=await policyState(req.actor,address(req.body.collection));
    res.json({state,steps:steps.map(({id,summary,to,from})=>({id,summary,to,from})),pendingActions:actions.filter(a=>['prepared','submitted','attention'].includes(a.state)),operators,authorizers,
      explanation:{allows:['Direct wallet-to-wallet transfers by the token holder (EOA, Safe and EIP-7702 wallets: options 6).','Transfers by the whitelisted marketplace conduit when a signed Seaport order is filled.'],
        blocks:['Transfers executed by any other operator contract, even if the holder approved it.'],
        ownerPowers:['The collection OWNER can later change the validator, list or ruleset, which can block or allow future transfers. This disclosed power cannot move tokens.'],
        neverGranted:['The validator never receives operator approval over holders’ tokens.']}});
  }));
  app.post('/api/policy/step',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['collection','step']);const collection=address(req.body.collection);const {state,steps}=await policyState(req.actor,collection);
    sellerMust(req.actor,state.owner);const step=steps[0];if(!step)fail('POLICY_ALREADY_CONFIGURED');if(step.id!==req.body.step)fail('POLICY_STEP_STALE');
    res.json(await store.createAction(req.actor,'policy',{collection,step:step.id,purpose:step.summary},{to:step.to,from:step.from,data:step.data,value:'0x0'}));
  }));
  app.get('/api/actions',requireAction('deploy'),wrap(async(req,res)=>{
    const kind=req.query.kind===undefined?null:String(req.query.kind);if(kind&&!['policy','approval','cancel'].includes(kind))fail('INVALID_INPUT',400);
    res.json({items:await store.listActions(req.actor,{kind,collection:req.query.collection===undefined?null:address(String(req.query.collection))})});
  }));
  app.post('/api/actions/:id/rejected',requireAction('deploy'),wrap(async(req,res)=>{exact(req.body,[]);res.json(await store.updateAction(req.actor,req.params.id,['prepared'],{state:'wallet_rejected'},'wallet-rejected'));}));
  app.post('/api/actions/:id/submitted',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,['transactionHash']);if(typeof req.body.transactionHash!=='string'||!HASH.test(req.body.transactionHash))fail('INVALID_HASH',400);
    const a=await store.getAction(req.actor,req.params.id),hash=req.body.transactionHash.toLowerCase();
    const tx=await provider.getTransaction(hash);
    if(tx&&(getAddress(tx.from)!==getAddress(a.tx.from)||getAddress(tx.to)!==getAddress(a.tx.to)||tx.data.toLowerCase()!==a.tx.data.toLowerCase()||tx.value!==0n))fail('TRANSACTION_MISMATCH');
    res.json(await store.updateAction(req.actor,a.id,['prepared','wallet_rejected'],{state:'submitted',tx_hash:hash},'submitted'));
  }));
  app.post('/api/actions/:id/reconcile',requireAction('deploy'),wrap(async(req,res)=>{
    exact(req.body,[]);const a=await store.getAction(req.actor,req.params.id);if(!a.txHash)fail('TRANSACTION_REQUIRED');if(['verified','failed'].includes(a.state))return res.json(a);
    const [tx,receipt]=await Promise.all([provider.getTransaction(a.txHash),provider.getTransactionReceipt(a.txHash)]);
    if(!tx||!receipt)return res.json({...a,pending:true});
    if(getAddress(tx.from)!==getAddress(a.tx.from)||getAddress(tx.to)!==getAddress(a.tx.to)||tx.data.toLowerCase()!==a.tx.data.toLowerCase())return res.json(await store.updateAction(req.actor,a.id,['submitted','attention'],{state:'attention',result:{code:'TRANSACTION_MISMATCH'}},'attention'));
    const confirmations=await receipt.confirmations();
    if(receipt.status!==1)return res.json(await store.updateAction(req.actor,a.id,['submitted','attention'],{state:'failed',result:{code:'TRANSACTION_REVERTED',block:receipt.blockNumber}},'failed'));
    if(confirmations<(market.chainId===31337?1:2))return res.json({...a,pending:true,confirmations});
    const result={block:receipt.blockNumber,blockHash:receipt.blockHash,confirmations};
    if(a.kind==='policy'&&a.subject.step==='create-list')result.listId=createdListId(receipt,market.validator);
    res.json(await store.updateAction(req.actor,a.id,['submitted','attention'],{state:'verified',result},'verified'));
  }));
}
const messages={
  APPROVAL_REQUIRED:'Approve the marketplace conduit for this collection before listing.',
  SIGNED_IN_WALLET_NOT_OWNER:'The signed-in wallet does not own this token (or is not the collection OWNER). Switch to the owning wallet.',
  POLICY_BLOCKS_MARKETPLACE:'The collection’s transfer policy blocks the marketplace conduit. Configure the transfer policy first.',
  POLICY_UNVERIFIED:'The transfer policy could not be verified; listing is blocked until it can be read.',
  MARKETPLACE_NOT_CONFIGURED:'No marketplace API is configured for this network (an OpenSea API key is required). Orders cannot be submitted.',
  MARKETPLACE_FEES_UNKNOWN:'The marketplace’s required fees could not be read, so proceeds cannot be calculated. Try again later.',
  REVIEW_STALE:'Fees or royalty changed since your review. Review the updated payment split.',
  MARKET_NOT_CONFIGURED:'Seaport marketplace contracts are not configured for this network.',
  LISTING_CHANGED:'This listing changed in another tab or request. Reload it.',
  ACTION_UNRESOLVED:'A previous wallet transaction for this item is still unresolved. Check it before starting another.',
  POLICY_STEP_STALE:'The on-chain policy changed; review the next step again.',
  TRANSACTION_MISMATCH:'The wallet transaction does not match the reviewed action. It was not accepted.',
};
