"use strict";
// Cobranças privadas só para vínculos confirmados e usuários que aceitaram avisos.
// Nunca inferir Discord ID a partir de apelidos ou perfis de CTA.
const cycle=require("./contributorCycle");
const weekly=require("./contributorWeekly");
const guildroster=require("./guildroster");
const GUILD_ID=process.env.GUILD_ID||"683411304408416285";
const STAGES=Object.freeze({1:"segunda",3:"quarta",4:"quinta",0:"domingo"});
const MAX_DM_PER_WEEK=4;
function keyOf(name){return guildroster.normName(name);}
function fail(code){throw Error(code);}
function silver(n){return Number(n).toLocaleString("pt-BR")+" de prata";}
function shortDate(s){const d=new Date(s);return String(d.getUTCDate()).padStart(2,"0")+"/"+String(d.getUTCMonth()+1).padStart(2,"0");}
function errorOf(e){return String(e?.message||e);}
async function init(pool){
  await pool.query("CREATE TABLE IF NOT EXISTS contributor_discord_links("+
    "player_key TEXT PRIMARY KEY,player_name TEXT NOT NULL,discord_user_id TEXT NOT NULL UNIQUE,"+
    "status TEXT NOT NULL CHECK(status IN ('pending','confirmed','revoked')),"+
    "consented_at TIMESTAMPTZ NOT NULL,reviewed_by TEXT,reviewed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE IF NOT EXISTS contributor_prior_debts("+
    "player_key TEXT PRIMARY KEY,amount BIGINT NOT NULL CHECK(amount>=0),note TEXT NOT NULL DEFAULT '',"+
    "updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE IF NOT EXISTS contributor_weekly_obligations("+
    "player_key TEXT NOT NULL,week_key DATE NOT NULL,tier TEXT NOT NULL,"+
    "due BIGINT NOT NULL CHECK(due>0),paid_total BIGINT NOT NULL DEFAULT 0 CHECK(paid_total>=0),"+
    "first_week BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),"+
    "PRIMARY KEY(player_key,week_key))");
  await pool.query("CREATE TABLE IF NOT EXISTS contributor_dm_settings("+
    "id SMALLINT PRIMARY KEY CHECK(id=1),enabled BOOLEAN NOT NULL DEFAULT false,"+
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_by TEXT)");
  await pool.query("INSERT INTO contributor_dm_settings(id,enabled) VALUES(1,false) ON CONFLICT(id) DO NOTHING");
  await pool.query("CREATE TABLE IF NOT EXISTS contributor_dm_log("+
    "player_key TEXT NOT NULL,week_key DATE NOT NULL,stage TEXT NOT NULL,"+
    "discord_user_id TEXT NOT NULL,status TEXT NOT NULL,attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),"+
    "detail TEXT,PRIMARY KEY(player_key,week_key,stage))");
}
async function activeRoster(pool){
  const roster=await weekly.rosterLatest(pool);
  const members=roster?.members||[];
  const ignored=(roster?.ignored_members||[]).filter(x=>x.reason==="nome duplicado no G").map(x=>x.player);
  return {roster,members,found:cycle.inspectRoster(members,{duplicateKeys:ignored}).found};
}
async function requestLink(pool,{player,discordId}){
  const key=keyOf(player),id=String(discordId||"");
  if(!key||!/^\d{15,22}$/.test(id))fail("vinculo_invalido");
  const {found}=await activeRoster(pool),member=found.get(key);
  if(!member)fail("jogador_nao_e_contribuinte_no_G");
  const own=await pool.query("SELECT player_key,status FROM contributor_discord_links WHERE discord_user_id=$1",[id]);
  if(own.rows.length&&own.rows[0].player_key!==key)fail("discord_ja_vinculado_outro_jogador");
  const linked=await pool.query("SELECT discord_user_id,status FROM contributor_discord_links WHERE player_key=$1",[key]);
  if(linked.rows.length&&linked.rows[0].discord_user_id!==id)fail("jogador_ja_vinculado_outro_discord");
  const r=await pool.query(
    "INSERT INTO contributor_discord_links(player_key,player_name,discord_user_id,status,consented_at) "+
    "VALUES($1,$2,$3,'pending',now()) ON CONFLICT(player_key) DO UPDATE SET "+
    "player_name=EXCLUDED.player_name,status=CASE WHEN contributor_discord_links.status='confirmed' "+
    "THEN 'confirmed' ELSE 'pending' END,consented_at=now(),updated_at=now() RETURNING status",
    [key,member.name,id]);
  return {player:member.name,status:r.rows[0].status};
}
async function stopLink(pool,discordId){
  const r=await pool.query(
    "UPDATE contributor_discord_links SET status='revoked',updated_at=now() "+
    "WHERE discord_user_id=$1 AND status<>'revoked' RETURNING player_name",[String(discordId)]);
  return {revoked:r.rowCount>0};
}
async function review(pool,{player,editor,client}){
  const key=keyOf(player),{found}=await activeRoster(pool);
  if(!found.has(key))fail("jogador_nao_e_contribuinte_no_G");
  const current=await pool.query("SELECT discord_user_id,status FROM contributor_discord_links WHERE player_key=$1",[key]);
  if(current.rows[0]?.status!=="pending")fail("vinculo_pendente_nao_encontrado");
  const guild=client.guilds.cache.get(GUILD_ID);
  const member=await guild?.members.fetch(current.rows[0].discord_user_id).catch(()=>null);
  if(!member)fail("discord_nao_e_membro");
  const updated=await pool.query("UPDATE contributor_discord_links SET status='confirmed',reviewed_by=$2,reviewed_at=now(),updated_at=now() "+
    "WHERE player_key=$1 AND status='pending' RETURNING player_name,discord_user_id",[key,String(editor)]);
  if(!updated.rowCount)fail("vinculo_ja_alterado");
  return {player:updated.rows[0].player_name,discordId:updated.rows[0].discord_user_id,status:"confirmed"};
}
async function priorDebt(pool,{player,enabled,amount,note,editor}){
  const key=keyOf(player),{found}=await activeRoster(pool);
  if(!found.has(key))fail("jogador_nao_e_contribuinte_no_G");
  if(typeof enabled!=="boolean")fail("marcacao_invalida");
  const value=enabled?Number(amount):0,reason=String(note||"").trim();
  if(!Number.isSafeInteger(value)||value<0||value>100000000000||enabled&&(!value||!reason||reason.length>240))
    fail("debito_anterior_invalido");
  const r=await pool.query("INSERT INTO contributor_prior_debts(player_key,amount,note,updated_by) "+
    "VALUES($1,$2,$3,$4) ON CONFLICT(player_key) DO UPDATE SET amount=EXCLUDED.amount,note=EXCLUDED.note,"+
    "updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING amount,note",
    [key,value,enabled?reason:"",String(editor)]);
  return {amount:Number(r.rows[0].amount),note:r.rows[0].note};
}
async function settings(pool){
  const r=await pool.query("SELECT enabled,updated_at,updated_by FROM contributor_dm_settings WHERE id=1");
  return r.rows[0]||{enabled:false};
}
async function setSettings(pool,{enabled,editor}){
  if(typeof enabled!=="boolean")fail("configuracao_invalida");
  const r=await pool.query("UPDATE contributor_dm_settings SET enabled=$1,updated_at=now(),updated_by=$2 "+
    "WHERE id=1 RETURNING enabled,updated_at,updated_by",[enabled,String(editor)]);
  return r.rows[0];
}
// Somente semanas observadas pelo sistema geram cobrança automática.
// A primeira semana registrada não retroage para cobranças anteriores desconhecidas.
async function sync(pool,now=new Date()){
  const week=cycle.weekAt(now),day=week.start.slice(0,10);
  const {found}=await activeRoster(pool);
  const active=await cycle.assignments(pool);
  const firstSeen=new Map(active.map(a=>[a.player_key,Date.parse(a.first_seen_at)]));
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(77831484)");
    for(const member of found.values()){
      const first=await client.query("SELECT 1 FROM contributor_weekly_obligations WHERE player_key=$1 LIMIT 1",[member.key]);
      await client.query("INSERT INTO contributor_weekly_obligations(player_key,week_key,tier,due,first_week) "+
        "VALUES($1,$2::date,$3,$4,$5) ON CONFLICT(player_key,week_key) DO UPDATE SET "+
        "tier=EXCLUDED.tier,due=EXCLUDED.due",
        [member.key,day,member.level,cycle.DUES[member.level],
          !first.rowCount&&firstSeen.has(member.key)&&firstSeen.get(member.key)>=Date.parse(week.start)&&
          firstSeen.get(member.key)<Date.parse(week.end)]);
    }
    // Congela o total apurado por competência para não reaparecer inadimplência
    // quando o CSV antigo é expurgado após 45 dias.
    await client.query("UPDATE contributor_weekly_obligations o SET paid_total=GREATEST(o.paid_total,"+
      "COALESCE((SELECT SUM(d.amount) FROM contributor_bank_deposits d WHERE d.player_key=o.player_key "+
      "AND d.paid_at >= (o.week_key::timestamp AT TIME ZONE 'UTC') "+
      "AND d.paid_at < ((o.week_key+7)::timestamp AT TIME ZONE 'UTC')),0)) "+
      "WHERE o.week_key >= $1::date AND o.week_key <= $2::date",
      [cycle.weekAt(now,-7).start.slice(0,10),day]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}
  finally{client.release();}
  return {week,contributors:found.size};
}
async function dashboard(pool,now=new Date()){
  const {week}=await sync(pool,now),{found}=await activeRoster(pool);
  const [links,manual,obligations,bank,config,log]=await Promise.all([
    pool.query("SELECT player_key,discord_user_id,status,consented_at,reviewed_at FROM contributor_discord_links"),
    pool.query("SELECT player_key,amount,note,updated_at FROM contributor_prior_debts"),
    pool.query("SELECT player_key,week_key,tier,due,paid_total,first_week FROM contributor_weekly_obligations ORDER BY week_key DESC"),
    cycle.deposits(pool,now),
    settings(pool),
    pool.query("SELECT player_key,week_key,stage,status,attempted_at,detail FROM contributor_dm_log "+
      "WHERE week_key >= $1::date ORDER BY attempted_at DESC LIMIT 300",[cycle.weekAt(now,-4).start.slice(0,10)])
  ]);
  const linked=new Map(links.rows.map(x=>[x.player_key,x]));
  const oldDebt=new Map(manual.rows.map(x=>[x.player_key,x]));
  const ledger=new Map();
  for(const o of obligations.rows){
    if(!ledger.has(o.player_key))ledger.set(o.player_key,[]);
    ledger.get(o.player_key).push(o);
  }
  const rows=[];
  for(const m of found.values()){
    const history=ledger.get(m.key)||[],current=history.find(o=>String(o.week_key).slice(0,10)===week.start.slice(0,10)||
      new Date(o.week_key).toISOString().slice(0,10)===week.start.slice(0,10));
    const payment=cycle.paymentForWeek(bank,m.key,m.level,week,now);
    const overdue=history.filter(o=>new Date(o.week_key).getTime()<Date.parse(week.start))
      .map(o=>({week:shortDate(o.week_key),amount:Math.max(0,Number(o.due)-Number(o.paid_total))}))
      .filter(o=>o.amount>0);
    const prior=oldDebt.get(m.key),manualAmount=Number(prior?.amount||0);
    rows.push({player:m.name,key:m.key,level:m.level,due:cycle.DUES[m.level],
      paymentStatus:payment.status,paid:payment.amount,
      firstWeek:!!current?.first_week,week:week.start,link:linked.get(m.key)||null,
      overdueWeeks:overdue.length,overdueAmount:overdue.reduce((a,b)=>a+b.amount,0),
      overdue,manualDebt:manualAmount,manualNote:prior?.note||"",
      totalOtherDebt:manualAmount+overdue.reduce((a,b)=>a+b.amount,0)});
  }
  return {week,settings:config,rows,logs:log.rows,unmatchedCandidates:"Não há vínculo por nickname automático"};
}
function stageAt(now){
  const date=new Date(now),stage=STAGES[date.getUTCDay()];
  return stage&&date.getUTCHours()>=15?stage:null;
}
function messageFor(row,week,stage){
  const paid=Number(row.paid||0),due=Number(row.due),first=row.firstWeek;
  const current=first?
    "Primeira adesão: saldo a completar "+silver(Math.max(0,due-paid))+".":
    "Cobrança integral da competência: "+silver(due)+". "+
    (paid?"Depósitos identificados nesta semana: "+silver(paid)+". A quitação exige o total integral.":"");
  const other=row.totalOtherDebt>0?
    "\n⚠️ Outras obrigações em aberto registradas: "+silver(row.totalOtherDebt)+
    " ("+row.overdueWeeks+" semana(s) e ajuste anterior, se houver). Valores de semanas anteriores não abatem a atual.":"";
  const intro=stage==="segunda"?"A nova competência começou.":stage==="quarta"?"O prazo normal termina hoje.":
    stage==="quinta"?"O prazo normal terminou; pagamentos agora são classificados como atraso.":"A competência termina na próxima segunda.";
  return "IMORTAIS · Contribuição semanal\nOlá, "+row.player+"! "+intro+
    "\nPeríodo: "+shortDate(week.start)+" a "+shortDate(week.end)+".\n"+current+other+
    "\nConfira seu extrato no jogo. Caso já tenha pago e a importação ainda não apareça, avise a staff."+
    "\nVocê pode parar estes avisos com /contribuinte_parar.";
}
async function sendOne(pool,client,{player,stage,now=new Date(),snapshot=null}){
  const key=keyOf(player),report=snapshot||await dashboard(pool,now),row=report.rows.find(x=>x.key===key);
  if(!row)fail("contribuinte_nao_encontrado");
  if(!row.link||row.link.status!=="confirmed")fail("discord_sem_vinculo_confirmado");
  // Antes de cada DM, revisar o extrato mais recente e a autorização.
  const bankFresh=await pool.query("SELECT MAX(imported_at) AS latest FROM contributor_bank_deposits");
  if(!bankFresh.rows[0]?.latest||Date.now()-new Date(bankFresh.rows[0].latest).getTime()>72*3600000)
    return {skipped:"extrato_desatualizado"};
  const latestBank=await pool.query("SELECT COALESCE(SUM(amount),0) AS total "+
    "FROM contributor_bank_deposits WHERE player_key=$1 AND paid_at>=$2 AND paid_at<$3 AND paid_at<= $4",
    [key,report.week.start,report.week.end,new Date(now)]);
  row.paid=Number(latestBank.rows[0].total);
  row.paymentStatus=row.paid>=row.due?"PAGO":row.paid>0?"PARCIAL":"PENDENTE";
  if(row.paymentStatus==="PAGO")return {skipped:"pago"};
  if(!report.settings.enabled)fail("mensagens_desativadas");
  const weekKey=report.week.start.slice(0,10);
  const already=await pool.query("SELECT count(*)::int AS n FROM contributor_dm_log WHERE player_key=$1 AND week_key=$2::date",[key,weekKey]);
  if(Number(already.rows[0].n)>=MAX_DM_PER_WEEK)return {skipped:"limite_semanal"};
  const guild=client.guilds.cache.get(GUILD_ID);
  const member=await guild?.members.fetch(row.link.discord_user_id).catch(()=>null);
  if(!member)return {skipped:"usuario_fora_do_discord"};
  const claim=await pool.query("INSERT INTO contributor_dm_log(player_key,week_key,stage,discord_user_id,status) "+
    "SELECT $1,$2::date,$3,$4,'claimed' WHERE EXISTS(SELECT 1 FROM contributor_discord_links "+
    "WHERE player_key=$1 AND discord_user_id=$4 AND status='confirmed') "+
    "ON CONFLICT DO NOTHING RETURNING player_key",[key,weekKey,stage,row.link.discord_user_id]);
  if(!claim.rowCount)return {skipped:"ja_processado"};
  try{
    await member.user.send({content:messageFor(row,report.week,stage),allowedMentions:{parse:[]}});
    await pool.query("UPDATE contributor_dm_log SET status='sent',detail=NULL WHERE player_key=$1 AND week_key=$2::date AND stage=$3",
      [key,weekKey,stage]);
    return {sent:true,player:row.player};
  }catch(e){
    await pool.query("UPDATE contributor_dm_log SET status='failed',detail=$4 WHERE player_key=$1 AND week_key=$2::date AND stage=$3",
      [key,weekKey,stage,String(e.code||"dm_blocked").slice(0,80)]);
    return {sent:false,error:"dm_bloqueada"};
  }
}
let ticking=false;
async function tick(pool,client,{now=new Date()}={}){
  if(ticking)return {skipped:"em_andamento"};
  const stage=stageAt(now);
  if(!stage)return {skipped:"fora_da_janela"};
  ticking=true;
  try{
    if(!(await settings(pool)).enabled)return {skipped:"desativado"};
    const d=await dashboard(pool,now);
    let sent=0,skipped=0;
    for(const r of d.rows){
      if(!r.link||r.link.status!=="confirmed"||["PAGO","PAGO COM ATRASO"].includes(r.paymentStatus)){skipped++;continue;}
      try{const result=await sendOne(pool,client,{player:r.player,stage,now,snapshot:d});if(result.sent)sent++;else skipped++;}
      catch(e){console.error("[contributor dm]",r.key,errorOf(e));skipped++;}
    }
    return {stage,sent,skipped};
  }finally{ticking=false;}
}
module.exports={init,requestLink,stopLink,review,priorDebt,settings,setSettings,sync,dashboard,stageAt,messageFor,sendOne,tick};
