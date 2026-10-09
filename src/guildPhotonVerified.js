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

module.exports={KNOWN_CATEGORY_LABELS,TENTATIVE_CODES,USER_CONFIRMED_CODES,parseChallengeResponse,
  parseMightContributionResponse,parseMightOverviewResponse,assemblePages,reconcileCategoryAtServerInstant};
