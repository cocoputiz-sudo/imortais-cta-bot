"use strict";

const guildroster=require("./guildroster");
const guildRankingAuth=require("./guildRankingAuth");
const guildSeason=require("./guildSeason");
const {KNOWN_CATEGORY_LABELS}=require("./guildPhotonVerified");

const DAY_MS=86400000;
const MIN_GAP_MS=6*DAY_MS;
const MAX_SWEEP_MS=5*60000;
const FRESH_MS=7*DAY_MS;
const CODES=Object.keys(KNOWN_CATEGORY_LABELS);
const DEFAULT_MINIMA=Object.freeze({
  "1":{pve:1,gathering:1},
  "2":{pve:1,gathering:1},
  "3":{pve:1,gathering:1}
});

function contributorLevel(roles){
  const list=(roles||[]).map(x=>String(x).normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLowerCase());
  for(const tier of ["1","2","3"]){
    if(list.some(role=>new RegExp("^contribuinte\\s*"+tier+"$","i").test(role)))return tier;
  }
  return null;
}
function normalizedPlayer(x){return guildroster.normName(x);}
function thresholds(value){
  if(!value||typeof value!=="object")return JSON.parse(JSON.stringify(DEFAULT_MINIMA));
  const result={};
  for(const tier of ["1","2","3"]){
    const row=value[tier];
    if(!row||typeof row!=="object")throw Error("minima_invalidos");
    result[tier]={};
    for(const key of ["pve","gathering"]){
      const n=Number(row[key]);
      if(!Number.isSafeInteger(n)||n<0||n>1000000000000000)throw Error("minima_invalidos");
      result[tier][key]=n;
    }
  }
  return result;
}
function validateSettings(input){
  const day=Number(input.weekday);
  const time=String(input.timeUtc||"");
  if(!Number.isSafeInteger(day)||day<0||day>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error("horario_invalido");
  if(typeof input.reminderEnabled!=="boolean")throw Error("lembrete_invalido");
  return {minima:thresholds(input.minima),weekday:day,timeUtc:time,reminderEnabled:input.reminderEnabled};
}

async function init(pool){
  await pool.query([
    "CREATE TABLE IF NOT EXISTS contributor_roster_latest(",
    "id INTEGER PRIMARY KEY CHECK(id=1), members JSONB NOT NULL, member_count INTEGER NOT NULL,",
    "imported_at TIMESTAMPTZ NOT NULL DEFAULT now(), imported_by TEXT)",
    ";CREATE TABLE IF NOT EXISTS contributor_weekly_settings(",
    "id INTEGER PRIMARY KEY CHECK(id=1), minima JSONB NOT NULL,",
    "reminder_enabled BOOLEAN NOT NULL DEFAULT false, weekday SMALLINT NOT NULL DEFAULT 0,",
    "time_utc TEXT NOT NULL DEFAULT '18:00', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_by TEXT)",
    ";CREATE TABLE IF NOT EXISTS contributor_weekly_notifications(",
    "week_key DATE PRIMARY KEY, reminder_claimed_at TIMESTAMPTZ,reminder_sent_at TIMESTAMPTZ,",
    "summary_claimed_at TIMESTAMPTZ,summary_sent_at TIMESTAMPTZ)",
  ].join(" "));
  await pool.query("INSERT INTO contributor_weekly_settings(id,minima) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING",
    [JSON.stringify(DEFAULT_MINIMA)]);
}

async function saveRoster(pool,text,actor){
  const result=guildroster.parseGuildRoster(text);
  if(!result.ok)throw Error(result.error||"lista_invalida");
  const members=result.members.map(m=>({name:m.name,key:m.key,roles:m.roles}));
  const r=await pool.query(
    "INSERT INTO contributor_roster_latest(id,members,member_count,imported_at,imported_by) VALUES(1,$1::jsonb,$2,now(),$3) "+
    "ON CONFLICT(id) DO UPDATE SET members=EXCLUDED.members,member_count=EXCLUDED.member_count,imported_at=EXCLUDED.imported_at,imported_by=EXCLUDED.imported_by "+
    "RETURNING imported_at,member_count,imported_by",
    [JSON.stringify(members),members.length,String(actor||"unknown")]);
  return {...r.rows[0],contributors:members.filter(m=>contributorLevel(m.roles)).length,
    skipped:result.skipped.length,duplicates:result.duplicates};
}
async function rosterLatest(pool){
  const r=await pool.query("SELECT members,member_count,imported_at,imported_by FROM contributor_roster_latest WHERE id=1");
  return r.rows[0]||null;
}
async function getSettings(pool){
  const r=await pool.query("SELECT minima,reminder_enabled,weekday,time_utc,updated_at,updated_by FROM contributor_weekly_settings WHERE id=1");
  const row=r.rows[0]||{};
  return {minima:thresholds(row.minima||DEFAULT_MINIMA),
    reminderEnabled:!!row.reminder_enabled,
    weekday:Number(row.weekday??0),timeUtc:String(row.time_utc||"18:00"),
    updatedAt:row.updated_at||null,updatedBy:row.updated_by||null};
}
async function saveSettings(pool,input,actor){
  const cfg=validateSettings(input);
  await pool.query("UPDATE contributor_weekly_settings SET minima=$1::jsonb,reminder_enabled=$2,weekday=$3,time_utc=$4,updated_at=now(),updated_by=$5 WHERE id=1",
    [JSON.stringify(cfg.minima),cfg.reminderEnabled,cfg.weekday,cfg.timeUtc,String(actor||"unknown")]);
  return getSettings(pool);
}

// A verified sweep must cover EVERY original zero-based Photon position once,
// on ONE paired observer device within five minutes; do not combine observers
// or partial sweeps, and never infer ranks from the player's Might value.
function completeSweeps(pages){
  const sorted=(pages||[]).filter(p=>
    p&&CODES.includes(String(p.code))&&p.deviceId&&
    Number.isSafeInteger(p.pageOffset)&&p.pageOffset>=0&&
    Number.isSafeInteger(p.totalMembers)&&p.totalMembers>0&&
    Array.isArray(p.members)&&p.members.length>0&&
    p.pageOffset+p.members.length<=p.totalMembers&&
    Number.isFinite(Date.parse(p.capturedAt))
  ).sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt)||a.pageOffset-b.pageOffset);
  const active=new Map(),full=[];
  for(const page of sorted){
    const group=page.code+"\u001f"+page.deviceId,at=Date.parse(page.capturedAt);
    if(page.pageOffset===0)active.delete(group);
    let sweep=active.get(group);
    if(!sweep&&page.pageOffset===0){
      sweep={code:page.code,deviceId:page.deviceId,total:page.totalMembers,
        startedAt:page.capturedAt,start:at,end:at,ranks:new Map(),names:new Map()};
      active.set(group,sweep);
    }
    if(!sweep)continue;
    if(sweep.total!==page.totalMembers||at-sweep.start>MAX_SWEEP_MS){
      active.delete(group);continue;
    }
    let conflict=false;
    for(let i=0;i<page.members.length;i++){
      const m=page.members[i],idx=page.pageOffset+i,key=normalizedPlayer(m.player),
        val=Number(m.might),rank=Number(m.rank),prev=sweep.ranks.get(idx);
      if(!key||!Number.isSafeInteger(val)||val<0||
        !Number.isSafeInteger(rank)||rank!==idx+1||
        (prev&&(prev.key!==key||prev.might!==val))||
        (sweep.names.has(key)&&sweep.names.get(key)!==idx)){conflict=true;break;}
    }
    if(conflict){active.delete(group);continue;}
    for(let i=0;i<page.members.length;i++){
      const m=page.members[i],idx=page.pageOffset+i,key=normalizedPlayer(m.player);
      sweep.ranks.set(idx,{key,name:m.player,might:Number(m.might)});
      sweep.names.set(key,idx);
    }
    sweep.end=at;
    if(sweep.ranks.size===sweep.total && sweep.names.size===sweep.total){
      full.push({code:sweep.code,deviceId:sweep.deviceId,
        startedAt:sweep.startedAt,capturedAt:new Date(at).toISOString(),
        totalMembers:sweep.total,members:new Map([...sweep.ranks.values()].map(m=>[m.key,m.might]))});
      active.delete(group);
    }
  }
  return full.sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
}
function selectPair(sweeps,code){
  const list=sweeps.filter(s=>s.code===code);
  const latest=list.at(-1)||null;
  const previous=latest?list.filter(s=>Date.parse(latest.capturedAt)-Date.parse(s.capturedAt)>=MIN_GAP_MS).at(-1)||null:null;
  return {code,name:KNOWN_CATEGORY_LABELS[code],latest:latest&&{
    capturedAt:latest.capturedAt,startedAt:latest.startedAt,deviceId:latest.deviceId,members:latest.totalMembers},
    previous:previous&&{capturedAt:previous.capturedAt,startedAt:previous.startedAt,deviceId:previous.deviceId,members:previous.totalMembers},
    ready:!!(latest&&previous),_latest:latest,_previous:previous};
}
function memberDelta(pair,key){
  if(!pair.ready)return null;
  const a=pair._previous.members.get(key),b=pair._latest.members.get(key);
  if(a==null||b==null||b<a)return null; // unknown, absent or season counter reset
  return b-a;
}
function computeReport({roster,settings,sweeps,now=new Date(),season=null,sourceWarnings=[]}){
  const latestRoster=roster?.members||[];
  const pairs=Object.fromEntries(CODES.map(code=>[code,selectPair(sweeps,code)]));
  const required=["PVE","GATHERING"];
  const nowMs=new Date(now).getTime();
  const staleCodes=required.filter(code=>!pairs[code].latest||
    nowMs-Date.parse(pairs[code].latest.capturedAt)>FRESH_MS);
  const incompleteCodes=required.filter(code=>!pairs[code].ready);
  const everyone=latestRoster.filter(m=>contributorLevel(m.roles));
  const rows=everyone.map(m=>{
    const tier=contributorLevel(m.roles),key=normalizedPlayer(m.name),minimum=settings.minima[tier];
    const pve=memberDelta(pairs.PVE,key),gathering=memberDelta(pairs.GATHERING,key);
    const other=CODES.filter(c=>!required.includes(c)).map(code=>memberDelta(pairs[code],key));
    const observed=other.filter(x=>x!=null);
    const otherMight=observed.length?observed.reduce((a,b)=>a+b,0):null;
    let status="SEM DADOS";
    if(pve!==null&&gathering!==null){
      if(pve===0&&gathering===0&&(otherMight===null||otherMight===0))status="SEM EVOLUÇÃO";
      else if((pve>0&&pve>=minimum.pve)||(gathering>0&&gathering>=minimum.gathering))status="ATIVO";
      else status="ABAIXO DO MÍNIMO";
    }
    return {player:m.name,level:tier,roles:m.roles,pveMight:pve,gatheringMight:gathering,
      otherMight,otherCategoriesCompared:observed.length,otherCategoriesTotal:CODES.length-2,
      status,minimum,sourceRosterAt:roster.imported_at||null};
  }).sort((a,b)=>a.level.localeCompare(b.level)||a.player.localeCompare(b.player,"pt-BR"));
  const counts={active:rows.filter(x=>x.status==="ATIVO").length,
    below:rows.filter(x=>x.status==="ABAIXO DO MÍNIMO"||x.status==="SEM EVOLUÇÃO").length,
    noData:rows.filter(x=>x.status==="SEM DADOS").length,
    noEvolution:rows.filter(x=>x.status==="SEM EVOLUÇÃO").length,total:rows.length};
  const meta=Object.fromEntries(CODES.map(c=>[c,({
    name:pairs[c].name,latest:pairs[c].latest,previous:pairs[c].previous,
    ready:pairs[c].ready,stale:!pairs[c].latest||nowMs-Date.parse(pairs[c].latest.capturedAt)>FRESH_MS
  })]));
  return {generatedAt:new Date(now).toISOString(),roster:roster?{
    memberCount:roster.member_count,importedAt:roster.imported_at,importedBy:roster.imported_by
  }:null,season,limits:settings.minima,categories:meta,rows,counts,
    stale:staleCodes.length>0,staleCategories:staleCodes,
    incompleteCategories:incompleteCodes,
    warnings:[
      ...(roster?[]:["Não há lista de membros salva em Guilda Online."]),
      ...sourceWarnings,
      ...(incompleteCodes.length?["Sem duas varreduras INTEGRAIS separadas por no mínimo 6 dias: "+incompleteCodes.join(", ")]:[]),
      ...(staleCodes.length?["DESATUALIZADO: última varredura integral de "+staleCodes.join(" e ")+" há mais de 7 dias ou ausente."]:[])
    ]};
}
async function getReport(pool,{now=new Date()}={}){
  const [roster,settings,epoch,allowed]=await Promise.all([
    rosterLatest(pool),getSettings(pool),guildSeason.getSeasonEpoch(pool),guildRankingAuth.approvedDeviceIds(pool)
  ]);
  const warnings=[];
  if(!guildSeason.canPublishRankings(epoch))warnings.push("Temporada sem início oficial verificado: classificação suspensa.");
  if(!allowed.size)warnings.push("Nenhum dispositivo de Might com pareamento ativo.");
  let sweeps=[];
  if(guildSeason.canPublishRankings(epoch)&&allowed.size){
    const bounds=new Date(Math.max(Date.parse(epoch.startAt||0)||0,new Date(now).getTime()-90*DAY_MS)).toISOString();
    const r=await pool.query(
      "SELECT s.id,s.device_id,s.captured_at,s.layout "+
      "FROM guild_might_snapshots s WHERE s.members_complete=true AND s.category_mapped=true "+
      "AND s.layout->>'guildVerified'='true' "+
      "AND s.layout->>'code'=ANY($1::text[]) AND s.device_id=ANY($2::text[]) "+
      "AND s.captured_at>=$3::timestamptz ORDER BY s.captured_at,s.id LIMIT 25000",
      [CODES,[...allowed],bounds]);
    if(r.rows.length===25000)warnings.push("Limite de 25.000 páginas atingido; algumas varreduras podem não estar disponíveis.");
    const ids=r.rows.map(x=>x.id),map=new Map();
    if(ids.length){
      const records=await pool.query(
        "SELECT snapshot_id,player_name,might,member_rank FROM guild_might_snapshot_members "+
        "WHERE snapshot_id=ANY($1::bigint[]) ORDER BY snapshot_id,member_rank",[ids]);
      for(const m of records.rows){
        const id=String(m.snapshot_id);
        if(!map.has(id))map.set(id,[]);
        map.get(id).push({player:m.player_name,might:Number(m.might),rank:Number(m.member_rank)});
      }
    }
    const pages=r.rows.map(x=>({
      code:x.layout?.code,deviceId:x.device_id,capturedAt:x.captured_at,
      pageOffset:Number(x.layout?.pageOffset),totalMembers:Number(x.layout?.totalMembers),
      members:map.get(String(x.id))||[]
    }));
    sweeps=completeSweeps(pages);
  }
  return computeReport({roster,settings,sweeps,now,season:epoch,sourceWarnings:warnings});
}
function mondayUtc(now){
  const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
  return d;
}
function scheduledForWeek(now,settings){
  const d=mondayUtc(now);
  d.setUTCDate(d.getUTCDate()+(settings.weekday+6)%7);
  const [hour,minute]=settings.timeUtc.split(":").map(Number);
  d.setUTCHours(hour,minute,0,0);
  return d;
}
let ticking=false;
async function tick(pool,client,{channelId,now=new Date()}={}){
  if(ticking)return {skipped:"in_progress"};
  ticking=true;
  try{
    const cfg=await getSettings(pool);
    if(!cfg.reminderEnabled)return {skipped:"disabled"};
    const schedule=scheduledForWeek(now,cfg),ms=new Date(now).getTime()-schedule.getTime();
    if(ms<0||ms>DAY_MS)return {skipped:"not_due"};
    if(!channelId)return {skipped:"staff_channel_unconfigured"};
    const channel=await client.channels.fetch(channelId).catch(()=>null);
    if(!channel||!channel.send||channel.guildId!==process.env.GUILD_ID)return {skipped:"staff_channel_missing"};
    const week=mondayUtc(now).toISOString().slice(0,10);
    await pool.query("INSERT INTO contributor_weekly_notifications(week_key) VALUES($1::date) ON CONFLICT DO NOTHING",[week]);
    const claim=async(prefix)=>pool.query(
      "UPDATE contributor_weekly_notifications SET "+prefix+"_claimed_at=now() "+
      "WHERE week_key=$1::date AND "+prefix+"_sent_at IS NULL "+
      "AND ("+prefix+"_claimed_at IS NULL OR "+prefix+"_claimed_at<now()-interval '10 minutes') RETURNING week_key",[week]);
    const reminder=await claim("reminder");
    if(reminder.rowCount){
      try{
        await channel.send({content:"📋 **VARREDURA SEMANAL DE MIGHT — IMORTAIS**\nHoje é dia de varredura INTEGRAL do Guild Might: percorram todas as páginas, especialmente PvE e Coleta, com o Combat Client pareado. A classificação de contribuintes só utiliza duas varreduras integrais com pelo menos 6 dias entre elas. Confira o relatório no War Room.",allowedMentions:{parse:[]}});
        await pool.query("UPDATE contributor_weekly_notifications SET reminder_sent_at=now() WHERE week_key=$1::date",[week]);
      }catch(e){await pool.query("UPDATE contributor_weekly_notifications SET reminder_claimed_at=NULL WHERE week_key=$1::date",[week]);throw e;}
    }
    const prior=await pool.query("SELECT reminder_sent_at,summary_sent_at FROM contributor_weekly_notifications WHERE week_key=$1::date",[week]);
    if(!prior.rows[0]?.reminder_sent_at||prior.rows[0]?.summary_sent_at)return {reminderPosted:!!reminder.rowCount};
    const report=await getReport(pool,{now});
    if(report.stale||report.incompleteCategories.length||!report.counts.total||
      ["PVE","GATHERING"].some(code=>!report.categories[code].latest||
      Date.parse(report.categories[code].latest.capturedAt)<schedule.getTime()))return {waitingForFullSweep:true};
    const claimed=await claim("summary");
    if(!claimed.rowCount)return {summaryPosted:false};
    try{
      await channel.send({content:
        "📊 **CONTRIBUINTES — RESUMO DA VARREDURA SEMANAL**\n"+
        "✅ ATIVOS: **"+report.counts.active+"** | "+
        "⚠️ ABAIXO (inclui sem evolução): **"+report.counts.below+"** | "+
        "❔ SEM DADOS: **"+report.counts.noData+"**\n"+
        "PVE: "+report.categories.PVE.latest.capturedAt+" UTC | Coleta: "+report.categories.GATHERING.latest.capturedAt+
        " UTC\nRelatório completo no War Room · Guild Might → Contribuintes – semana.",
        allowedMentions:{parse:[]}});
      await pool.query("UPDATE contributor_weekly_notifications SET summary_sent_at=now() WHERE week_key=$1::date",[week]);
    }catch(e){await pool.query("UPDATE contributor_weekly_notifications SET summary_claimed_at=NULL WHERE week_key=$1::date",[week]);throw e;}
    return {summaryPosted:true};
  }finally{ticking=false;}
}
module.exports={init,saveRoster,rosterLatest,getSettings,saveSettings,validateSettings,
  contributorLevel,completeSweeps,selectPair,memberDelta,computeReport,getReport,scheduledForWeek,tick};
