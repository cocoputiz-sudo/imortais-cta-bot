"use strict";
const {KNOWN_CATEGORY_LABELS,parseMightContributionResponse,parseMightOverviewResponse,assemblePages,validImortaisGuild}=require("./guildPhotonVerified");

const CATEGORY_ALIASES = Object.freeze({
  "pveoutlandsandroads": "PvE",
  "gatheringoutlandsandroads": "Coleta",
  "siphoningmages": "Magos Engarrafadores",
  "hideoutpowercores": "Núcleos de Esconderijo",
  "territorypowercrystals": "Cristais de Território",
  "outlandstreasures": "Tesouros",
  // "Aranhas" é a chave legada do nosso coletor para Crystal Creatures.
  // Não mudamos a chave para evitar duplicar Might entre snapshots antigos e novos.
  "crystalcreatures": "Aranhas",
  "smugglers": "Contrabandistas",
  "thedepths": "As Profundezas",
  "corrupteddungeons": "Masmorras Corrompidas",
  "castlescastleoutposts": "Castelos e Postos",
  "castlesandcastleoutposts": "Castelos e Postos",
  "dragonhunt": "Caça aos Dragões",
  "ancientlands": "Terras Ancestrais"
});

// Historical screenshot-derived SP weights are intentionally disabled.
// The validated Photon operations do not expose level, threshold or Season Points.
const REFERENCE_CATEGORIES_2026_10_07 = Object.freeze({});

function spPerMight({ level, targetMight, seasonPoints }) {
  const n = Number(level);
  const target = Number(targetMight);
  const sp = Number(seasonPoints);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(target) || target <= 0 || !Number.isFinite(sp) || sp < 0) return 0;
  return sp / (target / (n + 1));
}

function referenceWeightsPerMillion() {
  const out = {};
  for (const [name, category] of Object.entries(REFERENCE_CATEGORIES_2026_10_07)) {
    out[name] = spPerMight(category) * 1000000;
  }
  return out;
}

function pathJoin(base, key) {
  return base ? base + "." + key : String(key);
}

function flattenPhoton(value, { depth = 0, path = "", arrays = [], scalars = [] } = {}) {
  if (depth > 7) return { arrays, scalars };

  if (Array.isArray(value)) {
    arrays.push({ path, value });
    for (let i = 0; i < value.length; i++) {
      const nested = value[i];
      if (nested && typeof nested === "object") {
        flattenPhoton(nested, { depth: depth + 1, path: pathJoin(path, i), arrays, scalars });
      }
    }
    return { arrays, scalars };
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = pathJoin(path, key);
      if (Array.isArray(nested) || (nested && typeof nested === "object")) {
        flattenPhoton(nested, { depth: depth + 1, path: nextPath, arrays, scalars });
      } else {
        scalars.push({ path: nextPath, value: nested });
      }
    }
    return { arrays, scalars };
  }

  scalars.push({ path, value });
  return { arrays, scalars };
}

function isPlayerName(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length >= 2 && v.length <= 32 && /^[\p{L}\p{N}_-]+$/u.test(v);
}

function isMightNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value);
}

function inferContributionLayout(parameters) {
  const { arrays, scalars } = flattenPhoton(parameters || {});
  const stringArrays = arrays.filter(entry =>
    entry.value.length >= 2 &&
    entry.value.length <= 1200 &&
    entry.value.every(v => typeof v === "string")
  );
  const numericArrays = arrays.filter(entry =>
    entry.value.length >= 2 &&
    entry.value.length <= 1200 &&
    entry.value.every(isMightNumber)
  );

  const candidates = [];
  for (const names of stringArrays) {
    const nameQuality = names.value.filter(isPlayerName).length / names.value.length;
    if (nameQuality < 0.6) continue;

    for (const might of numericArrays) {
      if (might.value.length !== names.value.length) continue;
      const positive = might.value.filter(v => v > 0).length / might.value.length;
      const max = Math.max(...might.value);
      let confidence = 0.55 + 0.25 * nameQuality + 0.15 * positive;
      if (max >= 1000) confidence += 0.05;
      confidence = Math.min(1, confidence);

      candidates.push({
        namesPath: names.path,
        mightPath: might.path,
        count: names.value.length,
        confidence: Number(confidence.toFixed(3)),
        sample: names.value.slice(0, 5).map((name, index) => ({
          player: name,
          might: might.value[index]
        }))
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || b.count - a.count);

  return {
    candidates,
    numericScalars: scalars
      .filter(entry => typeof entry.value === "number" && Number.isFinite(entry.value))
      .slice(0, 80),
    stringScalars: scalars
      .filter(entry => typeof entry.value === "string" && entry.value.length <= 120)
      .slice(0, 80)
  };
}

function correlateProbeRows(rows, { windowMs = 10000 } = {}) {
  const ordered = [...(rows || [])].sort((a, b) =>
    new Date(a.occurred_at || a.occurredAt || 0) - new Date(b.occurred_at || b.occurredAt || 0)
  );
  const pending = new Map();
  const pairs = [];
  const unpairedResponses = [];

  for (const row of ordered) {
    const payload = row.payload || {};
    const direction = String(payload.direction || "response").toLowerCase();
    const operationName = String(payload.operationName || "unknown");
    const operationCode = payload.operationCode ?? null;
    const deviceId = String(row.device_id || row.deviceId || "");
    const at = new Date(row.occurred_at || row.occurredAt || 0);
    const atMs = at.getTime();
    const reqSerial = payload.parameters?.["255"];
    const key = deviceId + "\u001f" + operationName + "\u001f" + (reqSerial == null ? "" : String(reqSerial));

    if (direction === "request") {
      pending.set(key, row);
      continue;
    }

    const req = pending.get(key) || null;
    const reqAtMs = req ? new Date(req.occurred_at || req.occurredAt || 0).getTime() : NaN;
    const ageMs = Number.isFinite(atMs) && Number.isFinite(reqAtMs) ? atMs - reqAtMs : Number.POSITIVE_INFINITY;
    const correlated = req && ageMs >= 0 && ageMs <= windowMs ? req : null;

    if (correlated) pending.delete(key);
    else unpairedResponses.push(row);

    const responseParameters = payload.parameters || {};
    pairs.push({
      deviceId,
      observer: row.player_name || row.playerName || null,
      operationName,
      operationCode,
      requestEventId: correlated?.event_id || correlated?.eventId || null,
      responseEventId: row.event_id || row.eventId || null,
      requestAt: correlated?.occurred_at || correlated?.occurredAt || null,
      responseAt: row.occurred_at || row.occurredAt || null,
      latencyMs: correlated ? ageMs : null,
      requestParameters: correlated?.payload?.parameters || null,
      responseParameters,
      discovery: inferContributionLayout(responseParameters)
    });
  }

  return {
    pairs: pairs.sort((a, b) => new Date(b.responseAt || 0) - new Date(a.responseAt || 0)),
    pendingRequests: [...pending.values()],
    unpairedResponses
  };
}

module.exports = {
  REFERENCE_CATEGORIES_2026_10_07,
  CATEGORY_ALIASES,
  spPerMight,
  referenceWeightsPerMillion,
  flattenPhoton,
  inferContributionLayout,
  correlateProbeRows,
  normalizeCategoryLabel,
  stableJson,
  getByPath,
  inferCategoryIdentity,
  buildContributionSnapshots,
  buildDashboardFromLatestSnapshots
};


function normalizeCategoryLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function getByPath(root, path) {
  if (!path) return root;
  let current = root;
  for (const raw of String(path).split(".")) {
    if (current == null) return undefined;
    const key = Array.isArray(current) && /^\d+$/.test(raw) ? Number(raw) : raw;
    current = current[key];
  }
  return current;
}

function inferCategoryIdentity(pair) {
  // Actual 449 response includes the stable category code in parameter "1".
  const rawCode=pair?.responseParameters?.["1"];
  if(pair?.operationName==="GetGuildMightCategoryContribution" &&
    typeof rawCode==="string" && KNOWN_CATEGORY_LABELS[rawCode]){
    const name=KNOWN_CATEGORY_LABELS[rawCode];
    return {key:"name:"+normalizeCategoryLabel(name),name,mapped:true,
      source:"photon-category-code",rawLabel:rawCode,
      sourcePath:"1",nameTentative:false};
  }
  const sources = [
    ...(flattenPhoton(pair?.requestParameters || {}).scalars || []),
    ...(flattenPhoton(pair?.responseParameters || {}).scalars || [])
  ];
  const refs = [...new Set([...Object.values(KNOWN_CATEGORY_LABELS),
    "PvE","Coleta","Magos Engarrafadores","Aranhas","Tesouros",
    "Castelos e Postos","Núcleos de Esconderijo","Cristais de Território",
    "As Profundezas","Masmorras Corrompidas","Caça aos Dragões",
    "Terras Ancestrais","Hellgates","Contrabandistas"])];
  const byNorm = new Map(refs.map(name => [normalizeCategoryLabel(name), name]));

  for (const entry of sources) {
    if (typeof entry.value !== "string") continue;
    const norm = normalizeCategoryLabel(entry.value);
    const direct = byNorm.get(norm);
    const aliased = CATEGORY_ALIASES[norm];
    const name = direct || aliased || null;
    if (name) {
      return {
        key: "name:" + normalizeCategoryLabel(name),
        name,
        mapped: true,
        source: direct ? "payload-string" : "payload-alias",
        sourcePath: entry.path || null,
        rawLabel: direct ? null : entry.value
      };
    }
  }

  const requestScalars = flattenPhoton(pair?.requestParameters || {}).scalars || [];
  const numeric = requestScalars.filter(entry =>
    Number.isInteger(Number(entry.value)) &&
    Number(entry.value) >= 0 &&
    Number(entry.value) <= 100000
  );
  if (numeric.length === 1) {
    const value = Number(numeric[0].value);
    return {
      key: "id:" + value,
      name: "Categoria #" + value,
      mapped: false,
      source: "request-number",
      sourcePath: numeric[0].path || null
    };
  }

  const fingerprint = stableJson(pair?.requestParameters || {});
  return {
    key: "request:" + Buffer.from(fingerprint).toString("base64url").slice(0, 32),
    name: "Categoria não mapeada",
    mapped: false,
    source: "request-fingerprint",
    sourcePath: null
  };
}

function buildContributionSnapshots(rows, { minConfidence = 0.85 } = {}) {
  const correlation = correlateProbeRows(rows, { windowMs: 10000 });
  const snapshots = [];

  for (const pair of correlation.pairs) {
    if (!/^GetGuildMightCategory(?:Contribution|Overview)$/.test(String(pair.operationName || ""))) continue;
    if(!validImortaisGuild(pair.responseParameters,pair.operationName))continue;
    if(pair.operationName==="GetGuildMightCategoryOverview" &&
      parseMightOverviewResponse(pair.responseParameters)) {
      // Values here are GUILD category totals, never player names.
      continue;
    }
    if(pair.operationName==="GetGuildMightCategoryContribution"){
      const decoded=parseMightContributionResponse(pair.responseParameters);
      if(decoded){
        const category=inferCategoryIdentity(pair);
        snapshots.push({
          responseEventId:pair.responseEventId,requestEventId:pair.requestEventId,
          deviceId:pair.deviceId,observer:pair.observer,
          operationName:pair.operationName,category,
          capturedAt:pair.responseAt,confidence:1,
          requestParameters:pair.requestParameters||{},
          layout:{namesPath:"6",mightPath:"7",pageOffset:decoded.pageOffset,
            totalMembers:decoded.totalMembers,guildMight:decoded.guildMight,code:decoded.categoryCode,snapshotMarker:decoded.snapshotMarker},
          reference:null,
          members:decoded.members.map(m=>({...m,estimatedSp:null}))
        });
        continue;
      }
    }
    const candidate = (pair.discovery?.candidates || [])[0];
    if (!candidate || Number(candidate.confidence) < minConfidence) continue;

    const names = getByPath(pair.responseParameters, candidate.namesPath);
    const might = getByPath(pair.responseParameters, candidate.mightPath);
    if (!Array.isArray(names) || !Array.isArray(might) || names.length !== might.length || !names.length) continue;

    const members = [];
    for (let i = 0; i < names.length; i++) {
      const player = String(names[i] || "").trim();
      const value = Number(might[i]);
      if (!isPlayerName(player) || !isMightNumber(value)) continue;
      members.push({ player, might: value });
    }
    if (!members.length) continue;

    const category = inferCategoryIdentity(pair);
    // Legacy non-standard payloads are kept for diagnostics only.
    // No level/SP calculation is valid without explicit Photon fields.
    const reference = null;

    snapshots.push({
      responseEventId: pair.responseEventId,
      requestEventId: pair.requestEventId,
      deviceId: pair.deviceId,
      observer: pair.observer,
      operationName: pair.operationName,
      category,
      capturedAt: pair.responseAt,
      confidence: Number(candidate.confidence),
      requestParameters: pair.requestParameters || {},
      layout: {
        namesPath: candidate.namesPath,
        mightPath: candidate.mightPath,
        count: candidate.count
      },
      reference: null,
      members: members
        .map(m => ({
          ...m,
          estimatedSp: null
        }))
        .sort((a,b) => b.might - a.might || a.player.localeCompare(b.player, "pt-BR"))
    });
  }

  return snapshots.sort((a,b) => new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0));
}

function buildDashboardFromLatestSnapshots(snapshots,{seasonStartAt=null}={}){
  const byCategory=new Map();
  for(const snap of snapshots||[]){
    const code=snap?.layout?.code;
    // Old heuristic records are useful as diagnostics, not authenticated
    // leaderboard rows. Reprocessing is a separate, auditable operation.
    if(!code||!KNOWN_CATEGORY_LABELS[code]||snap.category?.mapped!==true)continue;
    if(!byCategory.has(code))byCategory.set(code,[]);
    byCategory.get(code).push(snap);
  }
  const categories=[];
  for(const [code,list] of byCategory){
    list.sort((a,b)=>new Date(a.capturedAt||0)-new Date(b.capturedAt||0));
    const latest=list[list.length-1];
    const pages=list.filter(s=>Number.isInteger(Number(s.layout?.pageOffset))&&
      Number.isInteger(Number(s.layout?.totalMembers))&&Number(s.layout.totalMembers)>0)
      .map(s=>({...s,pageOffset:Number(s.layout.pageOffset),
        totalMembers:Number(s.layout.totalMembers),
        categoryCode:code,snapshotMarker:s.layout.snapshotMarker??null,
        members:s.members||[]}));
    if(!pages.length)continue;
    const merged=assemblePages(pages,{seasonStartAt});
    categories.push({...latest,
      category:{key:"name:"+normalizeCategoryLabel(KNOWN_CATEGORY_LABELS[code]),
        name:KNOWN_CATEGORY_LABELS[code],mapped:true,nameTentative:false},
      capturedAt:merged.capturedAt||latest.capturedAt,
      members:merged.members.map(m=>({...m,estimatedSp:null})),
      totalMembers:merged.totalMembers,observedMembers:merged.observedMembers,
      historicalObservedMembers:merged.historicalObservedMembers,
      historicalMembers:merged.historicalMembers,
      oldestMemberAt:merged.oldestMemberAt,
      oldestMemberAgeMs:merged.oldestMemberAgeMs,
      lastCompleteAt:merged.lastCompleteAt,coverage:merged.coverage,
      recentWindowStart:seasonStartAt,
      complete:merged.complete,missingRanges:merged.missingRanges,
      pages:merged.pages,guildMight:null,
      observedMight:merged.observedMight,
      level:null,seasonPoints:null,threshold:null});
  }
  categories.sort((a,b)=>a.category.name.localeCompare(b.category.name,"pt-BR"));
  const ranking=new Map();
  for(const category of categories){
    for(const member of category.members||[]){
      const key=String(member.player||"").trim().toLowerCase();
      if(!key)continue;
      if(!ranking.has(key))ranking.set(key,{player:member.player,might:0,estimatedSp:null,categories:0});
      const row=ranking.get(key);
      row.might+=Number(member.might)||0;
      row.categories++;
    }
  }
  return {categories,ranking:[...ranking.values()]
    .sort((a,b)=>b.might-a.might||a.player.localeCompare(b.player,"pt-BR")),
    meta:{categoryCount:categories.length,mappedCategoryCount:categories.length,
      playerCount:ranking.size,seasonStartAt,
      newestAt:categories.reduce((last,c)=>!last||new Date(c.capturedAt)>new Date(last)?c.capturedAt:last,null),
      referenceDate:null}};
}
