"use strict";

/**
 * Verified against actual 2026-10-09 Photon dumps from Albion West.
 * These operations contain guild totals and paginated member lists, but
 * NOT Challenge level, category levels, thresholds, or Season Point rewards.
 * Never infer those latter values from the screenshot/reference table.
 */
const KNOWN_CATEGORY_LABELS = Object.freeze({
  CASTLE: "Castelos e Postos Avançados",
  CORRUPTED: "Masmorras Corrompidas",
  DRAGON_HUNT: "Caça aos Dragões",
  ENERGYCRYSTAL: "Cristais de Território",
  GATHERING: "Coleta",
  HELLDUNGEON: "As Profundezas",
  HELLGATE: "Hellgates",
  POWERCORE: "Núcleos de Esconderijo",
  PVE: "PvE (Outlands e Roads)",
  SMUGGLERS: "Contrabandistas",
  SPIDERS: "Criaturas de Cristal",
  TREASURES: "Tesouros das Outlands",
  // Confirmed by guild leader in Albion UI against category leaderboard on 2026-10-09.
  DRAGON_AREA: "Terras Ancestrais",
  GVGSEASON: "Magos Engarrafadores"
});
// All 14 mappings validated by guild leader against in-game category labels on 2026-10-09.
const USER_CONFIRMED_CODES = new Set(Object.keys(KNOWN_CATEGORY_LABELS));
const TENTATIVE_CODES = new Set();

// Identifier captured from verified IMORTAIS Photon probes, not a Discord
// role or the observer's display name. Match in constant time after decoding.
const IMORTAIS_GUILD_ID_BASE64="ckzUYJXLFUmTBs0y4mZ+SQ==";
function validImortaisGuild(p,operation){
  if(!p||typeof p!=="object")return false;
  // GvgSeasonContributionByActivity response uses param 1 for guild identity;
  // Might overview/contribution and Challenge use param 0.
  const field=operation==="GetGvgSeasonContributionByActivity"?"1":"0";
  const raw=p[field];
  if(!raw||raw.kind!=="bytes"||raw.length!==16)return false;
  const b64=typeof raw.base64==="string"?raw.base64:raw.previewBase64;
  if(typeof b64!=="string"||b64.length!==24||!/^[A-Za-z0-9+/]{22}==$/.test(b64))return false;
  const buf=Buffer.from(b64,"base64");
  return buf.length===16&&buf.toString("base64")===b64&&
    require("node:crypto").timingSafeEqual(buf,Buffer.from(IMORTAIS_GUILD_ID_BASE64,"base64"));
}
function parseGuildSeasonResponse(p){
  return validImortaisGuild(p,"GetGvgSeasonContributionByActivity")&&
    nonnegativeInteger(p["0"])&&p["0"]>0?p["0"]:null;
}

function nonnegativeInteger(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function playerName(v) { return typeof v === "string" && /^[\p{L}\p{N}_-]{2,32}$/u.test(v); }
function numArray(v) { return Array.isArray(v) && v.every(nonnegativeInteger); }
function namesArray(v) { return Array.isArray(v) && v.every(playerName); }

function parseChallengeResponse(p) {
  if (!p || !namesArray(p["5"]) || !nonnegativeInteger(p["3"])) return null;
  let points=p["6"];
  // Photon may send small score pages as byte[], including non-zero values.
  // The normal Combat Client sends previewBase64, while earlier dumps use
  // base64. Only decode complete byte arrays, never a truncated preview.
  if(points?.kind==="bytes"){
    const encoded=typeof points.base64==="string"?points.base64:points.previewBase64;
    const count=Number(points.length);
    if(Number.isSafeInteger(count) && count>=0 && count===p["5"].length &&
      typeof encoded==="string" && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) &&
      encoded.length%4===0){
      const octets=Buffer.from(encoded,"base64");
      if(octets.length===count && octets.toString("base64")===encoded)
        points=Array.from(octets);
    }
  }
  if(!numArray(points) || points.length!==p["5"].length) return null;
  const pageOffset = p["4"] == null ? 0 : p["4"];
  const totalMembers = p["3"];
  if (!nonnegativeInteger(pageOffset) || pageOffset + p["5"].length > totalMembers ||
      totalMembers > 100000 || p["5"].length > 1200) return null;
  return {
    operation: "GetGuildChallengePoints",
    snapshotMarker:p["1"]==null?null:String(p["1"]),
    guildTotalPoints:nonnegativeInteger(p["2"])?p["2"]:null,
    pageOffset, totalMembers,
    // 1/2 appear to be server markers/aggregates; semantics not verified.
    members: p["5"].map((player,i) => ({player,points:points[i],rank:pageOffset+i+1})),
    level: null,
    seasonPoints: null
  };
}

function parseMightContributionResponse(p) {
  if (!p || typeof p["1"] !== "string" || !namesArray(p["6"]) ||
    !numArray(p["7"]) || p["6"].length !== p["7"].length ||
    !nonnegativeInteger(p["4"]) || !nonnegativeInteger(p["3"])) return null;
  const pageOffset = p["5"] == null ? 0 : p["5"];
  const totalMembers = p["4"];
  if (!nonnegativeInteger(pageOffset) || pageOffset + p["6"].length > totalMembers ||
    totalMembers > 100000 || p["6"].length > 1200) return null;
  const code = p["1"];
  return {
    operation:"GetGuildMightCategoryContribution",
    categoryCode:code,
    snapshotMarker:p["2"]==null?null:String(p["2"]),
    categoryName:KNOWN_CATEGORY_LABELS[code] || code,
    categoryNameTentative:TENTATIVE_CODES.has(code),
    pageOffset,totalMembers,
    guildMight:p["3"],
    members:p["6"].map((player,i) => ({player,might:p["7"][i],rank:pageOffset+i+1})),
    level:null,seasonPoints:null,threshold:null
  };
}

function parseMightOverviewResponse(p) {
  if (!p || !Array.isArray(p["2"]) || !numArray(p["3"]) ||
    p["2"].length !== p["3"].length || !p["2"].every(x=>typeof x==="string")) return null;
  return {
    operation:"GetGuildMightCategoryOverview",
    snapshotMarker:p["1"]==null?null:String(p["1"]),
    guildIdBytes:p["0"]?.kind==="bytes"?p["0"]:null,
    seasonOrGuildReference:p["1"]??null,
    responseOperationCode:p["253"]??null,
    requestCorrelationId:p["255"]??null,
    categories:p["2"].map((code,i)=>({
      code,
      name:KNOWN_CATEGORY_LABELS[code] || code,
      nameTentative:TENTATIVE_CODES.has(code),
      guildMight:p["3"][i],
      level:null,seasonPoints:null,threshold:null
    }))
  };
}

/** Reconstruct rank slots, never treat a single paginated response as a full leaderboard. */
function assemblePages(pages,{seasonStartAt=null,asOf=null}={}){
  const started=seasonStartAt==null?Number.NEGATIVE_INFINITY:Date.parse(seasonStartAt);
  const entries=(pages||[]).filter(p=>p && nonnegativeInteger(p.pageOffset) &&
      nonnegativeInteger(p.totalMembers) && Array.isArray(p.members))
    .map(p=>({...p,ms:Date.parse(p.capturedAt||p.captured_at||0)}))
    .filter(p=>Number.isFinite(p.ms) && p.ms>=started)
    .sort((a,b)=>a.ms-b.ms);
  const empty={members:[],currentMembers:[],historicalMembers:[],totalMembers:null,
    observedMembers:0,historicalObservedMembers:0,complete:false,missingCount:0,
    pages:0,historicalPages:0,lastCompleteAt:null,oldestMemberAt:null};
  if(!entries.length)return empty;
  const newest=entries[entries.length-1];
  const now=asOf==null?Date.now():Date.parse(asOf);
  const validNow=Number.isFinite(now)?now:Date.now();
  const normalize=name=>String(name||"").trim().toLocaleLowerCase("en");
  // A complete capture must cover ALL positions in one exact server marker.
  // If Photon gives no marker, only a full single page can be trusted.
  const groups=new Map();
  for(const p of entries){
    const marker=p.snapshotMarker==null?null:String(p.snapshotMarker);
    const groupKey=marker==null
      ? "unmarked:"+String(p.responseEventId||p.ms)+":"+p.pageOffset
      : [p.categoryCode||"",marker,p.totalMembers].join("\u001f");
    if(!groups.has(groupKey))groups.set(groupKey,[]);
    groups.get(groupKey).push(p);
  }
  const completed=[];
  for(const group of groups.values()){
    const size=group[0].totalMembers;
    if(group.some(p=>p.totalMembers!==size))continue;
    const ranks=new Map();
    let conflict=false;
    for(const p of group){
      for(let i=0;i<p.members.length;i++){
        const name=normalize(p.members[i]?.player);
        const rank=p.pageOffset+i;
        if(!playerName(String(p.members[i]?.player||"")) || rank<0 || rank>=size){conflict=true;break;}
        const old=ranks.get(rank);
        if(old && normalize(old.member.player)!==name)conflict=true;
        if(!old||p.ms>old.ms)ranks.set(rank,{member:p.members[i],ms:p.ms,capturedAt:p.capturedAt});
      }
      if(conflict)break;
    }
    const keys=new Set([...ranks.values()].map(x=>normalize(x.member.player)));
    if(!conflict && ranks.size===size && keys.size===size && size>0){
      const at=Math.max(...group.map(p=>p.ms));
      completed.push({at,members:[...ranks.values()],marker:group[0].snapshotMarker??null,totalMembers:size});
    }
  }
  completed.sort((a,b)=>a.at-b.at);
  const latestComplete=completed[completed.length-1]||null;
  const start=latestComplete?.at??Number.NEGATIVE_INFINITY;
  const current=new Map(),deleted=new Map();
  if(latestComplete){
    for(const {member,ms,capturedAt} of latestComplete.members){
      const key=normalize(member.player);
      current.set(key,{...member,capturedAt,ms});
    }
    // Older valid increases are floors only for members still present in
    // the complete capture. Their older timestamps are not used as 'fresh'.
    for(const p of entries){
      if(p.ms>start)break;
      for(const m of p.members){
        const key=normalize(m.player),existing=current.get(key);
        if(existing && (m.might??m.points??0)>(existing.might??existing.points??0)){
          const value=m.might??m.points;
          if(m.might!=null)existing.might=value; else existing.points=value;
        }
      }
    }
    const departed=new Map();
    for(const p of entries){
      if(p.ms>=start)break;
      for(const m of p.members)if(!current.has(normalize(m.player))) departed.set(normalize(m.player),{
        ...m,player:m.player,capturedAt:p.capturedAt,ms:p.ms,stale:true,removedByComplete:true});
    }
    for(const [k,v] of departed)deleted.set(k,v);
  }
  for(const p of entries){
    if(p.ms<=start)continue;
    for(const m of p.members){
      const name=String(m.player||"").trim(),key=normalize(name);
      if(!playerName(name))continue;
      const prev=current.get(key);
      // Might and Challenge are monotonic within the same season. A lower
      // reading never overwrites a trusted higher prior observation.
      const oldValue=prev?.might??prev?.points??-1;
      const value=m.might??m.points??0;
      const row={...(prev||{}),...m,player:name,capturedAt:p.capturedAt,ms:p.ms};
      if(value<oldValue){
        if(prev.might!=null)row.might=prev.might;
        else row.points=prev.points;
        row.lowerReadingIgnored=true;
      }
      current.set(key,row);
      deleted.delete(key);
    }
  }
  const sortRanks=items=>[...items].sort((a,b)=>
    (b.points??b.might??0)-(a.points??a.might??0) ||
    a.player.localeCompare(b.player,"pt-BR"))
    .map((m,i)=>({
      player:m.player,rank:i+1,capturedAt:m.capturedAt,
      stale:validNow-m.ms>24*60*60*1000,
      ...(m.lowerReadingIgnored?{lowerReadingIgnored:true}:{}),
      ...(m.removedByComplete?{removedByComplete:true}:{}),
      ...(m.points!=null?{points:m.points}:{}),
      ...(m.might!=null?{might:m.might}:{})
    }));
  const members=sortRanks(current.values());
  const historicalMembers=sortRanks(deleted.values());
  const newestMarker=String(newest.snapshotMarker??"");
  const latestIsComplete=completed.some(c=>c.at===newest.ms &&
    String(c.marker??"")===newestMarker);
  const times=[...current.values()].map(x=>x.ms);
  return {
    members,currentMembers:members,historicalMembers,
    totalMembers:newest.totalMembers,observedMembers:members.length,
    historicalObservedMembers:current.size+deleted.size,
    complete:latestIsComplete,
    lastCompleteAt:latestComplete?new Date(latestComplete.at).toISOString():null,
    oldestMemberAt:times.length?new Date(Math.min(...times)).toISOString():null,
    oldestMemberAgeMs:times.length?Math.max(0,validNow-Math.min(...times)):null,
    missingCount:Math.max(0,newest.totalMembers-members.length),
    coverage:members.length+"/"+newest.totalMembers,
    pages:entries.filter(p=>String(p.snapshotMarker??"")===newestMarker).length,
    historicalPages:entries.length,
    capturedAt:newest.capturedAt,
    recentWindowStart:seasonStartAt,
    categoryCode:newest.categoryCode||null,
    snapshotMarker:newest.snapshotMarker||null,
    guildTotalPoints:newest.guildTotalPoints??null,
    observedPoints:members.reduce((total,m)=>total+(m.points??0),0),
    observedMight:members.reduce((total,m)=>total+(m.might??0),0),
    ranksRecalculated:true
  };
}


/**
 * Might sweeps are not equivalent to same-marker Photon instants.
 * A sweep uses ONE observer device, stable roster size, all rank slots,
 * unique player identities and a bounded elapsed time. Its purpose is
 * roster coverage and confirmed departures, not exact value reconciliation.
 */
function assembleMightPages(pages,{seasonStartAt=null,asOf=null,sweepMinutes=5}={}){
  const begin=seasonStartAt==null?-Infinity:Date.parse(seasonStartAt);
  const now=asOf==null?Date.now():Date.parse(asOf);
  const currentTime=Number.isFinite(now)?now:Date.now();
  const maxMs=Math.min(15,Math.max(1,Number(sweepMinutes)||5))*60000;
  const entries=(pages||[]).map(p=>({...p,ms:Date.parse(p.capturedAt||p.captured_at||0)}))
    .filter(p=>Number.isFinite(p.ms)&&p.ms>=begin&&
      Number.isSafeInteger(p.pageOffset)&&p.pageOffset>=0&&
      Number.isSafeInteger(p.totalMembers)&&p.totalMembers>0&&
      Array.isArray(p.members)&&p.members.length>0&&
      p.pageOffset+p.members.length<=p.totalMembers)
    .sort((a,b)=>a.ms-b.ms||a.pageOffset-b.pageOffset);
  if(!entries.length)return {members:[],historicalMembers:[],observedMembers:0,
    totalMembers:null,complete:false,sweepComplete:false,
    sweepCoverage:null,lastCompleteAt:null,oldestMemberAt:null,
    observedMight:0,coverage:null,pages:0,historicalPages:0};
  const keyOf=p=>String(p||"").trim().toLowerCase();
  const active=new Map(),full=[];
  for(const page of entries){
    const id=String(page.deviceId||"");
    // Unknown/missing source identity can be included in the season's
    // consolidated scores, but cannot certify membership departures.
    if(!id)continue;
    const rankZero=page.pageOffset===0;
    if(rankZero)active.delete(id);
    let sweep=active.get(id);
    if(!sweep && rankZero){
      sweep={start:page.ms,last:page.ms,total:page.totalMembers,
        ranks:new Map(),names:new Map(),device:id,count:0};
      active.set(id,sweep);
    }
    if(!sweep)continue;
    if(page.ms-sweep.start>maxMs||page.totalMembers!==sweep.total){
      active.delete(id);continue;
    }
    let conflict=false;
    for(let i=0;i<page.members.length;i++){
      const member=page.members[i],player=String(member.player||"").trim();
      const rank=page.pageOffset+i,normalized=keyOf(player);
      const existing=sweep.ranks.get(rank),otherRank=sweep.names.get(normalized);
      // member.rank from storage must match the original Photon page slot.
      // Historical snapshots without that metadata may be scored, not certified.
      if(!player||!/^\S/.test(player)||
        !Number.isFinite(Number(member.might))||Number(member.might)<0||
        !Number.isSafeInteger(member.rank)||member.rank!==rank+1||
        (existing&&keyOf(existing.player)!==normalized)||
        (otherRank!=null&&otherRank!==rank)){conflict=true;break;}
    }
    if(conflict){active.delete(id);continue;}
    for(let i=0;i<page.members.length;i++){
      const m=page.members[i],rank=page.pageOffset+i,key=keyOf(m.player);
      sweep.ranks.set(rank,{...m,capturedAt:page.capturedAt,ms:page.ms});
      sweep.names.set(key,rank);
    }
    sweep.last=page.ms;sweep.count++;
    if(sweep.ranks.size===sweep.total&&sweep.names.size===sweep.total){
      full.push({...sweep,members:[...sweep.ranks.values()]});
      active.delete(id);
    }
  }
  full.sort((a,b)=>a.last-b.last);
  const latestFull=full.at(-1)||null,cutoff=latestFull?.last??-Infinity;
  const eligible=latestFull?new Set(latestFull.members.map(m=>keyOf(m.player))):null;
  const latestSeen=new Map(),floors=new Map();
  for(const page of entries){
    for(const m of page.members){
      const name=String(m.player||"").trim(),key=keyOf(name),value=Number(m.might);
      if(!name||!Number.isFinite(value)||value<0)continue;
      const earlier=floors.get(key);
      if(!earlier||value>=earlier.might)
        floors.set(key,{player:name,might:value,capturedAt:page.capturedAt,ms:page.ms});
      latestSeen.set(key,{player:name,ms:page.ms});
    }
  }
  const current=new Map(),historical=new Map();
  for(const [key,row] of floors){
    let seenAfter=false;
    if(latestFull&&!eligible.has(key)){
      // Check only subsequent pages; not a previous observation.
      for(let i=entries.length-1;i>=0;i--){
        const p=entries[i];if(p.ms<=cutoff)break;
        if(p.members.some(m=>keyOf(m.player)===key)){seenAfter=true;break;}
      }
    }
    const live=!latestFull||eligible.has(key)||seenAfter;
    const lastSeenAt=latestSeen.get(key)?.ms;
    const record={...row,lastSeenAt:lastSeenAt==null?null:new Date(lastSeenAt).toISOString(),
      stale:currentTime-row.ms>24*3600000,
      ...(live?{}:{removedByComplete:true})};
    (live?current:historical).set(key,record);
  }
  const rank=(iter)=>[...iter].sort((a,b)=>b.might-a.might||a.player.localeCompare(b.player,"pt-BR"))
    .map((m,i)=>({...m,rank:i+1}));
  const members=rank(current.values()),history=rank(historical.values());
  const last=entries.at(-1);
  const timestamps=members.map(m=>m.ms);
  const latestTotal=last.totalMembers;
  const certified=!!latestFull&&latestFull.total===latestTotal&&members.length===latestTotal;
  return {members,currentMembers:members,historicalMembers:history,
    totalMembers:latestTotal,observedMembers:members.length,
    historicalObservedMembers:members.length+history.length,
    complete:certified,sweepComplete:!!latestFull,
    sweepCoverage:latestFull?latestFull.total+"/"+latestFull.total:null,
    sweepStartedAt:latestFull?new Date(latestFull.start).toISOString():null,
    sweepDurationMs:latestFull?latestFull.last-latestFull.start:null,
    lastCompleteAt:latestFull?new Date(latestFull.last).toISOString():null,
    oldestMemberAt:timestamps.length?new Date(Math.min(...timestamps)).toISOString():null,
    oldestMemberAgeMs:timestamps.length?Math.max(0,currentTime-Math.min(...timestamps)):null,
    coverage:members.length+"/"+latestTotal,
    missingCount:Math.max(0,latestTotal-members.length),
    pages:latestFull?.count||0,historicalPages:entries.length,
    capturedAt:last.capturedAt,
    observedMight:members.reduce((n,m)=>n+m.might,0),
    sweepMethod:"one_device_5min_stable_total_unique_positions"};
}

/**
 * Correlate actual server snapshots. Only report a numerical residue when all
 * member ranks are covered by ONE exact Photon snapshotMarker.
 * Cross-marker sums are deliberately not compared to an Overview aggregate.
 */
function reconcileCategoryAtServerInstant(overview, contributionPages, categoryCode) {
 const marker=overview?.snapshotMarker;
 const category=(overview?.categories||[]).find(c=>c.code===categoryCode);
 if(!marker||!category)return {matched:false,reason:"overview_missing"};
 const pages=(contributionPages||[]).filter(p=>p?.snapshotMarker===marker &&
   p.categoryCode===categoryCode);
 if(!pages.length)return {matched:false,reason:"no_matching_pages",snapshotMarker:marker};
 const totalMembers=pages[0].totalMembers;
 const players=new Map();
 const coveredRanks=new Set();
 for(const p of pages) {
   if(p.totalMembers!==totalMembers)return {matched:false,reason:"roster_changed",snapshotMarker:marker};
   p.members.forEach((m,i)=>{
     const rank=p.pageOffset+i+1;
     coveredRanks.add(rank);
     const key=m.player.toLowerCase();
     const existing=players.get(key);
     if(!existing||String(p.capturedAt||"")>=String(existing.capturedAt||""))
       players.set(key,{might:m.might,capturedAt:p.capturedAt});
   });
 }
 const complete=coveredRanks.size===totalMembers&&players.size===totalMembers;
 if(!complete)return {matched:true,complete:false,snapshotMarker:marker,
   observedMembers:players.size,expectedMembers:totalMembers,
   guildMight:category.guildMight,difference:null};
 const sum=[...players.values()].reduce((a,p)=>a+p.might,0);
 return {matched:true,complete:true,snapshotMarker:marker,
   observedMembers:players.size,expectedMembers:totalMembers,
   observedMight:sum,guildMight:category.guildMight,
   difference:sum-category.guildMight};
}

module.exports={KNOWN_CATEGORY_LABELS,TENTATIVE_CODES,USER_CONFIRMED_CODES,IMORTAIS_GUILD_ID_BASE64,validImortaisGuild,parseGuildSeasonResponse,parseChallengeResponse,
  parseMightContributionResponse,parseMightOverviewResponse,assemblePages,assembleMightPages,reconcileCategoryAtServerInstant};
