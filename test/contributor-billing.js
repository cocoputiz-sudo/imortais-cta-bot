"use strict";
const assert=require("node:assert/strict");
const db=require("../src/db");
const weekly=require("../src/contributorWeekly");
const cycle=require("../src/contributorCycle");
const billing=require("../src/contributorBilling");

async function main(){
  const pool=db.pool;
  await weekly.init(pool);
  await billing.init(pool);
  const now=new Date("2026-10-14T16:00:00Z");
  const roster=[{name:"CobrancaTesteA",roles:["CONTRIBUINTE 1"]},
    {name:"CobrancaTesteB",roles:["CONTRIBUINTE 3"]},
    {name:"NaoContribuinte",roles:["Officer"]}];
  await pool.query("INSERT INTO contributor_roster_latest(id,members,member_count,imported_at,imported_by,import_source) "+
    "VALUES(1,$1::jsonb,$2,now(),'billing-test','contributors_confirmed') "+
    "ON CONFLICT(id) DO UPDATE SET members=EXCLUDED.members,member_count=EXCLUDED.member_count,"+
    "imported_at=EXCLUDED.imported_at,imported_by=EXCLUDED.imported_by",
    [JSON.stringify(roster),roster.length]);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await cycle.reconcile(client,roster,now,0);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  const playerA="CobrancaTesteA",keyA="cobrancatest ea".replace(/\s/g,"");
  const user="123456789012345678";
  const initial=await billing.dashboard(pool,now);
  const row=initial.rows.find(x=>x.player===playerA);
  assert(row&&row.firstWeek,"primeira observacao desta semana e primeira adesao");
  assert.equal(row.due,4000000);
  assert.equal(initial.settings.enabled,false,"envio deve iniciar desativado");
  assert.equal(row.overdueWeeks,0,"nao cobrar semanas anteriores ao primeiro G observado");
  assert.equal(billing.stageAt(new Date("2026-10-12T14:59:00Z")),null);
  assert.equal(billing.stageAt(new Date("2026-10-12T15:00:00Z")),"segunda");
  assert.equal(billing.stageAt(new Date("2026-10-14T16:00:00Z")),"quarta");
  assert.equal(billing.stageAt(new Date("2026-10-15T16:00:00Z")),"quinta");
  assert.equal(billing.stageAt(new Date("2026-10-18T16:00:00Z")),"domingo");
  assert.equal(billing.stageAt(new Date("2026-10-16T16:00:00Z")),null);

  await assert.rejects(()=>billing.requestLink(pool,{player:"NaoContribuinte",discordId:user}),
    /jogador_nao_e_contribuinte_no_G/);
  const request=await billing.requestLink(pool,{player:playerA,discordId:user});
  assert.equal(request.status,"pending");
  const afterRequest=await billing.dashboard(pool,now);
  assert.equal(afterRequest.rows.find(x=>x.player===playerA).link.status,"pending");
  await assert.rejects(()=>billing.sendOne(pool,{guilds:{cache:new Map()}},{
    player:playerA,stage:"manual",now}),/discord_sem_vinculo_confirmado/);
  const sent=[];
  const discord={id:user,user:{send:async x=>sent.push(x)}};
  const guild={members:{fetch:async id=>id===user?discord:null}};
  const discordClient={guilds:{cache:new Map([[process.env.GUILD_ID||"683411304408416285",guild]])}};
  const review=await billing.review(pool,{player:playerA,editor:"staff-1",client:discordClient});
  assert.equal(review.status,"confirmed");
  await assert.rejects(()=>billing.review(pool,{player:playerA,editor:"staff-1",client:discordClient}),
    /vinculo_pendente_nao_encontrado/);
  const another="999999999999999999";
  await assert.rejects(()=>billing.requestLink(pool,{player:playerA,discordId:another}),
    /jogador_ja_vinculado_outro_discord/);
  await assert.rejects(()=>billing.priorDebt(pool,{player:playerA,enabled:true,amount:100,editor:"staff"}),
    /debito_anterior_invalido/);
  await billing.priorDebt(pool,{player:playerA,enabled:true,amount:6000000,note:"saldo anterior conferido",editor:"staff"});
  const bank="Date\tPlayer\tReason\tAmount\n2026-10-13 13:00:00\t"+playerA+"\tDeposit\t2000000";
  const imported=await cycle.importBank(pool,bank,"staff");
  assert.equal(imported.inserted,1);
  const paid=await billing.dashboard(pool,now),p=paid.rows.find(x=>x.player===playerA);
  assert.equal(p.paid,2000000);
  assert.equal(p.paymentStatus,"PARCIAL");
  assert.equal(p.manualDebt,6000000);
  assert.equal(p.totalOtherDebt,6000000);
  const text=billing.messageFor(p,paid.week,"quarta");
  assert.match(text,/Primeira adesão: saldo a completar 2.000.000 de prata/);
  assert.match(text,/6.000.000 de prata/);
  await assert.rejects(()=>billing.sendOne(pool,discordClient,{player:playerA,stage:"manual",now}),
    /mensagens_desativadas/);
  await billing.setSettings(pool,{enabled:true,editor:"staff"});
  const result=await billing.sendOne(pool,discordClient,{player:playerA,stage:"manual",now});
  assert.equal(result.sent,true);
  assert.equal(sent.length,1);
  assert.equal(sent[0].allowedMentions.parse.length,0);
  assert.equal((await billing.sendOne(pool,discordClient,{player:playerA,stage:"manual",now})).skipped,"ja_processado");
  assert.equal(sent.length,1,"idempotencia por semana e estágio");
  const next=await billing.dashboard(pool,new Date("2026-10-19T16:00:00Z"));
  const n=next.rows.find(x=>x.player===playerA);
  assert.equal(n.firstWeek,false);
  assert.equal(n.due,4000000,"nova semana integral, independentemente do pagamento parcial anterior");
  assert.equal(n.overdueWeeks,1);
  assert.equal(n.overdueAmount,2000000,"semana anterior nao perde pendencia");
  assert.equal(n.totalOtherDebt,8000000,"atraso historico + valor manual separado");
  assert.match(billing.messageFor(n,next.week,"segunda"),/Cobrança integral da competência: 4.000.000/);
  await billing.priorDebt(pool,{player:playerA,enabled:false,amount:0,note:"",editor:"staff"});
  const cleared=await billing.dashboard(pool,new Date("2026-10-19T16:00:00Z"));
  assert.equal(cleared.rows.find(x=>x.player===playerA).manualDebt,0,"desmarcar checkbox limpa apenas ajuste manual");
  assert.equal(cleared.rows.find(x=>x.player===playerA).overdueAmount,2000000,"historico semanal permanece");
  assert.equal((await billing.stopLink(pool,user)).revoked,true);
  await assert.rejects(()=>billing.sendOne(pool,discordClient,{player:playerA,stage:"quarta",now}),
    /discord_sem_vinculo_confirmado/);
  console.log("✅ Cobranças: consentimento, validação de staff, dívida manual, histórico, DM idempotente, semana integral");
  await pool.end();
}
main().catch(e=>{console.error("❌ Contributor billing:",e);db.pool.end().catch(()=>{});process.exitCode=1;});
