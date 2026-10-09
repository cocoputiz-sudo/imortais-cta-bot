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
  // Labels below are proposed correspondences, not confirmed by a Photon string.
  DRAGON_AREA: "Terras Ancestrais",
  GVGSEASON: "Magos Engarrafadores"
});
const TENTATIVE_CODES = new Set(["DRAGON_AREA", "GVGSEASON", "HELLDUNGEON"]);

function nonnegativeInteger(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function playerName(v) { return typeof v === "string" && /^[\p{L}\p{N}_-]{2,32}$/u.test(v); }
function numArray(v) { return Array.isArray(v) && v.every(nonnegativeInteger); }
function namesArray(v) { return Array.isArray(v) && v.every(playerName); }

function parseChallengeResponse(p) {
  if (!p || !namesArray(p["5"]) || !numArray(p["6"]) ||
    p["5"].length !== p["6"].length || !nonnegativeInteger(p["3"])) return null;
  const pageOffset = p["4"] == null ? 0 : p["4"];
  const totalMembers = p["3"];
  if (!nonnegativeInteger(pageOffset) || pageOffset + p["5"].length > totalMembers ||
      totalMembers > 100000 || p["5"].length > 1200) return null;
  return {
    operation: "GetGuildChallengePoints",
    pageOffset, totalMembers,
    // 1/2 appear to be server markers/aggregates; semantics not verified.
    members: p["5"].map((player,i) => ({player,points:p["6"][i],rank:pageOffset+i+1})),
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
  if(!entries.length)return {
    members:[],totalMembers:null,observedMembers:0,complete:false,
    missingRanges:[],pages:0
  };
  const newest=entries[entries.length-1];
  const selected=entries.filter(p=>newest.ms-p.ms<=maxWindowMs &&
    p.totalMembers===newest.totalMembers &&
    (!newest.categoryCode||p.categoryCode===newest.categoryCode));
  // Player identity, not ranking offset, is the deduplication key. A member
  // may move from rank 20 to rank 3 between pages and must appear once only.
  const byPlayer=new Map();
  for(const page of selected){
    for(const member of page.members){
      const name=String(member.player||"").trim();
      if(!playerName(name))continue;
      const key=name.toLocaleLowerCase("en");
      const existing=byPlayer.get(key);
      if(!existing || page.ms>existing.ms || page.ms===existing.ms &&
          String(page.responseEventId||"")>String(existing.eventId||"")){
        byPlayer.set(key,{...member,player:name,ms:page.ms,
          eventId:page.responseEventId||null});
      }
    }
  }
  const members=[...byPlayer.values()].sort((a,b)=>{
    const av=a.points??a.might??0,bv=b.points??b.might??0;
    return bv-av||a.player.localeCompare(b.player,"pt-BR");
  }).map((m,i)=>({
    player:m.player,rank:i+1,
    ...(m.points!=null?{points:m.points}:{}),
    ...(m.might!=null?{might:m.might}:{})
  }));
  // rank here means position among OBSERVED members, not a confirmed global rank
  // when coverage is incomplete. We never fabricate missing players as zero.
  const observedMembers=members.length;
  return {
    members,totalMembers:newest.totalMembers,observedMembers,
    complete:observedMembers===newest.totalMembers,
    missingCount:Math.max(0,newest.totalMembers-observedMembers),
    missingRanges:[], // obsolete when positions are recalculated by player
    ranksRecalculated:true,
    pages:selected.length,capturedAt:newest.capturedAt,
    categoryCode:newest.categoryCode||null
  };
}

module.exports={KNOWN_CATEGORY_LABELS,TENTATIVE_CODES,parseChallengeResponse,
  parseMightContributionResponse,parseMightOverviewResponse,assemblePages};
