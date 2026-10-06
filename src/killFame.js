"use strict";

const GAMEINFO_BASE = String(
  process.env.ALBION_GAMEINFO_BASE || "https://gameinfo.albiononline.com/api/gameinfo"
).replace(/\/+$/, "");
const MATCH_WINDOW_MS = Math.max(
  15_000,
  Number(process.env.ALBION_FAME_MATCH_WINDOW_MS) || 120_000
);
const API_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.ALBION_API_TIMEOUT_MS) || 8_000
);
const API_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(process.env.ALBION_API_CONCURRENCY) || 2)
);
const PLAYER_ID_CACHE_MS = 6 * 60 * 60 * 1000;
const EVENTS_CACHE_MS = 4_000;
const DEFAULT_RETRY_MS = [4_000, 15_000, 45_000, 120_000];

const playerIdCache = new Map();
const eventsCache = new Map();
const requestFlights = new Map();
const enrichmentFlights = new Map();
const requestQueue = [];
let activeRequests = 0;

let fetchImpl = (...args) => fetch(...args);
let sleepImpl = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let retryMs = [...DEFAULT_RETRY_MS];

function normName(v) {
  let out = String(v || "").trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^[!\s]+/, "").replace(/^\[[^\]]{1,16}\]\s*/i, "");
  } while (out !== prev);
  return out.trim().toLowerCase();
}

function normGuild(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function pumpQueue() {
  while (activeRequests < API_CONCURRENCY && requestQueue.length) {
    const item = requestQueue.shift();
    activeRequests++;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeRequests--;
        pumpQueue();
      });
  }
}

function runLimited(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    pumpQueue();
  });
}

async function requestOnce(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(GAMEINFO_BASE + path, {
      signal: controller.signal,
      headers: { "User-Agent": "IMORTAIS-War-Room/kill-fame-enrichment" }
    });
    if (response.status === 429) {
      const err = new Error("Albion GameInfo HTTP 429");
      err.status = 429;
      throw err;
    }
    if (!response.ok) {
      const err = new Error("Albion GameInfo HTTP " + response.status);
      err.status = response.status;
      throw err;
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function albionJson(path) {
  const key = String(path || "");
  if (requestFlights.has(key)) return requestFlights.get(key);

  let promise;
  promise = (async () => {
    let attempt = 0;
    while (true) {
      try {
        return await runLimited(() => requestOnce(key));
      } catch (err) {
        if (err?.status !== 429 || attempt >= retryMs.length) throw err;
        await sleepImpl(retryMs[attempt++]);
      }
    }
  })().finally(() => {
    if (requestFlights.get(key) === promise) requestFlights.delete(key);
  });

  requestFlights.set(key, promise);
  return promise;
}

async function resolvePlayerId(name) {
  const key = normName(name);
  if (!key) return null;

  const cached = playerIdCache.get(key);
  if (cached && Date.now() - cached.at < PLAYER_ID_CACHE_MS) return cached.id;

  const data = await albionJson("/search?q=" + encodeURIComponent(String(name || "").trim()));
  const players = Array.isArray(data?.players)
    ? data.players
    : (Array.isArray(data?.Players) ? data.Players : []);

  const ids = new Set(
    players
      .filter(p => normName(p?.Name ?? p?.name) === key)
      .map(p => String(p?.Id ?? p?.id ?? "").trim())
      .filter(Boolean)
  );

  // Nome exato ambíguo: não escolhe um ID arbitrariamente.
  if (ids.size !== 1) return null;
  const id = [...ids][0];
  playerIdCache.set(key, { at: Date.now(), id });
  return id;
}

async function recentEvents(playerName, kind, forceFresh = false) {
  const id = await resolvePlayerId(playerName);
  if (!id) return [];

  const cacheKey = id + "|" + kind;
  const cached = eventsCache.get(cacheKey);
  if (!forceFresh && cached && Date.now() - cached.at < EVENTS_CACHE_MS) return cached.events;

  const data = await albionJson("/players/" + encodeURIComponent(id) + "/" + kind);
  const events = Array.isArray(data) ? data : [];
  eventsCache.set(cacheKey, { at: Date.now(), events });
  return events;
}

function eventSide(evt, side) {
  return side === "killer"
    ? (evt?.Killer ?? evt?.killer ?? {})
    : (evt?.Victim ?? evt?.victim ?? {});
}

function eventName(evt, side) {
  const obj = eventSide(evt, side);
  return String(obj?.Name ?? obj?.name ?? "").trim();
}

function eventGuild(evt, side) {
  const obj = eventSide(evt, side);
  return String(obj?.GuildName ?? obj?.guildName ?? "").trim();
}

function eventTimeMs(evt) {
  const raw = evt?.TimeStamp ?? evt?.timestamp ?? evt?.Timestamp ?? evt?.timeStamp;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function eventFame(evt) {
  const raw = evt?.TotalVictimKillFame ?? evt?.totalVictimKillFame;
  const fame = Number(raw);
  return raw != null && Number.isFinite(fame) && fame >= 0 ? fame : null;
}

function matchOfficialEvent(events, expected) {
  const killer = normName(expected?.killer);
  const victim = normName(expected?.victim);
  const killerGuild = normGuild(expected?.killerGuild);
  const victimGuild = normGuild(expected?.victimGuild);
  const targetMs = new Date(expected?.occurredAt).getTime();
  if (!killer || !victim || !Number.isFinite(targetMs)) return null;

  const seen = new Set();
  const matches = [];

  for (const evt of events || []) {
    const eventId = String(evt?.EventId ?? evt?.eventId ?? "").trim();
    const dedupKey = eventId || JSON.stringify([
      eventName(evt, "killer"),
      eventName(evt, "victim"),
      evt?.TimeStamp ?? evt?.timestamp ?? null,
      eventFame(evt)
    ]);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (normName(eventName(evt, "killer")) !== killer) continue;
    if (normName(eventName(evt, "victim")) !== victim) continue;

    const offKillerGuild = normGuild(eventGuild(evt, "killer"));
    const offVictimGuild = normGuild(eventGuild(evt, "victim"));
    if (killerGuild && (!offKillerGuild || offKillerGuild !== killerGuild)) continue;
    if (victimGuild && (!offVictimGuild || offVictimGuild !== victimGuild)) continue;

    const officialMs = eventTimeMs(evt);
    if (!Number.isFinite(officialMs)) continue;
    if (Math.abs(officialMs - targetMs) > MATCH_WINDOW_MS) continue;
    if (eventFame(evt) == null) continue;
    matches.push(evt);
  }

  // Conservador: dois kills oficiais plausíveis significam ambiguidade.
  return matches.length === 1 ? matches[0] : null;
}

async function findOfficialEvent(payload, occurredAt, forceFresh = false) {
  const killer = String(payload?.killer || "").trim();
  const victim = String(payload?.victim || "").trim();
  if (!killer || !victim) return null;

  const [kills, deaths] = await Promise.allSettled([
    recentEvents(killer, "kills", forceFresh),
    recentEvents(victim, "deaths", forceFresh)
  ]);

  const candidates = [];
  if (kills.status === "fulfilled") candidates.push(...kills.value);
  if (deaths.status === "fulfilled") candidates.push(...deaths.value);

  return matchOfficialEvent(candidates, {
    killer,
    victim,
    killerGuild: payload?.killerGuild,
    victimGuild: payload?.victimGuild,
    occurredAt
  });
}

function buildPatch(official) {
  const fame = eventFame(official);
  if (fame == null) return null;

  const killer = eventSide(official, "killer");
  const victim = eventSide(official, "victim");
  return {
    killFame: fame,
    totalVictimKillFame: fame,
    albionEventId: String(official?.EventId ?? official?.eventId ?? "").trim() || null,
    albionBattleId: String(official?.BattleId ?? official?.battleId ?? "").trim() || null,
    officialTimestamp: official?.TimeStamp ?? official?.timestamp ?? null,
    officialLocation: official?.Location ?? official?.location ?? null,
    killerGuildOfficial: killer?.GuildName ?? killer?.guildName ?? null,
    victimGuildOfficial: victim?.GuildName ?? victim?.guildName ?? null,
    killerAllianceOfficial: killer?.AllianceName ?? killer?.allianceName ?? null,
    victimAllianceOfficial: victim?.AllianceName ?? victim?.allianceName ?? null,
    killFameSource: "albion-gameinfo",
    killFameResolvedAt: new Date().toISOString()
  };
}

async function enrichOnce({ pool, eventId, payload, occurredAt, forceFresh = false }) {
  if (!pool || !eventId || !payload?.killer || !payload?.victim) return null;
  const official = await findOfficialEvent(payload, occurredAt, forceFresh);
  const patch = official ? buildPatch(official) : null;
  if (!patch) return null;

  const { rows } = await pool.query(
    "UPDATE albion_telemetry_events " +
    "SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb " +
    "WHERE event_id=$1 RETURNING cta_event_id",
    [String(eventId), JSON.stringify(patch)]
  );
  return {
    patch,
    ctaEventId: rows[0]?.cta_event_id == null ? null : String(rows[0].cta_event_id)
  };
}

async function runEnrichment(args) {
  for (let attempt = 0; attempt <= retryMs.length; attempt++) {
    if (attempt > 0) await sleepImpl(retryMs[attempt - 1]);
    try {
      const result = await enrichOnce({ ...args, forceFresh: attempt > 0 });
      if (result) return result;
    } catch (err) {
      console.warn("kill fame enrichment:", err?.message || err);
    }
  }
  return null;
}

function queueEnrichment(args) {
  const key = String(args?.eventId || "");
  if (!key || !args?.pool || !args?.payload?.killer || !args?.payload?.victim) return null;
  if (enrichmentFlights.has(key)) return enrichmentFlights.get(key);

  let promise;
  promise = Promise.resolve()
    .then(() => runEnrichment(args))
    .then(result => {
      if (result?.ctaEventId && typeof args.onResolved === "function") {
        try { args.onResolved(result.ctaEventId, result.patch); } catch (_) {}
      }
      return result;
    })
    .catch(err => {
      console.warn("kill fame enrichment:", err?.message || err);
      return null;
    })
    .finally(() => {
      if (enrichmentFlights.get(key) === promise) enrichmentFlights.delete(key);
    });

  enrichmentFlights.set(key, promise);
  return promise;
}

function resetForTests() {
  playerIdCache.clear();
  eventsCache.clear();
  requestFlights.clear();
  enrichmentFlights.clear();
  requestQueue.splice(0);
  activeRequests = 0;
  fetchImpl = (...args) => fetch(...args);
  sleepImpl = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  retryMs = [...DEFAULT_RETRY_MS];
}

module.exports = {
  queueEnrichment,
  enrichOnce,
  __test: {
    albionJson,
    resolvePlayerId,
    matchOfficialEvent,
    findOfficialEvent,
    buildPatch,
    resetForTests,
    setFetch: fn => { fetchImpl = fn; },
    setSleep: fn => { sleepImpl = fn; },
    setRetryMs: values => { retryMs = Array.isArray(values) ? values.map(Number) : [...DEFAULT_RETRY_MS]; },
    concurrency: () => ({ active: activeRequests, queued: requestQueue.length, max: API_CONCURRENCY }),
    config: () => ({
      base: GAMEINFO_BASE,
      matchWindowMs: MATCH_WINDOW_MS,
      timeoutMs: API_TIMEOUT_MS,
      concurrency: API_CONCURRENCY
    })
  }
};
