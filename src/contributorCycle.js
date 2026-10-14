"use strict";

// Vinculos ATIVOS, sem arquivo historico de ex-membros. A lista completa do G
// e a fonte da categoria. A primeira observacao NAO prova a data da promocao.
const crypto=require("node:crypto");
const guildroster=require("./guildroster");
const attendance=require("./attendance");
const db=require("./db");

const DAY_MS=86400000;
const WEEK_MS=7*DAY_MS;
const BANK_RETENTION_DAYS=45;
const DUES=Object.freeze({"1":4000000,"2":4000000,"3":6000000,"4":10000000});
const CTA_MINIMA=Object.freeze({"1":10,"2":null,"3":6,"4":0});
function keyOf(name){return guildroster.normName(name);}
function tierOf(roles){
  const found=new Set((roles||[]).map(x=>String(x).normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLowerCase())
    .map(x=>/^contribuinte\s*([1-4])$/.exec(x)).filter(Boolean).map(x=>x[1]));
  if(found.size>1)throw Error("cargos_contribuinte_conflitantes");
  return [...found][0]||null;
}
function cycleAt(assignedAt,now=new Date()){
  const anchor=Date.parse(assignedAt),t=new Date(now).getTime();
  if(!Number.isFinite(anchor)||!Number.isFinite(t)||anchor>t) return null;
  const index=Math.floor((t-anchor)/WEEK_MS);
  const start=new Date(anchor+index*WEEK_MS).toISOString();
  const end=new Date(anchor+(index+1)*WEEK_MS).toISOString();
  return {start,end,index:index+1,daysElapsed:Math.min(7,Math.floor((t-Date.parse(start))/DAY_MS)),
    endsInMs:Date.parse(end)-t};
}
async function init(pool){
  await pool.query(
    "CREATE TABLE IF NOT EXISTS contributor_active_assignments("+
    "player_key TEXT PRIMARY KEY, player_name TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('1','2','3','4')),"+
    "first_seen_at TIMESTAMPTZ NOT NULL, assigned_at TIMESTAMPTZ NOT NULL,"+
    "assignment_source TEXT NOT NULL DEFAULT 'observed',"+
    "confirmed_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS contributor_bank_deposits("+
    "row_fingerprint TEXT PRIMARY KEY, player_key TEXT NOT NULL, player_name TEXT NOT NULL,"+
    "paid_at TIMESTAMPTZ NOT NULL, amount BIGINT NOT NULL CHECK(amount>0),"+
    "imported_at TIMESTAMPTZ NOT NULL DEFAULT now(), imported_by TEXT NOT NULL)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_contributor_bank_player_date ON contributor_bank_deposits(player_key,paid_at)");
}
// Chamar dentro da transacao que salva contributor_roster_latest. Impede
// lista parcial de excluir centenas de membros por engano.
async function reconcile(client,members,observedAt,previousCount){
  if(previousCount>=20 && members.length<Math.ceil(previousCount*0.75))
    throw Error("roster_partial");
  const now=new Date(observedAt);
  if(!Number.isFinite(now.getTime()))throw Error("data_roster_invalida");
  const found=new Map();
  for(const member of members){
    const level=tierOf(member.roles);
    if(level){
      const key=keyOf(member.name);
      if(!key||found.has(key))throw Error("jogador_duplicado");
      found.set(key,{key,name:member.name,level});
    }
  }
  for(const member of found.values()){
    await client.query(
      "INSERT INTO contributor_active_assignments"+
      "(player_key,player_name,tier,first_seen_at,assigned_at,assignment_source,updated_at)"+
      " VALUES($1,$2,$3,$4,$4,'observed',now())"+
      " ON CONFLICT(player_key) DO UPDATE SET player_name=EXCLUDED.player_name,"+
      "tier=EXCLUDED.tier,"+
      "first_seen_at=CASE WHEN contributor_active_assignments.tier=EXCLUDED.tier THEN contributor_active_assignments.first_seen_at ELSE EXCLUDED.first_seen_at END,"+
      "assigned_at=CASE WHEN contributor_active_assignments.tier=EXCLUDED.tier THEN contributor_active_assignments.assigned_at ELSE EXCLUDED.assigned_at END,"+
      "assignment_source=CASE WHEN contributor_active_assignments.tier=EXCLUDED.tier THEN contributor_active_assignments.assignment_source ELSE 'observed' END,"+
      "confirmed_by=CASE WHEN contributor_active_assignments.tier=EXCLUDED.tier THEN contributor_active_assignments.confirmed_by ELSE NULL END,"+
      "updated_at=now()",
      [member.key,member.name,member.level,now]);
  }
  // Quem saiu da guilda ou perdeu a tag nao continua como contribuinte ativo.
  await client.query("DELETE FROM contributor_active_assignments WHERE NOT(player_key=ANY($1::text[]))",[[...found.keys()]]);
  await client.query("DELETE FROM contributor_bank_deposits WHERE paid_at<now()-interval '45 days'");
  return found.size;
}
async function bootstrap(pool,roster){
  if(!roster?.members?.length)return;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(77831443)");
    const n=await client.query("SELECT count(*)::int AS n FROM contributor_active_assignments");
    if(Number(n.rows[0]?.n)===0){
      await reconcile(client,roster.members,roster.imported_at||new Date(),0);
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}
  finally{client.release();}
}
async function assignments(pool){
  const r=await pool.query("SELECT player_key,player_name,tier,first_seen_at,assigned_at,assignment_source,confirmed_by FROM contributor_active_assignments ORDER BY tier,player_name");
  return r.rows;
}
async function confirmAssignment(pool,{player,assignedAt,actor}){
  const key=keyOf(player);
  const date=new Date(assignedAt),now=Date.now();
  if(!key||!Number.isFinite(date.getTime())||date.getTime()>now||date.getTime()<now-120*DAY_MS)
    throw Error("data_atribuicao_invalida");
  const r=await pool.query(
    "UPDATE contributor_active_assignments SET assigned_at=$2,assignment_source='confirmed',confirmed_by=$3,updated_at=now()"+
    " WHERE player_key=$1 RETURNING player_name,tier,assigned_at,assignment_source",
    [key,date,String(actor||"staff")]);
  if(!r.rowCount)throw Error("contribuinte_nao_encontrado");
  return r.rows[0];
}
function splitDelimited(line,delimiter){
  const out=[];let cell="",quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;
    }else if(c===delimiter&&!quoted){out.push(cell.trim());cell="";}
    else cell+=c;
  }
  if(quoted)throw Error("extrato_csv_invalido");
  out.push(cell.trim());return out;
}
function parseBankCsv(input){
  const text=String(input||"").replace(/^\uFEFF/,"");
  if(!text||text.length>3000000)throw Error("extrato_csv_invalido");
  const lines=text.split(/\r?\n/).filter(x=>x.trim());
  if(lines.length<2||lines.length>25001)throw Error("extrato_csv_invalido");
  const delim=lines[0].includes("\t")?"\t":lines[0].includes(";")?";":",";
  const cols=splitDelimited(lines[0],delim).map(x=>x.toLowerCase().replace(/[^a-z]/g,""));
  const find=(variants)=>cols.findIndex(c=>variants.includes(c));
  const idx=[find(["date","data"]),find(["player","jogador"]),find(["reason","motivo"]),find(["amount","valor"])];
  if(idx.some(n=>n<0))throw Error("extrato_cabecalho_invalido");
  const rows=[],repeat=new Map();let skipped=0;
  for(const line of lines.slice(1)){
    const c=splitDelimited(line,delim);
    if(c.length<=Math.max(...idx)){skipped++;continue;}
    const [rawDate,name,reason,rawAmount]=idx.map(i=>c[i]);
    if(!/^(deposit|dep[oó]sito)$/i.test(reason.trim())){skipped++;continue;}
    const amount=Number(rawAmount.replace(/\s/g,""));
    // Data do jogo e assumida UTC apenas com formato YYYY-MM-DD HH:mm:ss.
    const iso=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(rawDate)?
      rawDate.replace(" ","T")+"Z":rawDate;
    const date=new Date(iso),key=keyOf(name);
    if(!Number.isSafeInteger(amount)||amount<=0||!key||!Number.isFinite(date.getTime()))
      throw Error("extrato_linha_invalida");
    const base=key+"|"+date.toISOString()+"|"+amount;
    const occurrence=repeat.get(base)||0;repeat.set(base,occurrence+1);
    rows.push({key,name,date:date.toISOString(),amount,
      fingerprint:crypto.createHash("sha256").update(base+"|"+occurrence).digest("hex")});
  }
  if(!rows.length)throw Error("extrato_sem_depositos");
  return {rows,skipped};
}
async function importBank(pool,text,actor){
  const parsed=parseBankCsv(text),client=await pool.connect();
  try{
    await client.query("BEGIN");
    let inserted=0;
    for(const r of parsed.rows){
      const res=await client.query(
        "INSERT INTO contributor_bank_deposits(row_fingerprint,player_key,player_name,paid_at,amount,imported_by) "+
        "VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [r.fingerprint,r.key,r.name,r.date,r.amount,String(actor||"staff")]);
      inserted+=res.rowCount;
    }
    await client.query("DELETE FROM contributor_bank_deposits WHERE paid_at<now()-interval '45 days'");
    await client.query("COMMIT");
    return {ok:true,parsed:parsed.rows.length,inserted,duplicates:parsed.rows.length-inserted,skipped:parsed.skipped,
      note:"Depositos importados como indicios; conferência de finalidade/pagamento permanece com a staff."};
  }catch(e){await client.query("ROLLBACK");throw e;}
  finally{client.release();}
}
async function deposits(pool,now=new Date()){
  const r=await pool.query(
    "SELECT player_key,paid_at,amount FROM contributor_bank_deposits WHERE paid_at >= $1 AND paid_at <= $2",
    [new Date(now.getTime()-BANK_RETENTION_DAYS*DAY_MS),now]);
  return r.rows;
}
async function attendanceByPlayer(now=new Date()){
  const guildId=process.env.GUILD_ID||"683411304408416285";
  const start=new Date(now.getTime()-WEEK_MS-DAY_MS);
  const all=await db.getEventsInRange(guildId,start,now);
  const list=attendance.selectCountedEvents(all).events.filter(ev=>{
    const w=attendance.windowFor(ev);
    return w&&w.end<=now&&w.start>=new Date(now.getTime()-WEEK_MS);
  });
  const ctx=await attendance.__test.loadEventsContext(guildId,list);
  const found=new Map(),ownerByNick=new Map(),ambiguous=new Set();
  for(const ev of list){
    const win=attendance.windowFor(ev);
    const rows=await attendance.processEvent(ev,ctx);
    for(const [userId,item] of rows){
      if(!["INTEGRAL","PARCIAL"].includes(item.level))continue;
      const key=keyOf(item.username);
      if(!key)continue;
      if(ownerByNick.has(key)&&ownerByNick.get(key)!==String(userId))ambiguous.add(key);
      else ownerByNick.set(key,String(userId));
      if(!found.has(key))found.set(key,[]);
      found.get(key).push({at:win.start.toISOString(),day:attendance.eventDay(ev,win),level:item.level});
    }
  }
  // Dois Discord IDs usando mesmo nome nao comprovam identidade com o Albion.
  for(const key of ambiguous)found.delete(key);
  return {events:list.length,byPlayer:found,ambiguous:[...ambiguous]};
}
function decorate(row,assignment,bankRows,attendanceRows,now=new Date(),sweeps=[]){
  const level=String(row.level),cycle=assignment?cycleAt(assignment.assigned_at,now):null;
  const paymentRequired=DUES[level]||null,ctaRequired=CTA_MINIMA[level]??null;
  const record=cycle?bankRows.filter(r=>r.player_key===keyOf(row.player)&&Date.parse(r.paid_at)>=Date.parse(cycle.start)&&Date.parse(r.paid_at)<Date.parse(cycle.end)):[];
  const paid=record.reduce((sum,r)=>sum+Number(r.amount),0);
  const cta=cycle?(attendanceRows||[]).filter(r=>Date.parse(r.at)>=Date.parse(cycle.start)&&Date.parse(r.at)<Date.parse(cycle.end)):[];
  const perDay={};
  for(const e of cta)perDay[e.day]=(perDay[e.day]||0)+1;
  const weekend=Object.entries(perDay).filter(([day])=>[0,6].includes(new Date(day+"T12:00:00Z").getUTCDay()));
  // Might exige baseline no proprio ciclo, nunca usa a varredura anterior a atribuicao.
  const pve=cycle?withinCycleMight(sweeps,"PVE",keyOf(row.player),cycle,now):null;
  const gathering=cycle?withinCycleMight(sweeps,"GATHERING",keyOf(row.player),cycle,now):null;
  const mightMinimum=row.minimum||{pve:1,gathering:1};
  const meetsMight=level!=="2"?null:pve==null||gathering==null?null:
    (pve>0&&pve>=mightMinimum.pve)||(gathering>0&&gathering>=mightMinimum.gathering);
  const meetsCta=ctaRequired==null?null:ctaRequired===0?true:
    cta.length===0?null:cta.length>=ctaRequired;
  const overallStatus=!cycle?"SEM DATA":level==="4"?"ISENTO DE CTA · CONFERIR PRATA":
    level==="2"?(meetsMight===true?"META MIGHT ATINGIDA · VERIFICAR ZVZ":
      meetsMight===false?"MIGHT ABAIXO DA META":"MIGHT SEM DADOS"):
    meetsCta===true?"META CTA ATINGIDA · OUTRAS OBRIGAÇÕES A CONFERIR":
    meetsCta===false?"CTA EM ANDAMENTO":"CTA SEM EVIDÊNCIA";
  return {...row,
    firstSeenAt:assignment?.first_seen_at||null,
    assignedAt:assignment?.assigned_at||null,
    assignmentSource:assignment?.assignment_source||"not_recorded",
    cycle,
    obligations:{paymentRequired,ctaRequired,resetDay:level==="1"||level==="2"?"OBRIGATÓRIO · VERIFICAR":"NÃO EXIGIDO",weekendRequired:level==="1"||level==="2",
      discordRequired:level!=="4",mightRequired:level==="2"},
    payment:{found:record.length,creditedCandidate:record.length?paid:null,verification:"PENDENTE DE CONFERÊNCIA"},
    attendance:{count:cta.length|| (level==="4"?0:null),weekendDays:weekend,
      matchedName:cta.length>0,verification:"CORRESPONDÊNCIA POR NOME, SEM COMPROVAÇÃO DE AUSÊNCIA"},
    cycleMight:{pve,gathering,verifiedWindow:pve!=null&&gathering!=null,meetsMight},
    ctaTargetMet:meetsCta,
    overallStatus
  };
}
function withinCycleMight(sweeps,code,key,cycle,now){
  const a=Date.parse(cycle.start),end=Math.min(Date.parse(cycle.end),new Date(now).getTime());
  const eligible=sweeps.filter(s=>s.code===code&&Date.parse(s.capturedAt)>=a&&Date.parse(s.capturedAt)<=end&&s.members.has(key));
  if(eligible.length<2)return null;
  const first=eligible[0].members.get(key),last=eligible[eligible.length-1].members.get(key);
  return last>=first?last-first:null;
}
module.exports={DAY_MS,WEEK_MS,DUES,CTA_MINIMA,tierOf,cycleAt,init,reconcile,bootstrap,assignments,
  confirmAssignment,parseBankCsv,importBank,deposits,attendanceByPlayer,decorate,withinCycleMight};
