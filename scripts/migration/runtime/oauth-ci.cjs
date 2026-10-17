'use strict';
// Disposable CI driver; provider double is installed BEFORE the real bootstrap.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {Pool} = require('pg');
const {start,stop} = require('./oauth-web.cjs');
if (process.env.CTA_MIGRATION_DISPOSABLE_CI !== 'yes' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable CI only');
const config=JSON.parse(fs.readFileSync('/run/imortais-oauth/config.json','utf8'));
let member=true,calls=0;
global.fetch=async(raw,options={})=>{
  calls++;
  assert.equal(options.redirect,'error');assert.ok(options.signal);
  if (String(raw)==='https://discord.com/api/oauth2/token') {
    assert.equal(options.body.get('client_secret'),'synthetic-oauth-secret');
    assert.equal(options.body.get('redirect_uri'),'https://imortais.macknacloud.com.br/auth/callback');
    return {json:async()=>({access_token:'synthetic-provider-access-token'})};
  }
  assert.equal(options.headers.Authorization,'Bearer synthetic-provider-access-token');
  if (String(raw)==='https://discord.com/api/users/@me') return {json:async()=>({id:'000000000000000002',username:'SyntheticOAuthMember'})};
  if (String(raw)==='https://discord.com/api/users/@me/guilds/683411304408416285/member') return {ok:member,json:async()=>({roles:[config.staff_role_id]})};
  throw new Error('External provider request forbidden');
};
function request(path,{method='GET',cookie,headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:3000,path,method,headers:{...headers,...(cookie?{Cookie:cookie}:{})}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',x=>raw+=x);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw}));
    });req.setTimeout(10000,()=>req.destroy(new Error('HTTP timeout')));req.on('error',reject);req.end();
  });
}
(async()=>{
  const {db,backend}=await start(config);
  assert.equal(backend.address().address,'127.0.0.1');
  assert.equal((await request('/')).status,200);assert.match((await request('/')).raw,/VALIDAÇÃO DO LOGIN/);
  const logo=await request('/assets/imortais-war-room-logo.png');assert.equal(logo.status,200);
  assert.equal((await request('/api/events')).status,401);
  assert.equal((await request('/api/health')).status,503);
  assert.equal((await request('/auth/callback?state=wrong&code=wrong')).status,400);assert.equal(calls,0);
  async function login(){
    const first=await request('/auth/login');assert.equal(first.status,302);
    const state=new URL(first.headers.location).searchParams.get('state');
    const path='/auth/callback?code=synthetic&state='+state;
    const result=await request(path);assert.equal(result.status,302);
    const cookie=result.headers['set-cookie'][0];
    for (const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/']) assert.ok(cookie.includes(flag));
    assert.equal(result.headers['referrer-policy'],'no-referrer');
    assert.equal((await request(path)).status,400);
    return cookie.split(';')[0];
  }
  const cookie=await login();
  const me=JSON.parse((await request('/auth/me',{cookie})).raw);assert.equal(me.logged,true);assert.equal(me.member,true);
  assert.equal((await request('/api/events',{cookie})).status,200);
  const event=(await db.pool.query('SELECT id FROM cta_events ORDER BY id LIMIT 1')).rows[0];
  assert.ok(event);assert.equal((await request('/api/roster?event='+event.id,{cookie})).status,200);
  for (const path of ['/api/cta/open','/api/cta/finish','/api/move','/api/telemetry/ingest','/api/telemetry/pair','/api/telemetry/pairing/create'])
    assert.equal((await request(path,{method:'POST',cookie})).status,403);
  for (const path of ['/api/telemetry/context','/api/telemetry/agents','//evil.example/','/%61uth/login','/assets/../auth/login','http://evil.example/'])
    assert.equal((await request(path,{cookie})).status,403);
  const fake=cookie.slice(0,-1)+(cookie.endsWith('a')?'b':'a');
  assert.equal(JSON.parse((await request('/auth/me',{cookie:fake})).raw).logged,false);
  // Removing default_transaction_read_only cannot confer SQL write privileges.
  const connection=await db.pool.connect();
  try {
    await connection.query('SET default_transaction_read_only=off');
    await assert.rejects(connection.query('UPDATE cta_events SET status=status WHERE false'),{code:'42501'});
    await assert.rejects(connection.query('CREATE TABLE public.validation_forbidden(id int)'),{code:'42501'});
    await assert.rejects(connection.query("SELECT nextval('cta_events_id_seq')"),{code:'42501'});
    await connection.query('SET default_transaction_read_only=on');
  } finally {connection.release();}
  const appUrl=new URL(config.database_url);appUrl.pathname='/app';
  const other=new Pool({connectionString:String(appUrl),ssl:false});
  try {await assert.rejects(other.query('SELECT note FROM sentinel'),{code:'42501'});} finally {await other.end();}
  const goodHealth=JSON.parse((await request('/health')).raw);
  assert.equal(goodHealth.oauthMember,true);assert.ok(goodHealth.oauthCallbackAt);assert.equal(goodHealth.botStarted,false);
  member=false;const outsider=await login();assert.equal((await request('/api/events',{cookie:outsider})).status,403);
  assert.equal(calls,6);
  assert.equal((await request('/auth/logout',{cookie})).status,302);
  await assert.rejects(global.fetch('https://discord.com/api/v10/gateway'),/oauth_destination_blocked/);
  await stop();
  process.stdout.write('OAUTH_VALIDATION_CI_OK: real readonly clone role, cross-database/write/sequence denial, unmodified OAuth handlers with provider mock, secure cookies/state/member checks, restricted browser gateway; no live provider or bot.\n');
})().catch(async error=>{process.stderr.write('OAUTH_VALIDATION_CI_FAILED: '+error.stack+'\n');await stop().catch(()=>{});process.exitCode=1;});
