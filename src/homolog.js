"use strict";
// Standalone staging server. Does not connect to Discord, production DB or production War Room.
if(process.env.HOMOLOG_MODE!=="1")throw Error("homolog-only entrypoint");
const crypto=require("crypto");
const express=require("express");
const db=require("./db");
const telemetry=require("./telemetry");
const challenge=require("./guildChallengeStore");
const web=require("./web");
const app=express();app.set("trust proxy",1);
app.use(express.json({limit:"12mb"}));
const viewer=process.env.HOMOLOG_VIEW_TOKEN;
if(!viewer||!process.env.TELEMETRY_INGEST_KEY||!process.env.DATABASE_URL)throw Error("Missing isolated staging secrets");
const safe=(a,b)=>{const aa=Buffer.from(a||""),bb=Buffer.from(b||"");return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)};
function readAuth(req,res,next){
  const raw=String(req.get("authorization")||"");
  if(raw.startsWith("Basic ")){
    try{const pair=Buffer.from(raw.slice(6),"base64").toString("utf8");
      if(safe(pair,"igor:"+viewer))return next();}catch(_){}
  }
  res.set("WWW-Authenticate",'Basic realm="IMORTAIS Homolog"');
  return res.status(401).send("Homologacao privada: login necessario");
}
function permit(req,res){return {isMember:true,isSiteAdmin:true};}
app.get("/api/health",(_req,res)=>res.json({ok:true,homolog:true}));
app.use((req,res,next)=>{
  if(req.method==="POST"&&req.path==="/api/telemetry/ingest")return next();
  return readAuth(req,res,next);
});
// Initialized inside boot after the staging schema is ready.
app.post("/api/homolog/issue-client-token", async(req,res)=>{
 try {
   // This route is behind the homolog-only HTTP Basic authentication.
   // Bound to the test machine, never to the master production credential.
   const token="imt_"+crypto.randomBytes(32).toString("base64url");
   const hash=crypto.createHash("sha256").update(token).digest("hex");
   const client=await db.pool.connect();
   try {
     await client.query("BEGIN");
     await client.query("UPDATE albion_telemetry_agent_tokens SET revoked_at=now() "+
       "WHERE label='WORKSPACEIGOR-HOMOLOG' AND revoked_at IS NULL");
     await client.query("INSERT INTO albion_telemetry_agent_tokens "+
       "(token_hash,label,device_id,player_name) VALUES($1,'WORKSPACEIGOR-HOMOLOG','WORKSPACEIGOR','BadMack')",[hash]);
     await client.query("COMMIT");
   } catch(e) {await client.query("ROLLBACK");throw e} finally {client.release()}
   res.set("Cache-Control","no-store").json({ok:true,token,deviceId:"WORKSPACEIGOR",
     note:"Chave restrita à homologação. Ao gerar outra, a anterior é revogada."});
 }catch(e){console.error("issue-client-token",e.message);res.status(500).json({error:"server"})}
});
app.post("/api/homolog/materialize",async(req,res)=>{
 try{const r=await telemetry.materializeGuildMightRecent({minutes:5000,limit:10000});res.json(r)}
 catch(e){console.error("materialize",e.message);res.status(500).json({error:"materialize"})}
});
app.get("/api/homolog/device-arrivals",async(req,res)=>{
 try{
  const r=await db.pool.query(
   "SELECT COALESCE(payload->>'operationName','?') AS operation, COUNT(*)::int AS n, "+
   "MAX(received_at) AS last_received_at FROM albion_telemetry_events "+
   "WHERE device_id='WORKSPACEIGOR' AND type='guild_might_probe' "+
   "GROUP BY COALESCE(payload->>'operationName','?') ORDER BY operation");
  res.json({deviceId:"WORKSPACEIGOR",operations:r.rows,
   received:r.rows.reduce((sum,x)=>sum+Number(x.n),0)});
 }catch(e){console.error("qa arrivals",e.message);res.status(500).json({error:"server"})}
});
app.get("/api/homolog/challenge",async(req,res)=>{try{res.json(await challenge.getDashboard(db.pool,{days:90}))}catch(e){res.status(500).json({error:"challenge"})}});

app.get("/api/homolog/legacy-plan",async(req,res)=>{
 try{
  const {planLegacyRepair}=require("./guildLegacyRepair");
  const plan=await planLegacyRepair(db.pool,{limit:20000});
  res.set("Cache-Control","no-store").json({
   dryRun:true,eligible:plan.eligible.length,quarantined:plan.quarantined.length,
   quarantineReasons:plan.quarantined.reduce((a,r)=>{a[r.reason]=(a[r.reason]||0)+1;return a;},{}),
   sampleEligible:plan.eligible.slice(0,15).map(x=>({snapshotId:x.snapshotId,code:x.code,oldCategory:x.oldCategory})),
   note:"Nenhum banco foi modificado. Aplicação futura exige autorização expressa."});
 }catch(e){console.error("homolog legacy plan",e.message);res.status(500).json({error:"legacy_plan"});}
});

// Exact production War Room HTML/JS, with isolated homolog-only authentication.
// No Discord OAuth, production DB, or CTA mutations are available here.
app.get("/auth/me",(_req,res)=>res.json({
  logged:true,member:true,canEdit:true,canManageDevices:false,
  canManageBomb:false,canManageCastleRoaming:false,isSiteAdmin:true,
  name:"BadMack · HOMOLOG"
}));
app.get("/api/events",(_req,res)=>res.json([]));
app.get("/api/news",(_req,res)=>res.json([]));
app.get("/auth/logout",(_req,res)=>res.redirect("/"));
app.get("/",(_req,res)=>res.type("html").send(web.renderWarRoomPage()));
(async()=>{await db.init();await telemetry.initSchema(db.pool);telemetry.installRoutes(app,{db,requireMember:permit,requireEditor:permit,requireDeviceManager:permit,requireAdmin:permit});const port=Number(process.env.PORT||3000);app.listen(port,"0.0.0.0",()=>console.log("isolated homolog listening",port))})().catch(e=>{console.error("homolog boot:",e.message);process.exit(1)});
