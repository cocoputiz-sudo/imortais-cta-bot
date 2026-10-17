"use strict";
// Real HTTP handlers/Postgres, with a synthetic OAuth provider and no bot token.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const Module = require("node:module");
const {once} = require("node:events");
let db, backend, bridge, stage="guard";
const streams=[];
console.log=console.info=(...args)=>console.error(...args);
setTimeout(()=>{console.error("WEB_PROBE_DEADLINE");process.exit(1);},120000).unref();

function request(base,path,{method="GET",body,cookie,headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const data=body===undefined?undefined:JSON.stringify(body);
    const req=http.request(base+path,{method,headers:{...(data?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)}:{}),...(cookie?{Cookie:cookie}:{}),...headers}},res=>{
      let raw="";
      res.setEncoding("utf8");
      res.on("data",chunk=>{raw+=chunk;if(raw.length>5*1024**2)res.destroy(new Error("response too large"));});
      res.on("error",reject);
      res.on("end",()=>{let json;try{json=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,raw,json});});
    });
    req.setTimeout(15000,()=>req.destroy(new Error("HTTP timeout")));
    req.on("error",reject);req.end(data);
  });
}

async function stream(base,path,cookie) {
  const state={frames:[],error:null};
  await new Promise((resolve,reject)=>{
    state.request=http.get(base+path,{headers:{Cookie:cookie}},res=>{
      state.response=res;
      if(res.statusCode!==200){res.resume();reject(new Error("SSE status"));return;}
      assert.match(res.headers["content-type"],/text\/event-stream/);
      let buffer="";
      res.setEncoding("utf8");
      res.on("data",chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf("\n\n"))>=0){state.frames.push(buffer.slice(0,end));buffer=buffer.slice(end+2);}if(buffer.length>1024**2)res.destroy();});
      res.on("error",error=>{state.error=error;});
      resolve();
    });
    state.request.on("error",reject);
  });
  state.wait=async predicate=>{
    const deadline=Date.now()+35000;
    while(Date.now()<deadline){
      const frame=state.frames.find(predicate);
      if(frame!==undefined)return frame;
      if(state.error)throw state.error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error("SSE frame timeout");
  };
  streams.push(state);return state;
}

async function main() {
  assert.equal(Number(process.versions.node.split(".")[0]),22);
  assert.ok(!process.env.DISCORD_TOKEN&&!process.env.DISCORD_CLIENT_SECRET&&!process.env.SESSION_SECRET&&!process.env.TELEMETRY_INGEST_KEY);
  const input=JSON.parse(fs.readFileSync(0,"utf8")),url=new URL(input.database_url);
  assert.equal(url.protocol,"postgresql:");
  assert.match(input.database,/^imortais_rehearsal_[0-9]{14}_[0-9a-f]{6}$/);
  assert.equal(url.hostname,"postgres18.imortais-producao.internal");assert.equal(url.port,"5432");
  assert.equal(url.username,"imortais_app");assert.equal(url.pathname,"/"+input.database);
  const guild="683411304408416285",user="000000000000000002",callback="https://cta-imortais.up.railway.app/auth/callback";
  Object.assign(process.env,{DATABASE_URL:input.database_url,PGSSL:"disable",PORT:"0",GUILD_ID:guild,
    DISCORD_CLIENT_ID:"1541617852056862801",DISCORD_CLIENT_SECRET:"synthetic-oauth-secret",
    SESSION_SECRET:crypto.randomBytes(32).toString("hex"),TELEMETRY_INGEST_KEY:crypto.randomBytes(32).toString("hex"),
    OAUTH_REDIRECT:callback});
  const originalLoad=Module._load;
  Module._load=function(name,parent,isMain){
    if(name==="discord.js"||/(?:^|\/)src\/index(?:\.js)?$/.test(name))throw new Error("Bot module blocked");
    return originalLoad.call(this,name,parent,isMain);
  };
  // OAuth is a local provider double: NEVER send a code/credential to Discord.
  let member=true,mockCalls=0;
  global.fetch=async(raw,opts={})=>{
    mockCalls++;
    const endpoint=String(raw);
    if(endpoint==="https://discord.com/api/oauth2/token"){
      assert.equal(opts.body.get("client_secret"),"synthetic-oauth-secret");assert.equal(opts.body.get("redirect_uri"),callback);
      return {ok:true,json:async()=>({access_token:"synthetic-provider-token"})};
    }
    if(endpoint==="https://discord.com/api/users/@me")return {ok:true,json:async()=>({id:user,username:"MigrationProbe"})};
    if(endpoint===`https://discord.com/api/users/@me/guilds/${guild}/member`)return {ok:member,json:async()=>({roles:[]})};
    throw new Error("External fetch blocked");
  };
  const realRequest=http.request;
  http.request=function(...args){
    const first=args[0],host=typeof first==="string"?new URL(first).hostname:first instanceof URL?first.hostname:first.hostname||first.host;
    assert.equal(host,"127.0.0.1");return realRequest.apply(this,args);
  };
  https.request=()=>{throw new Error("External HTTPS blocked");};
  db=require("./src/db");
  const identity=(await db.pool.query("SELECT current_database() AS database,current_user AS role FROM pg_roles WHERE rolname=current_user AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole")).rows[0];
  assert.equal(identity.database,input.database);assert.equal(identity.role,"imortais_app");
  stage="schema";await db.init();await db.init();
  const telemetry=require("./src/telemetry");await telemetry.initSchema(db.pool);
  const web=require("./src/web");
  const fakeClient={isReady:()=>false,guilds:{cache:new Map([[guild,{id:guild,ownerId:user,roles:{cache:new Map()}}]])}};
  backend=web.startWebServer(fakeClient,{});await once(backend,"listening");
  const {createBridge}=require("./bridge.cjs");
  bridge=createBridge(new URL("http://127.0.0.1:"+backend.address().port),true);
  bridge.listen(0,"127.0.0.1");await once(bridge,"listening");
  const base="http://127.0.0.1:"+bridge.address().port;
  stage="page-health";
  assert.equal((await request(base,"/")).status,200);
  assert.match((await request(base,"/")).raw,/War Room/);
  const logo=await request(base,"/assets/imortais-war-room-logo.png");assert.equal(logo.status,200);assert.match(logo.headers["content-type"],/image\/png/);
  const health=await request(base,"/api/health");assert.equal(health.status,503);assert.equal(health.json.database,true);assert.equal(health.json.discord,false);
  assert.equal((await request(base,"/api/events")).status,401);
  assert.equal((await request(base,"/api/telemetry/stream?event=1")).status,401);
  stage="oauth";
  assert.equal((await request(base,"/auth/callback?code=synthetic&state=invalid")).status,400);
  async function login(){
    const start=await request(base,"/auth/login");assert.equal(start.status,302);
    const target=new URL(start.headers.location);assert.equal(target.origin,"https://discord.com");
    assert.equal(target.searchParams.get("redirect_uri"),callback);
    const path="/auth/callback?code=synthetic&state="+target.searchParams.get("state");
    const result=await request(base,path);assert.equal(result.status,302);
    assert.equal((await request(base,path)).status,400);
    const setCookie=result.headers["set-cookie"][0];
    for(const flag of ["HttpOnly","Secure","SameSite=Lax","Path=/"])assert.ok(setCookie.includes(flag));
    return setCookie.split(";")[0];
  }
  const cookie=await login();assert.equal((await request(base,"/auth/me",{cookie})).json.member,true);
  const tampered=cookie.slice(0,-1)+(cookie.endsWith("a")?"b":"a");
  assert.equal((await request(base,"/auth/me",{cookie:tampered})).json.logged,false);
  member=false;const outsider=await login();assert.equal((await request(base,"/api/events",{cookie:outsider})).status,403);member=true;
  stage="roster-sse";
  const cta=await db.createEvent({guildId:guild,channelId:"000000000000000001",callerId:user,timeLabel:"migration-http-probe"});
  const roster=await request(base,"/api/roster?event="+cta.id,{cookie});assert.equal(roster.status,200);assert.equal(String(roster.json.event.id),String(cta.id));
  const rosterStream=await stream(base,"/api/stream?event="+cta.id,cookie);
  await rosterStream.wait(f=>f.startsWith("data:")&&f.includes("migration-http-probe"));
  await db.pool.query("UPDATE cta_events SET time_label='migration-http-updated' WHERE id=$1",[cta.id]);await web.notifyRosterChange(cta.id);
  await rosterStream.wait(f=>f.includes("migration-http-updated"));
  stage="pairing";
  const device="migration-http-"+crypto.randomBytes(8).toString("hex");
  const created=await request(base,"/api/telemetry/pairing/create",{method:"POST",cookie,body:{label:"Migration HTTP rehearsal",playerName:"MigrationProbe"}});assert.equal(created.status,200);
  const pairBody={code:created.json.code,deviceId:device,playerName:"MigrationProbe"};
  const pair=await request(base,"/api/telemetry/pair",{method:"POST",body:pairBody});assert.equal(pair.status,200);assert.match(pair.json.token,/^imt_/);
  assert.equal((await request(base,"/api/telemetry/pair",{method:"POST",body:pairBody})).status,401);
  const authorization="Bearer "+pair.json.token;
  const context=await request(base,"/api/telemetry/context?deviceId="+device+"&playerName=MigrationProbe",{headers:{Authorization:authorization}});
  assert.equal(context.status,200);assert.equal(context.json.credentialMode,"paired");assert.ok(context.json.cta);
  const active=String(context.json.cta.id);
  const teleStream=await stream(base,"/api/telemetry/stream?event="+active,cookie);await teleStream.wait(f=>f.includes('"kind":"ready"'));
  stage="ingest";
  const eventId=crypto.randomUUID(),body={device:{deviceId:device,playerName:"MigrationProbe",version:"migration-rehearsal"},ctaEventId:active,
    events:[{eventId,type:"heartbeat",occurredAt:new Date().toISOString(),payload:{currentCtaId:active,currentMap:"MigrationProbe"}}]};
  assert.equal((await request(base,"/api/telemetry/ingest",{method:"POST",body})).status,401);
  const ingest=await request(base,"/api/telemetry/ingest",{method:"POST",body,headers:{Authorization:authorization}});assert.equal(ingest.status,200);assert.equal(ingest.json.inserted,1);
  const count=await db.pool.query("SELECT count(*)::int AS n FROM albion_telemetry_events WHERE event_id=$1",[eventId]);assert.equal(count.rows[0].n,1);
  const duplicate=await request(base,"/api/telemetry/ingest",{method:"POST",body,headers:{Authorization:authorization}});assert.equal(duplicate.status,200);assert.equal(duplicate.json.duplicate,1);assert.equal(duplicate.json.inserted,0);
  await teleStream.wait(f=>f.includes(device)&&f.includes('"inserted":1'));
  stage="pair-limit";
  let limited=false;
  for(let i=0;i<9;i++){
    const response=await request(base,"/api/telemetry/pair",{method:"POST",body:pairBody,headers:{"X-Forwarded-For":"203.0.113."+(i+1)}});
    assert.ok([401,429].includes(response.status));if(response.status===429){assert.ok(Number(response.headers["retry-after"])>0);limited=true;break;}
  }
  assert.ok(limited);
  stage="heartbeat";
  await Promise.all([rosterStream.wait(f=>f.startsWith(":")),teleStream.wait(f=>f.startsWith(":"))]);
  const logout=await request(base,"/auth/logout",{cookie});assert.equal(logout.status,302);assert.match(logout.headers["set-cookie"][0],/Max-Age=0/);
  const report={status:"ok",database:input.database,role:identity.role,node:process.versions.node,db_init_runs:2,
    war_room_html:true,static_logo:true,http_bridge_local:true,oauth_mock_flow:true,cookie_flags:true,invalid_state_rejected:true,
    nonmember_rejected:true,forged_cookie_rejected:true,roster_sse:true,telemetry_ingest_persisted:true,telemetry_deduplicated:true,
    telemetry_sse:true,sse_heartbeat:true,pairing_single_use:true,pairing_rate_limited:true,health_no_discord_503:true,
    oauth_mock_calls:mockCalls,oauth_provider_live:false,public_https_path_tested:false,public_client_ip_chain_tested:false,
    bot_started:false,discord_module_loaded:false,production_secrets_received:false,synthetic_records_only_in_clone:true};
  assert.ok(!Object.keys(require.cache).some(p=>/\/discord\.js\//.test(p)));
  return report;
}

main().then(async report=>{await cleanup();process.stdout.write(JSON.stringify(report));}).catch(async error=>{
  console.error("WEB_PROBE_ERROR: "+stage+": "+(error.code||error.name));await cleanup();process.exitCode=1;
});
async function cleanup(){
  for(const s of streams){s.response?.destroy();s.request?.destroy();}
  for(const server of [bridge,backend])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(db)await db.pool.end();
}
