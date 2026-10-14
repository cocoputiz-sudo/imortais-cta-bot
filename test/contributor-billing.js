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
  const rejectedApplicant="111111111111111111";
  const request=await billing.requestLink(pool,{player:playerA,discordId:rejectedApplicant});
  assert.equal(request.status,"pending");
  const afterRequest=await billing.dashboard(pool,now);
  assert.equal(afterRequest.rows.find(x=>x.player===playerA).link.status,"pending");
  await assert.rejects(()=>billing.sendOne(pool,{guilds:{cache:new Map()}},{
    player:playerA,stage:"manual",now}),/discord_sem_vinculo_confirmado/);
  const rejected=await billing.closeLink(pool,{player:playerA,editor:"police-42",
    reason:"Conta sem comprovação do personagem",action:"reject"});
  assert.equal(rejected.status,"revoked");
  const audit=await pool.query("SELECT reviewed_by,review_reason,reviewed_at,status FROM contributor_discord_links WHERE player_key=$1",[keyA]);
  assert.equal(audit.rows[0].reviewed_by,"police-42");
  assert.equal(audit.rows[0].review_reason,"Conta sem comprovação do personagem");
  assert(audit.rows[0].reviewed_at,"recusa precisa ser datada");
  await assert.rejects(()=>billing.closeLink(pool,{player:playerA,editor:"staff",
    reason:"segunda recusa",action:"reject"}),/status_vinculo_invalido/);
  const freshRequest=await billing.requestLink(pool,{player:playerA,discordId:user});
  assert.equal(freshRequest.status,"pending","pedido recusado libera personagem para outro Discord ID");
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
  const imported=await cycle.importBank(pool,bank,"billing-regression");
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
  await pool.query("UPDATE contributor_bank_imports SET imported_at='2026-10-01T00:00:00Z'");
  assert.equal((await billing.sendOne(pool,discordClient,{player:playerA,stage:"manual",now})).skipped,
    "extrato_desatualizado","importação antiga bloqueia cobrança");
  const repeated=await cycle.importBank(pool,bank,"billing-regression");
  assert.equal(repeated.inserted,0,"reimportar mesmo extrato não duplica depósitos");
  assert.equal(repeated.duplicates,1);
  const empty=await cycle.importBank(pool,"Date\tPlayer\tReason\tAmount\n"+
    "2026-10-14 12:00:00\tCobrancaTesteA\tWithdrawal\t-4000000","billing-regression");
  assert.equal(empty.inserted,0,"arquivo sem depósitos novos também é importação válida");
  assert.equal(empty.parsed,0);
  const freshness=await pool.query("SELECT count(*)::int AS total,max(imported_at) AS latest "+
    "FROM contributor_bank_imports WHERE imported_by='billing-regression'");
  assert.equal(freshness.rows[0].total,3,"cada importação bem-sucedida deve ser auditada");
  assert(new Date(freshness.rows[0].latest).getTime()>Date.parse("2026-10-12T00:00:00Z"),
    "reimportação sem operações novas renova frescor");
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
  await assert.rejects(()=>billing.adjustWeek(pool,{player:playerA,weekKey:"2026-10-12",
    amount:2000001,reason:"Valor inválido",editor:"police-42"}),/baixa_superior_ao_saldo/);
  await assert.rejects(()=>billing.adjustWeek(pool,{player:playerA,weekKey:"2026-10-12",
    amount:2000000,reason:"",editor:"police-42"}),/baixa_invalida/);
  const previousWriteoff=await billing.adjustWeek(pool,{player:playerA,weekKey:"2026-10-12",
    amount:2000000,reason:"Acordo aprovado para a semana encerrada",editor:"police-42"});
  assert.equal(previousWriteoff.remaining,0);
  const paidOld=await billing.dashboard(pool,new Date("2026-10-19T16:00:00Z"));
  assert.equal(paidOld.rows.find(x=>x.player===playerA).overdueWeeks,0);
  assert.equal(paidOld.rows.find(x=>x.player===playerA).totalOtherDebt,6000000);
  const currentWriteoff=await billing.adjustWeek(pool,{player:playerA,weekKey:"2026-10-19",
    amount:4000000,reason:"Baixa expressa da staff",editor:"police-42"});
  assert.equal(currentWriteoff.remaining,0);
  const writeoffAudit=await pool.query("SELECT adjusted_by,adjusted_at,amount,reason FROM contributor_weekly_adjustments "+
    "WHERE player_key=$1 AND week_key=$2::date",[keyA,"2026-10-19"]);
  assert.equal(writeoffAudit.rows[0].adjusted_by,"police-42");
  assert.equal(Number(writeoffAudit.rows[0].amount),4000000);
  assert(writeoffAudit.rows[0].adjusted_at);
  await pool.query("UPDATE contributor_bank_imports SET imported_at='2026-10-19T15:30:00Z' WHERE id=(SELECT max(id) FROM contributor_bank_imports)");
  assert.equal((await billing.sendOne(pool,discordClient,{player:playerA,
    stage:"segunda",now:new Date("2026-10-19T16:00:00Z")})).skipped,"baixa_manual",
    "competência quitada por ajuste não gera mensagem");
  const afterWriteoff=await billing.dashboard(pool,new Date("2026-10-19T16:00:00Z"));
  assert.equal(afterWriteoff.rows.find(x=>x.player===playerA).currentRemaining,0);
  assert.equal(afterWriteoff.rows.find(x=>x.player===playerA).paymentStatus,"BAIXADO");
  await billing.priorDebt(pool,{player:playerA,enabled:false,amount:0,note:"",editor:"staff"});
  const cleared=await billing.dashboard(pool,new Date("2026-10-19T16:00:00Z"));
  assert.equal(cleared.rows.find(x=>x.player===playerA).manualDebt,0,"desmarcar checkbox limpa apenas ajuste manual");
  assert.equal(cleared.rows.find(x=>x.player===playerA).overdueAmount,0,
    "baixa antiga zera a dívida sem apagar o lançamento auditável");
  const revoked=await billing.closeLink(pool,{player:playerA,editor:"police-42",
    reason:"Revogação administrativa",action:"revoke"});
  assert.equal(revoked.status,"revoked");
  const revokedAudit=await pool.query("SELECT status,reviewed_by,review_reason,reviewed_at FROM contributor_discord_links "+
    "WHERE player_key=$1",[keyA]);
  assert.equal(revokedAudit.rows[0].review_reason,"Revogação administrativa");
  assert.equal(revokedAudit.rows[0].reviewed_by,"police-42");
  await assert.rejects(()=>billing.sendOne(pool,discordClient,{player:playerA,stage:"quarta",now}),
    /discord_sem_vinculo_confirmado/);
  assert.equal((await billing.stopLink(pool,user)).revoked,false);
  console.log("✅ Cobranças: consentimento, validação de staff, dívida manual, histórico, DM idempotente, semana integral");
  await pool.end();
}
main().catch(e=>{console.error("❌ Contributor billing:",e);db.pool.end().catch(()=>{});process.exitCode=1;});
