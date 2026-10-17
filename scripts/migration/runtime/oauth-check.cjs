'use strict';
// Local readiness only: never follows redirects or exchanges an OAuth code.
const http = require('node:http');
const assert = require('node:assert/strict');
function get(path,method='GET') {
  return new Promise((resolve,reject)=>{
    const req=http.request('http://127.0.0.1:3000'+path,{method},res=>{
      let body='';res.setEncoding('utf8');res.on('data',x=>body+=x);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.setTimeout(10000,()=>req.destroy(new Error('timeout')));req.on('error',reject);req.end();
  });
}
(async()=>{
  const health=await get('/health'), state=JSON.parse(health.body);
  assert.equal(health.status,200);assert.equal(state.mode,'oauth-validation');assert.equal(state.database,true);
  assert.equal(state.readOnly,true);assert.equal(state.botStarted,false);assert.equal(state.discord,false);
  assert.equal(state.discordModuleLoaded,false);assert.match(state.node,/^22\./);
  assert.equal((await get('/api/events')).status,401);
  assert.equal((await get('/api/telemetry/context')).status,403);
  assert.equal((await get('/api/cta/open','POST')).status,403);
  assert.equal((await get('/auth/callback?code=invalid&state=invalid')).status,400);
  const login=await get('/auth/login');assert.equal(login.status,302);
  const target=new URL(login.headers.location);assert.equal(target.origin,'https://discord.com');
  assert.equal(target.searchParams.get('client_id'),'1541617852056862801');
  assert.equal(target.searchParams.get('redirect_uri'),'https://imortais.macknacloud.com.br/auth/callback');
  const page=await get('/');assert.equal(page.status,200);assert.match(page.body,/VALIDAÇÃO DO LOGIN/);
  process.stdout.write(JSON.stringify({...state,localChecksPassed:true,oauthBrowserFlowTested:false}));
})().catch(()=>{process.stderr.write('OAUTH_LOCAL_CHECK_FAILED\n');process.exitCode=1;});
