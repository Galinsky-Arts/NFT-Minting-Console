/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {markdownToHtml} from '../scripts/build-quickstart-pdf.mjs';

const doc=name=>readFile(new URL('../docs/'+name,import.meta.url));

test('quick start covers every owner step and optional key; PDF is committed',async()=>{
  const md=String(await doc('OWNER_QUICKSTART.md'));
  for(const needed of ['RPC_URL','NFT_SETUP_CODE','DEPLOYMENT_FACTORY_ADDRESS','PINATA_JWT','OPENSEA_API_KEY','PRIVATE_STORAGE_','NEON_API_KEY','Create release','Deploy & mint','Marketplace'])
    assert.ok(md.includes(needed),'quick start mentions '+needed);
  const pdf=await doc('OWNER_QUICKSTART.pdf');
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>10000);
});

test('handoff states owner-gated work and claims no external audit',async()=>{
  const md=String(await doc('HANDOFF.md'));
  for(const needed of ['What remains (owner-gated only)','RPC_URL','Backups','Alerts','Environment variables','no audit or'])assert.ok(md.includes(needed),needed);
  assert.ok(!/externally audited|audit (passed|complete)|certified/i.test(md));
});

test('PDF renderer escapes HTML and renders lists, tables and inline code',()=>{
  const html=markdownToHtml('# T <x>\n\n1. one\n   more\n2. `two`\n\n| a | b |\n| --- | --- |\n| **c** | d |\n\nSee https://example.com now.');
  assert.match(html,/<h1>T &lt;x&gt;<\/h1>/);assert.match(html,/<ol><li>one more<\/li><li><code>two<\/code><\/li><\/ol>/);
  assert.match(html,/<td><strong>c<\/strong><\/td>/);assert.match(html,/<a href="https:\/\/example.com">/);assert.ok(!html.includes('<x>'));
});
