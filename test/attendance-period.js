"use strict";
const assert=require("assert").strict;
const db=require("../src/db");
const attendance=require("../src/attendance");
const period=require("../src/attendance-period");

async function main(){
  assert.equal(period.parsePeriod("27/09/2026","04/10/2026").days,7);
  assert.equal(period.parsePeriod("04/10/2026","11/10/2026").days,7);
  assert.equal(period.parsePeriod("27/09/2026","04/10/2026").lastLabel,"03/10/2026");
  assert.equal(period.parsePeriod("04/10/2026","11/10/2026").start.toISOString(),"2026-10-04T00:00:00.000Z");
  for(const [start,end] of [["31/02/2026","04/10/2026"],["27/09/2026","27/09/2026"],["04/10/2026","27/09/2026"],["27/09/26","04/10/2026"]])
    assert.throws(()=>period.parsePeriod(start,end),RangeError);

  const role=(id,name)=>({id,name});
  const guild={ownerId:"owner"};
  assert.ok(period.memberExclusionReason({id:"staff",roles:{cache:new Map([["1",role("1268568850971230331","Mestre de Guerra")]])}},guild));
  assert.ok(period.memberExclusionReason({id:"officer",roles:{cache:new Map([["2",role("123","Officer")]])}},guild));
  assert.ok(period.memberExclusionReason({id:"owner",roles:{cache:new Map()}},guild));
  assert.equal(period.memberExclusionReason({id:"player",roles:{cache:new Map([["3",role("456","Contribuinte")]])}},guild),null);
  const rows=[
    {user_id:"staff",username:"Staff",score:99,integral:10,parcial:0},
    {user_id:"offline",username:"Unresolved",score:95,integral:9,parcial:0},
    {user_id:"officer",username:"Officer",score:90,integral:8,parcial:0},
    {user_id:"player",username:"Player",score:80,integral:7,parcial:0},
    {user_id:"rapida",username:"Rápida",score:70,integral:0,parcial:0},
    {user_id:"other",username:"Other",score:60,integral:1,parcial:1}
  ];
  const memberMap={
    staff:{id:"staff",roles:{cache:new Map([["s",role("1268568850971230331","Mestre de Guerra")]])}},
    officer:{id:"officer",roles:{cache:new Map([["o",role("543","Officers")]])}},
    player:{id:"player",roles:{cache:new Map()}},
    other:{id:"other",roles:{cache:new Map()}}
  };
  const prize=await period.selectPrizeWinners(rows,guild,{fetchMember:async id=>{if(!memberMap[id])throw Error("not found");return memberMap[id];}});
  assert.deepEqual(prize.winners.map(r=>r.username),["Player","Other"]);
  assert.deepEqual(prize.excluded.map(r=>r.username),["Staff","Officer"]);
  assert.deepEqual(prize.unresolved.map(r=>r.username),["Unresolved"]);

  // CTA 01:20 de domingo 04/10 pertence ao dia operacional sábado 03/10.
  // CTA criado no sábado para 05/10 (segunda) não entra no intervalo encerrado 04/10.
  const events=[
    {id:1,guild_id:"g",created_at:new Date("2026-10-03T22:00:00Z"),time_label:"01:20",status:"closed",closed_at:new Date("2026-10-04T03:00:00Z")},
    {id:2,guild_id:"g",created_at:new Date("2026-10-04T11:00:00Z"),time_label:"17:20",status:"closed",closed_at:new Date("2026-10-04T19:10:00Z")},
    {id:3,guild_id:"g",created_at:new Date("2026-10-03T18:00:00Z"),time_label:"17:20",status:"closed",closed_at:new Date("2026-10-03T20:00:00Z")},
    {id:4,guild_id:"g",created_at:new Date("2026-09-26T22:00:00Z"),time_label:"17:20",status:"closed",closed_at:new Date("2026-09-27T19:00:00Z")},
    {id:5,guild_id:"g",created_at:new Date("2026-10-03T21:00:00Z"),time_label:"01:20",status:"cancelled"}
  ];
  // A janela real do CTA 26/09 às 17:20 é 27/09 se criado após 19:20.
  events[3].created_at=new Date("2026-09-26T22:00:00Z");
  const saved={getEventsInRange:db.getEventsInRange,getSignupsForEvents:db.getSignupsForEvents,
    getBombConfirmsForEvents:db.getBombConfirmsForEvents,getPresenceInRange:db.getPresenceInRange};
  try {
    db.getEventsInRange=async(g,start,end)=>events.filter(ev=>ev.created_at>=start&&ev.created_at<=end);
    db.getSignupsForEvents=async()=>[];
    db.getBombConfirmsForEvents=async()=>[];
    db.getPresenceInRange=async()=>[];
    const first=period.parsePeriod("27/09/2026","04/10/2026");
    const second=period.parsePeriod("04/10/2026","11/10/2026");
    const r1=await attendance.buildReportForOperationalPeriod("g",first.start,first.end);
    const r2=await attendance.buildReportForOperationalPeriod("g",second.start,second.end);
    assert.deepEqual(r1.events.map(e=>e.id).sort((a,b)=>a-b),[1,3,4]);
    assert.deepEqual(r2.events.map(e=>e.id),[2]);
    assert.equal(r1.ctaCount,3);assert.equal(r2.ctaCount,1);
  } finally {Object.assign(db,saved);}
  console.log("✅ Attendance period/ranking: TODOS OS TESTES PASSARAM");
}
main().catch(e=>{console.error("❌ Attendance period:",e);process.exitCode=1;});
