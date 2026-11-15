import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {getBytes} from 'ethers';
import {testWallets} from './fixtures.mjs';

// Real browser + real database + real Seaport 1.6 + real Limit Break validator on the disposable local EVM.
// No marketplace indexes this network, so the best reachable state must be "Valid order, not on a marketplace".
test.describe.configure({mode:'serial'});
async function relay(method:string,params:unknown[]=[]):Promise<unknown>{
  const response=await fetch('http://127.0.0.1:4178',{method:'POST',headers:{'Content-Type':'application/json','X-NFT-Test':'disposable-local-only'},body:JSON.stringify({method,params})});
  if(!response.ok)throw new Error('Marketplace fixture request failed.');return (await response.json()).result;
}
declare global {interface Window {__mp:{calls:string[]};__mpRpc(method:string,params:unknown[]):Promise<unknown>;__mpSign(data:string):Promise<string>;__mpTyped(payload:string):Promise<string>;}}

async function setup(page:Page,mobile:boolean){
  const index=mobile?9:8,signer=testWallets[index]!;
  const fixture=await relay('fixture_marketplace',[index]) as {collection:string;seaport:string};
  await page.exposeFunction('__mpSign',(data:string)=>signer.signMessage(getBytes(data)));
  await page.exposeFunction('__mpTyped',(payload:string)=>{
    const {domain,types,message}=JSON.parse(payload);const {EIP712Domain:_d,...rest}=types;void _d;
    return signer.signTypedData(domain,rest,message);
  });
  await page.exposeFunction('__mpRpc',async(method:string,params:unknown[])=>{
    if(method!=='eth_sendTransaction')return relay(method,params);
    const v=params[0] as {from:string;to:string;data:string;value:string};
    if(v.from.toLowerCase()!==signer.address.toLowerCase())throw new Error('Unexpected sender');
    const nonce=Number(BigInt(await relay('eth_getTransactionCount',[signer.address,'pending']) as string));
    const gasPrice=BigInt(await relay('eth_gasPrice') as string);
    const gas=BigInt(await relay('eth_estimateGas',[{from:v.from,to:v.to,data:v.data,value:v.value}]) as string)*2n;
    const raw=await signer.signTransaction({to:v.to,data:v.data,value:BigInt(v.value),nonce,gasLimit:gas,gasPrice,chainId:31337n,type:0});
    return relay('eth_sendRawTransaction',[raw]);
  });
  await page.addInitScript(({address})=>{
    window.__mp={calls:[]};
    window.ethereum={async request({method,params}){
      window.__mp.calls.push(method);
      if(method==='eth_accounts'||method==='eth_requestAccounts')return [address];
      if(method==='eth_chainId')return '0x7a69';
      if(method==='personal_sign')return window.__mpSign((params as string[])[0]!);
      if(method==='eth_signTypedData_v4')return window.__mpTyped((params as string[])[1]!);
      return window.__mpRpc(method,(params as unknown[])||[]);
    },on(){},removeListener(){}};
  },{address:signer.address});
  await page.goto('/#/marketplace');
  await page.locator('.topbar').getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading',{name:'Marketplace transfer policy'})).toBeVisible();
  return fixture;
}
const listingRow=(page:Page,tokenId:string)=>page.locator('.transaction-row').filter({hasText:`Token #${tokenId}`});

test('owner configures the real transfer policy, lists, observes a real sale and cancels another order',async({page},info)=>{
  test.setTimeout(120_000);
  const {collection}=await setup(page,info.project.name==='mobile');
  // 1. Transfer policy: every step is a wallet transaction followed by on-chain readback.
  const policy=page.locator('section').filter({has:page.getByRole('heading',{name:'Marketplace transfer policy'})});
  await policy.getByLabel('Collection contract').fill(collection);
  await policy.getByRole('button',{name:'Check policy'}).click();
  await expect(policy.getByText(/OWNER transactions? needed/)).toBeVisible();
  await policy.getByRole('checkbox',{name:/controls which marketplaces/}).check();
  for(let i=0;i<6;i++){
    if(await policy.getByText(/Verified on-chain: whitelist ruleset 255 with options 6/).isVisible())break;
    await policy.getByRole('button',{name:/^Send: /}).click();
    await expect(policy.getByText(/Confirmed and read back from the chain|Verified on-chain/).first()).toBeVisible({timeout:20_000});
  }
  await expect(policy.getByText(/Verified on-chain: whitelist ruleset 255 with options 6/)).toBeVisible();

  // 2. List token 1: check, review exact payments, approve, sign.
  const form=page.locator('section').filter({has:page.getByRole('heading',{name:'List a minted NFT for sale'})});
  await form.getByLabel('Collection contract').fill(collection);
  await form.getByLabel('Token ID').fill('1');
  await form.getByLabel('Price (ETH)').fill('0.5');
  await form.getByRole('button',{name:'Check token'}).click();
  await expect(form.getByText('Allows this marketplace')).toBeVisible();
  await form.getByRole('button',{name:'Prepare order for review'}).click();
  const review=page.locator('section').filter({has:page.getByRole('heading',{name:'Exact Seaport order'})});
  await expect(review.getByRole('cell',{name:'Creator royalty (ERC-2981)'})).toBeVisible();
  await expect(review.getByRole('cell',{name:'0.025 ETH'})).toBeVisible();
  await expect(review.getByRole('cell',{name:'0.475 ETH'})).toBeVisible();
  const signsBefore=await page.evaluate(()=>window.__mp.calls.filter(c=>c==='eth_signTypedData_v4').length);
  expect(signsBefore).toBe(0);
  await review.getByRole('button',{name:'Approve in wallet'}).click();
  await expect(page.getByText('Approval confirmed on-chain.')).toBeVisible({timeout:20_000});
  await review.getByRole('checkbox',{name:/I reviewed the price/}).check();
  await review.getByRole('button',{name:'Sign and submit'}).click();
  const row1=listingRow(page,'1');
  await expect(row1.locator('.badge')).toHaveText('Valid order, not on a marketplace',{timeout:30_000});
  await expect(page.getByText('Listed on OpenSea, verified')).toHaveCount(0);

  // 3. A real buyer fills the signed order on-chain; the console reports the sale and royalty evidence.
  const listings=await page.evaluate(async()=>(await fetch('/api/marketplace/listings',{credentials:'same-origin'})).json()) as {id:string;tokenId:string;state:string}[];
  const target=listings.find(l=>l.tokenId==='1'&&l.state==='valid_unindexed')!;
  const signed=await page.evaluate(async(id)=>(await fetch('/api/marketplace/listings/'+id,{credentials:'same-origin'})).json(),target.id) as {order:{components:Record<string,unknown>&{consideration:unknown[]};signature:string}};
  const {counter:_c,...rest}=signed.order.components;void _c;
  const fill=await relay('fixture_fill',[{...rest,totalOriginalConsiderationItems:String(signed.order.components.consideration.length)},signed.order.signature]) as {buyer:string};
  await row1.getByRole('button',{name:'Verify now'}).click();
  await expect(row1.locator('.badge')).toHaveText('Sold',{timeout:20_000});
  await expect(row1.getByText(`${fill.buyer.slice(0,6)}…${fill.buyer.slice(-4)}`)).toBeVisible();
  await expect(row1.getByText('0.025 ETH (expected 0.025 ETH)')).toBeVisible();

  // 4. List token 2, then cancel it on-chain through the wallet.
  await form.getByLabel('Token ID').fill('2');
  await form.getByRole('button',{name:'Check token'}).click();
  await expect(form.getByText('Approved',{exact:true})).toBeVisible();
  await form.getByRole('button',{name:'Prepare order for review'}).click();
  await expect(review.getByRole('button',{name:'Approve in wallet'})).toHaveCount(0);
  await review.getByRole('checkbox',{name:/I reviewed the price/}).check();
  await review.getByRole('button',{name:'Sign and submit'}).click();
  const row2=listingRow(page,'2');
  await expect(row2.locator('.badge')).toHaveText('Valid order, not on a marketplace',{timeout:30_000});
  await row2.getByRole('button',{name:'Cancel on-chain'}).click();
  await expect(row2.locator('.badge')).toHaveText('Cancelled',{timeout:30_000});

  const a11y=await new AxeBuilder({page}).include('main').analyze();
  expect(a11y.violations.filter(v=>['critical','serious'].includes(v.impact||''))).toEqual([]);
});
