import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeRoleFromUrl,runtimeRoleStatements,provisionRuntimeRole} from '../scripts/provision-runtime-role.mjs';
const pw='a1'.repeat(24),owner='postgresql://owner:o@ep-x.example.tech/neondb';
test('runtime role password comes only from the restricted runtime URL on the same database',()=>{
  assert.equal(runtimeRoleFromUrl(`postgresql://nft_console_runtime:${pw}@ep-x.example.tech/neondb`,owner).password,pw);
  assert.equal(runtimeRoleFromUrl(`postgresql://nft_console_runtime:${pw}@ep-x-pooler.example.tech/neondb`,owner).password,pw);
  for(const url of [`postgresql://neondb_owner:${pw}@ep-x.example.tech/neondb`,'postgresql://nft_console_runtime:short@ep-x.example.tech/neondb',`postgresql://nft_console_runtime:${pw}@ep-y.example.tech/neondb`,`postgresql://nft_console_runtime:${pw}@ep-x.example.tech/other`,'not a url'])
    assert.throws(()=>runtimeRoleFromUrl(url,owner));
  assert.throws(()=>runtimeRoleFromUrl(`postgresql://nft_console_runtime:${pw}@ep-x.example.tech/neondb`,`postgresql://nft_console_runtime:${pw}@ep-x.example.tech/neondb`),/migration owner/);
});
test('created login is non-inheriting and unprivileged, grants are SET-only, and passwords are quoted',()=>{
  const [create,grant]=runtimeRoleStatements("x'y",false);
  assert.match(create,/^CREATE ROLE nft_console_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'x''y'$/);
  assert.equal(grant,'GRANT nft_console_api, nft_console_auth_service, nft_console_identity TO nft_console_runtime WITH ADMIN FALSE, INHERIT FALSE, SET TRUE');
  assert.match(runtimeRoleStatements('p',true)[0],/^ALTER ROLE nft_console_runtime WITH PASSWORD 'p'$/);
});
function fakeClient({exists=false,restricted=true,extra=0}={}){
  const log=[];return {log,async query(sql){log.push(sql.split(' ')[0]);
    if(sql.startsWith('SELECT 1 FROM pg_roles'))return {rowCount:exists?1:0,rows:[]};
    if(sql.startsWith('SELECT rolcanlogin'))return {rows:[{restricted}]};
    if(sql.startsWith('SELECT r.rolname'))return {rowCount:extra,rows:[]};
    return {rowCount:0,rows:[]};}};
}
test('provisioning commits only a restricted login without extra memberships',async()=>{
  const ok=fakeClient();assert.deepEqual(await provisionRuntimeRole(ok,pw),{role:'nft_console_runtime',created:true});assert.equal(ok.log.at(-1),'COMMIT');
  for(const state of [{exists:true,restricted:false},{extra:1}]){const c=fakeClient(state);await assert.rejects(provisionRuntimeRole(c,pw),/review them manually|not restricted/);assert.equal(c.log.at(-1),'ROLLBACK');}
});
