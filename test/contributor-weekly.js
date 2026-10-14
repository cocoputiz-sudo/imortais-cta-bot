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
assert.equal(observed.start,"2026-10-05T00:00:00.000Z");
assert.equal(observed.end,"2026-10-12T00:00:00.000Z");
assert.equal(cycles.cycleAt("2026-10-15T12:00:00Z",new Date("2026-10-10T12:00:00Z")).start,
  observed.start,"assigned_at nao altera competencia global");
assert.equal(cycles.weekAt(new Date("2026-10-12T00:00:00Z")).start,"2026-10-12T00:00:00.000Z");
assert.equal(cycles.weekAt(new Date("2026-10-18T23:59:59Z")).end,"2026-10-19T00:00:00.000Z");
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
assert.equal(decorated.payment.creditedCandidate,null);
// Competencia UTC da segunda 00:00 inclusiva ate a proxima segunda exclusiva.
const currentNow=new Date("2026-10-15T15:00:00Z");
const currentWeek=cycles.weekAt(currentNow),previousWeek=cycles.weekAt(currentNow,-1);
const makeDeposit=(player,at,amount)=>({player_key:player.toLowerCase(),player_name:player,paid_at:at,amount});
const sunday=makeDeposit("Aldora","2026-10-11T23:00:00Z",4000000);
const monday=makeDeposit("Aldora","2026-10-12T00:30:00Z",4000000);
assert.equal(cycles.paymentForWeek([sunday,monday],"aldora","1",previousWeek,currentNow).amount,4000000,
  "domingo 23:00 UTC pertence a competencia anterior");
assert.equal(cycles.paymentForWeek([sunday,monday],"aldora","1",currentWeek,currentNow).amount,4000000,
  "segunda 00:30 UTC pertence a nova competencia");
assert.equal(cycles.paymentForWeek([monday],"aldora","1",currentWeek,currentNow).status,"PAGO");
const split=[
 makeDeposit("Aldora","2026-10-12T01:00:00Z",2000000),
 makeDeposit("Aldora","2026-10-14T23:59:00Z",2000000)
];
const splitPayment=cycles.paymentForWeek(split,"aldora","1",currentWeek,currentNow);
assert.equal(splitPayment.status,"PAGO","dois depositos de 2M quitam C1 ate quarta");
assert.equal(splitPayment.amount,4000000);
assert.equal(splitPayment.validUntil,"2026-10-19T00:00:00.000Z");
assert.equal(cycles.paymentForWeek([makeDeposit("Aldora","2026-10-15T00:00:00Z",4000000)],
  "aldora","1",currentWeek,currentNow).status,"PAGO COM ATRASO","quinta 00:00 UTC e atraso");
assert.equal(cycles.paymentForWeek([makeDeposit("Aldora","2026-10-18T23:59:00Z",4000000)],
  "aldora","1",currentWeek,new Date("2026-10-18T23:59:59Z")).status,"PAGO COM ATRASO");
assert.equal(cycles.paymentForWeek(split.slice(0,1),"aldora","1",currentWeek,currentNow).status,"PARCIAL");
assert.equal(cycles.paymentForWeek([],"aldora","1",currentWeek,currentNow).status,"PENDENTE");
assert.equal(cycles.paymentForWeek([],"aldora","1",previousWeek,currentNow).status,"NÃO PAGO");
const extra=cycles.paymentForWeek([makeDeposit("Aldora","2026-10-12T10:00:00Z",8000000)],
 "aldora","1",currentWeek,currentNow);
assert.equal(extra.excess,4000000);
assert.equal(cycles.paymentForWeek([makeDeposit("Aldora","2026-10-12T10:00:00Z",8000000)],
 "aldora","1",cycles.weekAt(new Date("2026-10-19T10:00:00Z")),new Date("2026-10-19T10:00:00Z")).status,
 "PENDENTE","excedente nao passa para a semana seguinte");
const firstSeen=new Date("2026-10-14T12:00:00Z").toISOString();
const newContributor=cycles.decorate({player:"Aldora",level:"1"},{
 first_seen_at:firstSeen,assigned_at:firstSeen,assignment_source:"observed"
},[makeDeposit("Aldora","2026-10-12T00:30:00Z",4000000)],
 [{at:"2026-10-12T03:00:00Z",day:"2026-10-12",level:"INTEGRAL"}],currentNow);
assert.equal(newContributor.payment.status,"PAGO","pagamento anterior a primeira observacao no G vale na semana");
assert.equal(newContributor.attendance.count,1,"CTA anterior a primeira observacao no G conta");
assert.equal(newContributor.previousPayment.status,"NÃO APLICÁVEL","novato nao e cobrado por semana anterior");
const mightSweeps=[
 {code:"PVE",capturedAt:"2026-10-12T02:00:00Z",members:new Map([["aldora",100]])},
 {code:"PVE",capturedAt:"2026-10-15T02:00:00Z",members:new Map([["aldora",130]])},
 {code:"GATHERING",capturedAt:"2026-10-12T02:00:00Z",members:new Map([["aldora",5]])},
 {code:"GATHERING",capturedAt:"2026-10-15T02:00:00Z",members:new Map([["aldora",5]])}
];
const newMighter=cycles.decorate({player:"Aldora",level:"2",minimum:{pve:1,gathering:1}},{
 first_seen_at:firstSeen,assigned_at:firstSeen
},[],[],currentNow,mightSweeps);
assert.equal(newMighter.cycleMight.pve,30,"Might anterior a atribuicao e dentro da semana conta para C2");
assert.equal(newMighter.cycleMight.meetsMight,true);
assert.equal(cycles.withinCycleMight([{code:"PVE",capturedAt:"2026-10-11T22:00:00Z",
 members:new Map([["aldora",0]])},mightSweeps[1]],"PVE","aldora",currentWeek,currentNow),null,
 "baseline da competencia anterior nao e permitido");
const unlinkedRoster={members:[
 {name:"Aldora",roles:["CONTRIBUINTE 1"]},{name:"Patrulheiro",roles:["Officer"]}
]};
const reportMembers=[{player:"Aldora"}];
const unlinked=weekly.unlinkedDeposits([
 makeDeposit("Aldorra","2026-10-12T11:00:00Z",4000000),
 makeDeposit("Patrulheiro","2026-10-13T11:00:00Z",4000000)
],unlinkedRoster,{rows:reportMembers},currentNow);
assert.equal(unlinked.length,2,"nomes nao associados aparecem em secao separada");
assert.equal(unlinked.find(x=>x.player==="Aldorra").reason,"Nome não encontrado no G");
assert.equal(unlinked.find(x=>x.player==="Aldorra").suggestion,"Aldora");
assert.equal(unlinked.find(x=>x.player==="Patrulheiro").reason,"Está no G sem cargo de contribuinte");
assert.equal(weekly.unlinkedDeposits([makeDeposit("Aldora","2026-10-12T11:00:00Z",4000000)],
 unlinkedRoster,{rows:reportMembers},currentNow).length,0);

// O total recebido e a contagem de pagantes incluem valores parciais e excedentes,
// mas nao incluem depositos nao vinculados nem contam duas vezes o mesmo jogador.
const payments=[
 {player:"Aldora",payment:cycles.paymentForWeek(split,"aldora","1",currentWeek,currentNow)},
 {player:"Brunao",payment:cycles.paymentForWeek([makeDeposit("Brunao","2026-10-13T12:00:00Z",2000000)],
   "brunao","1",currentWeek,currentNow)},
 {player:"C3Extra",payment:cycles.paymentForWeek([makeDeposit("C3Extra","2026-10-13T12:00:00Z",8000000)],
   "c3extra","3",currentWeek,currentNow)},
 {player:"SemPagamento",payment:cycles.paymentForWeek([],"sempagamento","1",currentWeek,currentNow)}
];
const totals=weekly.weeklyPaymentTotals(payments);
assert.deepEqual(totals,{receivedSilver:14000000,payingContributors:3},
  "4M quitados + 2M parciais + 8M com excedente; tres jogadores distintos");
assert.deepEqual(weekly.weeklyPaymentTotals([...payments,{...payments[0],player:"ALDORA"}]),totals,
  "jogador normalizado duplicado nao pode inflar o total nem os pagantes");
assert.deepEqual(weekly.weeklyPaymentTotals([],true),{receivedSilver:0,payingContributors:0});
assert.deepEqual(weekly.weeklyPaymentTotals(payments,false),{receivedSilver:null,payingContributors:null},
  "fonte indisponivel nao pode aparecer como zero recebido");


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
