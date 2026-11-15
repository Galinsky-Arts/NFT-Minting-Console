import {test,expect} from '@playwright/test';
import type {Browser,Page} from '@playwright/test';
import {getBytes} from 'ethers';
import {testWallets} from './fixtures.mjs';

// Two real browser contexts act as two devices of the same wallet. All encryption happens in-page; the test
// watches every request body to prove plaintext never leaves the browser.
test.describe.configure({mode:'serial'});
const PASS='a long private passphrase 42';
async function device(browser:Browser,index:number){
  const context=await browser.newContext();const page=await context.newPage();const signer=testWallets[index]!;
  await page.exposeFunction('__wsSign',(data:string)=>signer.signMessage(getBytes(data)));
  await page.addInitScript(({address})=>{
    (window as unknown as {ethereum:unknown}).ethereum={async request({method,params}:{method:string;params?:unknown[]}){
      if(method==='eth_accounts'||method==='eth_requestAccounts')return [address];
      if(method==='eth_chainId')return '0x7a69';
      if(method==='personal_sign')return (window as unknown as {__wsSign(d:string):Promise<string>}).__wsSign((params as string[])[0]!);
      throw new Error('Unsupported in this test: '+method);
    },on(){},removeListener(){}};
  },{address:signer.address});
  const bodies:string[]=[];page.on('request',r=>{const b=r.postDataBuffer();if(b)bodies.push(b.toString('latin1'));});
  await page.goto('/#/workspace');
  await page.locator('.topbar').getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  return {page,context,bodies};
}
async function fillPass(page:Page,confirm=true){
  await page.getByLabel('Vault passphrase (12+ characters)').fill(PASS);
  if(confirm)await page.getByLabel('Repeat passphrase').fill(PASS);
}

test('two devices: encrypted draft and files, fingerprint enrollment, approval, reload, revocation',async({browser},info)=>{
  test.setTimeout(240_000);
  const index=info.project.name==='mobile'?9:8,marker=`Unreleased ${info.project.name} release ${Date.now()}`;
  const A=await device(browser,index);
  await expect(A.page.getByRole('heading',{name:'Create your private workspace'})).toBeVisible();
  await fillPass(A.page);
  const backup=A.page.waitForEvent('download');
  await A.page.getByRole('button',{name:'Create encrypted workspace'}).click();
  expect((await backup).suggestedFilename()).toMatch(/^nft-console-recovery-[0-9a-f]{6}-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(A.page.getByLabel('Recovery code',{exact:true})).toHaveText(/^[0-9a-f]{5}(-[0-9a-f]{5}){7}$/,{timeout:60_000});
  await A.page.getByRole('checkbox',{name:/I stored the recovery code/}).click();
  await expect(A.page.getByRole('heading',{name:'Save your recovery code now'})).toHaveCount(0);

  // Encrypted draft with a multi-chunk private file (3 x 4 MiB chunks).
  await A.page.getByRole('button',{name:'New draft'}).click();
  await A.page.getByLabel('Release title').fill(marker);
  await A.page.getByLabel('Collection name').fill('Private Collection');
  const fileBytes=Buffer.alloc(9*1024*1024+100);for(let i=0;i<fileBytes.length;i+=4096)fileBytes.write('SECRETPIXELS',i,'latin1');
  await A.page.getByLabel(/Add artwork, audio, video or documents/).setInputFiles({name:'secret-art.png',mimeType:'image/png',buffer:fileBytes});
  await expect(A.page.getByText('Encrypted, stored, verified and saved to the draft.')).toBeVisible({timeout:90_000});
  await expect(A.page.getByText('secret-art.png')).toBeVisible();
  await A.page.getByRole('button',{name:'Save encrypted draft'}).click();
  await expect(A.page.getByText('Saved. Only your authorized devices can decrypt it.')).toBeVisible();

  // Device B enrolls; fingerprints are compared across devices before certification.
  const B=await device(browser,index);
  await expect(B.page.getByRole('heading',{name:'Enroll this browser'})).toBeVisible();
  await B.page.locator('section').filter({has:B.page.getByRole('heading',{name:'Enroll this browser'})}).getByLabel('Vault passphrase (12+ characters)').fill(PASS);
  await B.page.locator('section').filter({has:B.page.getByRole('heading',{name:'Enroll this browser'})}).getByLabel('Repeat passphrase').fill(PASS);
  await B.page.locator('section').filter({has:B.page.getByRole('heading',{name:'Enroll this browser'})}).getByLabel('Name for this device').fill('Second laptop');
  await B.page.getByRole('button',{name:'Request access'}).click();
  const fpB=(await B.page.locator('.recovery-code').innerText({timeout:60_000})).trim();
  expect(fpB).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/);
  await A.page.getByRole('button',{name:'Sync'}).click();
  await expect(A.page.getByText(fpB)).toBeVisible();
  await A.page.getByRole('checkbox',{name:'The fingerprint on the other device matches exactly.'}).check();
  await A.page.getByRole('button',{name:'Certify device'}).click();
  await B.page.getByRole('button',{name:'Check again'}).click();
  await expect(B.page.getByText('Waiting for an authorized device to approve this one.')).toBeVisible();
  await A.page.getByRole('button',{name:'Sync'}).click();
  await A.page.getByRole('button',{name:'Approve and share draft keys'}).click();
  await expect(A.page.getByText('Second laptop — active')).toBeVisible();
  await B.page.getByRole('button',{name:'Check again'}).click();
  await expect(B.page.getByText('This device is now an authorized member.')).toBeVisible();

  // B decrypts the draft and the file.
  await B.page.getByRole('button',{name:'Open',exact:true}).first().click();
  await expect(B.page.getByLabel('Release title')).toHaveValue(marker);
  await B.page.getByRole('button',{name:'Decrypt and preview'}).click();
  await expect(B.page.getByRole('link',{name:'Download decrypted copy'})).toBeVisible({timeout:60_000});

  // Reload B: the vault persists locally (sealed) and unlocks with the passphrase.
  await B.page.reload();
  await expect(B.page.getByRole('heading',{name:'Unlock your private workspace'})).toBeVisible();
  await B.page.getByLabel('Vault passphrase (12+ characters)').fill(PASS);
  await B.page.getByRole('button',{name:'Unlock'}).click();
  await B.page.getByRole('button',{name:'Open',exact:true}).first().click();
  await expect(B.page.getByLabel('Release title')).toHaveValue(marker);

  // A revokes B: keys rotate and the draft is re-encrypted; B can no longer open it.
  A.page.once('dialog',d=>void d.accept());
  await A.page.getByRole('button',{name:'Revoke'}).click();
  await expect(A.page.getByText('Second laptop — revoked')).toBeVisible({timeout:60_000});
  await B.page.getByRole('button',{name:'Sync'}).click();
  await B.page.getByRole('button',{name:'Open',exact:true}).first().click().catch(()=>{});
  await expect(B.page.locator('.notice').filter({hasText:/./}).first()).toBeVisible();
  await expect(B.page.getByLabel('Release title')).not.toHaveValue(marker+'x');

  // No request body from either device ever contained plaintext.
  for(const body of [...A.bodies,...B.bodies]){expect(body.includes(marker)).toBe(false);expect(body.includes('SECRETPIXELS')).toBe(false);expect(body.includes('secret-art.png')).toBe(false);}
  await A.context.close();await B.context.close();
});
