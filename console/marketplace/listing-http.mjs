import {ListingError} from './listing.mjs';

const MESSAGES=Object.freeze({
  NOT_TOKEN_OWNER:'Your signed-in wallet does not own this token on-chain.',
  POLICY_BLOCKS_MARKETPLACE:"The collection's transfer validator rejects the marketplace operator. Configure the transfer policy first.",
  POLICY_UNVERIFIED:'The transfer policy could not be read. Nothing was prepared.',
  ACTIVE_LISTING_EXISTS:'This token already has a signed order. Cancel it before listing again.',
  WRONG_SIGNATURE:'The signature was not made by the seller wallet for this exact order.',
  BAD_SIGNATURE:'The signature is malformed.',
  SEAPORT_UNVERIFIED:'The configured Seaport contract failed on-chain verification.',
  CONDUIT_UNAVAILABLE:'The marketplace conduit is not deployed on this network.',
  TOKEN_NOT_MINTED:'That token does not exist on this collection.',
  NOT_ERC721:'That address is not an ERC-721 collection.',
  COLLECTION_NOT_DEPLOYED:'No contract is deployed at that collection address.',
  MARKETPLACE_NOT_CONFIGURED:'Marketplace listing is not configured on this server (RPC and Seaport are required).',
  OPENSEA_NOT_CONFIGURED:'OPENSEA_API_KEY is not configured on the server.',
  OPENSEA_COLLECTION_UNKNOWN:'OpenSea has not indexed this token yet. Try again after OpenSea picks up the mint.',
  FEES_EXCEED_PRICE:'Fees and royalty would consume the whole price.',
  EXPIRATION:'Choose a duration between 1 and 180 days.',
  PRICE:'Enter a price greater than zero.',
});
export function installMarketplaceRoutes(app,requireAction,service){
  const wrap=fn=>async(req,res)=>{
    try{res.json(await fn(req));}
    catch(error){
      if(error instanceof ListingError){
        const status=error.status||(/^(PRICE|EXPIRATION|ADDRESS|COLLECTION|TOKEN_ID|UINT|SELLER)$/.test(error.code)?400:409);
        return res.status(status).json({code:error.code,error:MESSAGES[error.code]||'The listing check failed: '+error.code,detail:error.detail??null});
      }
      if(error?.status&&error?.code)return res.status(error.status).json({code:error.code,error:error.message});
      console.error(JSON.stringify({event:'marketplace_error',message:String(error?.message||error).slice(0,300)}));
      res.status(503).json({code:'MARKETPLACE_UNAVAILABLE',error:'The marketplace check could not be completed. Nothing was signed or submitted.'});
    }
  };
  app.get('/api/marketplace',requireAction('read'),(_req,res)=>res.json(service.describe()));
  app.get('/api/marketplace/listings',requireAction('list'),wrap(req=>service.list(req.actor)));
  app.get('/api/marketplace/listings/:id',requireAction('list'),wrap(req=>service.get(req.actor,req.params.id)));
  app.post('/api/marketplace/inspect',requireAction('list'),wrap(req=>service.inspect(req.actor,{collection:req.body?.collection,tokenId:String(req.body?.tokenId??''),priceWei:req.body?.priceWei||undefined})));
  app.post('/api/marketplace/listings',requireAction('list'),wrap(req=>service.prepare(req.actor,{collection:req.body?.collection,tokenId:String(req.body?.tokenId??''),priceWei:String(req.body?.priceWei??''),durationDays:req.body?.durationDays})));
  app.post('/api/marketplace/listings/:id/signature',requireAction('list'),wrap(req=>service.sign(req.actor,req.params.id,req.body?.signature)));
  app.post('/api/marketplace/listings/:id/submit',requireAction('list'),wrap(req=>service.submit(req.actor,req.params.id)));
  app.post('/api/marketplace/listings/:id/verify',requireAction('list'),wrap(req=>service.verify(req.actor,req.params.id)));
  app.post('/api/marketplace/listings/:id/cancel',requireAction('list'),wrap(req=>service.cancelPlan(req.actor,req.params.id)));
  app.post('/api/marketplace/listings/:id/cancel-transaction',requireAction('list'),wrap(req=>service.recordCancel(req.actor,req.params.id,req.body?.hash)));
}
