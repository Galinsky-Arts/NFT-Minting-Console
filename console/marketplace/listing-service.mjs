import {randomUUID} from 'node:crypto';
import {getAddress,Contract,ZeroAddress} from 'ethers';
import {ListingError,marketplaceProfile,inspectMarketplace,inspectToken,splitPayments,composeOrder,checkComponents,
  onChainOrderHash,verifyOrderSignature,observeOrder,findSettlement,approvalTransaction,cancelTransaction,priceOf,SEAPORT_ABI} from './listing.mjs';
import {openSeaListingTerms,submitToOpenSea,observeOpenSea} from './opensea.mjs';

/**
 * Listing state machine. A row only reaches 'listed' when the chain shows a valid, fillable-by-policy
 * order AND OpenSea returns this exact order as ACTIVE. Without a marketplace index (Sepolia, local),
 * the best reachable state is 'valid_unindexed' and the UI never calls that an OpenSea listing.
 */
const LIVE=['signed','submission_uncertain','verifying','listed','valid_unindexed','cancel_pending'];
const FINAL=['sold','cancelled','superseded'];
const fail=(code,status=409,detail)=>{const e=new ListingError(code,detail);e.status=status;throw e;};
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TX=/^0x[0-9a-fA-F]{64}$/;

export function listingView(row){
  if(!row)return null;
  return {id:row.id,chainId:Number(row.chain_id),seaport:row.seaport,collection:row.collection,tokenId:String(row.token_id),seller:row.seller,
    orderHash:row.order_hash,state:row.state,review:row.review,signed:Boolean(row.signature),
    order:row.signature?{components:row.components,signature:row.signature}:null,submission:row.submission,
    observation:row.observation,settlement:row.settlement,cancelTx:row.cancel_tx,createdAt:row.created_at,updatedAt:row.updated_at};
}

export async function checkMarketplaceSchema(repository){
  const client=await repository.pool.connect();let broken;
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE nft_console_api');
    await client.query('SELECT order_hash,components,review,signature,state,submission,observation,settlement,cancel_tx FROM nft_console.marketplace_listings LIMIT 0');
    await client.query('SELECT root_public_key,epoch FROM nft_console.workspace_accounts LIMIT 0');await client.query('SELECT sealed FROM nft_console.workspace_drafts LIMIT 0');await client.query('SELECT body FROM nft_console.workspace_chunks LIMIT 0');await client.query('ROLLBACK');}
  catch(error){try{await client.query('ROLLBACK');}catch(cause){broken=cause;}throw error;}
  finally{client.release(broken);}
}

export class ListingService {
  constructor({repository,provider,chainId,profile,env={},opensea=null}){
    this.repository=repository;this.provider=provider;this.chainId=chainId;this.env=env;this.opensea=opensea;
    try{this.market=profile?.marketplace?marketplaceProfile(profile,chainId,env):null;}catch{this.market=null;}
  }
  get configured(){return Boolean(this.provider&&this.market);}
  get marketplaceIndexed(){return this.market?.api==='opensea'&&Boolean(this.opensea);}
  describe(){
    if(!this.market)return {configured:false};
    return {configured:this.configured,name:this.market.name,chainId:this.chainId,seaport:this.market.seaport,
      marketplace:this.market.api==='opensea'?'opensea':null,openSeaConfigured:Boolean(this.opensea),
      note:this.market.api==='opensea'?(this.opensea?'Listings are submitted to OpenSea and verified against both OpenSea and the chain.':'OPENSEA_API_KEY is not configured: orders cannot be submitted or verified as OpenSea listings.')
        :'OpenSea does not index this network. Orders are verified on-chain only and are never shown as OpenSea listings.'};
  }
  #require(){if(!this.configured)fail('MARKETPLACE_NOT_CONFIGURED',503);if(this.market.api==='opensea'&&!this.opensea)fail('OPENSEA_NOT_CONFIGURED',503);}
  #tx(actor,fn){if(actor.role!=='owner')fail('OWNER_REQUIRED',403);return this.repository.transaction(actor,null,fn);}
  async #row(client,account,id){
    if(typeof id!=='string'||!ID.test(id))fail('LISTING_NOT_FOUND',404);
    const r=await client.query('SELECT * FROM nft_console.marketplace_listings WHERE account_id=$1 AND id=$2',[account,id]);
    if(!r.rows[0])fail('LISTING_NOT_FOUND',404);return r.rows[0];
  }
  async #update(id,actor,fields){
    const keys=Object.keys(fields);
    return this.#tx(actor,async(client,account)=>{
      const sets=keys.map((k,i)=>`${k}=$${i+3}`).join(',');
      const r=await client.query(`UPDATE nft_console.marketplace_listings SET ${sets},updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2 RETURNING *`,[account,id,...keys.map(k=>fields[k])]);
      return listingView(r.rows[0]);
    });
  }

  async list(actor){
    return this.#tx(actor,async(client,account)=>{
      const r=await client.query('SELECT * FROM nft_console.marketplace_listings WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200',[account]);
      return r.rows.map(listingView);
    });
  }
  async get(actor,id){return this.#tx(actor,async(c,a)=>listingView(await this.#row(c,a,id)));}

  /** Pre-listing check of one token for the signed-in wallet. Read-only. */
  async inspect(actor,{collection,tokenId,priceWei='1000000000000000000'}){
    this.#require();
    const market=await inspectMarketplace(this.provider,this.market);
    const token=await inspectToken(this.provider,{collection,tokenId,seller:actor.wallet,operator:market.operator,priceWei,zone:market.zone});
    return {market:{name:market.name,seaport:market.seaport,operator:market.operator},token};
  }

  async prepare(actor,{collection,tokenId,priceWei,durationDays}){
    this.#require();
    const days=Number(durationDays);if(!Number.isInteger(days)||days<1||days>180)fail('EXPIRATION',400);
    const seller=getAddress(actor.wallet);
    let market=await inspectMarketplace(this.provider,this.market);
    let token=await inspectToken(this.provider,{collection,tokenId,seller,operator:market.operator,priceWei,zone:market.zone});
    if(!token.sellerOwns)fail('NOT_TOKEN_OWNER',409,{owner:token.owner});
    if(token.policy.status==='blocked')fail('POLICY_BLOCKS_MARKETPLACE',409,token.policy);
    if(token.policy.status==='unknown')fail('POLICY_UNVERIFIED',503,token.policy);
    const warnings=[];
    if(token.policy.status==='no-validator')warnings.push('This collection has no transfer validator: no on-chain transfer policy applies.');
    let fees=[],royalty=token.royalty,openseaSlug=null;
    if(this.market.api==='opensea'){
      const terms=await openSeaListingTerms(this.opensea,{collection:token.collection,tokenId:token.tokenId,royalty});
      if(terms.requiredZone&&terms.requiredZone!==market.zone)market=await inspectMarketplace(this.provider,this.market,{zone:terms.requiredZone});
      if(market.zone!==ZeroAddress){token=await inspectToken(this.provider,{collection,tokenId,seller,operator:market.operator,priceWei,zone:market.zone});
        if(token.policy.status==='blocked')fail('POLICY_BLOCKS_MARKETPLACE',409,token.policy);}
      fees=terms.fees;openseaSlug=terms.slug;
      if(terms.creatorFeeBps>0&&royalty){
        const required=BigInt(priceWei)*BigInt(terms.creatorFeeBps)/10000n;
        if(required>BigInt(royalty.amountWei)){royalty={...royalty,amountWei:required.toString()};warnings.push('OpenSea requires a creator fee above the ERC-2981 rate; the higher amount is used.');}
      }
    }else if(this.env.MARKETPLACE_FEE_RECIPIENT&&this.env.MARKETPLACE_FEE_BPS){
      fees=[{recipient:this.env.MARKETPLACE_FEE_RECIPIENT,bps:Number(this.env.MARKETPLACE_FEE_BPS),label:'Marketplace fee',required:true}];
    }
    if(!royalty)warnings.push('The collection reports no ERC-2981 royalty for this token; no creator royalty is included.');
    const payments=splitPayments({priceWei,seller,fees,royalty});
    const block=await this.provider.getBlock('latest');
    const counter=await new Contract(market.seaport,SEAPORT_ABI,this.provider).getCounter(seller);
    const start=BigInt(block.timestamp)-60n;
    const plan=composeOrder({market,seller,collection:token.collection,tokenId:token.tokenId,payments,counter:counter.toString(),startTime:start.toString(),endTime:(start+BigInt(days)*86400n+60n).toString()});
    if(await onChainOrderHash(this.provider,market,plan.components)!==plan.orderHash)fail('ORDER_HASH_MISMATCH',503);
    const review={marketplace:market.name,indexed:this.market.api==='opensea',seller,collection:token.collection,tokenId:token.tokenId,
      priceWei:priceOf(plan.components).toString(),payments,startTime:plan.components.startTime,endTime:plan.components.endTime,
      operator:market.operator,zone:market.zone,conduitKey:market.conduitKey,policy:token.policy,approvalRequired:!token.approved,
      openseaSlug,warnings,preparedBlock:block.number,
      royaltyDisclosure:'ERC-2981 reports royalty information. This order pays the listed creator royalty only if it is filled through Seaport; direct wallet transfers and other paths may pay none.'};
    const id=randomUUID();
    const row=await this.#tx(actor,async(client,account)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,771301))',[account+':'+token.collection+':'+token.tokenId]);
      const live=await client.query('SELECT id,state FROM nft_console.marketplace_listings WHERE account_id=$1 AND chain_id=$2 AND collection=$3 AND token_id=$4 AND state = ANY($5)',
        [account,this.chainId,token.collection.toLowerCase(),token.tokenId,LIVE]);
      if(live.rows.length)fail('ACTIVE_LISTING_EXISTS',409,{listingId:live.rows[0].id,state:live.rows[0].state});
      await client.query("UPDATE nft_console.marketplace_listings SET state='superseded',updated_at=clock_timestamp() WHERE account_id=$1 AND chain_id=$2 AND collection=$3 AND token_id=$4 AND state='prepared'",[account,this.chainId,token.collection.toLowerCase(),token.tokenId]);
      const r=await client.query('INSERT INTO nft_console.marketplace_listings(account_id,id,chain_id,seaport,collection,token_id,seller,order_hash,components,review) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [account,id,this.chainId,market.seaport.toLowerCase(),token.collection.toLowerCase(),token.tokenId,seller.toLowerCase(),plan.orderHash,plan.components,review]);
      return r.rows[0];
    });
    const sellerIsContract=(await this.provider.getCode(seller))!=='0x';
    return {listing:listingView(row),sellerIsContract,typedData:{domain:plan.domain,types:plan.types,primaryType:'OrderComponents',message:plan.components},
      approvalTransaction:token.approved?null:approvalTransaction(token.collection,market.operator)};
  }

  /** Rebuilds the stored order from scratch and proves it is unchanged before any further use. */
  async #plan(row){
    const market=await inspectMarketplace(this.provider,this.market,{zone:row.components.zone});
    if(market.seaport.toLowerCase()!==row.seaport)fail('SEAPORT_CHANGED',409);
    const plan=checkComponents(market,row.components,{seller:row.seller,collection:row.collection,tokenId:String(row.token_id)});
    if(plan.orderHash!==row.order_hash)fail('ORDER_CHANGED',409);
    return {market,plan};
  }

  async sign(actor,id,signature){
    this.#require();
    const row=await this.#tx(actor,(c,a)=>this.#row(c,a,id));
    if(row.state!=='prepared')fail('NOT_AWAITING_SIGNATURE');
    if(getAddress(row.seller)!==getAddress(actor.wallet))fail('SELLER_MISMATCH',403);
    const {plan}=await this.#plan(row);
    if(await onChainOrderHash(this.provider,this.market,plan.components)!==row.order_hash)fail('ORDER_HASH_MISMATCH',503);
    const verified=await verifyOrderSignature(this.provider,plan,signature);
    await this.#update(id,actor,{signature:verified.signature,state:'signed'});
    return this.submit(actor,id);
  }

  /** Submits only after the chain shows the order is currently valid. Never creates a different order. */
  async submit(actor,id){
    this.#require();
    const row=await this.#tx(actor,(c,a)=>this.#row(c,a,id));
    if(!['signed','submission_uncertain','inactive'].includes(row.state)||!row.signature)fail('NOT_SUBMITTABLE');
    const {market,plan}=await this.#plan(row);
    const seen=await observeOrder(this.provider,market,{components:plan.components,signature:row.signature,orderHash:row.order_hash});
    if(seen.state!=='valid')return this.#update(id,actor,{state:seen.state==='sold'?'verifying':seen.state,observation:{chain:seen.facts,chainState:seen.state,checkedAt:new Date().toISOString()}});
    if(!this.marketplaceIndexed)return this.verify(actor,id);
    const outcome=await submitToOpenSea(this.opensea,market,{components:plan.components,signature:row.signature,review:row.review});
    if(outcome.outcome==='accepted'&&outcome.orderHash!==row.order_hash)fail('MARKETPLACE_HASH_MISMATCH',502);
    const state=outcome.outcome==='accepted'?'verifying':outcome.outcome==='uncertain'?'submission_uncertain':'rejected';
    await this.#update(id,actor,{state,submission:{...outcome,at:new Date().toISOString(),attempts:(row.submission?.attempts||0)+1}});
    return state==='verifying'?this.verify(actor,id):this.get(actor,id);
  }

  /**
   * Independent verification and recovery. Safe to call repeatedly. An uncertain submission is resolved by
   * looking up the deterministic order hash; only the identical signed order is ever re-posted.
   */
  async verify(actor,id){
    this.#require();
    const row=await this.#tx(actor,(c,a)=>this.#row(c,a,id));
    if(FINAL.includes(row.state))return listingView(row);
    if(!row.signature)return listingView(row);
    const {market,plan}=await this.#plan(row);
    const seen=await observeOrder(this.provider,market,{components:plan.components,signature:row.signature,orderHash:row.order_hash});
    const observation={chain:seen.facts,chainState:seen.state,checkedAt:new Date().toISOString()};
    let state;let settlement=null;
    if(seen.state==='sold'){
      settlement=await findSettlement(this.provider,market,{orderHash:row.order_hash,components:plan.components,fromBlock:Number(row.review.preparedBlock)||0,
        royaltyRecipient:row.review.payments.find(p=>p.role==='creator-royalty')?.recipient});
      state=settlement?'sold':'verifying';
      if(settlement)settlement={...settlement,expectedRoyaltyWei:row.review.payments.find(p=>p.role==='creator-royalty')?.amountWei||'0'};
    }else if(seen.state==='cancelled')state='cancelled';
    else if(seen.state==='expired')state='expired';
    else if(seen.state==='inactive')state=row.cancel_tx&&row.state==='cancel_pending'?'cancel_pending':'inactive';
    else if(!this.marketplaceIndexed){
      state=seen.facts.fill.status==='fillable'?'valid_unindexed':'verifying';
    }else{
      if(row.state==='cancel_pending')state='cancel_pending';
      else{
        const os=await observeOpenSea(this.opensea,market,{orderHash:row.order_hash,components:plan.components});
        observation.marketplace=os;
        if(os.status==='ACTIVE'&&os.matches)state='listed';
        else if(os.status==='absent'&&row.state==='submission_uncertain'){
          const outcome=await submitToOpenSea(this.opensea,market,{components:plan.components,signature:row.signature,review:row.review});
          observation.resubmission={...outcome,note:'Identical signed order re-posted after confirming OpenSea had no record of its hash.'};
          state=outcome.outcome==='rejected'?'rejected':outcome.outcome==='uncertain'?'submission_uncertain':'verifying';
          if(outcome.outcome==='accepted'){
            const after=await observeOpenSea(this.opensea,market,{orderHash:row.order_hash,components:plan.components});
            observation.marketplace=after;if(after.status==='ACTIVE'&&after.matches)state='listed';
          }
        }else if(os.status==='absent'||os.status==='unavailable')state=row.state==='submission_uncertain'?'submission_uncertain':'verifying';
        else if(os.status==='ACTIVE'&&!os.matches)state='inactive';
        else state='inactive';
      }
    }
    const fields={state,observation};if(settlement)fields.settlement=settlement;
    return this.#update(id,actor,fields);
  }

  async cancelPlan(actor,id){
    this.#require();
    const row=await this.#tx(actor,(c,a)=>this.#row(c,a,id));
    if(FINAL.includes(row.state))fail('LISTING_FINAL');
    if(row.state==='prepared'){await this.#update(id,actor,{state:'superseded'});return {transaction:null,note:'The unsigned order was discarded. Nothing was signed, so nothing needs cancelling on-chain.'};}
    const {market,plan}=await this.#plan(row);
    return {transaction:cancelTransaction(market,plan.components),
      note:'This Seaport cancel transaction makes the signed order permanently unfillable on every marketplace. It costs network gas.'};
  }
  async recordCancel(actor,id,hash){
    if(typeof hash!=='string'||!TX.test(hash))fail('BAD_TRANSACTION_HASH',400);
    const row=await this.#tx(actor,(c,a)=>this.#row(c,a,id));
    if(FINAL.includes(row.state))fail('LISTING_FINAL');
    const tx=await this.provider.getTransaction(hash);
    if(tx){
      const {market,plan}=await this.#plan(row);
      const expected=cancelTransaction(market,plan.components);
      const direct=getAddress(tx.from)===getAddress(row.seller)&&tx.to&&getAddress(tx.to)===getAddress(market.seaport)&&tx.data.toLowerCase()===expected.data.toLowerCase();
      // A Safe seller executes through its own contract: the outer call targets the Safe and must embed the exact cancel calldata.
      const viaSafe=tx.to&&getAddress(tx.to)===getAddress(row.seller)&&tx.data.toLowerCase().includes(expected.data.slice(2).toLowerCase());
      if(!direct&&!viaSafe)fail('NOT_THE_CANCEL_TRANSACTION',409);
    }
    await this.#update(id,actor,{cancel_tx:hash.toLowerCase(),state:'cancel_pending'});
    return this.verify(actor,id);
  }
}
