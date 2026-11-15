import {Contract,getAddress,isAddress} from 'ethers';

/** Ported from the closed PR #62: a live, read-only view of a deployed NFT Console collection.
 * Every value is read from the chain at one block; nothing is cached, guessed or written. */
export class InventoryError extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}
const ABI=['function name() view returns (string)','function symbol() view returns (string)','function SERIES_SIZE() view returns (uint256)','function totalMinted() view returns (uint256)',
  'function mintingClosed() view returns (bool)','function owner() view returns (address)','function MINTER() view returns (address)','function ROYALTY_RECIPIENT() view returns (address)',
  'function CREATOR_ROYALTY_BPS() view returns (uint96)','function getTransferValidator() view returns (address)','function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)','function workTitle(uint256) view returns (string)','function mediaSHA256(uint256) view returns (bytes32)',
  'function rightsURI(uint256) view returns (string)','function rightsSHA256(uint256) view returns (bytes32)'];
export const PAGE_SIZE=100;

export async function readCollectionInventory(provider,address,{page=0,chainId}={}){
  if(typeof address!=='string'||!isAddress(address))throw new InventoryError('INVALID_ADDRESS',400);
  if(!Number.isSafeInteger(page)||page<0||page>100000)throw new InventoryError('INVALID_PAGE',400);
  const collection=getAddress(address),blockTag=await provider.getBlockNumber();
  if(await provider.getCode(collection,blockTag)==='0x')throw new InventoryError('COLLECTION_NOT_DEPLOYED',404);
  const c=new Contract(collection,ABI,provider),call=(fn,...args)=>c[fn](...args,{blockTag});
  let info;
  try{
    const [name,symbol,size,minted,closed,owner,minter,royaltyRecipient,bps,validator]=await Promise.all(
      ['name','symbol','SERIES_SIZE','totalMinted','mintingClosed','owner','MINTER','ROYALTY_RECIPIENT','CREATOR_ROYALTY_BPS','getTransferValidator'].map(fn=>call(fn)));
    info={collection,chainId:chainId??null,name,symbol,seriesSize:size.toString(),totalMinted:minted.toString(),remainingSupply:(size-minted).toString(),mintingClosed:closed,owner,minter,royaltyRecipient,royaltyBps:Number(bps),validator};
  }catch{throw new InventoryError('NOT_AN_NFT_CONSOLE_COLLECTION',409);}
  const size=BigInt(info.seriesSize),start=BigInt(page*PAGE_SIZE)+1n,end=size<start+BigInt(PAGE_SIZE-1)?size:start+BigInt(PAGE_SIZE-1),tokens=[];
  for(let id=start;id<=end;id+=20n){
    const ids=[];for(let j=id;j<=end&&j<id+20n;j++)ids.push(j);
    const rows=await Promise.all(ids.map(async t=>{
      let holder;try{holder=await call('ownerOf',t);}catch{return null;} // unminted token IDs revert
      const [metadataURI,title,mediaSHA256,rightsURI,rightsSHA256]=await Promise.all(['tokenURI','workTitle','mediaSHA256','rightsURI','rightsSHA256'].map(fn=>call(fn,t)));
      return {tokenId:t.toString(),owner:holder,metadataURI,title,mediaSHA256,rightsURI,rightsSHA256};
    }));
    tokens.push(...rows.filter(Boolean));
  }
  return {...info,page,pageSize:PAGE_SIZE,hasMore:end<size,tokens,block:blockTag};
}

export function installCollectionRoutes(app,requireAction,{provider,chainId}){
  app.get('/api/collections/:address',requireAction('read'),async(req,res)=>{
    try{
      if(!provider)return res.status(503).json({code:'RPC_NOT_CONFIGURED',error:'Collection inventory needs the server RPC connection.'});
      const page=req.query.page===undefined?0:Number(req.query.page);
      res.json(await readCollectionInventory(provider,req.params.address,{page,chainId}));
    }catch(error){
      if(error instanceof InventoryError)return res.status(error.status).json({code:error.code,error:'The collection could not be read: '+error.code});
      console.error(JSON.stringify({event:'inventory_error',message:String(error?.shortMessage||error?.message||error).slice(0,200)}));
      res.status(503).json({code:'INVENTORY_UNAVAILABLE',error:'The collection could not be read from the chain right now.'});
    }
  });
}
