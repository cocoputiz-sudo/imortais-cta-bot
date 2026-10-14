"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const weekly=require("../src/contributorWeekly");
const cycles=require("../src/contributorCycle");
const {completeSweeps,selectPair,computeReport,contributorLevel,scheduledForWeek,validateSettings}=weekly;
const t=Date.parse("2026-10-10T15:00:00Z"),day=86400000,iso=x=>new Date(x).toISOString();
const page=(code,at,offset,items,deviceId="d1")=>({
 code,deviceId,capturedAt:iso(at),pageOffset:offset,totalMembers:4,
 members:items.map(([player,might],i)=>({player,might,rank:offset+i+1}))
});
const all=[
 page("PVE",t-8*day,0,[["A",10],["B",0]]),
 page("PVE",t-8*day+1000,2,[["C",20],["D",1]]),
 page("GATHERING",t-8*day,0,[["A",5],["B",0]]),
 page("GATHERING",t-8*day+1000,2,[["C",5],["D",5]]),
 page("PVE",t-1000,0,[["A",15],["B",0]]),
 page("PVE",t,2,[["C",20],["D",1]]),
 page("GATHERING",t-1000,0,[["A",5],["B",0]]),
 page("GATHERING",t,2,[["C",20],["D",5]])
];
const sweeps=completeSweeps(all);
assert.equal(sweeps.length,4);
assert.equal(selectPair(sweeps,"PVE").ready,true);
assert.equal(completeSweeps(all.slice(0,1)).length,0);
assert.equal(completeSweeps([page("PVE",t,0,[["A",1],["B",2]]),page("PVE",t+1000,2,[["C",3],["D",4]],"d2")]).length,0);
assert.equal(completeSweeps([page("PVE",t,0,[["A",1],["B",2]]),page("PVE",t+360000,2,[["C",3],["D",4]])]).length,0);
assert.equal(completeSweeps([page("PVE",t,0,[["A",1],["B",2]]),page("PVE",t+1000,2,[["A",3],["D",4]])]).length,0);
const cfg={minima:{"1":{pve:1,gathering:1},"2":{pve:10,gathering:10},"3":{pve:3,gathering:3}},reminderEnabled:false,weekday:0,timeUtc:"18:00"};
const roster={members:[
 {name:"A",roles:["CONTRIBUINTE 1"]},{name:"B",roles:["Contribuinte 2"]},
 {name:"C",roles:["CONTRIBUINTE 3"]},{name:"D",roles:["CONTRIBUINTE 1"]},
 {name:"Outsider",roles:["Mestre de Guerra"]},{name:"Unknown",roles:["Contribuinte 2"]}
],member_count:6,imported_at:iso(t-5000),imported_by:"staff"};
const report=computeReport({roster,settings:cfg,sweeps,now:new Date(t+1000)});
const status=Object.fromEntries(report.rows.map(x=>[x.player,x.status]));
assert.equal(report.rows.length,5);
assert.equal(status.A,"ATIVO");
assert.equal(status.B,"SEM EVOLUÇÃO");
assert.equal(status.C,"ATIVO");
assert.equal(status.D,"SEM EVOLUÇÃO");
assert.equal(status.Unknown,"SEM DADOS");
assert.equal(report.counts.active,2);
assert.equal(report.counts.below,2);
assert.equal(report.counts.noData,1);
assert.equal(report.stale,false);
assert.equal(computeReport({roster,settings:cfg,sweeps,now:new Date(t+9*day)}).stale,true);
assert.equal(contributorLevel(["Contribuinte 3"]),"3");
assert.equal(contributorLevel(["CONTRIBUINTE 4"]),"4");
assert.equal(contributorLevel(["CONTRIBUINTE 2","CONTRIBUINTE 4"]),null,
  "cargo conflitante nao interrompe a renderizacao do relatorio");
const ignoredRoster={members:[
  {name:"Invalido",roles:["CONTRIBUINTE 2","CONTRIBUINTE 4"]},
  {name:"Duplicado",roles:["CONTRIBUINTE 1"]}
],member_count:2,imported_at:iso(t),
  ignored_members:[{player:"Invalido",reason:"cargos de contribuinte conflitantes"},
    {player:"Duplicado",reason:"nome duplicado no G"}]};
const ignoredReport=computeReport({roster:ignoredRoster,settings:cfg,sweeps,now:new Date(t)});
assert.equal(ignoredReport.rows.length,0,"conflitos/duplicatas nao devem aparecer na apuracao");
assert(ignoredReport.warnings.some(x=>x.includes("Invalido")));
assert(ignoredReport.warnings.some(x=>x.includes("Duplicado")));
const observed=cycles.cycleAt("2026-10-01T12:00:00Z",new Date("2026-10-10T12:00:00Z"));
assert.equal(observed.start,"2026-10-08T12:00:00.000Z");
assert.equal(observed.end,"2026-10-15T12:00:00.000Z");
assert.equal(cycles.cycleAt("2026-10-15T12:00:00Z",new Date("2026-10-10T12:00:00Z")),null);
const bank=cycles.parseBankCsv('Date\tPlayer\tReason\tAmount\n2026-10-07 21:10:59\tA\tDeposit\t4000000\n2026-10-07 20:00:00\tB\tWithdrawal\t-1000000');
assert.equal(bank.rows.length,1);
assert.equal(bank.rows[0].amount,4000000);
assert.equal(bank.skipped,1);
assert.equal(cycles.DUES["4"],10000000);
assert.equal(cycles.CTA_MINIMA["4"],0);
const tier4Roster={members:[{name:"Totalmente",roles:["Contribuinte 4"]}],member_count:1,imported_at:iso(t)};
const exempt=computeReport({roster:tier4Roster,settings:cfg,sweeps,now:new Date(t)});
assert.equal(exempt.rows.length,1);
assert.equal(exempt.rows[0].status,"ISENTO");
assert.equal(exempt.counts.exempt,1);
const decorated=cycles.decorate({player:"Totalmente",level:"4"},{
 first_seen_at:"2026-10-08T12:00:00Z",assigned_at:"2026-10-08T12:00:00Z",assignment_source:"observed"
},[],[],new Date("2026-10-10T12:00:00Z"));
assert.equal(decorated.obligations.paymentRequired,10000000);
assert.equal(decorated.obligations.ctaRequired,0);
assert.equal(decorated.cycleMight.pve,null);
assert.equal(decorated.payment.creditedCandidate,null);
assert.equal(contributorLevel(["Contribuinte 3x"]),null);
assert.throws(()=>validateSettings({...cfg,minima:{"1":{pve:-1,gathering:1},"2":{pve:1,gathering:1},"3":{pve:1,gathering:1}}}));
assert.equal(scheduledForWeek(new Date("2026-10-10T15:00:00Z"),{weekday:0,timeUtc:"18:00"}).toISOString(),"2026-10-11T18:00:00.000Z");
const webSource=fs.readFileSync(require.resolve("../src/web"),"utf8");
const indexSource=fs.readFileSync(require.resolve("../src/index"),"utf8");
const warRoomPage=require("../src/web").__test.PAGE;
const browser=/<script>([\s\S]*?)<\/script>/.exec(warRoomPage);
assert(browser&&browser[1]);
new vm.Script(browser[1],{filename:"weekly-browser.js"});
const scriptSnippet=warRoomPage;
assert(scriptSnippet.includes("Contribuintes – semana"));
assert(scriptSnippet.includes("Exportar CSV"));
assert(scriptSnippet.includes("Exportar HTML"));
assert(webSource.includes('app.get("/api/contributors/weekly"'));
assert(webSource.includes('app.post("/api/contributors/settings"'));
assert(webSource.includes("const sess=requireContributorEditor(req,res)"),
  "Contributors editors must use section-scoped authorization, not global site admin");
assert(webSource.includes("function requireContributorEditor(req,res)"),
  "server must authorize contributors via distinct scoped role");
assert(indexSource.includes("contributorWeekly.tick"));
assert(indexSource.includes("await contributorWeekly.init(db.pool)"));
console.log("✅ Contributor weekly full-sweep, delta, roster, status, stale, auth and scheduler regression");
