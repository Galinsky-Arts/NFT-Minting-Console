import {getAddress,isAddress} from 'ethers';
import {readFileSync} from 'node:fs';
const registry=JSON.parse(readFileSync(new URL('../../config/chains.json',import.meta.url),'utf8'));
const KEY=/^0x[0-9a-fA-F]{64}$/;
export class MarketError extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
export const fail=(code,status)=>{throw new MarketError(code,status);};
const addr=(v,code)=>{if(typeof v!=='string'||!isAddress(v)||/^0x0{40}$/i.test(v))fail(code||'MARKET_CONFIG_INVALID');return getAddress(v);};
/** Marketplace/policy infrastructure for one chain. Mainnet/Sepolia values come from the reviewed
 * registry and are re-verified on-chain before use; local values may only be injected for chain 31337. */
export function marketConfig(env,chainId){
  const p=registry.chains[String(chainId)];if(!p)fail('UNSUPPORTED_CHAIN');
  const m=p.market||{};
  const local=chainId===31337&&env.NODE_ENV!=='production';
  const pick=(name,value)=>local&&env[name]?env[name]:value;
  const seaport=pick('MARKET_SEAPORT',m.seaport),controller=pick('MARKET_CONDUIT_CONTROLLER',m.conduitController),conduitKey=pick('MARKET_CONDUIT_KEY',m.conduitKey);
  const validator=pick('MARKET_VALIDATOR',env.TRANSFER_VALIDATOR_ADDRESS||p.validator);
  if(!seaport||!controller||!conduitKey)return {chainId,slug:p.slug,available:false,validator:validator?addr(validator):null,reason:'MARKET_NOT_CONFIGURED'};
  if(!KEY.test(conduitKey))fail('MARKET_CONFIG_INVALID');
  const marketplace=chainId===31337?(local&&env.MARKET_FIXTURE==='1'?'fixture':null):(m.opensea?'opensea':null);
  return Object.freeze({chainId,slug:p.slug,available:true,seaport:addr(seaport),seaportVersion:'1.6',conduitController:addr(controller),conduitKey:conduitKey.toLowerCase(),
    validator:validator?addr(validator):null,signedZone:p.signedZone?addr(p.signedZone):null,marketplace,
    openseaFeeRecipient:m.openseaFeeRecipient?addr(m.openseaFeeRecipient):null,openseaApi:m.opensea||null});
}
