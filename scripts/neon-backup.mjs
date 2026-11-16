#!/usr/bin/env node
/**
 * Neon backup / restore drill (NFT-32).
 *
 * A Neon branch is a copy-on-write snapshot of its parent at a point in time; it keeps that data even after
 * the parent changes or its point-in-time history window (6 h on the current plan) has passed. This script
 * creates dated `backup-YYYY-MM-DD[-HHMM]` branches of the production branch without compute endpoints (no
 * running cost beyond storage), lists them, verifies them and prints the restore procedure.
 *
 * It never deletes, resets or restores anything unless `prune` is called with `--confirm`, and `prune`
 * only ever touches non-default `backup-*` branches carrying the given `--label` (e.g. the weekly ones).
 *
 *   NEON_API_KEY=... node scripts/neon-backup.mjs snapshot [--project ID] [--branch NAME] [--label TEXT]
 *   node scripts/neon-backup.mjs list|verify NAME|schema-check NAME|restore-plan NAME|prune --keep N --label L [--confirm]
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_PROJECT='silent-resonance-77956314';
const API='https://console.neon.tech/api/v2';
const BACKUP=/^backup-\d{4}-\d{2}-\d{2}(-\d{4})?(-[a-z0-9-]{1,24})?$/;

export function backupName(date=new Date(),label=''){
  const iso=date.toISOString(),base=`backup-${iso.slice(0,10)}-${iso.slice(11,13)}${iso.slice(14,16)}`;
  const clean=String(label).toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24);
  return clean?`${base}-${clean}`:base;
}

export function neonClient({apiKey=process.env.NEON_API_KEY,fetchImpl=globalThis.fetch,api=API}={}){
  return async function call(method,route,body){
    const headers={accept:'application/json'};
    if(apiKey)headers.authorization='Bearer '+apiKey;
    if(body)headers['content-type']='application/json';
    const res=await fetchImpl(api+route,{method,headers,body:body?JSON.stringify(body):undefined});
    const text=await res.text();let json;try{json=text?JSON.parse(text):{};}catch{json={raw:text.slice(0,200)};}
    if(!res.ok){
      const hint=res.status===401?' Set NEON_API_KEY (a Neon API key for the Galinsky Arts organization).':'';
      throw new Error(`Neon API ${method} ${route} failed with ${res.status}: ${String(json.message||json.raw||'').slice(0,200)}${hint}`);
    }
    return json;
  };
}

async function sourceBranch(call,project,name){
  const {branches}=await call('GET',`/projects/${project}/branches`);
  const source=name?branches.find(b=>b.name===name||b.id===name):branches.find(b=>b.default);
  if(!source)throw new Error(`Branch ${name||'(default)'} not found in project ${project}.`);
  return {source,branches};
}

/** Creates a dated, compute-less child branch of the production (default) branch. */
export async function snapshot(call,{project=DEFAULT_PROJECT,branch,label,now=new Date()}={}){
  const {source,branches}=await sourceBranch(call,project,branch);
  const name=backupName(now,label);
  if(branches.some(b=>b.name===name))throw new Error(`A backup named ${name} already exists; nothing was created.`);
  const created=await call('POST',`/projects/${project}/branches`,{branch:{parent_id:source.id,name}});
  const b=created.branch;
  return {project,backupBranchId:b.id,backupBranchName:b.name,parentBranchId:source.id,parentBranchName:source.name,
    parentLsn:b.parent_lsn??null,parentTimestamp:b.parent_timestamp??null,createdAt:b.created_at,state:b.current_state??null,computeEndpoints:(created.endpoints||[]).length};
}

export async function list(call,{project=DEFAULT_PROJECT}={}){
  const {branches}=await call('GET',`/projects/${project}/branches`);
  return branches.filter(b=>BACKUP.test(b.name)).sort((a,b)=>a.created_at<b.created_at?1:-1)
    .map(b=>({id:b.id,name:b.name,createdAt:b.created_at,parentId:b.parent_id,parentLsn:b.parent_lsn??null,state:b.current_state??null}));
}

export async function verify(call,{project=DEFAULT_PROJECT,name}){
  const {branches}=await call('GET',`/projects/${project}/branches`);
  const b=branches.find(x=>x.name===name||x.id===name);
  if(!b||!BACKUP.test(b.name))throw new Error(`Backup ${name} not found.`);
  const parent=branches.find(x=>x.id===b.parent_id);
  const ok=b.current_state==='ready'&&Boolean(parent);
  return {ok,id:b.id,name:b.name,state:b.current_state,parent:parent?.name??null,parentLsn:b.parent_lsn??null,logicalSizeBytes:b.logical_size??null};
}

/** Deletes the oldest backup branches beyond `keep`. Dry run unless confirm is true. */
export async function prune(call,{project=DEFAULT_PROJECT,keep,label,confirm=false}){
  if(!Number.isSafeInteger(keep)||keep<1)throw new Error('--keep must be a positive integer.');
  if(typeof label!=='string'||!/^[a-z0-9-]{1,24}$/.test(label))throw new Error('--label is required: only backups created with that label are pruned.');
  const {branches}=await call('GET',`/projects/${project}/branches`);
  const backups=branches.filter(b=>BACKUP.test(b.name)&&b.name.endsWith('-'+label)&&!b.default&&!b.protected).sort((a,b)=>a.created_at<b.created_at?1:-1);
  const doomed=backups.slice(keep);
  if(confirm)for(const b of doomed)await call('DELETE',`/projects/${project}/branches/${b.id}`);
  return {kept:backups.slice(0,keep).map(b=>b.name),[confirm?'deleted':'wouldDelete']:doomed.map(b=>b.name)};
}

/**
 * Restore drill without touching production: Neon renders a schema dump of the backup branch on demand
 * (temporary compute), which is compared with the production branch. Proves the snapshot is readable and complete.
 */
export async function schemaCheck(call,{project=DEFAULT_PROJECT,name,database='neondb'}){
  const {branches}=await call('GET',`/projects/${project}/branches`);
  const b=branches.find(x=>x.name===name||x.id===name),parent=b&&branches.find(x=>x.id===b.parent_id);
  if(!b||!BACKUP.test(b.name)||!parent)throw new Error(`Backup ${name} or its parent not found.`);
  const strip=sql=>String(sql).split('\n').filter(l=>!/^(--|\\restrict|\\unrestrict)/.test(l)).join('\n');
  const q=`?db_name=${encodeURIComponent(database)}`;
  const [backup,production]=await Promise.all([call('GET',`/projects/${project}/branches/${b.id}/schema${q}`),call('GET',`/projects/${project}/branches/${parent.id}/schema${q}`)]);
  const tables=sql=>(strip(sql).match(/^CREATE TABLE /gm)||[]).length;
  return {backup:b.name,production:parent.name,database,backupTables:tables(backup.sql),productionTables:tables(production.sql),
    identical:strip(backup.sql)===strip(production.sql)};
}

export function restorePlan({project=DEFAULT_PROJECT,name,productionBranch='main'}){
  return [
    `Restore drill / recovery for ${name} in Neon project ${project}`,
    '',
    'Option A - non-destructive (recommended first): inspect the backup on its own compute',
    `  1. Neon console > Branches > ${name} > Add compute (or API: POST /projects/${project}/endpoints {"endpoint":{"branch_id":"<backup id>","type":"read_write"}}).`,
    '  2. Connect with the branch connection string and check row counts, e.g. SELECT count(*) FROM nft_console.releases;',
    '  3. Delete that compute when done. Production is untouched.',
    '',
    `Option B - roll production back to the backup (destructive for writes made after the backup):`,
    `  1. Put the app in maintenance: in Render, suspend srv-dbsvpavf3r2c73bha9mg (or scale to 0).`,
    `  2. Neon console > Branches > ${productionBranch} > Restore > "From another branch" > ${name}, keeping "preserve as" a`,
    `     dated branch so the pre-restore state is retained. API equivalent:`,
    `     POST /projects/${project}/branches/<${productionBranch} id>/restore {"source_branch_id":"<backup id>","preserve_under_name":"pre-restore-YYYY-MM-DD"}`,
    '  3. The connection string and roles are unchanged, so DATABASE_URL in Render needs no edit. Resume the service.',
    '  4. Check https://nft-minting-console.onrender.com/api/status and sign in as the administrator.',
    '',
    'Option C - point the app at a copy: add a compute to the backup branch and set DATABASE_URL in Render to it.',
    '',
    'Wallet keys, contracts and on-chain data are not in the database and are unaffected by any restore.'
  ].join('\n');
}

function args(argv){const out={_:[]};for(let i=0;i<argv.length;i++){const a=argv[i];if(a.startsWith('--')){const k=a.slice(2);const v=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;out[k]=v;}else out._.push(a);}return out;}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const a=args(process.argv.slice(2)),cmd=a._[0],project=a.project||process.env.NEON_PROJECT_ID||DEFAULT_PROJECT,call=neonClient();
  try{
    let out;
    if(cmd==='snapshot')out=await snapshot(call,{project,branch:a.branch,label:a.label===true?'':a.label});
    else if(cmd==='list')out=await list(call,{project});
    else if(cmd==='verify')out=await verify(call,{project,name:a._[1]});
    else if(cmd==='schema-check')out=await schemaCheck(call,{project,name:a._[1],database:a.database||'neondb'});
    else if(cmd==='prune')out=await prune(call,{project,keep:Number(a.keep),label:a.label,confirm:a.confirm===true});
    else if(cmd==='restore-plan'){console.log(restorePlan({project,name:a._[1]||'<backup name>'}));process.exit(0);}
    else{console.error('Usage: neon-backup.mjs snapshot|list|verify NAME|schema-check NAME|restore-plan NAME|prune --keep N --label L [--confirm]');process.exit(2);}
    console.log(JSON.stringify(out,null,2));
    if((cmd==='verify'&&!out.ok)||(cmd==='schema-check'&&(!out.identical||!out.backupTables)))process.exit(1);
  }catch(error){console.error(String(error.message||error));process.exit(1);}
}
