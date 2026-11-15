import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// NFT-36: a hosted installation without RPC_URL tells the owner exactly which variable to add, is keyboard
// operable and accessible, and exposes no wallet action.
test('chain-not-configured installation explains the RPC_URL fix accessibly and offers no wallet action',async({page},info)=>{
  const origin=`http://127.0.0.1:${info.project.name==='mobile'?4186:4185}`;
  let walletCalls=0;await page.exposeFunction('__walletCall',()=>{walletCalls++;});
  await page.addInitScript(()=>{(window as unknown as {ethereum:unknown}).ethereum={request:async()=>{await (window as unknown as {__walletCall:()=>Promise<void>}).__walletCall();return [];},on(){},removeListener(){}};});
  await page.goto(origin);
  const heading=page.getByRole('heading',{level:1,name:'Blockchain connection not configured'});
  await expect(heading).toBeVisible();await expect(heading).toBeFocused();
  const steps=page.getByRole('region',{name:'Add RPC_URL to finish setup'});
  await expect(steps.getByRole('listitem')).toHaveCount(5);
  await expect(steps).toContainText('Add Environment Variable');await expect(steps).toContainText('NFT_SETUP_CODE');
  await expect(page.getByRole('region',{name:'Installation status'})).toContainText('Restricted database verified');
  await expect(page.getByText('PINATA_JWT')).toBeVisible();
  await expect(page.getByRole('button',{name:/Connect|Register|Sign in/})).toHaveCount(0);
  // Keyboard: skip link first, then the copy and reload controls are reachable in order.
  await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to main content'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Copy name RPC_URL'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Reload after saving'})).toBeFocused();
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const status=await page.evaluate(async()=>(await fetch('/api/status')).json()) as {mode:string;blockedActions:{envVar:string}[]};
  expect(status.mode).toBe('degraded');expect(status.blockedActions.map(b=>b.envVar)).toContain('RPC_URL');
  expect(walletCalls).toBe(0);
  await page.screenshot({path:`test-results/${info.project.name}-chain-not-configured.png`,fullPage:true});
});
