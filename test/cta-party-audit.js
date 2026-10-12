"use strict";

const assert = require("node:assert/strict");
const { normName, findSignupCollisions } = require("../src/playerName");
const { buildPartyObservations } = require("../src/partyAudit");
const telemetry = require("../src/telemetry");

const NOW = Date.now();
const at = ms => new Date(NOW + ms).toISOString();
const signup = (username,id,party,slot=0) => ({
  username,user_id:id,party_index:party,slot_index:slot,weapon:"GOLEM"
});
const snap = (device,observer,members,receivedAgo=2_000,heartbeatAgo=2_000,occurredOffset=-2_000) => ({
  device_id:device, player_name:observer, payload:{members},
  occurred_at:at(occurredOffset),received_at:at(-receivedAgo),
  heartbeat_received_at:heartbeatAgo===null?null:at(-heartbeatAgo)
});
async function confirm(signups, snapshots, voice=[], partys=[0,1]) {
  const pool = {query:async sql=>{
    if(sql.includes("WHERE cta_event_id=$1 AND type='party_snapshot'"))return {rows:snapshots};
    if(sql.includes("FROM voice_presence"))return {rows:voice};
    return {rows:[]};
  }};
  telemetry.__test.setConfirmPoolForTests(pool);
  return telemetry.getConfirm({
    pool,
    getEvent:async()=>({id:162,guild_id:"G",time_label:"17:20",status:"open"}),
    getSignups:async()=>signups,
    parsePartyList:()=>partys
  },"162");
}
(async()=>{
  assert.equal(normName("![IM] ANGELXXOFC 😍"),"angelxxofc");
  assert.equal(normName("[IM] [ESP] ANGELXXOFC 🥳"),"angelxxofc");
  assert.equal(normName("ANGELXXOFC"),"angelxxofc");
  assert.equal(normName("ANGELXXOFC Outra"),"angelxxofc outra");
  assert.equal(normName("T4Flet-01"),"t4flet-01");
  assert.equal(normName("PLAYER_NAME"),"player_name");
  assert.equal(normName("ANDRE.1"),"andre.1");
  assert.equal(normName("A 😍"),"a 😍","nome curto inválido não pode ser truncado");
  assert.equal(findSignupCollisions([
    signup("![IM] ANGELXXOFC 😍","u-1",0),
    signup("[IM] ANGELXXOFC 🥳","u-2",0)
  ]).size,1);

  const normal=await confirm(
    [signup("![IM] ANGELXXOFC 😍","discord-123",0,17),signup("[IM] BadMack","discord-999",0,0)],
    [snap("dev-a","BadMack",["ANGELXXOFC","BadMack"])],
    [{user_id:"discord-123",username:"Nome Discord completamente diferente"},
     {user_id:"discord-999",username:"Outro apelido Discord"}]
  );
  assert.equal(normal.resumo.corretos,2);
  assert.equal(normal.resumo.foraParty,0);
  assert.equal(normal.resumo.jogoSemEscala,0);
  assert.equal(normal.gameNoSignup.length,0);
  assert.equal(normal.pts[0].linhas.find(x=>x.n.includes("ANGELXXOFC")).discord,true,"call por user_id");
  assert.equal(normal.issuesByParty[0].correct.length,2);
  assert.equal(normal.issuesByParty[0].coverage.activeDevices,1);
  console.log("✅ ANGELXXOFC: um jogador correto, sem intruso, sem falso não visto; Discord por ID");

  const conflict=await confirm([
    signup("![IM] ANGELXXOFC 😍","id-a",0,0),
    signup("![IM] ANGELXXOFC 🥳","id-b",0,1)
  ],[snap("dev-a","BadMack",["ANGELXXOFC","BadMack"])]);
  assert.equal(conflict.nameCollisions.length,1);
  assert.equal(conflict.resumo.colisoesNomes,1);
  assert.equal(conflict.resumo.corretos,0);
  assert.equal(conflict.resumo.foraParty,0);
  assert.equal(conflict.gameNoSignup.some(x=>normName(x.n)==="angelxxofc"),false);
  assert.equal(conflict.issuesByParty[0].collisions.length,2);
  console.log("✅ colisão retida: inscrições distintas, nenhum vínculo automático");

  const overlap=await confirm([
    signup("Alpha","a",0,0),signup("Beta","b",0,1),signup("Gamma","c",0,2)
  ],[
    snap("dev-a","Alpha",["Alpha","Beta"],3_000,1_000),
    snap("dev-b","Gamma",["Beta","Gamma"],1_000,1_000)
  ]);
  assert.equal(overlap.realParties.length,1,"listas sobrepostas são a mesma PT");
  assert.equal(overlap.realParties[0].devices,2);
  assert.equal(overlap.issuesByParty[0].coverage.activeDevices,2);
  assert.equal(overlap.resumo.corretos,3);
  console.log("✅ duas observações com composições diferentes da mesma PT unificadas");

  const historical=await confirm([signup("Alpha","a",0,0)],[
    snap("dev-a","Alpha",["Alpha","Beta"],300_000,300_000)
  ]);
  assert.equal(historical.pts[0].linhas[0].st,"stale");
  assert.equal(historical.pts[0].linhas[0].snapshotStale,true);
  assert.equal(historical.resumo.corretos,0);
  assert.equal(historical.resumo.foraParty,0);
  assert.equal(historical.issuesByParty[0].coverage.activeDevices,0);
  console.log("✅ heartbeat defasado: não atribui PT correta nem ausência definitiva");

  const reserve=await confirm([
    signup("Alpha","a",0,0),signup("Reserva","r",null,null)
  ],[snap("dev-a","Alpha",["Alpha","Reserva"])]);
  assert.equal(reserve.pts.find(g=>g.pt==="Reserva").linhas[0].st,"reserve");
  assert.equal(reserve.issuesByParty[0].reserves.length,1);
  assert.equal(reserve.gameNoSignup.length,0);
  console.log("✅ reserva dentro da party incluído na auditoria, não como intruso sem inscrição");

  const absentCoverage=await confirm([
    signup("Alpha","a",0,0),signup("Bravo","b",1,0)
  ],[snap("dev-a","Alpha",["Alpha","Other"])]);
  assert.equal(absentCoverage.pts.find(x=>x.pt==="PT 2").linhas[0].st,"unobserved");
  assert.equal(absentCoverage.resumo.semCobertura,1);
  assert.equal(absentCoverage.resumo.foraParty,0);
  console.log("✅ PT sem observador ativo não vira jogador ausente");

  const solo=await confirm([signup("Alpha","a",0,0)],[
    snap("dev-a","Alpha",["Alpha"])
  ]);
  assert.equal(solo.pts[0].linhas[0].st,"solo");
  assert.equal(solo.resumo.corretos,0);
  assert.equal(solo.issuesByParty[0].unidentified.length,1);
  const empty=await confirm([signup("Alpha","a",0,0)],[
    snap("dev-a","Alpha",[])
  ]);
  assert.equal(empty.resumo.jogo,0);
  assert.equal(empty.pts[0].linhas[0].st,"unobserved");
  console.log("✅ saída da PT: snapshot solo ou vazio não ressuscita a formação");

  const x=buildPartyObservations([
    snap("PT1","BadMack",["BadMack","ANGELXXOFC"],30_000,1000,120_000),
    snap("PT1new","Other",["ANGELXXOFC","Other"],1000,1000,-150_000)
  ],new Map([[1,new Set(["angelxxofc","badmack","other"])]]),{now:NOW});
  assert.equal(x.actualByName.get("angelxxofc").deviceId,"PT1new","usar received_at, não relógio local occurred_at");

  // Regressão: observador B retém composição antiga com q0 na PT1;
  // q0 migrou para PT2 e é visto mais recentemente pelo device C.
  const p = Array.from({length:18},(_,i)=>`p${i}`);
  const q = Array.from({length:9},(_,i)=>`q${i}`);
  const moveSnapshots = [
    snap("device-A","p0",p,5_000,1_000),
    snap("device-B","p1",[...p.slice(0,17),"q0"],120_000,1_000),
    snap("device-C","q0",q,5_000,1_000)
  ];
  const movePlan = new Map([
    [1,new Set(p)], [2,new Set(q)]
  ]);
  const moved = buildPartyObservations(moveSnapshots,movePlan,{now:NOW});
  assert.equal(moved.parties.length,2,"troca de PT não pode fundir clusters");
  assert.equal(moved.parties.find(x=>x.display===1).members.length,18,"PT1 sem q0 antigo");
  assert.equal(moved.parties.find(x=>x.display===2).members.length,9,"PT2 completa");
  assert.equal(moved.actualByName.size,27,"27 jogadores distintos sem duplicação");
  for (const name of q) {
    assert.equal(moved.actualByName.get(name).party,2,`${name} deve aparecer na PT2`);
    assert.equal(moved.actualByName.get(name).partyLabel,"PT 2");
  }
  assert.equal(moved.actualByName.get("q0").deviceId,"device-C",
    "received_at mais recente prevalece sobre snapshot do device B");
  const movedConfirm = await confirm([
    signup("p0","p0",0),signup("p17","p17",0),
    signup("q0","q0",1),signup("q8","q8",1)
  ],moveSnapshots);
  assert.equal(movedConfirm.realParties.length,2);
  assert.equal(movedConfirm.resumo.jogo,27);
  assert.equal(movedConfirm.resumo.corretos,4);
  assert.equal(movedConfirm.pts.find(x=>x.pt==="PT 2").linhas.find(x=>x.n==="q0").st,"ok");

  // B sem heartbeat fresco não une PTs nem reivindica quem já foi visto depois.
  const staleBridge = buildPartyObservations([
    moveSnapshots[0],
    snap("device-B","p1",[...p.slice(0,17),"q0","antigo"],120_000,120_000),
    moveSnapshots[2]
  ],movePlan,{now:NOW});
  assert.equal(staleBridge.parties.length,2);
  assert.equal(staleBridge.parties.find(x=>x.display===1).activeDevices.size,1);
  assert.equal(staleBridge.parties.find(x=>x.display===2).activeDevices.size,1);
  assert.equal(staleBridge.actualByName.get("q0").party,2);
  assert.equal(staleBridge.actualByName.get("p0").deviceId,"device-A");
  assert.equal(staleBridge.actualByName.get("antigo").stale,true,
    "membro sem captura posterior pode ser mantido, mas como defasado");
  console.log("✅ migração q0 PT1→PT2, sobreposição 50%, heartbeat e deduplicação global");

  // Recorte do CTA #162 às 17:50 UTC: dois dispositivos, PT1 (18) e PT2 (5),
  // sem interseção. A foto anterior com 19 jogadores é de OUTRO instante.
  const pt1Names=["A0roboros","amittere1","ANGELXXOFC","BadMack","Caiodogral2",
    "CamilleVegana","CascaGrossa57","Choujiro","Deathfake","girabel88",
    "HOCOKBCmeTaHe","HYPNOSBRO1","JANAILSONVT","Kodamm","Rafaeliz",
    "RodriguinhoGG","T4Flet","Zezinha1111"];
  const pt2Names=["Adiel85","Arterom","LordIMT","MeuAmigoTotoro","SrTURGAS"];
  const historicalCapture=await confirm([
    signup("![IM] ANGELXXOFC 😍","angel",0),signup("BadMack","mack",0),
    signup("Arterom","arter",1),signup("SrTURGAS","tur",1)
  ],[
    snap("WORKSPACEIGOR","BadMack",pt1Names),
    snap("DESKTOP-IV2U0RV","SrTURGAS",pt2Names)
  ]);
  assert.equal(historicalCapture.resumo.jogo,23);
  assert.equal(historicalCapture.realParties.length,2);
  assert.equal(historicalCapture.issuesByParty[0].coverage.activeDevices,1);
  assert.equal(historicalCapture.issuesByParty[1].coverage.activeDevices,1);
  assert.equal(historicalCapture.resumo.corretos,4);
  assert.equal(historicalCapture.gameNoSignup.some(x=>x.n==="ANGELXXOFC"),false);
  console.log("✅ fixture do CTA #162: 18 PT1 + 5 PT2, duas coberturas distintas, sem duplicações");

  const legacyFallback=await confirm([signup("Alpha","id-real",0,0)],[
    snap("dev","Alpha",["Alpha","Beta"])
  ],[{user_id:null,username:"Alpha"}]);
  assert.equal(legacyFallback.pts[0].linhas[0].discord,true,"fallback permitido só com ID ausente");
  const crossId=await confirm([signup("Alpha","id-real",0,0)],[
    snap("dev","Alpha",["Alpha","Beta"])
  ],[{user_id:"id-diferente",username:"Alpha"}]);
  assert.equal(crossId.pts[0].linhas[0].discord,false,"não unir IDs diferentes por nickname igual");
  console.log("✅ relógios divergentes e IDs Discord diferentes respeitados");

  console.log("✅ PR CTA partido: regressões concluídas");
})().catch(error=>{console.error(error);process.exitCode=1;});
