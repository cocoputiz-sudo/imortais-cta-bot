'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {createGateway} = require('./runtime/oauth-gateway.cjs');
let backend,gate;
function request(base,path,{method='GET',headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const origin=new URL(base);
    const req=http.request({hostname:origin.hostname,port:origin.port,path,method,headers},res=>{
      let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw}));
    });req.on('error',reject);req.end();
  });
}
(async()=>{
  let hits=0;
  backend=http.createServer((req,res)=>{
    hits++;
    assert.equal(req.headers.authorization,undefined);
    assert.equal(req.headers['x-forwarded-for'],'127.0.0.1');
    assert.equal(req.headers.forwarded,undefined);
    assert.equal(req.headers.cookie,'sid=synthetic');
    res.writeHead(200,{'Content-Type':'text/html','Content-Length':26,'Set-Cookie':'sid=new; Secure; HttpOnly'});
    res.end('<html><body></body></html>');
  });backend.listen(0,'127.0.0.1');await once(backend,'listening');
  gate=createGateway(new URL('http://127.0.0.1:'+backend.address().port),{decorate:true});
  gate.listen(0,'127.0.0.1');await once(gate,'listening');const base='http://127.0.0.1:'+gate.address().port;
  const good=await request(base,'/',{headers:{Cookie:'sid=synthetic',Authorization:'Bearer must-not-forward',
    'X-Forwarded-For':'203.0.113.1',Forwarded:'for=203.0.113.1'}});
  assert.equal(good.status,200);assert.match(good.raw,/VALIDAÇÃO DO LOGIN/);
  assert.equal(good.headers['content-length'],undefined);assert.match(good.headers['set-cookie'][0],/HttpOnly/);
  for (const path of ['/api/telemetry/ingest','/api/telemetry/pair','/api/contributors/billing/send',
    '//example.com/','/%61uth/login','/assets/../auth/login'])
    assert.equal((await request(base,path)).status,403);
  assert.equal((await request(base,'/auth/callback',{method:'POST'})).status,403);
  assert.equal((await request(base,'/auth/login',{method:'HEAD'})).status,403);
  assert.equal((await request(base,'/auth/login',{headers:{'Content-Length':'1'}})).status,403);
  assert.equal(hits,1);
  for (let i=0;i<30;i++) assert.equal((await request(base,'/auth/login',{headers:{Cookie:'sid=synthetic'}})).status,200);
  assert.equal((await request(base,'/auth/login',{headers:{Cookie:'sid=synthetic','X-Forwarded-For':'198.51.100.9'}})).status,429);
  assert.equal(hits,31);
  await close();process.stdout.write('OAUTH_GATEWAY_OK: exact read-only paths, denied writes/encoded paths/GET bodies, cookies and banner, stripped credentials/forwarding, bounded login attempts.\n');
})().catch(async error=>{console.error(error);await close();process.exitCode=1;});
async function close(){for(const server of [gate,backend])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
