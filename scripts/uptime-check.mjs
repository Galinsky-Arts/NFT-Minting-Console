#!/usr/bin/env node
/**
 * Scheduled uptime check (NFT-32). Reads the public /api/status endpoint (no credentials) and keeps exactly one
 * GitHub issue labelled `uptime-alert` in sync: opened or commented while the service is down, closed on recovery.
 * The degraded "chain not configured" mode counts as UP: the service answers and reports its own state.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/uptime-check.mjs [https://.../api/status]
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_URL='https://nft-minting-console.onrender.com/api/status';
export const LABEL='uptime-alert';
export const TITLE='Uptime alert: NFT Console status check failing';

/** Probes the status URL, retrying to ride out a free-tier cold start. */
export async function probe(url,{fetchImpl=globalThis.fetch,attempts=3,timeoutMs=90000,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  let last;
  for(let i=1;i<=attempts;i++){
    const started=Date.now();
    try{
      const res=await fetchImpl(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      const text=await res.text();let body=null;try{body=JSON.parse(text);}catch{/* not JSON */}
      last={up:res.status===200&&body!==null&&typeof body==='object',status:res.status,mode:body?.mode??null,ms:Date.now()-started,attempt:i,
        reason:res.status!==200?`HTTP ${res.status}`:body===null?'response was not JSON':null};
    }catch(error){last={up:false,status:null,mode:null,ms:Date.now()-started,attempt:i,reason:String(error?.name==='TimeoutError'?'timed out':error?.message||error).slice(0,160)};}
    if(last.up)return last;
    if(i<attempts)await wait(20000);
  }
  return last;
}

export function github({token=process.env.GITHUB_TOKEN,repo=process.env.GITHUB_REPOSITORY,fetchImpl=globalThis.fetch}={}){
  if(!token||!/^[\w.-]+\/[\w.-]+$/.test(String(repo)))throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required.');
  return async(method,route,body)=>{
    const res=await fetchImpl(`https://api.github.com/repos/${repo}${route}`,{method,headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,'x-github-api-version':'2022-11-28',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(!res.ok)throw new Error(`GitHub ${method} ${route} failed: ${res.status}`);
    return res.status===204?null:res.json();
  };
}

/** Opens/updates the alert issue on failure and closes it on recovery. Returns the action taken. */
export async function reconcile(gh,result,{url=DEFAULT_URL,runUrl='',now=new Date()}={}){
  const open=(await gh('GET',`/issues?state=open&labels=${LABEL}&per_page=10`)).filter(i=>!i.pull_request);
  const when=now.toISOString();
  if(!result.up){
    const detail=`- Checked: ${when}\n- URL: ${url}\n- Result: ${result.reason||'down'} (HTTP ${result.status??'none'}, attempt ${result.attempt})${runUrl?`\n- Run: ${runUrl}`:''}`;
    if(open.length){await gh('POST',`/issues/${open[0].number}/comments`,{body:`Still failing.\n\n${detail}`});return {action:'commented',issue:open[0].number};}
    const created=await gh('POST','/issues',{title:TITLE,labels:[LABEL],body:`The scheduled uptime check could not get a healthy response.\n\n${detail}\n\n`+
      'What to check: Render dashboard > nft-minting-console > Events/Logs; Neon project status. See docs/HANDOFF.md (Alerts). '+
      'This issue closes automatically when the check recovers.'});
    return {action:'opened',issue:created.number};
  }
  for(const issue of open){
    await gh('POST',`/issues/${issue.number}/comments`,{body:`Recovered at ${when}: HTTP ${result.status}, mode \`${result.mode??'unknown'}\`, ${result.ms} ms.`});
    await gh('PATCH',`/issues/${issue.number}`,{state:'closed',state_reason:'completed'});
  }
  return {action:open.length?'closed':'none',issues:open.map(i=>i.number)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const url=process.argv[2]||process.env.UPTIME_URL||DEFAULT_URL;
  const result=await probe(url);
  console.log(JSON.stringify({url,...result}));
  const runUrl=process.env.GITHUB_RUN_ID?`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:'';
  if(process.env.GITHUB_TOKEN)console.log(JSON.stringify(await reconcile(github(),result,{url,runUrl})));
  if(!result.up)process.exitCode=1;
}
