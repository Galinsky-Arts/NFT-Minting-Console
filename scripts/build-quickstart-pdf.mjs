#!/usr/bin/env node
/**
 * Renders docs/OWNER_QUICKSTART.md to docs/OWNER_QUICKSTART.pdf with Playwright's Chromium (print to PDF).
 * Tiny Markdown subset: headings, paragraphs, ordered/unordered lists, tables, **bold**, `code`, links.
 *   [CHROMIUM_PATH=/path/to/chrome] node scripts/build-quickstart-pdf.mjs [input.md] [output.pdf]
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const inline=s=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,'<a href="$2">$1</a>').replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g,'$1<a href="$2">$2</a>');

export function markdownToHtml(md,title='Document'){
  const lines=md.replace(/\r/g,'').split('\n'),out=[];let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    let m;
    if((m=line.match(/^(#{1,3}) (.*)$/))){out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);i++;continue;}
    if(line.startsWith('|')){
      const rows=[];while(i<lines.length&&lines[i].startsWith('|'))rows.push(lines[i++]);
      const cells=r=>r.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
      out.push('<table><thead><tr>'+cells(rows[0]).map(c=>`<th>${inline(c)}</th>`).join('')+'</tr></thead><tbody>'+
        rows.slice(2).map(r=>'<tr>'+cells(r).map(c=>`<td>${inline(c)}</td>`).join('')+'</tr>').join('')+'</tbody></table>');
      continue;
    }
    if(/^(\d+\.|-) /.test(line)){
      const ordered=/^\d+\./.test(line),items=[];
      while(i<lines.length&&(/^(\d+\.|-) /.test(lines[i])||/^ {2,}\S/.test(lines[i]))){
        if(/^(\d+\.|-) /.test(lines[i]))items.push(lines[i].replace(/^(\d+\.|-) /,''));else items[items.length-1]+=' '+lines[i].trim();i++;
      }
      out.push(`<${ordered?'ol':'ul'}>`+items.map(x=>`<li>${inline(x)}</li>`).join('')+`</${ordered?'ol':'ul'}>`);continue;
    }
    const para=[];while(i<lines.length&&lines[i].trim()&&!/^(#|\||\d+\. |- )/.test(lines[i]))para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{font:10.5pt/1.45 "DejaVu Sans",Arial,sans-serif;color:#1a1a1a;margin:0}
  h1{font-size:19pt;margin:0 0 8pt;color:#14213d}h2{font-size:13pt;margin:14pt 0 5pt;color:#14213d;border-bottom:1px solid #d0d5dd;padding-bottom:2pt;break-after:avoid}
  p,li{margin:3pt 0}ol,ul{margin:3pt 0 3pt 16pt;padding:0}code{font:9pt "DejaVu Sans Mono",monospace;background:#f1f3f5;padding:0 2pt;border-radius:2pt;overflow-wrap:anywhere}
  table{border-collapse:collapse;width:100%;margin:5pt 0;font-size:9pt;break-inside:avoid}th,td{border:1px solid #c9ced6;padding:3pt 5pt;text-align:left;vertical-align:top}th{background:#eef1f5}
  a{color:#1d4ed8;text-decoration:none}</style></head><body>${out.join('\n')}</body></html>`;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('..',import.meta.url));
  const input=process.argv[2]||path.join(root,'docs/OWNER_QUICKSTART.md'),output=process.argv[3]||path.join(root,'docs/OWNER_QUICKSTART.pdf');
  const html=markdownToHtml(await readFile(input,'utf8'),'NFT Console - Owner Quick Start');
  const {chromium}=await import('@playwright/test');
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
  try{
    const page=await browser.newPage();await page.setContent(html,{waitUntil:'load'});
    await page.pdf({path:output,format:'A4',margin:{top:'16mm',bottom:'16mm',left:'16mm',right:'16mm'},printBackground:true,
      displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;color:#666">NFT Console Owner Quick Start - page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'});
    console.log('Wrote '+path.relative(root,output));
  }finally{await browser.close();}
}
