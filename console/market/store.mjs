import {randomUUID} from 'node:crypto';
import {MarketError} from './config.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id=v=>{if(typeof v!=='string'||!UUID.test(v))throw new MarketError('INVALID_ID',400);return v;};
const LISTING_COLUMNS=new Set(['state','signature','submission','verification','sale']);
const ACTION_COLUMNS=new Set(['state','tx_hash','result']);
const listing=r=>({id:r.id,chainId:Number(r.chain_id),collection:r.collection,tokenId:r.token_id,seller:r.seller,orderHash:r.order_hash,state:r.state,revision:r.revision,marketplace:r.marketplace,
  order:r.order_json,review:r.review,signed:Boolean(r.signature),signature:r.signature,submission:r.submission,verification:r.verification,sale:r.sale,preparedBlock:Number(r.prepared_block),replaces:r.replaces,createdAt:r.created_at,updatedAt:r.updated_at});
const action=r=>({id:r.id,chainId:Number(r.chain_id),kind:r.kind,subject:r.subject,tx:r.tx,state:r.state,txHash:r.tx_hash,result:r.result,createdAt:r.created_at,updatedAt:r.updated_at});
function assignments(changes,allowed,offset){
  const cols=Object.keys(changes);if(!cols.length||cols.some(k=>!allowed.has(k)))throw new MarketError('INVALID_UPDATE',500);
  return {sql:cols.map((k,i)=>`${k}=$${i+offset}`).join(','),values:Object.values(changes)};
}
/** Owner-scoped, row-level-secured persistence for listings and wallet actions with an append-only event log. */
export class MarketStore {
  constructor(repository){this.repository=repository;}
  tx(actor,fn){if(actor.role!=='owner')throw new MarketError('OWNER_REQUIRED',403);return this.repository.transaction(actor,null,fn);}
  async event(client,account,actor,subject,event,detail){await client.query('INSERT INTO nft_console.market_events(account_id,chain_id,subject,event,detail) VALUES($1,$2,$3,$4,$5)',[account,actor.chainId,subject,event,detail]);}
  async createListing(actor,v){return this.tx(actor,async(c,a)=>{
    const n=await c.query('SELECT count(*)::int n FROM nft_console.market_listings WHERE account_id=$1',[a]);if(n.rows[0].n>=5000)throw new MarketError('LISTING_CAPACITY');
    const lid=randomUUID();
    const r=await c.query(`INSERT INTO nft_console.market_listings(account_id,id,chain_id,collection,token_id,seller,order_hash,state,marketplace,order_json,review,prepared_block,replaces)
      VALUES($1,$2,$3,$4,$5,$6,$7,'prepared',$8,$9,$10,$11,$12) RETURNING *`,[a,lid,actor.chainId,v.collection,v.tokenId,v.seller,v.order.orderHash.toLowerCase(),v.marketplace,v.order,v.review,v.preparedBlock,v.replaces||null]);
    await this.event(c,a,actor,lid,'prepared',{orderHash:v.order.orderHash,priceWei:v.review.priceWei});return listing(r.rows[0]);
  });}
  async getListing(actor,lid){id(lid);return this.tx(actor,async c=>{const r=await c.query('SELECT * FROM nft_console.market_listings WHERE id=$1',[lid]);if(!r.rows[0])throw new MarketError('NOT_FOUND',404);return listing(r.rows[0]);});}
  async listListings(actor,{collection}={}){return this.tx(actor,async c=>{
    const r=await c.query('SELECT * FROM nft_console.market_listings WHERE ($1::text IS NULL OR lower(collection)=lower($1)) ORDER BY created_at DESC LIMIT 200',[collection||null]);return r.rows.map(listing);});}
  /** Compare-and-swap transition; a concurrent change fails instead of overwriting evidence. */
  async updateListing(actor,lid,revision,changes,event,detail={}){id(lid);const set=assignments(changes,LISTING_COLUMNS,4);return this.tx(actor,async(c,a)=>{
    const r=await c.query(`UPDATE nft_console.market_listings SET ${set.sql},revision=revision+1,updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2 AND revision=$3 RETURNING *`,[a,lid,revision,...set.values]);
    if(!r.rows[0])throw new MarketError('LISTING_CHANGED');await this.event(c,a,actor,lid,event,detail);return listing(r.rows[0]);
  });}
  async events(actor,subject){id(subject);return this.tx(actor,async c=>(await c.query('SELECT event,detail,occurred_at FROM nft_console.market_events WHERE subject=$1 ORDER BY id LIMIT 500',[subject])).rows);}
  async createAction(actor,kind,subject,tx){return this.tx(actor,async(c,a)=>{
    const open=await c.query("SELECT state FROM nft_console.wallet_actions WHERE account_id=$1 AND state IN('submitted','attention') AND subject=$2::jsonb AND kind=$3 LIMIT 1",[a,subject,kind]);
    if(open.rows[0])throw new MarketError('ACTION_UNRESOLVED');
    const aid=randomUUID();const r=await c.query("INSERT INTO nft_console.wallet_actions(account_id,id,chain_id,kind,subject,tx,state) VALUES($1,$2,$3,$4,$5,$6,'prepared') RETURNING *",[a,aid,actor.chainId,kind,subject,tx]);
    await this.event(c,a,actor,aid,'action-prepared',{kind,subject,to:tx.to});return action(r.rows[0]);
  });}
  async getAction(actor,aid){id(aid);return this.tx(actor,async c=>{const r=await c.query('SELECT * FROM nft_console.wallet_actions WHERE id=$1',[aid]);if(!r.rows[0])throw new MarketError('NOT_FOUND',404);return action(r.rows[0]);});}
  async listActions(actor,{kind,collection}={}){return this.tx(actor,async c=>(await c.query("SELECT * FROM nft_console.wallet_actions WHERE ($1::text IS NULL OR kind=$1) AND ($2::text IS NULL OR lower(subject->>'collection')=lower($2)) ORDER BY created_at DESC LIMIT 200",[kind||null,collection||null])).rows.map(action));}
  async updateAction(actor,aid,from,changes,event){id(aid);const set=assignments(changes,ACTION_COLUMNS,4);return this.tx(actor,async(c,a)=>{
    const r=await c.query(`UPDATE nft_console.wallet_actions SET ${set.sql},updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2 AND state=ANY($3) RETURNING *`,[a,aid,from,...set.values]);
    if(!r.rows[0])throw new MarketError('ACTION_CHANGED');await this.event(c,a,actor,aid,event,changes);return action(r.rows[0]);
  });}
  async checkSchema(){
    const client=await this.repository.pool.connect();
    try{await client.query('BEGIN');await client.query('SET LOCAL ROLE nft_console_api');
      for(const t of ['market_listings','wallet_actions','private_records','private_devices','private_blob_chunks'])await client.query(`SELECT 1 FROM nft_console.${t} LIMIT 0`);
    }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  }
}
