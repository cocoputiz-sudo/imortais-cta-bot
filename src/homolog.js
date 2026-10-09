"use strict";
// Standalone staging server. Does not connect to Discord, production DB or production War Room.
if(process.env.HOMOLOG_MODE!=="1")throw Error("homolog-only entrypoint");
const crypto=require("crypto");
const express=require("express");
const db=require("./db");
const telemetry=require("./telemetry");
const challenge=require("./guildChallengeStore");
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
app.get("/",(_req,res)=>res.type("html").send(PAGE));
const PAGE=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IMORTAIS — HOMOLOGAÇÃO Guild Might</title><style>
body{background:#101821;color:#edf3f9;font:14px Arial,sans-serif;max-width:1300px;margin:0 auto;padding:24px}
h1{color:#e1ae62}h2{margin-top:25px}small,.muted{color:#9cacbc}
button{background:#263648;color:#fff;border:1px solid #5e7590;border-radius:8px;padding:12px;cursor:pointer}
button.selected{border-color:#e1ae62;color:#e1ae62}
#cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:9px}
#cards button{text-align:left;min-height:85px}
table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #334354;text-align:left;padding:8px}
.grid{display:flex;gap:18px;flex-wrap:wrap}.panel{background:#192534;border:1px solid #334353;padding:14px;border-radius:10px;margin:12px 0}
.stale{color:#eab16a}input{background:#1b2b3e;color:white;padding:10px;border:1px solid #536070}
</style></head><body><h1>IMORTAIS · Homologação Guild Might</h1><div class="panel"><b>Fase B — chave de envio exclusivo à homologação</b><p class="muted">Somente dispositivo WORKSPACEIGOR / jogador BadMack. Ao gerar uma nova chave, a anterior deixa de funcionar.</p>
<button type="button" onclick="issueToken()">Gerar chave temporária WORKSPACEIGOR</button>
<input id="tokenOutput" type="password" autocomplete="off" readonly placeholder="Chave aparece apenas uma vez aqui" size="48">
<button type="button" onclick="copyToken()">Copiar chave</button></div><p class="muted">Ambiente separado de produção • snapshots Photon de teste • nenhuma informação é enviada ao Discord</p>
<p id="status">Carregando...</p><div class="panel" id="qaArrivals">WORKSPACEIGOR: aguardando primeiros eventos de homologação.</div><div class="grid"><div class="panel" id="overall"></div><div class="panel" id="challenge"></div></div>
<h2>Categorias de Might (14)</h2><div id="cards"></div><h2 id="heading">Selecione uma categoria</h2>
<input id="filter" placeholder="Buscar jogador" aria-label="Buscar jogador" oninput="renderRank()">
<div id="rank"></div><script>
async function issueToken(){
 if(!confirm("Revogar a chave anterior e gerar uma nova, exclusivamente para WORKSPACEIGOR?"))return;
 const r=await fetch("/api/homolog/issue-client-token",{method:"POST"});
 if(!r.ok){alert("Erro de autorização ou servidor: "+r.status);return}
 const j=await r.json();document.getElementById("tokenOutput").value=j.token;
}
function copyToken(){const input=document.getElementById("tokenOutput");if(!input.value){alert("Gere a chave primeiro");return};navigator.clipboard.writeText(input.value).then(()=>alert("Chave copiada")).catch(()=>{input.type="text";input.select();alert("Copie a chave selecionada")})}
let d={categories:[]},ch={},pick=null;
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=x=>Number(x||0).toLocaleString("pt-BR");
const when=x=>x?new Date(x).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}):"não informado";
async function load(){
 try{const [a,b]=await Promise.all([fetch("/api/telemetry/guild-might?days=90").then(r=>r.json()),fetch("/api/homolog/challenge").then(r=>r.json())]);
 fetch("/api/homolog/device-arrivals").then(r=>r.json()).then(q=>{
  document.getElementById("qaArrivals").innerHTML=
    "<b>WORKSPACEIGOR — dados recebidos neste ambiente: "+fmt(q.received)+"</b> "+
    (q.operations||[]).map(op=>"<div>"+esc(op.operation)+": "+fmt(op.n)+
    " eventos · recebido "+esc(when(op.last_received_at))+"</div>").join("");
 }).catch(()=>{});
 d=a;ch=b;document.getElementById("status").textContent="Último Might: "+when(a.meta?.newestAt)+" • Challenge: "+when(b.capturedAt);
 document.getElementById("overall").textContent="Might: "+(a.categories||[]).length+"/14 categorias";
 document.getElementById("challenge").textContent="Challenge: "+fmt(b.observedMembers)+"/"+fmt(b.expectedMembers)+" recentes • "+fmt(b.historicalObservedMembers)+" históricos";
 document.getElementById("cards").innerHTML=(a.categories||[]).map((c,i)=>'<button onclick="choose('+i+')" class="'+(pick===i?"selected":"")+'"><b>'+esc(c.category?.name)+'</b><br><small>'+esc(c.layout?.code||"ID indisponível")+' · '+fmt(c.observedMembers)+'/'+fmt(c.totalMembers)+' recentes<br>Histórico: '+fmt(c.historicalObservedMembers)+' • '+esc(when(c.capturedAt))+'</small></button>').join("")+'<button onclick="choose(-1)">🔑 Guild Challenge<br><small>'+fmt(b.observedMembers)+'/'+fmt(b.expectedMembers)+' recentes</small></button>';
 if(pick===null)pick=-1;renderRank();
 }catch(e){document.getElementById("status").textContent="Erro ao consultar homologação: "+e.message}
}
function choose(i){pick=i;load()}
function renderRank(){
 const isChallenge=pick===-1;const item=isChallenge?ch:d.categories?.[pick];if(!item)return;
 const nm=isChallenge?"Guild Challenge":item.category?.name;
 document.getElementById("heading").textContent=nm+" — "+fmt(item.observedMembers)+" de "+fmt(isChallenge?item.expectedMembers:item.totalMembers)+" recentes; "+fmt(item.historicalObservedMembers)+" históricos";
 const filter=document.getElementById("filter").value.toLowerCase();
 const recent=(item.members||[]).map(m=>({...m,stale:false}));
 const older=(item.historicalMembers||[]).map(m=>({...m,stale:true}));
 const arr=[...recent,...older].filter(m=>String(m.player).toLowerCase().includes(filter));
 document.getElementById("rank").innerHTML='<table><thead><tr><th>Pos. observada</th><th>Jogador</th><th>Valor</th><th>Capturado (Brasília)</th><th>Status</th></tr></thead><tbody>'+arr.map(m=>'<tr><td>'+fmt(m.rank)+'</td><td>'+esc(m.player)+'</td><td>'+fmt(isChallenge?m.points:m.might)+'</td><td>'+esc(when(m.capturedAt))+'</td><td class="'+(m.stale?'stale':'')+'">'+(m.stale?'DESATUALIZADO':'RECENTE')+'</td></tr>').join("")+'</tbody></table>';
}
load();
</script></body></html>`;
(async()=>{await db.init();await telemetry.initSchema(db.pool);telemetry.installRoutes(app,{db,requireMember:permit,requireEditor:permit,requireDeviceManager:permit,requireAdmin:permit});const port=Number(process.env.PORT||3000);app.listen(port,"0.0.0.0",()=>console.log("isolated homolog listening",port))})().catch(e=>{console.error("homolog boot:",e.message);process.exit(1)});
