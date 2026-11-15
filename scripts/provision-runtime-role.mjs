import {fileURLToPath} from 'node:url';
import path from 'node:path';

/**
 * Operations-only: create or re-key the restricted application login documented in
 * docs/PR09_DURABLE_STORAGE.md, using the migration owner connection (DATABASE_URL_UNPOOLED).
 * The runtime password is taken from the application's own DATABASE_URL so no extra secret exists.
 * Never run this from the application process; the runtime refuses DATABASE_URL_UNPOOLED.
 */
export const RUNTIME_ROLE='nft_console_runtime';
const GRANTED=['nft_console_api','nft_console_auth_service','nft_console_identity'];
const quoteLiteral=value=>"'"+String(value).replace(/'/g,"''")+"'";

export function runtimeRoleFromUrl(runtimeUrl,ownerUrl){
  let runtime,owner;
  try{runtime=new URL(runtimeUrl);owner=new URL(ownerUrl);}catch{throw new Error('Invalid database connection configuration.');}
  const password=decodeURIComponent(runtime.password||'');
  if(decodeURIComponent(runtime.username)!==RUNTIME_ROLE)throw new Error(`DATABASE_URL must use the ${RUNTIME_ROLE} login.`);
  if(decodeURIComponent(owner.username)===RUNTIME_ROLE)throw new Error('DATABASE_URL_UNPOOLED must be the migration owner, not the runtime login.');
  if(password.length<32||/[\0]/.test(password))throw new Error('The runtime password must be a generated value of at least 32 characters.');
  if(runtime.hostname.replace('-pooler','')!==owner.hostname.replace('-pooler','')||runtime.pathname!==owner.pathname)throw new Error('Runtime and migration URLs must target the same database.');
  return {password};
}

export function runtimeRoleStatements(password,exists){
  const flags='LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  return [
    exists?`ALTER ROLE ${RUNTIME_ROLE} WITH PASSWORD ${quoteLiteral(password)}`:`CREATE ROLE ${RUNTIME_ROLE} ${flags} PASSWORD ${quoteLiteral(password)}`,
    `GRANT ${GRANTED.join(', ')} TO ${RUNTIME_ROLE} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
  ];
}

export async function provisionRuntimeRole(client,password){
  await client.query('BEGIN');
  try{
    const exists=(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[RUNTIME_ROLE])).rowCount>0;
    for(const sql of runtimeRoleStatements(password,exists))await client.query(sql);
    const flags=await client.query('SELECT rolcanlogin AND NOT (rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted FROM pg_roles WHERE rolname=$1',[RUNTIME_ROLE]);
    if(flags.rows[0]?.restricted!==true)throw new Error('The existing runtime login is not restricted; review it manually.');
    const extra=await client.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
      WHERE u.rolname=$1 AND NOT r.rolname=ANY($2::text[])`,[RUNTIME_ROLE,GRANTED]);
    if(extra.rowCount)throw new Error('The runtime login has unexpected role memberships; review them manually.');
    await client.query('COMMIT');
    return {role:RUNTIME_ROLE,created:!exists};
  }catch(error){await client.query('ROLLBACK');throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const ownerUrl=process.env.DATABASE_URL_UNPOOLED,runtimeUrl=process.env.DATABASE_URL;
  if(!ownerUrl||!runtimeUrl)throw new Error('Set DATABASE_URL_UNPOOLED (migration owner) and DATABASE_URL (runtime login) in the operations environment.');
  const {password}=runtimeRoleFromUrl(runtimeUrl,ownerUrl);
  const {default:pg}=await import('pg');const {databaseOptions}=await import('../console/data/pool.mjs');
  const client=new pg.Client(databaseOptions(ownerUrl));await client.connect();
  try{console.log(JSON.stringify(await provisionRuntimeRole(client,password)));}finally{await client.end();}
}
