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
  // Observed 2026-10-09 final page: five zero-valued bytes instead of number array.
  if (points?.kind==="bytes" && points.length===p["5"].length &&
    typeof points.base64==="string" && /^[A-Za-z0-9+/=]+$/.test(points.base64)) {
    const octets=Buffer.from(points.base64,"base64");
    if(octets.length===points.length && octets.every(x=>x===0))
      points=Array(octets.length).fill(0);
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
function assemblePages(pages,{maxWindowMs=2*60*60*1000}={}){
  const entries=(pages||[])
    .filter(p=>p && nonnegativeInteger(p.pageOffset) &&
      nonnegativeInteger(p.totalMembers) && Array.isArray(p.members))
    .map(p=>({...p,ms:Date.parse(p.capturedAt||p.captured_at||0)}))
    .filter(p=>Number.isFinite(p.ms))
    .sort((a,b)=>a.ms-b.ms);
  if(!entries.length)return {members:[],currentMembers:[],historicalMembers:[],totalMembers:null,
    observedMembers:0,historicalObservedMembers:0,complete:false,missingCount:0,pages:0};
  const newest=entries[entries.length-1];
  const recent=entries.filter(p=>p.ms>=newest.ms-maxWindowMs && p.totalMembers===newest.totalMembers &&
    (!newest.categoryCode||p.categoryCode===newest.categoryCode) &&
    (!newest.snapshotMarker||p.snapshotMarker===newest.snapshotMarker));
  // Full file history and recent observations must be kept separate. A historical
  // value is NEVER copied into the live/current leaderboard.
  function latestByPlayer(collection){
    const chosen=new Map();
    for(const page of collection){
      for(const member of page.members){
        const name=String(member.player||"").trim();
        if(!playerName(name))continue;
        const key=name.toLocaleLowerCase("en");
        const old=chosen.get(key);
        if(!old||page.ms>=old.ms){
          chosen.set(key,{...member,player:name,
            capturedAt:page.capturedAt,ms:page.ms,
            stale:page.ms<newest.ms-maxWindowMs});
        }
      }
    }
    return chosen;
  }
  const current=latestByPlayer(recent);
  const historical=latestByPlayer(entries);
  function sortRanks(items){
    return [...items].sort((a,b)=>
      (b.points??b.might??0)-(a.points??a.might??0) ||
      a.player.localeCompare(b.player,"pt-BR"))
      .map((m,i)=>({
        player:m.player,rank:i+1,capturedAt:m.capturedAt,
        stale:m.stale,
        ...(m.points!=null?{points:m.points}:{}),
        ...(m.might!=null?{might:m.might}:{})
      }));
  }
  const members=sortRanks(current.values());
  const historicalMembers=sortRanks([...historical.entries()]
    .filter(([key])=>!current.has(key)).map(([,member])=>({...member,stale:true})));
  return {
    members,currentMembers:members,historicalMembers,
    totalMembers:newest.totalMembers,
    observedMembers:members.length,
    historicalObservedMembers:historical.size,
    complete:members.length===newest.totalMembers,
    missingCount:Math.max(0,newest.totalMembers-members.length),
    pages:recent.length,historicalPages:entries.length,
    capturedAt:newest.capturedAt,
    recentWindowStart:new Date(newest.ms-maxWindowMs).toISOString(),
    categoryCode:newest.categoryCode||null,
    snapshotMarker:newest.snapshotMarker||null,
    guildTotalPoints:newest.guildTotalPoints??null,
    ranksRecalculated:true
  };
}

module.exports={KNOWN_CATEGORY_LABELS,TENTATIVE_CODES,USER_CONFIRMED_CODES,parseChallengeResponse,
  parseMightContributionResponse,parseMightOverviewResponse,assemblePages};
