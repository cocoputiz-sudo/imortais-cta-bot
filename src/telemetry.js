// ============================================================================
// IMORTAIS TELEMETRY — bridge entre o Combat Client e o CTA War Room
// ============================================================================
const crypto = require("crypto");
const navigation = require("./navigation");
const killFame = require("./killFame");

const telemetryStreams = new Map(); // eventId -> Set(res)
let pool = null;
const _confirmCache = new Map(); // eventId -> { at, payload }
const CONFIRM_TTL_MS = 2000;
const _combatCache = new Map(); // eventId -> { at, promise }
const _combatInFlight = new Set();
const COMBAT_CACHE_OPEN_TTL_MS = 8000;
const COMBAT_CACHE_CLOSED_TTL_MS = 60000;
const COMBAT_CACHE_MAX_ENTRIES = 20;
const GUILD_STATE_FRESH_MS = Math.max(60_000, Number(process.env.GUILD_STATE_FRESH_MS) || 10 * 60 * 1000);
const OBSERVER_HEARTBEAT_FRESH_MS = Math.max(30_000, Number(process.env.OBSERVER_HEARTBEAT_FRESH_MS) || 60 * 1000);
const COMBAT_FIGHT_GAP_MS = Math.max(30_000, Number(process.env.COMBAT_FIGHT_GAP_MS) || 2 * 60 * 1000);
const COMBAT_DEATH_DEDUP_MS = Math.max(5_000, Number(process.env.COMBAT_DEATH_DEDUP_MS) || 30_000);
const COMBAT_BATTLE_MIN_EVENTS = Math.max(1, Number(process.env.COMBAT_BATTLE_MIN_EVENTS) || 5);
// Um mesmo loot costuma ser observado por vários Combat Clients. Reenvio do MESMO
// client já é deduplicado pelo event_id; esta janela serve apenas para fundir cópias
// semânticas vindas de observers diferentes, preservando loots repetidos reais.
const LOOT_DEDUP_MS = Math.max(250, Number(process.env.LOOT_DEDUP_MS) || 2500);
let zoneChangeHandler = null;

function setZoneChangeHandler(handler) {
  zoneChangeHandler = typeof handler === "function" ? handler : null;
}

function normName(v) {
  let out = String(v || "").trim();
  // Remove repetidamente prefixos de tag ([IM], [ESP], [BR], etc.) e sinais (!, !!)
  // ate sobrar so o nick do jogo. Cobre nicks com multiplas tags: "[IM] [ESP] Cizk".
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

function isImortaisFamilyGuildName(value) {
  const g = normGuild(value);
  return g === "imortais" || g === "imortais2" || g === "imortaisacademy";
}

function shouldEnrichKillFame(payload, rosterKeysInput) {
  const rosterKeys = rosterKeysInput instanceof Set
    ? rosterKeysInput
    : new Set((rosterKeysInput || []).map(normName).filter(Boolean));
  return isImortaisFamilyGuildName(payload?.killerGuild) ||
    isImortaisFamilyGuildName(payload?.victimGuild) ||
    rosterKeys.has(normName(payload?.killer)) ||
    rosterKeys.has(normName(payload?.victim));
}

function presenceMapName(value) {
  const text = String(value || "").trim();
  return text || "Mapa desconhecido";
}

function presencePlayerKey(player) {
  // O nome é a chave primária porque o próprio observer não carrega o GUID no
  // snapshot, mas pode aparecer com GUID no snapshot de outro client.
  const name = normName(player && (player.name || player.playerName));
  if (name) return "name:" + name;
  const playerId = String((player && (player.playerId || player.guid)) || "").trim().toLowerCase();
  return playerId ? "id:" + playerId : "";
}

function presenceForcesForWindow(rows, rosterKeysInput, mapName, firstAt, lastAt) {
  const rosterKeys = rosterKeysInput instanceof Set
    ? rosterKeysInput
    : new Set((rosterKeysInput || []).map(normName).filter(Boolean));
  const wantedMap = presenceMapName(mapName).toLowerCase();
  const startMs = new Date(firstAt).getTime();
  const endMs = new Date(lastAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;

  const PAD_MS = 15 * 1000;
  const BUCKET_MS = 30 * 1000;
  const samples = [];
  const canonical = new Map();

  function mergePlayer(raw, forceOurs) {
    const key = presencePlayerKey(raw);
    if (!key) return null;
    const name = String((raw && (raw.name || raw.playerName)) || "").trim() || key.replace(/^name:/, "");
    const guild = String((raw && (raw.guild || raw.guildName)) || "").trim() || null;
    const alliance = String((raw && (raw.alliance || raw.allianceName)) || "").trim() || null;
    const ours = !!forceOurs || isImortaisFamilyGuildName(guild) || rosterKeys.has(normName(name));
    const prev = canonical.get(key);
    if (!prev) {
      canonical.set(key, { key, name, guild, alliance, ours });
    } else {
      if (!prev.guild && guild) prev.guild = guild;
      if (!prev.alliance && alliance) prev.alliance = alliance;
      prev.ours = prev.ours || ours;
    }
    return key;
  }

  for (const row of rows || []) {
    const atMs = new Date(row.occurred_at || row.occurredAt).getTime();
    if (!Number.isFinite(atMs) || atMs < startMs - PAD_MS || atMs > endMs + PAD_MS) continue;
    const payload = row.payload || {};
    const cluster = presenceMapName(payload.cluster || payload.map);
    if (cluster.toLowerCase() !== wantedMap) continue;

    const keys = new Set();
    const observer = String(row.player_name || row.playerName || "").trim();
    if (observer && rosterKeys.has(normName(observer))) {
      const key = mergePlayer({ name: observer, guild: "IMORTAIS" }, true);
      if (key) keys.add(key);
    }

    const players = Array.isArray(payload.players) ? payload.players : [];
    for (const raw of players.slice(0, 500)) {
      const key = mergePlayer(raw, false);
      if (key) keys.add(key);
    }

    samples.push({
      atMs,
      bucket: Math.floor(atMs / BUCKET_MS) * BUCKET_MS,
      deviceId: String(row.device_id || row.deviceId || "sem-device"),
      keys
    });
  }

  if (!samples.length) return null;

  const seenKeys = new Set();
  const buckets = new Map();
  const devices = new Set();

  for (const sample of samples) {
    devices.add(sample.deviceId);
    if (!buckets.has(sample.bucket)) buckets.set(sample.bucket, new Set());
    const bucketKeys = buckets.get(sample.bucket);
    for (const key of sample.keys) {
      seenKeys.add(key);
      bucketKeys.add(key);
    }
  }

  const ourUniqueKeys = [...seenKeys].filter(key => canonical.get(key) && canonical.get(key).ours);
  const guildStats = new Map();

  function guildRow(guild, alliance) {
    const display = String(guild || "").trim() || "Sem guilda";
    const key = display === "Sem guilda" ? "__sem_guilda__" : (normGuild(display) || "__sem_guilda__");
    if (!guildStats.has(key)) {
      guildStats.set(key, {
        guild: display,
        alliance: String(alliance || "").trim() || null,
        uniqueKeys: new Set(),
        unique: 0,
        peak: 0,
        oursAtPeak: 0,
        peakAt: null
      });
    }
    const item = guildStats.get(key);
    if (!item.alliance && alliance) item.alliance = String(alliance).trim() || null;
    return item;
  }

  for (const key of seenKeys) {
    const p = canonical.get(key);
    if (!p || p.ours) continue;
    guildRow(p.guild, p.alliance).uniqueKeys.add(key);
  }
  for (const item of guildStats.values()) item.unique = item.uniqueKeys.size;

  let ourPeak = 0;
  let ourPeakAt = null;
  for (const [bucketAt, keys] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    let ours = 0;
    const enemyCounts = new Map();

    for (const key of keys) {
      const p = canonical.get(key);
      if (!p) continue;
      if (p.ours) {
        ours++;
        continue;
      }
      const item = guildRow(p.guild, p.alliance);
      const gkey = item.guild === "Sem guilda" ? "__sem_guilda__" : (normGuild(item.guild) || "__sem_guilda__");
      enemyCounts.set(gkey, (enemyCounts.get(gkey) || 0) + 1);
    }

    if (ours > ourPeak) {
      ourPeak = ours;
      ourPeakAt = new Date(bucketAt).toISOString();
    }

    for (const [gkey, count] of enemyCounts) {
      const item = guildStats.get(gkey);
      if (item && count > item.peak) {
        item.peak = count;
        item.oursAtPeak = ours;
        item.peakAt = new Date(bucketAt).toISOString();
      }
    }
  }

  const guilds = [...guildStats.values()]
    .map(item => ({
      guild: item.guild,
      alliance: item.alliance,
      unique: item.unique,
      peak: item.peak,
      oursAtPeak: item.oursAtPeak,
      differenceAtPeak: item.peak - item.oursAtPeak,
      peakAt: item.peakAt
    }))
    .filter(item => item.unique > 0 || item.peak > 0)
    .sort((a, b) => b.peak - a.peak || b.unique - a.unique || a.guild.localeCompare(b.guild, "pt-BR"));

  return {
    sampleCount: samples.length,
    observerCount: devices.size,
    bucketSeconds: Math.round(BUCKET_MS / 1000),
    our: { unique: ourUniqueKeys.length, peak: ourPeak, peakAt: ourPeakAt },
    guilds,
    note: "Presença observada pelos Combat Clients via snapshots de NewCharacter/Leave. Os números representam jogadores vistos pela nossa rede de observers, não a população absoluta do mapa."
  };
}

async function getPresenceSnapshotRows(eventId) {
  const startedAt = Date.now();
  const { rows } = await pool.query(`
    SELECT event_id, device_id, player_name, payload, occurred_at, received_at
    FROM albion_telemetry_events
    WHERE cta_event_id=$1 AND type='player_presence_snapshot'
    ORDER BY occurred_at ASC, received_at ASC
  `, [eventId]);
  const out = rows || [];
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 2000) {
    console.log(
      "⏱️ Presence snapshots CTA " + eventId + ": " +
      out.length + " snapshot(s) em " + elapsedMs + " ms"
    );
  }
  return out;
}

function presenceAreaSummary(rows) {
  const BUCKET_MS = 15 * 1000;
  const totalBuckets = new Set();
  const byPlayer = new Map();

  for (const row of rows || []) {
    const atMs = new Date(row.occurred_at || row.occurredAt).getTime();
    if (!Number.isFinite(atMs)) continue;

    const bucket = Math.floor(atMs / BUCKET_MS) * BUCKET_MS;
    totalBuckets.add(bucket);

    const players = Array.isArray(row?.payload?.players) ? row.payload.players : [];
    for (const raw of players.slice(0, 500)) {
      const identity = presencePlayerKey(raw);
      if (!identity || !identity.startsWith("name:")) continue;
      const playerKey = identity.slice(5);
      if (!playerKey) continue;

      if (!byPlayer.has(playerKey)) {
        byPlayer.set(playerKey, {
          playerKey,
          seenBuckets: new Set(),
          albionPlayerId: null,
          guidAtMs: -Infinity
        });
      }

      const item = byPlayer.get(playerKey);
      item.seenBuckets.add(bucket);

      const guid = String(raw?.playerId || raw?.guid || "").trim();
      if (guid && atMs >= item.guidAtMs) {
        item.albionPlayerId = guid;
        item.guidAtMs = atMs;
      }
    }
  }

  return {
    observed: totalBuckets.size > 0,
    totalBuckets: totalBuckets.size,
    players: [...byPlayer.values()].map(item => ({
      playerKey: item.playerKey,
      seenBuckets: item.seenBuckets.size,
      albionPlayerId: item.albionPlayerId
    }))
  };
}

async function getPresenceArea(eventId, presenceRows) {
  const rows = Array.isArray(presenceRows)
    ? presenceRows
    : await getPresenceSnapshotRows(eventId);
  return presenceAreaSummary(rows);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bearer(req) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

function safeSecretEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function createAgentToken() {
  return "imt_" + crypto.randomBytes(32).toString("base64url");
}

async function authenticateTelemetry(req, { deviceId = "", playerName = "", allowMaster = true } = {}) {
  const token = bearer(req);
  if (!token) return null;

  const master = process.env.TELEMETRY_INGEST_KEY || "";
  if (allowMaster && master && safeSecretEqual(token, master)) {
    return { kind: "master", tokenHash: null, agent: null };
  }

  const hash = tokenHash(token);
  const { rows } = await pool.query(
    `SELECT token_hash, label, device_id, player_name, revoked_at
       FROM albion_telemetry_agent_tokens
      WHERE token_hash=$1 AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  const agent = rows[0];
  if (!agent) return null;

  if (agent.device_id && deviceId && String(agent.device_id) !== String(deviceId)) return null;
  if (agent.player_name && playerName && normName(agent.player_name) !== normName(playerName)) return null;

  if (!agent.device_id && deviceId) {
    await pool.query(
      `UPDATE albion_telemetry_agent_tokens
          SET device_id=$2, last_seen=now()
        WHERE token_hash=$1`,
      [hash, deviceId]
    );
    agent.device_id = deviceId;
  } else {
    await pool.query(
      `UPDATE albion_telemetry_agent_tokens SET last_seen=now() WHERE token_hash=$1`,
      [hash]
    );
  }

  return { kind: "agent", tokenHash: hash, agent };
}

function parseCtaClockMinutes(label) {
  const m = /(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?:\s|$)/.exec(String(label || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function signedClockDeltaMinutes(targetMinutes, now = new Date()) {
  if (!Number.isFinite(targetMinutes)) return null;
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let delta = targetMinutes - nowMinutes;
  while (delta <= -720) delta += 1440;
  while (delta > 720) delta -= 1440;
  return delta;
}

function ctaTimeRank(row, now = new Date()) {
  const clock = parseCtaClockMinutes(row?.time_label);
  const delta = signedClockDeltaMinutes(clock, now);
  if (delta == null) {
    return { bucket: 9, distance: Number.MAX_SAFE_INTEGER };
  }

  // Até 45 min antes do horário, o próximo CTA já pode estar em formação.
  // Depois do horário, mantemos o CTA preferido por até 3h.
  if (delta >= 0 && delta <= 45) return { bucket: 0, distance: delta };
  if (delta < 0 && delta >= -180) return { bucket: 1, distance: Math.abs(delta) };
  return { bucket: 2, distance: Math.abs(delta) };
}

function compareCtaRelevance(a, b, now = new Date()) {
  const ar = ctaTimeRank(a, now);
  const br = ctaTimeRank(b, now);
  return ar.bucket - br.bucket
    || ar.distance - br.distance
    || new Date(b.created_at || 0) - new Date(a.created_at || 0);
}

/**
 * Fila autoritativa da telemetria.
 *
 * Regra operacional IMORTAIS: enquanto existir um CTA anterior com status "open",
 * TODA a telemetria pertence a ele. Somente quando esse CTA for finalizado/cancelado
 * o próximo CTA aberto passa a receber dados.
 *
 * remind_30/remind_10 carregam a data real do CTA e evitam ambiguidade em virada de dia.
 * created_at é fallback para CTAs sem lembrete (ex.: eventos abertos manualmente).
 */
async function resolveEarliestOpenCta() {
  const { rows } = await pool.query(
    `SELECT id, guild_id, time_label, status, created_at, remind_30, remind_10
       FROM cta_events
      WHERE status='open'
      ORDER BY COALESCE(
                 remind_30 + interval '30 minutes',
                 remind_10 + interval '10 minutes',
                 created_at
               ) ASC,
               created_at ASC,
               id ASC
      LIMIT 1`
  );
  return rows[0] || null;
}

async function resolveActiveCtaForPlayer(playerName) {
  const key = normName(playerName);
  if (!key) return null;

  const { rows } = await pool.query(
    `SELECT e.id, e.time_label, e.status, e.created_at, s.username
       FROM cta_events e
       JOIN cta_signups s ON s.event_id=e.id
      WHERE e.status='open'`
  );

  return rows
    .filter(row => normName(row.username) === key)
    .sort((a, b) => compareCtaRelevance(a, b))[0] || null;
}

async function resolveActiveCtaForDevice(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT e.id, e.time_label, e.status, e.created_at
       FROM albion_telemetry_events t
       JOIN cta_events e ON e.id=t.cta_event_id
      WHERE t.device_id=$1
        AND e.status='open'
        AND t.cta_event_id IS NOT NULL
        AND t.received_at >= now() - interval '10 minutes'
      ORDER BY t.received_at DESC
      LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function resolveActiveCtaFromParty(members) {
  const keys = new Set(
    (Array.isArray(members) ? members : [])
      .map(normName)
      .filter(Boolean)
  );
  if (!keys.size) return null;

  const { rows } = await pool.query(
    `SELECT e.id, e.time_label, e.status, e.created_at, s.username
       FROM cta_events e
       JOIN cta_signups s ON s.event_id=e.id
      WHERE e.status='open'`
  );

  const byEvent = new Map();
  for (const row of rows) {
    const id = String(row.id);
    if (!byEvent.has(id)) {
      byEvent.set(id, {
        id: row.id,
        time_label: row.time_label,
        status: row.status,
        created_at: row.created_at,
        overlap: 0
      });
    }
    if (keys.has(normName(row.username))) byEvent.get(id).overlap++;
  }

  return [...byEvent.values()]
    .filter(x => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || compareCtaRelevance(a, b))[0] || null;
}

async function resolveActiveCtaFromLatestPartyForDevice(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return null;

  const { rows } = await pool.query(
    `SELECT payload
       FROM albion_telemetry_events
      WHERE device_id=$1
        AND type='party_snapshot'
        AND received_at >= now() - interval '3 hours'
      ORDER BY received_at DESC, occurred_at DESC
      LIMIT 1`,
    [id]
  );

  const members = rows[0]?.payload?.members;
  return Array.isArray(members) && members.length
    ? resolveActiveCtaFromParty(members)
    : null;
}

async function initSchema(dbPool) {
  pool = dbPool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS albion_telemetry_devices (
      device_id    TEXT PRIMARY KEY,
      player_name  TEXT,
      version      TEXT,
      first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS albion_telemetry_agent_tokens (
      token_hash   TEXT PRIMARY KEY,
      label        TEXT,
      device_id    TEXT,
      player_name  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen    TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS albion_telemetry_pairing_codes (
      code_hash    TEXT PRIMARY KEY,
      label        TEXT,
      player_name  TEXT,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_albion_tel_agents_device
      ON albion_telemetry_agent_tokens(device_id);
    CREATE INDEX IF NOT EXISTS idx_albion_tel_agents_player
      ON albion_telemetry_agent_tokens(lower(player_name));

    CREATE TABLE IF NOT EXISTS albion_telemetry_events (
      event_id      TEXT PRIMARY KEY,
      cta_event_id  BIGINT REFERENCES cta_events(id) ON DELETE SET NULL,
      device_id     TEXT NOT NULL,
      type          TEXT NOT NULL,
      occurred_at   TIMESTAMPTZ NOT NULL,
      player_name   TEXT,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_albion_tel_cta_type_time
      ON albion_telemetry_events(cta_event_id, type, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_albion_tel_device_time
      ON albion_telemetry_events(device_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_albion_tel_type_time
      ON albion_telemetry_events(type, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS albion_guild_presence (
      player_key      TEXT PRIMARY KEY,
      player_name     TEXT NOT NULL,
      player_id       TEXT,
      online          BOOLEAN NOT NULL,
      last_seen_at    TIMESTAMPTZ,
      state_at        TIMESTAMPTZ NOT NULL,
      last_event_at   TIMESTAMPTZ NOT NULL,
      observer_device TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_albion_guild_presence_online
      ON albion_guild_presence(online, state_at DESC);
  `);
}

function notifyTelemetry(eventId, info = {}) {
  const set = telemetryStreams.get(String(eventId || ""));
  if (!set || !set.size) return;
  const payload = `data: ${JSON.stringify({ kind: "telemetry", eventId: String(eventId), ...info })}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch (_) { /* ignore */ }
  }
}

async function latestPartyMembers(eventId) {
  // Party é estado, não heartbeat. A última observação conhecida de cada client
  // permanece válida até chegar um NOVO party_snapshot daquele mesmo dispositivo.
  // Ausência de tráfego nunca transforma uma PT conhecida em PT vazia.
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT device_id, player_name, payload, occurred_at, received_at,
             ROW_NUMBER() OVER (
               PARTITION BY device_id
               ORDER BY occurred_at DESC, received_at DESC
             ) AS rn
      FROM albion_telemetry_events
      WHERE cta_event_id=$1 AND type='party_snapshot'
    )
    SELECT device_id, player_name, payload, occurred_at, received_at
      FROM ranked
     WHERE rn=1
  `, [eventId]);

  const members = new Map();
  for (const row of rows) {
    const arr = row.payload && Array.isArray(row.payload.members) ? row.payload.members : [];
    const observed = [...arr];
    if (row.player_name) observed.push(row.player_name);
    for (const name of observed) {
      const key = normName(name);
      if (!key) continue;
      if (!members.has(key)) members.set(key, { name: String(name), devices: [] });
      members.get(key).devices.push(row.device_id);
    }
  }
  return { members, snapshots: rows };
}

async function getPlayerEquipment(eventId, playerName) {
  const key = normName(playerName);
  if (!key) return null;
  const party = await latestPartyMembers(eventId);
  let best = null;
  const slots = ["mainHand","offHand","head","chest","shoes","bag","cape","mount","potion","food"];

  for (const row of party.snapshots || []) {
    const states = row.payload && Array.isArray(row.payload.memberStates) ? row.payload.memberStates : [];
    for (const state of states) {
      if (!state || normName(state.name) !== key) continue;
      const src = state.equipment && typeof state.equipment === "object" ? state.equipment : {};
      const equipment = {};
      let itemCount = 0;
      for (const slot of slots) {
        const value = String(src[slot] || "").trim();
        equipment[slot] = value || null;
        if (value) itemCount++;
      }
      if (!itemCount) continue;
      const candidate = {
        playerName: String(state.name || playerName || ""),
        itemPower: Math.max(0, Number(state.itemPower) || 0),
        inspected: !!state.inspected,
        equipment,
        occurredAt: row.occurred_at,
        deviceId: row.device_id
      };
      if (!best || new Date(candidate.occurredAt) > new Date(best.occurredAt)) best = candidate;
    }
  }
  return best;
}

async function getConfirm(db, eventId) {
  const ev = await db.getEvent(eventId).catch(() => null);
  if (!ev) return null;

  const signups = await db.getSignups(eventId);
  const pl = db.parsePartyList(ev);
  const displayByRaw = new Map(pl.map((raw, idx) => [Number(raw), idx + 1]));

  // ----- Parties reais vistas pelos Combat Clients -----
  const party = await latestPartyMembers(eventId);
  const snapshotRows = party.snapshots || [];

  // Party Snapshot V2: guarda somente IDs textuais dos itens. Os ícones são
  // renderizados pelo navegador diretamente pelo renderer oficial do Albion.
  const equipmentByName = new Map();
  function cleanEquipment(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const slots = ["mainHand","offHand","head","chest","shoes","bag","cape","mount","potion","food"];
    const out = {};
    let count = 0;
    for (const slot of slots) {
      const value = String(src[slot] || "").trim();
      out[slot] = value || null;
      if (value) count++;
    }
    return { equipment: out, itemCount: count };
  }
  for (const row of snapshotRows) {
    const states = row.payload && Array.isArray(row.payload.memberStates)
      ? row.payload.memberStates
      : [];
    for (const state of states) {
      if (!state || typeof state !== "object") continue;
      const name = String(state.name || "").trim();
      const key = normName(name);
      if (!key) continue;
      const parsed = cleanEquipment(state.equipment);
      if (!parsed.itemCount) continue;
      const candidate = {
        name,
        itemPower: Math.max(0, Number(state.itemPower) || 0),
        inspected: !!state.inspected,
        equipment: parsed.equipment,
        occurredAt: row.occurred_at,
        deviceId: row.device_id
      };
      const prev = equipmentByName.get(key);
      if (!prev || new Date(candidate.occurredAt) > new Date(prev.occurredAt)) {
        equipmentByName.set(key, candidate);
      }
    }
  }

  // Deduplica snapshots idênticos (vários clientes dentro da mesma party enxergam
  // essencialmente a mesma lista). Mantém o snapshot mais recente de cada assinatura.
  const realPartyMap = new Map();
  for (const row of snapshotRows) {
    const arr = row.payload && Array.isArray(row.payload.members) ? row.payload.members : [];
    const observed = [...arr];
    if (row.player_name) observed.push(row.player_name);
    const clean = [...new Set(observed.map(x => String(x || "").trim()).filter(Boolean))];
    if (!clean.length) continue;
    const signature = clean.map(normName).sort().join("|");
    const prev = realPartyMap.get(signature);
    if (!prev || new Date(row.occurred_at) > new Date(prev.occurredAt)) {
      realPartyMap.set(signature, {
        signature,
        members: clean,
        memberKeys: new Set(clean.map(normName)),
        occurredAt: row.occurred_at,
        devices: new Set([row.device_id])
      });
    } else {
      prev.devices.add(row.device_id);
    }
  }
  const realParties = [...realPartyMap.values()];

  // ----- Formação planejada -----
  const planned = new Map(); // display PT -> Set(nome normalizado)
  for (const s of signups) {
    if (s.party_index == null) continue;
    const display = displayByRaw.get(Number(s.party_index)) || (Number(s.party_index) + 1);
    if (!planned.has(display)) planned.set(display, new Set());
    planned.get(display).add(normName(s.username));
  }

  // Associa cada party real à PT planejada com maior sobreposição.
  // É propositalmente conservador: sem qualquer membro em comum ela fica "não identificada".
  const candidates = [];
  realParties.forEach((rp, realIndex) => {
    for (const [display, names] of planned.entries()) {
      let overlap = 0;
      for (const key of rp.memberKeys) if (names.has(key)) overlap++;
      if (overlap > 0) {
        const union = new Set([...rp.memberKeys, ...names]).size || 1;
        candidates.push({ realIndex, display, overlap, score: overlap / union });
      }
    }
  });
  candidates.sort((a,b) => b.overlap - a.overlap || b.score - a.score);

  const usedReal = new Set(), usedDisplay = new Set();
  for (const x of candidates) {
    if (usedReal.has(x.realIndex) || usedDisplay.has(x.display)) continue;
    realParties[x.realIndex].display = x.display;
    realParties[x.realIndex].overlap = x.overlap;
    usedReal.add(x.realIndex);
    usedDisplay.add(x.display);
  }

  const actualByName = new Map();
  for (const rp of realParties) {
    for (const name of rp.members) {
      const key = normName(name);
      if (!key) continue;
      const current = actualByName.get(key);
      const candidate = {
        name,
        party: rp.display || null,
        partyLabel: rp.display ? `PT ${rp.display}` : "Party não identificada",
        occurredAt: rp.occurredAt,
        devices: rp.devices.size
      };
      if (!current || new Date(candidate.occurredAt) > new Date(current.occurredAt)) {
        actualByName.set(key, candidate);
      }
    }
  }

  // ----- Discord: presença atual na call de preparação -----
  const voice = await db.pool.query(`
    SELECT DISTINCT ON (user_id)
           user_id, username, channel_id, joined_at
      FROM voice_presence
     WHERE guild_id=$1
       AND channel_kind='prep'
       AND left_at IS NULL
     ORDER BY user_id, joined_at DESC
  `, [ev.guild_id]).then(r => r.rows).catch(() => []);

  const voiceByName = new Map();
  for (const v of voice) {
    const key = normName(v.username);
    if (key) voiceByName.set(key, v);
  }

  // ----- Albion: presenca da guild (online/offline) por jogador -----
  const gp = await getGuildPresence().catch(() => ({ members: [], onlineCount: 0, generatedAt: null }));
  const albionByName = new Map();
  for (const gm of (gp.members || [])) { const k = normName(gm.playerName); if (k) albionByName.set(k, gm); }
  function albionOf(key) {
    const g = albionByName.get(key);
    return {
      st: g ? (g.effectiveStatus || "unknown") : "unknown",
      raw: g ? (g.online ? "online" : "offline") : "unknown",
      freshness: g ? g.freshness : "unknown",
      observerActive: g ? !!g.observerActive : false,
      seenAt: g ? g.lastSeenAt : null,
      stateAt: g ? g.stateAt : null,
      lastEventAt: g ? g.lastEventAt : null
    };
  }
  function categoriaDe(st, albionSt, inDiscord) {
    if (albionSt === "offline") return "off_pingou";
    if (st === "wrong") return "pt_errada";
    if (st === "ok") return inDiscord ? "pronto" : "online_fora_call";
    if (albionSt === "online") return inDiscord ? "fora_pt" : "online_fora_call";
    return "indefinido";
  }
  const CAT_LABEL = { pronto: "PRONTO", online_fora_call: "ONLINE, FORA DA CALL", fora_pt: "NA CALL, FORA DA PT", off_pingou: "PINGOU, OFFLINE", pt_errada: "PT ERRADA", indefinido: "—" };

  const signupByName = new Map();
  for (const s of signups) signupByName.set(normName(s.username), s);

  const rows = [];
  const pts = new Map();
  const resumo = {
    inscritos: signups.length,
    discord: voice.length,
    jogo: actualByName.size,
    corretos: 0,
    ptErrada: 0,
    foraParty: 0,
    pingouForaDiscord: 0,
    discordSemPing: 0,
    jogoSemEscala: 0,
    prontidao: 0
  };

  for (const s of signups) {
    const key = normName(s.username);
    const actual = actualByName.get(key);
    const inDiscord = voiceByName.has(key);
    const plannedDisplay = s.party_index == null
      ? null
      : (displayByRaw.get(Number(s.party_index)) || (Number(s.party_index) + 1));

    let status = "ok";
    let obs = "";

    if (!actual) {
      status = "miss";
      resumo.foraParty++;
      obs = "Pingou, mas não foi detectado em nenhuma party";
    } else if (plannedDisplay == null) {
      status = "extra";
      resumo.jogoSemEscala++;
      obs = `Está no jogo (${actual.partyLabel}), mas segue como reserva`;
    } else if (actual.party != null && Number(actual.party) !== Number(plannedDisplay)) {
      status = "wrong";
      resumo.ptErrada++;
      obs = `Deveria estar PT ${plannedDisplay}, está ${actual.partyLabel}`;
    } else if (actual.party == null) {
      status = "seen";
      obs = "Detectado no jogo, party real ainda não identificada";
    } else {
      resumo.corretos++;
      obs = `PT ${plannedDisplay} correta`;
    }

    if (!inDiscord) {
      resumo.pingouForaDiscord++;
      obs += (obs ? " · " : "") + "fora da call de preparação";
    }

    const alb = albionOf(key);
    const categoria = categoriaDe(status, alb.st, inDiscord);
    const row = {
      n: s.username,
      arma: s.weapon,
      slot: s.slot_index == null ? null : Number(s.slot_index) + 1,
      plannedParty: plannedDisplay,
      actualParty: actual?.party || null,
      actualPartyLabel: actual?.partyLabel || null,
      discord: inDiscord,
      game: !!actual,
      ping: true,
      albion: alb.st,
      albionKnownState: alb.raw,
      albionFreshness: alb.freshness,
      albionObserverActive: alb.observerActive,
      albionSeenAt: alb.seenAt,
      albionStateAt: alb.stateAt,
      albionLastEventAt: alb.lastEventAt,
      equipment: equipmentByName.get(key)?.equipment || null,
      itemPower: equipmentByName.get(key)?.itemPower || null,
      equipmentInspected: equipmentByName.get(key)?.inspected || false,
      equipmentObservedAt: equipmentByName.get(key)?.occurredAt || null,
      categoria,
      categoriaLabel: CAT_LABEL[categoria],
      st: status,
      obs
    };
    rows.push(row);

    const group = plannedDisplay == null ? "Reserva" : `PT ${plannedDisplay}`;
    if (!pts.has(group)) pts.set(group, []);
    pts.get(group).push(row);
  }

  const discordNoPing = [];
  for (const [key, v] of voiceByName.entries()) {
    if (signupByName.has(key)) continue;
    const actual = actualByName.get(key);
    resumo.discordSemPing++;
    discordNoPing.push({
      n: v.username,
      discord: true,
      ping: false,
      game: !!actual,
      albion: albionOf(key).st,
      actualParty: actual?.party || null,
      actualPartyLabel: actual?.partyLabel || null,
      equipment: equipmentByName.get(key)?.equipment || null,
      itemPower: equipmentByName.get(key)?.itemPower || null,
      equipmentInspected: equipmentByName.get(key)?.inspected || false,
      equipmentObservedAt: equipmentByName.get(key)?.occurredAt || null,
      st: "nop",
      obs: actual
        ? `Está na call e no jogo (${actual.partyLabel}), mas não pingou`
        : "Está na call de preparação, mas não pingou"
    });
  }

  const gameNoSignup = [];
  for (const [key, a] of actualByName.entries()) {
    if (signupByName.has(key)) continue;
    resumo.jogoSemEscala++;
    gameNoSignup.push({
      n: a.name,
      discord: voiceByName.has(key),
      ping: false,
      game: true,
      albion: albionOf(key).st,
      actualParty: a.party || null,
      actualPartyLabel: a.partyLabel,
      equipment: equipmentByName.get(key)?.equipment || null,
      itemPower: equipmentByName.get(key)?.itemPower || null,
      equipmentInspected: equipmentByName.get(key)?.inspected || false,
      equipmentObservedAt: equipmentByName.get(key)?.occurredAt || null,
      st: "extra",
      obs: voiceByName.has(key)
        ? `No jogo e na call, sem ping (${a.partyLabel})`
        : `No jogo sem escala (${a.partyLabel})`
    });
  }

  const issuesByParty = new Map();
  function issueGroup(display) {
    const key = Number(display);
    if (!issuesByParty.has(key)) {
      issuesByParty.set(key, { party: key, missing: [], intruders: [], correct: [] });
    }
    return issuesByParty.get(key);
  }

  for (const row of rows) {
    if (row.plannedParty != null) {
      const g = issueGroup(row.plannedParty);
      if (row.actualParty == null) g.missing.push(row);
      else if (Number(row.actualParty) === Number(row.plannedParty)) g.correct.push(row);
    }
    if (row.actualParty != null && row.plannedParty != null && Number(row.actualParty) !== Number(row.plannedParty)) {
      issueGroup(row.actualParty).intruders.push(row);
      issueGroup(row.plannedParty).missing.push(row);
    }
  }

  const plannedCount = signups.filter(s => s.party_index != null).length;
  resumo.prontidao = plannedCount
    ? Math.round((resumo.corretos / plannedCount) * 100)
    : 0;

  return {
    event: {
      id: String(ev.id),
      time: ev.time_label,
      status: ev.status
    },
    resumo,
    pts: [...pts.entries()].map(([pt, linhas]) => ({ pt, linhas })),
    discordNoPing,
    gameNoSignup,
    issuesByParty: [...issuesByParty.values()]
      .sort((a,b) => a.party - b.party)
      .map(g => ({
        party: g.party,
        missing: g.missing.sort((a,b) => (a.slot||99) - (b.slot||99)),
        intruders: g.intruders.sort((a,b) => String(a.n).localeCompare(String(b.n))),
        correct: g.correct.sort((a,b) => (a.slot||99) - (b.slot||99))
      })),
    realParties: realParties.map((rp, i) => ({
      id: i + 1,
      mappedParty: rp.display || null,
      overlap: rp.overlap || 0,
      members: rp.members,
      devices: rp.devices.size,
      occurredAt: rp.occurredAt
    })),
    meta: {
      partySnapshots: snapshotRows.length,
      equipmentPlayers: equipmentByName.size,
      guildGeneratedAt: gp.generatedAt || null,
      guildOnline: gp.onlineConfirmedCount || 0,
      guildOnlineKnown: gp.onlineKnownCount || 0,
      guildOnlineStale: gp.onlineStaleCount || 0,
      guildActiveObservers: gp.activeObserverCount || 0,
      guildRecentStates: gp.recentStateCount || 0,
      realParties: realParties.length,
      partyPlayers: actualByName.size,
      discordPlayers: voice.length,
      latestPartyAt: snapshotRows.reduce((latest, row) => {
        const t = row.occurred_at ? new Date(row.occurred_at).getTime() : 0;
        return t > latest ? t : latest;
      }, 0) || null,
      note: "A party exibida é o último estado conhecido de cada Combat Client. Falta de novo snapshot não zera a PT; somente um novo snapshot altera o estado."
    }
  };
}

const TRANSPORT_DELIVERY_ZONE_NAMES = Object.freeze({
  VORTEX: [
    "Thunderrock Upland",
    "Rivercopse Curve",
    "Giantweald Woods",
    "Deepwood Pines",
  ],
  ORBS: [
    "Thunderrock Upland",
    "Deepwood Pines",
    "Murdergulch Trail",
    "Sandmount Ascent",
    "Timberscar Copse",
  ],
});

function transportDeliveryZoneNames(type) {
  return TRANSPORT_DELIVERY_ZONE_NAMES[String(type || "").toUpperCase()] || [];
}

function navDeadlineMs(objective) {
  const t = objective?.expires_at ? new Date(objective.expires_at).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function navPlanCompare(a, b) {
  if (!b) return -1;
  // Primeiro preserva objetivos; depois evita sair de um pickup transportável que já
  // está no mapa atual; só então usa horário e distância como desempate.
  const keys = [
    "impossible",
    "missed",
    "lateSeconds",
    "localPickupDeferrals",
    "deadlineTie",
    "travelSeconds",
  ];
  for (const key of keys) {
    const av = Number(a?.[key] || 0);
    const bv = Number(b?.[key] || 0);
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function navTransitionTiming(objective, transition, elapsedBefore, nowMs) {
  const elapsed = Math.max(0, Number(elapsedBefore) || 0);
  if (!transition?.ok) {
    return {
      pickupArrivalSeconds: null,
      pickupAtSeconds: null,
      waitSeconds: 0,
      lateSeconds: null,
      elapsedAfter: elapsed,
    };
  }

  const status = String(objective?.status || "pending").toLowerCase();
  if (status === "carrying") {
    return {
      pickupArrivalSeconds: null,
      pickupAtSeconds: null,
      waitSeconds: 0,
      lateSeconds: 0,
      elapsedAfter: elapsed + Number(transition.totalSeconds || 0),
    };
  }

  const pickupTravelSeconds = Number(
    transition.deadlineTravelSeconds ?? transition.pickupTravelSeconds ?? 0
  ) || 0;
  const deliveryTravelSeconds = Number(transition.deliveryTravelSeconds || 0) || 0;
  const pickupArrivalSeconds = elapsed + pickupTravelSeconds;
  const objectiveMs = navDeadlineMs(objective);
  const objectiveOffsetSeconds = objectiveMs == null
    ? null
    : (objectiveMs - nowMs) / 1000;

  const waitSeconds = objectiveOffsetSeconds == null
    ? 0
    : Math.max(0, objectiveOffsetSeconds - pickupArrivalSeconds);
  const lateSeconds = objectiveOffsetSeconds == null
    ? 0
    : Math.max(0, pickupArrivalSeconds - objectiveOffsetSeconds);
  const pickupAtSeconds = pickupArrivalSeconds + waitSeconds;

  return {
    pickupArrivalSeconds,
    pickupAtSeconds,
    waitSeconds,
    lateSeconds,
    elapsedAfter: pickupAtSeconds + deliveryTravelSeconds,
  };
}

function optimizeNavigationObjectives(activeObjectives, source, secondsPerMap, nowMs) {
  const active = Array.isArray(activeObjectives) ? activeObjectives.slice() : [];
  const carrying = active
    .filter(o => String(o.status || "").toLowerCase() === "carrying")
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const pending = active
    .filter(o => String(o.status || "pending").toLowerCase() === "pending");

  const baseScore = {
    impossible: 0,
    missed: 0,
    lateSeconds: 0,
    localPickupDeferrals: 0,
    travelSeconds: 0,
    deadlineTie: 0,
  };

  if (!source) {
    pending.sort((a, b) => {
      const da = navDeadlineMs(a);
      const db = navDeadlineMs(b);
      if (da == null && db != null) return 1;
      if (da != null && db == null) return -1;
      if (da != null && db != null && da !== db) return da - db;
      return (Number(a.position) || 0) - (Number(b.position) || 0);
    });
    const ordered = [...carrying, ...pending];
    return {
      plan: ordered.map(objective => ({ objective, transition: null })),
      objectives: ordered,
      mode: "deadline",
      score: baseScore,
    };
  }

  const routeCache = new Map();
  const deliveryZoneCache = new Map();

  function deliveryZonesForType(type) {
    const key = String(type || "").toUpperCase();
    if (deliveryZoneCache.has(key)) return deliveryZoneCache.get(key);
    const zones = transportDeliveryZoneNames(key)
      .map(name => navigation.resolveZone(name).zone)
      .filter(Boolean)
      .map(zone => navigation.zoneDisplay(zone));
    deliveryZoneCache.set(key, zones);
    return zones;
  }

  function edge(from, to) {
    const key = String(from || "") + "=>" + String(to || "");
    if (routeCache.has(key)) return routeCache.get(key);
    const route = from && to ? navigation.shortestRoute(from, to) : null;
    const ok = !!route?.ok;
    const maps = ok ? Number(route.maps || 0) : null;
    const out = {
      route,
      ok,
      maps,
      seconds: ok ? maps * secondsPerMap : null,
    };
    routeCache.set(key, out);
    return out;
  }

  function transitionOptions(from, objective) {
    const type = String(objective.objective_type || "").toUpperCase();
    const status = String(objective.status || "pending").toLowerCase();

    if (status === "carrying") {
      const deliveryName = objective.delivery_zone_name;
      const deliveryId = objective.delivery_zone_id || deliveryName;
      const delivery = edge(from, deliveryId);
      return [{
        objective,
        stage: "carrying",
        ok: delivery.ok,
        start: from,
        pickupRoute: null,
        pickupMaps: 0,
        pickupTravelSeconds: 0,
        deliveryZone: deliveryName ? { id: deliveryId, name: deliveryName } : null,
        deliveryRoute: delivery.route,
        deliveryMaps: delivery.maps,
        deliveryTravelSeconds: delivery.seconds,
        totalMaps: delivery.maps,
        totalSeconds: delivery.seconds,
        deadlineTravelSeconds: 0,
        end: deliveryId,
      }];
    }

    const pickupId = objective.target_zone_id || objective.target_zone_name;
    const pickup = edge(from, pickupId);

    const deliveryZones = deliveryZonesForType(type);
    if (!deliveryZones.length) {
      return [{
        objective,
        stage: "pending",
        ok: pickup.ok,
        start: from,
        pickupRoute: pickup.route,
        pickupMaps: pickup.maps,
        pickupTravelSeconds: pickup.seconds,
        deliveryZone: null,
        deliveryRoute: null,
        deliveryMaps: 0,
        deliveryTravelSeconds: 0,
        totalMaps: pickup.maps,
        totalSeconds: pickup.seconds,
        deadlineTravelSeconds: pickup.seconds,
        end: pickupId,
      }];
    }

    return deliveryZones.map(drop => {
      const carry = edge(pickupId, drop.id || drop.name);
      const ok = pickup.ok && carry.ok;
      const pickupMaps = pickup.maps;
      const deliveryMaps = carry.maps;
      return {
        objective,
        stage: "pending",
        ok,
        start: from,
        pickupRoute: pickup.route,
        pickupMaps,
        pickupTravelSeconds: pickup.seconds,
        deliveryZone: drop,
        deliveryRoute: carry.route,
        deliveryMaps,
        deliveryTravelSeconds: carry.seconds,
        totalMaps: ok ? Number(pickupMaps || 0) + Number(deliveryMaps || 0) : null,
        totalSeconds: ok ? Number(pickup.seconds || 0) + Number(carry.seconds || 0) : null,
        // O deadline de um objetivo transportável é o horário para CHEGAR/PEGAR
        // no mapa onde ele está. O transporte até a entrega conta para os próximos objetivos.
        deadlineTravelSeconds: pickup.seconds,
        end: drop.id || drop.name,
      };
    });
  }

  const prefixPlan = [];
  let prefixSource = source;
  let prefixElapsed = 0;
  let prefixScore = { ...baseScore };

  // Se já estamos carregando Vortex/Orb, a entrega é obrigatória antes de reorganizar
  // os objetivos que ainda não foram pegos.
  for (const objective of carrying) {
    const transition = transitionOptions(prefixSource, objective)[0];
    prefixPlan.push({ objective, transition });
    if (!transition?.ok) {
      prefixScore.impossible++;
    } else {
      prefixElapsed += Number(transition.totalSeconds || 0);
      prefixScore.travelSeconds += Number(transition.totalSeconds || 0);
      prefixSource = transition.end;
    }
  }

  if (!pending.length) {
    return {
      plan: prefixPlan,
      objectives: prefixPlan.map(x => x.objective),
      mode: "carrying",
      score: prefixScore,
    };
  }

  const insertionOrder = new Map(pending.map((o, i) => [String(o.id), i]));

  function isTransportPickupAt(current, objective) {
    if (!transportDeliveryZoneNames(objective?.objective_type).length) return false;
    const pickupId = objective?.target_zone_id || objective?.target_zone_name;
    const pickupLeg = edge(current, pickupId);
    return !!pickupLeg?.ok && Number(pickupLeg.maps || 0) === 0;
  }

  function addTransitionScore(
    score,
    transition,
    objective,
    elapsedBefore,
    position,
    totalCount,
    localPickupDeferred = false
  ) {
    const next = { ...score };
    if (!transition?.ok) {
      next.impossible++;
      return next;
    }

    const timing = navTransitionTiming(objective, transition, elapsedBefore, nowMs);
    const deadline = navDeadlineMs(objective);
    if (deadline != null) {
      const late = Math.max(0, Math.floor(Number(timing.lateSeconds || 0)));
      if (late > 0) next.missed++;
      next.lateSeconds += late;
      next.deadlineTie += (totalCount - position + 1) *
        Math.max(0, Math.floor((deadline - nowMs) / 1000));
    }
    if (localPickupDeferred) next.localPickupDeferrals++;
    next.travelSeconds += Number(transition.totalSeconds || 0);
    return next;
  }

  function partialDefinitelyWorse(score, best) {
    if (!best) return false;
    if (score.impossible !== best.impossible) return score.impossible > best.impossible;
    if (score.missed !== best.missed) return score.missed > best.missed;
    if (score.lateSeconds !== best.lateSeconds) return score.lateSeconds > best.lateSeconds;
    if (score.localPickupDeferrals !== best.localPickupDeferrals) {
      return score.localPickupDeferrals > best.localPickupDeferrals;
    }
    return false;
  }

  let bestPlan = null;
  let bestScore = null;

  // Teste exato enquanto o espaço de busca ainda é pequeno. Vortex tem 4 entregas e
  // Orb tem 5; o limite evita explosão combinatória (por exemplo, 6 Orbs = 11.250.000).
  const EXACT_SCENARIO_LIMIT = 750000;
  let estimatedScenarios = 1;
  for (let n = 2; n <= pending.length; n++) {
    estimatedScenarios *= n;
    if (estimatedScenarios > EXACT_SCENARIO_LIMIT) break;
  }
  if (estimatedScenarios <= EXACT_SCENARIO_LIMIT) {
    for (const objective of pending) {
      const branches = Math.max(1, transportDeliveryZoneNames(objective.objective_type).length);
      estimatedScenarios *= branches;
      if (estimatedScenarios > EXACT_SCENARIO_LIMIT) break;
    }
  }

  if (pending.length <= 8 && estimatedScenarios <= EXACT_SCENARIO_LIMIT) {
    const used = new Array(pending.length).fill(false);
    const plan = [];

    function walk(current, elapsed, score) {
      if (plan.length === pending.length) {
        if (!bestScore || navPlanCompare(score, bestScore) < 0) {
          bestScore = { ...score };
          bestPlan = plan.slice();
        }
        return;
      }

      const localPickupIndexes = new Set();
      for (let j = 0; j < pending.length; j++) {
        if (!used[j] && isTransportPickupAt(current, pending[j])) {
          localPickupIndexes.add(j);
        }
      }

      for (let i = 0; i < pending.length; i++) {
        if (used[i]) continue;
        const objective = pending[i];
        const options = transitionOptions(current, objective);
        const localPickupDeferred =
          localPickupIndexes.size > 0 && !localPickupIndexes.has(i);

        for (const transition of options) {
          const position = prefixPlan.length + plan.length + 1;
          const totalCount = prefixPlan.length + pending.length;
          const nextScore = addTransitionScore(
            score,
            transition,
            objective,
            elapsed,
            position,
            totalCount,
            localPickupDeferred
          );
          if (partialDefinitelyWorse(nextScore, bestScore)) continue;

          used[i] = true;
          plan.push({ objective, transition });
          const timing = navTransitionTiming(objective, transition, elapsed, nowMs);
          const nextElapsed = transition?.ok ? timing.elapsedAfter : elapsed;
          const nextCurrent = transition?.ok ? transition.end : current;
          walk(nextCurrent, nextElapsed, nextScore);
          plan.pop();
          used[i] = false;
        }
      }
    }

    walk(prefixSource, prefixElapsed, prefixScore);
    const tail = bestPlan || pending.map(objective => ({
      objective,
      transition: transitionOptions(prefixSource, objective)[0] || null,
    }));
    const full = [...prefixPlan, ...tail];
    return {
      plan: full,
      objectives: full.map(x => x.objective),
      mode: "exact",
      score: bestScore || prefixScore,
      estimatedScenarios,
    };
  }

  // Filas maiores usam heurística, mas preservam a mesma regra operacional:
  // evitar perdas primeiro e, se isso não piorar a viabilidade, coletar Vortex/Orb
  // que já esteja no mapa atual antes de sair dele.
  const remaining = pending.slice();
  const greedyPlan = [];
  let current = prefixSource;
  let elapsed = prefixElapsed;
  let score = { ...prefixScore };

  while (remaining.length) {
    const hasLocalPickup = remaining.some(objective =>
      isTransportPickupAt(current, objective)
    );
    const candidates = [];

    for (const objective of remaining) {
      for (const transition of transitionOptions(current, objective)) {
        const timing = navTransitionTiming(objective, transition, elapsed, nowMs);
        const deadline = navDeadlineMs(objective);
        const pickupArrival = timing.pickupArrivalSeconds == null
          ? Number.POSITIVE_INFINITY
          : nowMs + timing.pickupArrivalSeconds * 1000;
        const slack = deadline == null
          ? Number.POSITIVE_INFINITY
          : (deadline - pickupArrival) / 1000;
        const localPickup = isTransportPickupAt(current, objective);

        let projectedMisses = Number(timing.lateSeconds || 0) > 0 ? 1 : 0;
        if (transition?.ok) {
          const nextCurrent = transition.end;
          const nextElapsed = timing.elapsedAfter;
          for (const other of remaining) {
            if (other === objective) continue;
            const otherDeadline = navDeadlineMs(other);
            if (otherDeadline == null) continue;
            const otherOptions = transitionOptions(nextCurrent, other);
            const otherTransition = otherOptions.find(x => x?.ok) || otherOptions[0];
            if (!otherTransition?.ok) {
              projectedMisses++;
              continue;
            }
            const otherPickupTravel = Number(
              otherTransition.deadlineTravelSeconds ??
              otherTransition.pickupTravelSeconds ??
              0
            ) || 0;
            const otherArrivalMs = nowMs + (nextElapsed + otherPickupTravel) * 1000;
            if (otherArrivalMs > otherDeadline) projectedMisses++;
          }
        }

        candidates.push({
          objective,
          transition,
          timing,
          localPickup,
          projectedMisses,
          slack,
          total: transition?.ok
            ? Number(transition.totalSeconds || 0)
            : Number.MAX_SAFE_INTEGER / 1000,
        });
      }
    }

    candidates.sort((a, b) => {
      if (!!a.transition?.ok !== !!b.transition?.ok) return a.transition?.ok ? -1 : 1;
      if (a.projectedMisses !== b.projectedMisses) return a.projectedMisses - b.projectedMisses;
      if (hasLocalPickup && a.localPickup !== b.localPickup) return a.localPickup ? -1 : 1;
      if (a.slack !== b.slack) return a.slack - b.slack;
      if (a.total !== b.total) return a.total - b.total;
      return (insertionOrder.get(String(a.objective.id)) || 0) -
        (insertionOrder.get(String(b.objective.id)) || 0);
    });

    const pick = candidates[0];
    const position = prefixPlan.length + greedyPlan.length + 1;
    const totalCount = prefixPlan.length + pending.length;
    const localPickupDeferred = hasLocalPickup && !pick.localPickup;
    score = addTransitionScore(
      score,
      pick.transition,
      pick.objective,
      elapsed,
      position,
      totalCount,
      localPickupDeferred
    );
    greedyPlan.push({ objective: pick.objective, transition: pick.transition });

    if (pick.transition?.ok) {
      elapsed = pick.timing.elapsedAfter;
      current = pick.transition.end;
    }
    remaining.splice(remaining.indexOf(pick.objective), 1);
  }

  const full = [...prefixPlan, ...greedyPlan];
  return {
    plan: full,
    objectives: full.map(x => x.objective),
    mode: "greedy",
    score,
    estimatedScenarios,
  };
}

async function getNavigationState(db, eventId = null) {
  const globalMode = !eventId || String(eventId).trim().toLowerCase() === "global";
  const ev = globalMode ? null : await db.getEvent(eventId).catch(() => null);
  if (!globalMode && !ev) return null;

  const objectives = globalMode
    ? await db.getGlobalNavigationObjectives({ includeDone: true }).catch(() => [])
    : await db.getNavigationObjectives(eventId, { includeDone: true }).catch(() => []);
  const active = objectives.filter(o => {
    const status = String(o.status || "pending").toLowerCase();
    return status === "pending" || status === "carrying";
  });
  const session = globalMode
    ? await db.getGlobalNavigationSession().catch(() => null)
    : await db.getNavigationSession(eventId).catch(() => null);
  const secondsPerMap = Math.max(
    20,
    Math.min(600, Number(session?.seconds_per_map || process.env.NAV_SECONDS_PER_MAP || 90) || 90)
  );

  // No modo global a posição do zerg vem dos últimos zone_change de cada dispositivo,
  // mesmo quando não existe CTA aberto. O vínculo a CTA continua disponível apenas
  // para compatibilidade com comandos/filas legadas.
  const positionSql = globalMode
    ? `
      WITH ranked AS (
        SELECT device_id, player_name, payload, occurred_at, received_at,
               ROW_NUMBER() OVER (
                 PARTITION BY device_id
                 ORDER BY occurred_at DESC, received_at DESC
               ) AS rn
          FROM albion_telemetry_events
         WHERE type='zone_change'
           AND received_at >= now() - interval '15 minutes'
      )
      SELECT device_id, player_name, payload, occurred_at, received_at
        FROM ranked
       WHERE rn=1
       ORDER BY received_at DESC
    `
    : `
      WITH ranked AS (
        SELECT device_id, player_name, payload, occurred_at, received_at,
               ROW_NUMBER() OVER (
                 PARTITION BY device_id
                 ORDER BY occurred_at DESC, received_at DESC
               ) AS rn
          FROM albion_telemetry_events
         WHERE cta_event_id=$1
           AND type='zone_change'
           AND received_at >= now() - interval '15 minutes'
      )
      SELECT device_id, player_name, payload, occurred_at, received_at
        FROM ranked
       WHERE rn=1
       ORDER BY received_at DESC
    `;
  const { rows } = await pool.query(positionSql, globalMode ? [] : [eventId]);

  const positions = [];
  const byZone = new Map();

  for (const row of rows) {
    const payload = row.payload || {};
    const rawName = String(
      payload.clusterName ||
      payload.zoneName ||
      payload.cluster ||
      payload.uniqueName ||
      payload.clusterIndex ||
      ""
    ).trim();
    const rawIndex = String(payload.clusterIndex || payload.index || "").trim();
    const resolved = navigation.resolveZone(rawName || rawIndex);
    const zone = resolved.zone ? navigation.zoneDisplay(resolved.zone) : null;

    const position = {
      deviceId: row.device_id,
      playerName: row.player_name || null,
      clusterName: rawName || null,
      clusterIndex: rawIndex || null,
      zone,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
    };
    positions.push(position);

    const key = zone?.id || (rawName ? "raw:" + navigation.norm(rawName) : "");
    if (!key) continue;
    if (!byZone.has(key)) {
      byZone.set(key, {
        key,
        zone,
        clusterName: zone?.name || rawName,
        count: 0,
        players: [],
        latestAt: row.received_at,
      });
    }
    const group = byZone.get(key);
    group.count++;
    if (position.playerName) group.players.push(position.playerName);
    if (new Date(row.received_at) > new Date(group.latestAt)) group.latestAt = row.received_at;
  }

  const groups = [...byZone.values()].sort((a, b) =>
    b.count - a.count ||
    new Date(b.latestAt || 0) - new Date(a.latestAt || 0) ||
    String(a.clusterName).localeCompare(String(b.clusterName))
  );

  const majority = groups[0] || null;
  const nowMs = Date.now();

  function objectiveOut(o, plannedDelivery = null) {
    const expiresMs = o?.expires_at ? new Date(o.expires_at).getTime() - nowMs : null;
    return {
      id: String(o.id),
      ctaEventId: globalMode ? null : String(o.cta_event_id),
      position: Number(o.position),
      status: String(o.status || "pending"),
      type: o.objective_type,
      rarity: o.rarity || null,
      targetZoneId: o.target_zone_id,
      targetZoneName: o.target_zone_name,
      expiresAt: o.expires_at,
      remainingSeconds: Number.isFinite(expiresMs) ? Math.floor(expiresMs / 1000) : null,
      ready: Number.isFinite(expiresMs) ? expiresMs <= 0 : true,
      expired: Number.isFinite(expiresMs) ? expiresMs <= 0 : false,
      deliveryZoneId: o.delivery_zone_id || plannedDelivery?.id || null,
      deliveryZoneName: o.delivery_zone_name || plannedDelivery?.name || null,
      pickedAt: o.picked_at || null,
      createdBy: o.created_by || null,
      completedAt: o.completed_at || null,
      updatedAt: o.updated_at,
    };
  }

  const source = majority ? (majority.zone?.id || majority.clusterName) : null;
  const sourceNameInitial = majority ? (majority.zone?.name || majority.clusterName) : null;
  const optimized = optimizeNavigationObjectives(active, source, secondsPerMap, nowMs);
  const plan = optimized.plan || [];

  const activeOut = plan.map(entry =>
    objectiveOut(entry.objective, entry.transition?.deliveryZone || null)
  );
  const allOut = objectives.map(o => objectiveOut(o));

  let route = null;
  let instruction = null;
  const legs = [];
  let sourceName = sourceNameInitial;
  let cumulativeTravelSeconds = 0;
  let cumulativeElapsedSeconds = 0;

  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const objective = entry.objective;
    const t = entry.transition;
    const out = objectiveOut(objective, t?.deliveryZone || null);
    const stage = String(objective.status || "pending").toLowerCase();

    const validRoute = !!t?.ok;
    const pickupTravelSeconds = validRoute ? Number(t.pickupTravelSeconds || 0) : null;
    const deliveryTravelSeconds = validRoute ? Number(t.deliveryTravelSeconds || 0) : null;
    const totalTravelSeconds = validRoute ? Number(t.totalSeconds || 0) : null;
    const pickupMaps = validRoute ? Number(t.pickupMaps || 0) : null;
    const deliveryMaps = validRoute && t.deliveryMaps != null ? Number(t.deliveryMaps || 0) : null;
    const totalMaps = validRoute && t.totalMaps != null ? Number(t.totalMaps || 0) : null;

    const elapsedBefore = cumulativeElapsedSeconds;
    const timing = navTransitionTiming(objective, t, elapsedBefore, nowMs);
    const pickupArrivalSeconds = timing.pickupArrivalSeconds;

    const deadlineMs = objective.expires_at ? new Date(objective.expires_at).getTime() : null;
    const chainMassByMs = Number.isFinite(deadlineMs) && pickupArrivalSeconds != null
      ? deadlineMs - pickupArrivalSeconds * 1000
      : null;
    const legDepartureByMs = Number.isFinite(deadlineMs) && pickupTravelSeconds != null
      ? deadlineMs - pickupTravelSeconds * 1000
      : null;
    const arrivalIfLeaveNowMs = pickupArrivalSeconds != null
      ? nowMs + pickupArrivalSeconds * 1000
      : null;
    const scheduledPickupAtMs = timing.pickupAtSeconds != null
      ? nowMs + timing.pickupAtSeconds * 1000
      : null;
    const slackSeconds = Number.isFinite(deadlineMs) && Number.isFinite(arrivalIfLeaveNowMs)
      ? Math.floor((deadlineMs - arrivalIfLeaveNowMs) / 1000)
      : null;

    if (validRoute) {
      cumulativeTravelSeconds += totalTravelSeconds;
      cumulativeElapsedSeconds = timing.elapsedAfter;
    }

    const primaryRoute = stage === "carrying"
      ? t?.deliveryRoute
      : t?.pickupRoute;

    legs.push({
      index: i + 1,
      stage,
      objective: out,
      from: sourceName,
      to: stage === "carrying"
        ? (out.deliveryZoneName || objective.delivery_zone_name)
        : objective.target_zone_name,
      endAt: t?.deliveryZone?.name || objective.target_zone_name,
      route: primaryRoute || null,
      maps: totalMaps,
      travelSeconds: totalTravelSeconds,
      pickup: stage === "carrying" ? null : {
        zoneId: objective.target_zone_id,
        zoneName: objective.target_zone_name,
        route: t?.pickupRoute || null,
        maps: pickupMaps,
        travelSeconds: pickupTravelSeconds,
      },
      delivery: t?.deliveryZone ? {
        zoneId: t.deliveryZone.id,
        zoneName: t.deliveryZone.name,
        route: t.deliveryRoute || null,
        maps: deliveryMaps,
        travelSeconds: deliveryTravelSeconds,
      } : null,
      cumulativeTravelSeconds: validRoute ? cumulativeTravelSeconds : null,
      cumulativeElapsedSeconds: validRoute ? cumulativeElapsedSeconds : null,
      waitSeconds: validRoute ? Math.max(0, Math.ceil(Number(timing.waitSeconds || 0))) : null,
      scheduledPickupAt: Number.isFinite(scheduledPickupAtMs)
        ? new Date(scheduledPickupAtMs).toISOString()
        : null,
      massBy: Number.isFinite(chainMassByMs) ? new Date(chainMassByMs).toISOString() : null,
      massInSeconds: Number.isFinite(chainMassByMs) ? Math.floor((chainMassByMs - nowMs) / 1000) : null,
      leavePreviousBy: Number.isFinite(legDepartureByMs) ? new Date(legDepartureByMs).toISOString() : null,
      leavePreviousInSeconds: Number.isFinite(legDepartureByMs) ? Math.floor((legDepartureByMs - nowMs) / 1000) : null,
      arrivalIfLeaveNow: Number.isFinite(arrivalIfLeaveNowMs) ? new Date(arrivalIfLeaveNowMs).toISOString() : null,
      finishIfLeaveNow: validRoute
        ? new Date(nowMs + cumulativeElapsedSeconds * 1000).toISOString()
        : null,
      slackSeconds,
      feasibleIfLeaveNow: slackSeconds == null ? null : slackSeconds >= 0,
    });

    sourceName = t?.deliveryZone?.name || objective.target_zone_name;
  }

  if (legs[0]?.route?.ok) {
    route = legs[0].route;
    instruction = navigation.nextInstruction(route);
    if (
      instruction?.arrived &&
      legs[0].stage !== "carrying" &&
      Number(legs[0].waitSeconds || 0) > 0
    ) {
      instruction = {
        ...instruction,
        waiting: true,
        waitSeconds: Number(legs[0].waitSeconds || 0),
        readyAt: legs[0].objective?.expiresAt || null,
        text: `AGUARDAR NO MAPA · objetivo em ${Math.ceil(Number(legs[0].waitSeconds || 0))}s`,
      };
    }
  }

  return {
    event: globalMode
      ? { id: "global", time: null, status: "active", scope: "global" }
      : { id: String(ev.id), time: ev.time_label, status: ev.status, scope: "cta" },
    objective: activeOut[0] || null,
    objectives: activeOut,
    allObjectives: allOut,
    itinerary: {
      secondsPerMap,
      totalPending: activeOut.length,
      totalTravelSeconds: legs.reduce((sum, x) => sum + (Number(x.travelSeconds) || 0), 0),
      totalElapsedSeconds: legs.length
        ? Number(legs[legs.length - 1].cumulativeElapsedSeconds || 0)
        : 0,
      vortexDeliveryZones: transportDeliveryZoneNames("VORTEX").slice(),
      orbsDeliveryZones: transportDeliveryZoneNames("ORBS").slice(),
      optimization: {
        mode: optimized.mode,
        score: optimized.score,
        estimatedScenarios: optimized.estimatedScenarios ?? null,
        rule: "avoid missed objective times; prefer transport pickups already on the current map; wait until objective time when early; then minimize schedule priority and map travel"
      },
      legs,
    },
    current: majority ? {
      zone: majority.zone,
      clusterName: majority.clusterName,
      observers: majority.count,
      players: [...new Set(majority.players)].slice(0, 50),
      latestAt: majority.latestAt,
    } : null,
    route,
    instruction,
    positions: {
      observers: positions.length,
      zones: groups.map(g => ({
        zone: g.zone,
        clusterName: g.clusterName,
        count: g.count,
        players: [...new Set(g.players)].slice(0, 50),
        latestAt: g.latestAt,
      })),
      devices: positions,
    },
    graph: navigation.stats(),
  };
}

async function getLoot(db, eventId) {
  const { rows } = await pool.query(`
    SELECT event_id, device_id, occurred_at, received_at, player_name, payload
      FROM albion_telemetry_events
     WHERE cta_event_id=$1 AND type='loot'
     ORDER BY occurred_at ASC, received_at ASC
     LIMIT 5000
  `, [eventId]);

  // Identidades legadas: versões antigas do Combat Client não enviavam a guild
  // de quem lootou. Para não perder o histórico desses CTAs, usamos como fallback
  // quem foi inscrito OU apareceu em algum snapshot de party daquele CTA.
  const signups = await db.getSignups(eventId).catch(() => []);
  const legacyAllowed = new Map();
  for (const s of signups) {
    const key = normName(s.username);
    if (key) legacyAllowed.set(key, s.username);
  }

  const partyRows = await pool.query(`
    SELECT player_name, payload
      FROM albion_telemetry_events
     WHERE cta_event_id=$1 AND type='party_snapshot'
  `, [eventId]).then(r => r.rows).catch(() => []);

  for (const row of partyRows) {
    const names = [];
    if (row.player_name) names.push(row.player_name);
    if (row.payload && Array.isArray(row.payload.members)) names.push(...row.payload.members);
    for (const name of names) {
      const key = normName(name);
      if (key && !legacyAllowed.has(key)) legacyAllowed.set(key, String(name));
    }
  }

  // O EventId elimina reenvio do mesmo client no INSERT. O que ainda sobra são
  // cópias do MESMO pickup vistas por vários observers. Sem objectId nativo no
  // payload de loot, a deduplicação canônica combina identidade semântica + janela
  // curta e, principalmente, NUNCA funde dois registros do mesmo device. Assim,
  // dois pickups reais e iguais feitos em sequência continuam separados.
  const canonical = [];
  const byBase = new Map();

  function cleanLootText(v) {
    return String(v || "").trim().toLowerCase();
  }
  function lootTime(v) {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  function compatibleText(a, b) {
    return !a || !b || a === b;
  }

  for (const row of rows) {
    const p = row.payload || {};
    const rawName = String(p.lootedBy || row.player_name || "?").trim() || "?";
    const item = String(p.item || "?").trim() || "?";
    const quantity = Math.max(0, num(p.quantity, 0));
    const unitValue = Math.max(0, num(p.estimatedValue));
    const origin = cleanLootText(p.lootedFrom);
    const cluster = cleanLootText(p.cluster);
    const guild = String(p.lootedByGuild || p.guild || "").trim();
    const deviceId = String(row.device_id || "sem-device");
    const occurredMs = lootTime(row.occurred_at);
    const receivedMs = lootTime(row.received_at);
    const baseKey = [
      normName(rawName),
      cleanLootText(item),
      String(quantity),
      String(Math.round(unitValue * 100))
    ].join("|");

    if (!byBase.has(baseKey)) byBase.set(baseKey, []);
    const candidates = byBase.get(baseKey);
    let hit = null;

    for (let i = candidates.length - 1; i >= 0; i--) {
      const x = candidates[i];
      // Mesmo observer = pode ser um segundo loot real idêntico. Não colapsar.
      if (x.devices.has(deviceId)) continue;

      const occurredClose = occurredMs && x.lastOccurredMs
        ? Math.abs(occurredMs - x.lastOccurredMs) <= LOOT_DEDUP_MS
        : false;
      const receivedClose = receivedMs && x.lastReceivedMs
        ? Math.abs(receivedMs - x.lastReceivedMs) <= LOOT_DEDUP_MS
        : false;
      if (!occurredClose && !receivedClose) continue;
      if (!compatibleText(origin, x.origin) || !compatibleText(cluster, x.cluster)) continue;

      hit = x;
      break;
    }

    if (!hit) {
      hit = {
        baseKey,
        rawName,
        item,
        quantity,
        unitValue,
        origin,
        cluster,
        guilds: new Set(),
        devices: new Set(),
        eventIds: [],
        copies: 0,
        occurredAt: row.occurred_at,
        receivedAt: row.received_at,
        lastOccurredMs: occurredMs,
        lastReceivedMs: receivedMs,
      };
      candidates.push(hit);
      canonical.push(hit);
    }

    hit.devices.add(deviceId);
    hit.eventIds.push(String(row.event_id));
    hit.copies++;
    if (guild) hit.guilds.add(guild);
    if (!hit.origin && origin) hit.origin = origin;
    if (!hit.cluster && cluster) hit.cluster = cluster;
    if (occurredMs >= hit.lastOccurredMs) {
      hit.lastOccurredMs = occurredMs;
      hit.occurredAt = row.occurred_at;
    }
    if (receivedMs >= hit.lastReceivedMs) {
      hit.lastReceivedMs = receivedMs;
      hit.receivedAt = row.received_at;
    }
  }

  let capturado = 0;
  let ignorados = 0;
  let considerados = 0;
  let legacyConsiderados = 0;
  let guildConsiderados = 0;
  const byPlayer = new Map();
  const itens = [];
  const allowedGuilds = new Set(["imortais", "imortaisacademy", "imortais2"]);

  const orderedCanonical = canonical.slice().sort((a, b) =>
    b.lastOccurredMs - a.lastOccurredMs || b.lastReceivedMs - a.lastReceivedMs
  );

  for (const r of orderedCanonical) {
    const key = normName(r.rawName);
    const guilds = [...r.guilds];
    const familyGuild = guilds.find(g => allowedGuilds.has(normGuild(g))) || "";
    const hasGuildEvidence = guilds.length > 0;

    let allowed = false;
    let displayName = r.rawName;
    let filterMode = "";

    if (familyGuild) {
      allowed = true;
      filterMode = "guild";
      guildConsiderados++;
    } else if (!hasGuildEvidence && key && legacyAllowed.has(key)) {
      allowed = true;
      filterMode = "legacy_party";
      displayName = legacyAllowed.get(key) || r.rawName;
      legacyConsiderados++;
    }

    if (!allowed) {
      ignorados++;
      continue;
    }

    considerados++;
    const value = r.unitValue * r.quantity;
    capturado += value;
    byPlayer.set(displayName, (byPlayer.get(displayName) || 0) + value);

    if (itens.length < 100) {
      itens.push({
        jog: displayName,
        item: r.item,
        qtd: r.quantity,
        unit: r.unitValue,
        origem: r.origin || r.cluster || "",
        guild: familyGuild || (guilds[0] || null),
        filtro: filterMode,
        v: value,
        st: "capturado",
        at: r.occurredAt,
        observers: r.devices.size,
        copies: r.copies,
        deduped: Math.max(0, r.copies - 1),
      });
    }
  }

  const top = [...byPlayer.entries()]
    .map(([n, v]) => ({ n, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 20);

  const collapsed = Math.max(0, rows.length - canonical.length);
  return {
    resumo: { capturado, entregue: null, pendente: null, divergencias: null },
    top,
    itens,
    meta: {
      totalEventos: rows.length,
      totalEventosRaw: rows.length,
      eventosUnicos: canonical.length,
      duplicadosColapsados: collapsed,
      lootDedupWindowMs: LOOT_DEDUP_MS,
      eventosConsiderados: considerados,
      eventosIgnorados: ignorados,
      guildConsiderados,
      legacyConsiderados,
      filtroAtivo: true,
      filtro: "guild_imortais_family",
      comparatorReady: false,
      note:
        "Loot deduplicado no servidor: reenvios do mesmo EventId são eliminados no banco e cópias do mesmo pickup vistas por observers diferentes são fundidas por jogador + item + quantidade + valor, origem/mapa compatíveis e janela de " +
        Math.round(LOOT_DEDUP_MS / 100) / 10 +
        "s. Registros do mesmo device nunca são fundidos. " +
        (legacyConsiderados > 0
          ? "Guilds IMORTAIS, IMORTAIS ACADEMY e IMORTAIS 2 são aceitas; eventos antigos sem guild usam como compatibilidade quem apareceu na formação/party do CTA."
          : "Somente loot cuja guild informada é IMORTAIS, IMORTAIS ACADEMY ou IMORTAIS 2 entra no desempenho.") +
        " Entrega em baú ainda depende do Loot Comparator."
    }
  };
}

async function getCombat(db, eventId, options = {}) {
  const hasPresenceRows = Array.isArray(options?.presenceRows);
  const [combatResult, presenceRows] = await Promise.all([
    pool.query(`
      SELECT event_id, device_id, type, player_name, payload, occurred_at, received_at
      FROM albion_telemetry_events
      WHERE cta_event_id=$1
        AND type IN ('combat_delta','death','kill','knockout','knocked_out','combat_result','player_death_observed')
      ORDER BY occurred_at ASC, received_at ASC
    `, [eventId]),
    hasPresenceRows ? Promise.resolve(options.presenceRows) : getPresenceSnapshotRows(eventId)
  ]);
  const rows = combatResult.rows || [];

  const signups = await db.getSignups(eventId).catch(() => []);
  const ev = await db.getEvent(eventId).catch(() => null);
  const pl = ev ? db.parsePartyList(ev) : [];
  const displayByRaw = new Map(pl.map((raw, idx) => [Number(raw), idx + 1]));
  const signupByName = new Map(signups.map(s => [normName(s.username), s]));
  const rosterKeys = new Set(signups.map(s => normName(s.username)).filter(Boolean));
  const players = new Map();
  const ptAgg = new Map();
  const deviceAgg = new Map();
  const killCandidates = new Map();
  const killCandidatesByPair = new Map();
  const deltaFingerprints = new Map();
  const canonicalDeltaCandidates = new Map();
  const mapAgg = new Map();
  let deaths = 0;
  let rawKillLikeEvents = 0;
  let rawObservedDeaths = 0;
  let rawCombatDeltaEvents = 0;

  function cleanMap(value) {
    const text = String(value || "").trim();
    return text || "Mapa desconhecido";
  }
  function isImortaisFamilyGuild(value) {
    return isImortaisFamilyGuildName(value);
  }
  function ptFor(name) {
    const s = signupByName.get(normName(name));
    if (!s || s.party_index == null) return "Sem PT";
    return `PT ${displayByRaw.get(Number(s.party_index)) || (Number(s.party_index) + 1)}`;
  }
  function playerIn(store, name) {
    const key = normName(name);
    if (!store.has(key)) store.set(key, { n: String(name || "?"), dmg: 0, heal: 0, mortes: 0 });
    return store.get(key);
  }
  function ptIn(store, name) {
    if (!store.has(name)) store.set(name, { pt: name, dmg: 0, heal: 0, mortes: 0 });
    return store.get(name);
  }
  function device(id) {
    const key = String(id || "sem-device");
    if (!deviceAgg.has(key)) {
      deviceAgg.set(key, {
        deviceId: key,
        eventos: 0,
        combatDelta: 0,
        killLike: 0,
        observedDeaths: 0,
        damage: 0,
        healing: 0,
        firstAt: null,
        lastAt: null
      });
    }
    return deviceAgg.get(key);
  }
  function mapBucket(name) {
    const key = cleanMap(name);
    if (!mapAgg.has(key)) {
      mapAgg.set(key, {
        map: key,
        players: new Map(),
        canonicalPlayers: new Map(),
        pts: new Map(),
        canonicalPts: new Map(),
        devices: new Set(),
        killCandidates: new Map(),
        totalEvents: 0,
        rawCombatDeltaEvents: 0,
        canonicalDeltaEvents: 0,
        collapsedCombatDeltaEvents: 0,
        multiObserverDeltaCandidates: 0,
        rawKillLikeEvents: 0,
        deaths: 0,
        firstAt: null,
        lastAt: null,
        fights: []
      });
    }
    return mapAgg.get(key);
  }
  function bucketMs(value, size) {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? Math.floor(t / size) * size : 0;
  }
  function touchWindow(bucket, at) {
    if (!bucket.firstAt || new Date(at) < new Date(bucket.firstAt)) bucket.firstAt = at;
    if (!bucket.lastAt || new Date(at) > new Date(bucket.lastAt)) bucket.lastAt = at;
  }
  function fightFor(map, at) {
    const atMs = new Date(at).getTime();
    let fight = map.fights[map.fights.length - 1];
    const lastMs = fight && fight.lastAt ? new Date(fight.lastAt).getTime() : NaN;
    if (!fight || !Number.isFinite(lastMs) || !Number.isFinite(atMs) || atMs - lastMs > COMBAT_FIGHT_GAP_MS) {
      fight = {
        n: map.fights.length + 1,
        players: new Map(),
        canonicalPlayers: new Map(),
        pts: new Map(),
        canonicalPts: new Map(),
        devices: new Set(),
        killCandidates: new Map(),
        totalEvents: 0,
        rawCombatDeltaEvents: 0,
        canonicalDeltaEvents: 0,
        collapsedCombatDeltaEvents: 0,
        multiObserverDeltaCandidates: 0,
        rawKillLikeEvents: 0,
        deaths: 0,
        firstAt: at,
        lastAt: at
      };
      map.fights.push(fight);
    }
    touchWindow(fight, at);
    return fight;
  }
  function deathCandidateFor(cluster, killer, victim, occurredAt, receivedAt, map, fight, payload = {}) {
    // Identidade canônica da morte:
    // - mapa + vítima são a chave principal;
    // - victimObjectId é usado como evidência forte quando disponível;
    // - o mesmo óbito é fundido quando occurred_at OU received_at cai na janela.
    //
    // Não usamos killer na chave. Observers diferentes podem atribuir o golpe final
    // de forma diferente, mas a mesma vítima não consegue morrer duas vezes em poucos
    // segundos no mesmo mapa. Isso também permite fundir CombatResult legado com DiedEvent.
    const victimKey = normName(victim);
    const baseKey = [cluster, victimKey].join("|");
    if (!killCandidatesByPair.has(baseKey)) killCandidatesByPair.set(baseKey, []);
    const arr = killCandidatesByPair.get(baseKey);

    const occurredMs = new Date(occurredAt).getTime();
    const receivedMs = new Date(receivedAt).getTime();
    const victimObjectId = num(payload.victimObjectId, 0) > 0 ? String(payload.victimObjectId) : null;
    const killerObjectId = num(payload.killerObjectId, 0) > 0 ? String(payload.killerObjectId) : null;

    let k = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const candidate = arr[i];

      const occurredClose =
        Number.isFinite(occurredMs) &&
        Number.isFinite(candidate.lastOccurredMs) &&
        Math.abs(occurredMs - candidate.lastOccurredMs) <= COMBAT_DEATH_DEDUP_MS;

      const receivedClose =
        Number.isFinite(receivedMs) &&
        Number.isFinite(candidate.lastReceivedMs) &&
        Math.abs(receivedMs - candidate.lastReceivedMs) <= COMBAT_DEATH_DEDUP_MS;

      const objectCompatible =
        !victimObjectId ||
        candidate.victimObjectIds.size === 0 ||
        candidate.victimObjectIds.has(victimObjectId);

      if (objectCompatible && (occurredClose || receivedClose)) {
        k = candidate;
        break;
      }

      // Como os eventos chegam ordenados, depois de duas janelas inteiras de distância
      // não há motivo para continuar procurando para trás.
      const newestKnown = Math.max(
        Number.isFinite(candidate.lastOccurredMs) ? candidate.lastOccurredMs : 0,
        Number.isFinite(candidate.lastReceivedMs) ? candidate.lastReceivedMs : 0
      );
      const currentKnown = Math.max(
        Number.isFinite(occurredMs) ? occurredMs : 0,
        Number.isFinite(receivedMs) ? receivedMs : 0
      );
      if (newestKnown && currentKnown && currentKnown - newestKnown > COMBAT_DEATH_DEDUP_MS * 2) break;
    }

    if (!k) {
      const anchorMs = Number.isFinite(occurredMs)
        ? occurredMs
        : (Number.isFinite(receivedMs) ? receivedMs : Date.now());
      const id = baseKey + "|" + String(anchorMs) + "|" + String(arr.length + 1);
      k = {
        id,
        map: cluster,
        killer,
        victim,
        occurredAt,
        receivedAt,
        firstOccurredMs: Number.isFinite(occurredMs) ? occurredMs : null,
        lastOccurredMs: Number.isFinite(occurredMs) ? occurredMs : null,
        firstReceivedMs: Number.isFinite(receivedMs) ? receivedMs : null,
        lastReceivedMs: Number.isFinite(receivedMs) ? receivedMs : null,
        devices: new Set(),
        observedDeathDevices: new Set(),
        observedDeathDeviceCounts: new Map(),
        sourceTypes: new Set(),
        killerNames: new Set(),
        killerGuilds: new Set(),
        victimGuilds: new Set(),
        victimObjectIds: new Set(),
        killerObjectIds: new Set(),
        rawEvents: 0,
        observedDeathEvents: 0,
        killFame: 0,
        killFameResolved: false,
        albionEventIds: new Set(),
        albionBattleIds: new Set(),
        killerInRoster: rosterKeys.has(normName(killer)),
        victimInRoster: rosterKeys.has(victimKey),
        killerInFamily: false,
        victimInFamily: false,
        mapBucket: map,
        fightBucket: fight
      };
      arr.push(k);
      killCandidates.set(id, k);
      map.killCandidates.set(id, k);
      fight.killCandidates.set(id, k);
    }

    if (Number.isFinite(occurredMs)) {
      k.firstOccurredMs = k.firstOccurredMs == null ? occurredMs : Math.min(k.firstOccurredMs, occurredMs);
      k.lastOccurredMs = k.lastOccurredMs == null ? occurredMs : Math.max(k.lastOccurredMs, occurredMs);
    }
    if (Number.isFinite(receivedMs)) {
      k.firstReceivedMs = k.firstReceivedMs == null ? receivedMs : Math.min(k.firstReceivedMs, receivedMs);
      k.lastReceivedMs = k.lastReceivedMs == null ? receivedMs : Math.max(k.lastReceivedMs, receivedMs);
    }
    if (killer) k.killerNames.add(String(killer).trim());
    if (victimObjectId) k.victimObjectIds.add(victimObjectId);
    if (killerObjectId) k.killerObjectIds.add(killerObjectId);

    return k;
  }

  for (const r of rows) {
    const p = r.payload || {};
    const cluster = cleanMap(p.cluster);

    if (r.type === "player_death_observed") {
      const killerKey = normName(p.killer);
      const victimKey = normName(p.victim);
      const relevant =
        isImortaisFamilyGuild(p.killerGuild) ||
        isImortaisFamilyGuild(p.victimGuild) ||
        rosterKeys.has(killerKey) ||
        rosterKeys.has(victimKey);
      if (!relevant) continue;
    }

    const map = mapBucket(cluster);
    const fight = fightFor(map, r.occurred_at);
    const d = device(r.device_id);
    d.eventos++;
    map.totalEvents++;
    fight.totalEvents++;
    map.devices.add(String(r.device_id || "sem-device"));
    fight.devices.add(String(r.device_id || "sem-device"));
    touchWindow(map, r.occurred_at);
    if (!d.firstAt || new Date(r.occurred_at) < new Date(d.firstAt)) d.firstAt = r.occurred_at;
    if (!d.lastAt || new Date(r.occurred_at) > new Date(d.lastAt)) d.lastAt = r.occurred_at;

    if (r.type === "combat_delta") {
      const name = String(p.player || r.player_name || "?");
      const dmg = num(p.damage), heal = num(p.healing);
      const deviceId = String(r.device_id || "sem-device");

      rawCombatDeltaEvents++;
      map.rawCombatDeltaEvents++;
      fight.rawCombatDeltaEvents++;

      const x = playerIn(players, name), g = ptIn(ptAgg, ptFor(name));
      x.dmg += dmg; x.heal += heal; g.dmg += dmg; g.heal += heal;

      const mx = playerIn(map.players, name), mg = ptIn(map.pts, ptFor(name));
      mx.dmg += dmg; mx.heal += heal; mg.dmg += dmg; mg.heal += heal;

      const fx = playerIn(fight.players, name), fg = ptIn(fight.pts, ptFor(name));
      fx.dmg += dmg; fx.heal += heal; fg.dmg += dmg; fg.heal += heal;

      d.combatDelta++; d.damage += dmg; d.healing += heal;

      // Fusão conservadora: só colapsa deltas exatamente iguais do mesmo jogador,
      // mapa e janela de 1s. Se o mesmo fingerprint aparece repetido no mesmo device,
      // preservamos a maior multiplicidade observada por um único device.
      const fp = [
        cluster,
        normName(name),
        String(Math.round(dmg)),
        String(Math.round(heal)),
        String(bucketMs(r.occurred_at, 1000))
      ].join("|");
      if (!deltaFingerprints.has(fp)) deltaFingerprints.set(fp, new Set());
      deltaFingerprints.get(fp).add(deviceId);

      let dc = canonicalDeltaCandidates.get(fp);
      if (!dc) {
        dc = {
          cluster,
          name,
          dmg,
          heal,
          occurredAt: r.occurred_at,
          devices: new Set(),
          deviceCounts: new Map(),
          rawEvents: 0,
          mapBucket: map,
          fightBucket: fight
        };
        canonicalDeltaCandidates.set(fp, dc);
      }
      dc.rawEvents++;
      dc.devices.add(deviceId);
      dc.deviceCounts.set(deviceId, (dc.deviceCounts.get(deviceId) || 0) + 1);
    }

    if (r.type === "kill" || r.type === "death" || r.type === "player_death_observed") {
      const killer = String(p.killer || "").trim();
      const victim = String(p.victim || "").trim();
      const lethal = p.isLethal !== false;
      if (killer && victim && lethal) {
        rawKillLikeEvents++;
        map.rawKillLikeEvents++;
        fight.rawKillLikeEvents++;
        d.killLike++;
        if (r.type === "player_death_observed") {
          rawObservedDeaths++;
          d.observedDeaths++;
        }

        const k = deathCandidateFor(
          cluster,
          killer,
          victim,
          r.occurred_at,
          r.received_at,
          map,
          fight,
          p
        );
        k.rawEvents++;
        const observerDeviceId = String(r.device_id || "sem-device");
        if (r.type === "player_death_observed") {
          k.observedDeathEvents++;
          k.observedDeathDevices.add(observerDeviceId);
          k.observedDeathDeviceCounts.set(
            observerDeviceId,
            (k.observedDeathDeviceCounts.get(observerDeviceId) || 0) + 1
          );
        }
        k.devices.add(observerDeviceId);
        k.sourceTypes.add(r.type);
        if (p.killerGuild) k.killerGuilds.add(String(p.killerGuild).trim());
        if (p.victimGuild) k.victimGuilds.add(String(p.victimGuild).trim());
        k.killerInRoster = k.killerInRoster || rosterKeys.has(normName(killer));
        k.victimInRoster = k.victimInRoster || rosterKeys.has(normName(victim));
        k.killerInFamily = k.killerInFamily || isImortaisFamilyGuild(p.killerGuild);
        k.victimInFamily = k.victimInFamily || isImortaisFamilyGuild(p.victimGuild);
        const fameRaw = p.killFame ?? p.totalVictimKillFame ?? p.TotalVictimKillFame ?? null;
        const fame = Number(fameRaw);
        if (fameRaw != null && Number.isFinite(fame) && fame >= 0) {
          k.killFame = Math.max(k.killFame, fame);
          k.killFameResolved = true;
        }
        if (p.albionEventId) k.albionEventIds.add(String(p.albionEventId));
        if (p.albionBattleId) k.albionBattleIds.add(String(p.albionBattleId));
      }
    }
  }

  const canonicalDeltaRows = [...canonicalDeltaCandidates.values()];
  const canonicalPlayers = new Map();
  const canonicalPtAgg = new Map();
  let canonicalDamage = 0;
  let canonicalHealing = 0;
  let canonicalCombatDeltaEvents = 0;
  let collapsedCombatDeltaEvents = 0;
  let multiObserverDeltaCandidates = 0;

  for (const dc of canonicalDeltaRows) {
    const copies = Math.max(1, ...dc.deviceCounts.values());
    const damage = dc.dmg * copies;
    const healing = dc.heal * copies;

    canonicalCombatDeltaEvents += copies;
    collapsedCombatDeltaEvents += Math.max(0, dc.rawEvents - copies);
    if (dc.devices.size > 1) multiObserverDeltaCandidates++;

    canonicalDamage += damage;
    canonicalHealing += healing;

    const px = playerIn(canonicalPlayers, dc.name);
    const pg = ptIn(canonicalPtAgg, ptFor(dc.name));
    px.dmg += damage; px.heal += healing;
    pg.dmg += damage; pg.heal += healing;

    const mx = playerIn(dc.mapBucket.canonicalPlayers, dc.name);
    const mg = ptIn(dc.mapBucket.canonicalPts, ptFor(dc.name));
    mx.dmg += damage; mx.heal += healing;
    mg.dmg += damage; mg.heal += healing;
    dc.mapBucket.canonicalDeltaEvents += copies;
    dc.mapBucket.collapsedCombatDeltaEvents += Math.max(0, dc.rawEvents - copies);
    if (dc.devices.size > 1) dc.mapBucket.multiObserverDeltaCandidates++;

    const fx = playerIn(dc.fightBucket.canonicalPlayers, dc.name);
    const fg = ptIn(dc.fightBucket.canonicalPts, ptFor(dc.name));
    fx.dmg += damage; fx.heal += healing;
    fg.dmg += damage; fg.heal += healing;
    dc.fightBucket.canonicalDeltaEvents += copies;
    dc.fightBucket.collapsedCombatDeltaEvents += Math.max(0, dc.rawEvents - copies);
    if (dc.devices.size > 1) dc.fightBucket.multiObserverDeltaCandidates++;
  }

  const canonicalKills = [...killCandidates.values()];
  const canonicalObservedDeaths = canonicalKills.filter(k => k.observedDeathEvents > 0);
  const observedDeathObserverHistogram = canonicalObservedDeaths.reduce((acc, k) => {
    const observers = Math.max(1, k.observedDeathDevices.size);
    acc[observers] = (acc[observers] || 0) + 1;
    return acc;
  }, {});
  const crossObserverObservedDeathCopies = canonicalObservedDeaths.reduce(
    (sum, k) => sum + Math.max(0, k.observedDeathDevices.size - 1),
    0
  );
  const sameObserverObservedDeathCopies = canonicalObservedDeaths.reduce((sum, k) => {
    let duplicates = 0;
    for (const count of k.observedDeathDeviceCounts.values()) {
      duplicates += Math.max(0, Number(count) - 1);
    }
    return sum + duplicates;
  }, 0);
  for (const k of canonicalKills) {
    k.killerIsOurs = k.killerInFamily || k.killerInRoster;
    k.victimIsOurs = k.victimInFamily || k.victimInRoster;

    if (k.victimIsOurs && !k.killerIsOurs) {
      deaths++;
      k.mapBucket.deaths++;
      k.fightBucket.deaths++;
      playerIn(players, k.victim).mortes++;
      ptIn(ptAgg, ptFor(k.victim)).mortes++;
      playerIn(k.mapBucket.players, k.victim).mortes++;
      ptIn(k.mapBucket.pts, ptFor(k.victim)).mortes++;
      playerIn(k.fightBucket.players, k.victim).mortes++;
      ptIn(k.fightBucket.pts, ptFor(k.victim)).mortes++;
    }
  }

  const unclassifiedCanonicalKills = canonicalKills.filter(
    k => !!k.killerIsOurs === !!k.victimIsOurs
  );
  const friendlyCanonicalKills = unclassifiedCanonicalKills.filter(
    k => k.killerIsOurs && k.victimIsOurs
  );
  const externalCanonicalKills = unclassifiedCanonicalKills.filter(
    k => !k.killerIsOurs && !k.victimIsOurs
  );

  function serializeUnclassifiedKill(k) {
    let classification = "nem_kill_nossa_nem_morte_nossa";
    if (k.killerIsOurs && k.victimIsOurs) classification = "ambos_nossos";
    else if (!k.killerIsOurs && !k.victimIsOurs) classification = "nenhum_nosso";
    return {
      map: k.map,
      occurredAt: k.occurredAt,
      killer: k.killer,
      victim: k.victim,
      killerGuilds: [...k.killerGuilds],
      victimGuilds: [...k.victimGuilds],
      sourceTypes: [...k.sourceTypes],
      observers: k.devices.size,
      observedDeathObservers: k.observedDeathDevices.size,
      classification
    };
  }

  function combatPlayerRows(rawStore, canonicalStore, kills, limit = 100) {
    const kd = new Map();
    function kdFor(name) {
      const key = normName(name);
      if (!kd.has(key)) kd.set(key, { n: String(name || "?"), kills: 0, deaths: 0, killFame: 0, deathFame: 0 });
      return kd.get(key);
    }
    for (const k of kills) {
      if (k.killerIsOurs && !k.victimIsOurs) {
        const row = kdFor(k.killer);
        row.kills++;
        row.killFame += num(k.killFame);
      }
      if (k.victimIsOurs && !k.killerIsOurs) {
        const row = kdFor(k.victim);
        row.deaths++;
        row.deathFame += num(k.killFame);
      }
    }

    const keys = new Set([...rawStore.keys(), ...canonicalStore.keys(), ...kd.keys()]);
    return [...keys].map(key => {
      const raw = rawStore.get(key) || {};
      const canonical = canonicalStore.get(key) || {};
      const combat = kd.get(key) || {};
      const name = raw.n || canonical.n || combat.n || key || "?";
      return {
        n: name,
        pt: ptFor(name),
        damage: num(canonical.dmg),
        healing: num(canonical.heal),
        rawDamage: num(raw.dmg),
        rawHealing: num(raw.heal),
        kills: num(combat.kills),
        deaths: num(combat.deaths),
        killFame: num(combat.killFame),
        deathFame: num(combat.deathFame)
      };
    })
      .filter(x =>
        x.damage > 0 || x.healing > 0 || x.rawDamage > 0 || x.rawHealing > 0 ||
        x.kills > 0 || x.deaths > 0 || x.killFame > 0 || x.deathFame > 0
      )
      .sort((a, b) =>
        b.damage - a.damage ||
        b.kills - a.kills ||
        b.healing - a.healing ||
        a.n.localeCompare(b.n, "pt-BR")
      )
      .slice(0, limit);
  }

  function killRanking(kills, limit = 20) {
    const byPlayer = new Map();
    for (const k of kills.filter(x => x.killerIsOurs && !x.victimIsOurs)) {
      const key = normName(k.killer);
      const cur = byPlayer.get(key) || { n: k.killer, v: 0 };
      cur.v++;
      byPlayer.set(key, cur);
    }
    return [...byPlayer.values()].sort((a, b) => b.v - a.v || a.n.localeCompare(b.n)).slice(0, limit);
  }

  function fameRanking(kills, side = "kill", limit = 20) {
    const byPlayer = new Map();
    for (const k of kills) {
      const ours = side === "kill"
        ? (k.killerIsOurs && !k.victimIsOurs)
        : (k.victimIsOurs && !k.killerIsOurs);
      if (!ours || num(k.killFame) <= 0) continue;
      const name = side === "kill" ? k.killer : k.victim;
      const key = normName(name);
      const cur = byPlayer.get(key) || { n: name, v: 0 };
      cur.v += num(k.killFame);
      byPlayer.set(key, cur);
    }
    return [...byPlayer.values()]
      .sort((a, b) => b.v - a.v || a.n.localeCompare(b.n))
      .slice(0, limit);
  }

  function enemyGuildName(guilds) {
    for (const raw of (guilds || [])) {
      const guild = String(raw || "").trim();
      if (guild && !isImortaisFamilyGuild(guild)) return guild;
    }
    return "Sem guilda";
  }

  function killScoreFor(kills) {
    const byGuild = new Map();

    function scoreRow(guild) {
      const display = String(guild || "").trim() || "Sem guilda";
      const key = display === "Sem guilda" ? "__sem_guilda__" : (normGuild(display) || "__sem_guilda__");
      if (!byGuild.has(key)) {
        byGuild.set(key, { guild: display, weKilledThem: 0, theyKilledUs: 0 });
      }
      return byGuild.get(key);
    }

    for (const k of kills) {
      const killerIsOurs = !!(k.killerInRoster || k.killerInFamily);
      const victimIsOurs = !!(k.victimInRoster || k.victimInFamily);

      // Ignora friendly fire e mortes entre dois inimigos.
      if (killerIsOurs === victimIsOurs) continue;

      if (killerIsOurs) {
        scoreRow(enemyGuildName(k.victimGuilds)).weKilledThem++;
      } else {
        scoreRow(enemyGuildName(k.killerGuilds)).theyKilledUs++;
      }
    }

    const rows = [...byGuild.values()]
      .filter(x => x.weKilledThem > 0 || x.theyKilledUs > 0)
      .sort((a, b) =>
        (b.weKilledThem + b.theyKilledUs) - (a.weKilledThem + a.theyKilledUs) ||
        b.weKilledThem - a.weKilledThem ||
        a.guild.localeCompare(b.guild, "pt-BR")
      );

    return {
      byGuild: rows,
      totals: {
        weKilled: rows.reduce((sum, x) => sum + x.weKilledThem, 0),
        wereKilled: rows.reduce((sum, x) => sum + x.theyKilledUs, 0)
      }
    };
  }
  function serializeFight(bucket) {
    const list = [...bucket.players.values()];
    const canonicalList = [...bucket.canonicalPlayers.values()];
    const kills = [...bucket.killCandidates.values()];
    const ourKills = kills.filter(k => k.killerIsOurs && !k.victimIsOurs);
    const ourDeaths = kills.filter(k => k.victimIsOurs && !k.killerIsOurs);
    const relevantDeathEvents = ourKills.length + ourDeaths.length;
    return {
      n: bucket.n,
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
      totalEvents: bucket.totalEvents,
      observers: [...bucket.devices],
      relevantDeathEvents,
      reportable: relevantDeathEvents >= COMBAT_BATTLE_MIN_EVENTS,
      resumo: {
        damage: list.reduce((a, x) => a + x.dmg, 0),
        healing: list.reduce((a, x) => a + x.heal, 0),
        mortes: bucket.deaths,
        killsCandidate: ourKills.length,
        deathsCandidate: ourDeaths.length,
        killFame: ourKills.reduce((sum, k) => sum + num(k.killFame), 0),
        deathFame: ourDeaths.reduce((sum, k) => sum + num(k.killFame), 0)
      },
      resumoDedup: {
        damage: canonicalList.reduce((a, x) => a + x.dmg, 0),
        healing: canonicalList.reduce((a, x) => a + x.heal, 0)
      },
      players: combatPlayerRows(bucket.players, bucket.canonicalPlayers, kills),
      topDmg: list.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 10).map(x => ({ n: x.n, v: x.dmg })),
      topHeal: list.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 10).map(x => ({ n: x.n, v: x.heal })),
      topDmgDedup: canonicalList.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 10).map(x => ({ n: x.n, v: x.dmg })),
      topHealDedup: canonicalList.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 10).map(x => ({ n: x.n, v: x.heal })),
      topKillsCandidate: killRanking(kills, 10),
      topKillFame: fameRanking(kills, "kill", 10),
      topDeathFame: fameRanking(kills, "death", 10),
      killScore: killScoreFor(kills),
      audit: {
        rawCombatDeltaEvents: bucket.rawCombatDeltaEvents,
        canonicalDeltaEvents: bucket.canonicalDeltaEvents,
        collapsedCombatDeltaEvents: bucket.collapsedCombatDeltaEvents,
        multiObserverDeltaCandidates: bucket.multiObserverDeltaCandidates,
        rawKillLikeEvents: bucket.rawKillLikeEvents,
        uniqueKillCandidates: kills.length,
        duplicateKillLikeEvents: Math.max(0, bucket.rawKillLikeEvents - kills.length),
        multiObserverKillCandidates: kills.filter(k => k.devices.size > 1).length,
        fameResolvedCandidates: kills.filter(k => k.killFameResolved).length,
        fameUnresolvedCandidates: kills.filter(k => !k.killFameResolved).length,
        fameResolvedCandidates: kills.filter(k => k.killFameResolved).length,
        fameUnresolvedCandidates: kills.filter(k => !k.killFameResolved).length
      }
    };
  }
  function serializeMap(bucket) {
    const list = [...bucket.players.values()];
    const canonicalList = [...bucket.canonicalPlayers.values()];
    const kills = [...bucket.killCandidates.values()];
    const ourKills = kills.filter(k => k.killerIsOurs && !k.victimIsOurs);
    const ourDeaths = kills.filter(k => k.victimIsOurs && !k.killerIsOurs);
    const serializedFights = bucket.fights.map(serializeFight);
    const reportableFights = serializedFights.filter(f => f.reportable);
    return {
      map: bucket.map,
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
      totalEvents: bucket.totalEvents,
      observers: [...bucket.devices],
      resumo: {
        damage: list.reduce((a, x) => a + x.dmg, 0),
        healing: list.reduce((a, x) => a + x.heal, 0),
        mortes: bucket.deaths,
        killsCandidate: ourKills.length,
        deathsCandidate: ourDeaths.length,
        killFame: ourKills.reduce((sum, k) => sum + num(k.killFame), 0),
        deathFame: ourDeaths.reduce((sum, k) => sum + num(k.killFame), 0)
      },
      resumoDedup: {
        damage: canonicalList.reduce((a, x) => a + x.dmg, 0),
        healing: canonicalList.reduce((a, x) => a + x.heal, 0)
      },
      porPt: [...bucket.pts.values()].sort((a, b) => a.pt.localeCompare(b.pt, "pt-BR", { numeric: true })),
      porPtDedup: [...bucket.canonicalPts.values()].sort((a, b) => a.pt.localeCompare(b.pt, "pt-BR", { numeric: true })),
      topDmg: list.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 20).map(x => ({ n: x.n, v: x.dmg })),
      topHeal: list.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 20).map(x => ({ n: x.n, v: x.heal })),
      topDmgDedup: canonicalList.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 20).map(x => ({ n: x.n, v: x.dmg })),
      topHealDedup: canonicalList.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 20).map(x => ({ n: x.n, v: x.heal })),
      topKillsCandidate: killRanking(kills),
      topKillFame: fameRanking(kills, "kill"),
      topDeathFame: fameRanking(kills, "death"),
      killScore: killScoreFor(kills),
      fights: reportableFights,
      audit: {
        candidateFights: serializedFights.length,
        reportableFights: reportableFights.length,
        suppressedFights: Math.max(0, serializedFights.length - reportableFights.length),
        battleMinRelevantEvents: COMBAT_BATTLE_MIN_EVENTS,
        rawCombatDeltaEvents: bucket.rawCombatDeltaEvents,
        canonicalDeltaEvents: bucket.canonicalDeltaEvents,
        collapsedCombatDeltaEvents: bucket.collapsedCombatDeltaEvents,
        multiObserverDeltaCandidates: bucket.multiObserverDeltaCandidates,
        rawKillLikeEvents: bucket.rawKillLikeEvents,
        uniqueKillCandidates: kills.length,
        duplicateKillLikeEvents: Math.max(0, bucket.rawKillLikeEvents - kills.length),
        multiObserverKillCandidates: kills.filter(k => k.devices.size > 1).length
      }
    };
  }

  const list = [...players.values()];
  const canonicalList = [...canonicalPlayers.values()];
  const kills = canonicalKills;
  const ourKills = kills.filter(k => k.killerIsOurs && !k.victimIsOurs);
  const ourDeaths = kills.filter(k => k.victimIsOurs && !k.killerIsOurs);

  // Linha do tempo das mortes dos nossos jogadores.
  // "rapidReturn" só fica true quando:
  // 1) há uma morte anterior do mesmo jogador em até 10 minutos; e
  // 2) existe atividade canônica de combate do jogador entre as duas mortes.
  // Isso é mais conservador do que assumir "regear" apenas pelo intervalo.
  const RAPID_REDEATH_MS = 10 * 60 * 1000;
  const activityTimesByPlayer = new Map();
  for (const dc of canonicalDeltaRows) {
    const key = normName(dc.name);
    const ts = new Date(dc.occurredAt).getTime();
    if (!key || !Number.isFinite(ts)) continue;
    if (!activityTimesByPlayer.has(key)) activityTimesByPlayer.set(key, []);
    activityTimesByPlayer.get(key).push(ts);
  }
  for (const arr of activityTimesByPlayer.values()) arr.sort((a, b) => a - b);

  const deathsByPlayer = new Map();
  for (const k of ourDeaths) {
    const key = normName(k.victim);
    if (!key) continue;
    if (!deathsByPlayer.has(key)) deathsByPlayer.set(key, []);
    deathsByPlayer.get(key).push(k);
  }

  const ourDeathTimeline = [];
  for (const [victimKey, arr] of deathsByPlayer) {
    arr.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
    const activity = activityTimesByPlayer.get(victimKey) || [];
    let prev = null;
    for (const k of arr) {
      const atMs = new Date(k.occurredAt).getTime();
      const prevMs = prev ? new Date(prev.occurredAt).getTime() : NaN;
      const gapMs = Number.isFinite(atMs) && Number.isFinite(prevMs) ? Math.max(0, atMs - prevMs) : null;
      const activityBetween = gapMs != null && gapMs > 0
        ? activity.some(t => t > prevMs && t < atMs)
        : false;
      const fightStartMs = k.fightBucket?.firstAt ? new Date(k.fightBucket.firstAt).getTime() : NaN;
      const secondsIntoFight =
        Number.isFinite(atMs) && Number.isFinite(fightStartMs)
          ? Math.max(0, Math.round((atMs - fightStartMs) / 1000))
          : null;

      ourDeathTimeline.push({
        victim: k.victim,
        killer: k.killer,
        killerGuilds: [...k.killerGuilds],
        occurredAt: k.occurredAt,
        map: k.map,
        fight: k.fightBucket?.n ?? null,
        fightFirstAt: k.fightBucket?.firstAt || null,
        secondsIntoFight,
        sincePreviousDeathSeconds: gapMs == null ? null : Math.round(gapMs / 1000),
        combatActivityBetween: activityBetween,
        rapidReturn: !!(activityBetween && gapMs > 0 && gapMs <= RAPID_REDEATH_MS),
        deathFame: num(k.killFame),
        fameResolved: !!k.killFameResolved,
        observers: k.devices.size
      });
      prev = k;
    }
  }
  const overlappingDeltaFingerprints = [...deltaFingerprints.values()].filter(set => set.size > 1).length;
  const devices = [...deviceAgg.values()].sort((a, b) => b.eventos - a.eventos);
  const maps = [...mapAgg.values()]
    .map(serializeMap)
    .filter(m => (m.fights || []).length > 0)
    .map(m => ({
      ...m,
      forces: presenceForcesForWindow(presenceRows, rosterKeys, m.map, m.firstAt, m.lastAt),
      fights: (m.fights || []).map(f => ({
        ...f,
        forces: presenceForcesForWindow(presenceRows, rosterKeys, m.map, f.firstAt, f.lastAt)
      }))
    }))
    .sort((a, b) => {
      if (a.map === "Mapa desconhecido" && b.map !== "Mapa desconhecido") return 1;
      if (b.map === "Mapa desconhecido" && a.map !== "Mapa desconhecido") return -1;
      return b.totalEvents - a.totalEvents || a.map.localeCompare(b.map);
    });

  return {
    resumo: {
      damage: list.reduce((a, x) => a + x.dmg, 0),
      healing: list.reduce((a, x) => a + x.heal, 0),
      mortes: deaths,
      killsCandidate: ourKills.length,
      deathsCandidate: ourDeaths.length,
      killFame: ourKills.reduce((sum, k) => sum + num(k.killFame), 0),
      deathFame: ourDeaths.reduce((sum, k) => sum + num(k.killFame), 0),
      fights: null
    },
    resumoDedup: {
      damage: canonicalDamage,
      healing: canonicalHealing
    },
    players: combatPlayerRows(players, canonicalPlayers, kills, 500),
    deaths: ourDeathTimeline.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt)),
    maps,
    porPt: [...ptAgg.values()].sort((a, b) => a.pt.localeCompare(b.pt, "pt-BR", { numeric: true })),
    porPtDedup: [...canonicalPtAgg.values()].sort((a, b) => a.pt.localeCompare(b.pt, "pt-BR", { numeric: true })),
    topDmg: list.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 20).map(x => ({ n: x.n, v: x.dmg })),
    topHeal: list.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 20).map(x => ({ n: x.n, v: x.heal })),
    topDmgDedup: canonicalList.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 20).map(x => ({ n: x.n, v: x.dmg })),
    topHealDedup: canonicalList.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 20).map(x => ({ n: x.n, v: x.heal })),
    topKillsCandidate: killRanking(kills),
    topKillFame: fameRanking(kills, "kill"),
    topDeathFame: fameRanking(kills, "death"),
    killScore: killScoreFor(kills),
    audit: {
      rosterPlayers: rosterKeys.size,
      presenceSnapshots: presenceRows.length,
      rawCombatDeltaEvents,
      canonicalCombatDeltaEvents,
      collapsedCombatDeltaEvents,
      multiObserverDeltaCandidates,
      rawKillLikeEvents,
      rawObservedDeaths,
      canonicalObservedDeaths: canonicalObservedDeaths.length,
      collapsedObservedDeathCopies: Math.max(0, rawObservedDeaths - canonicalObservedDeaths.length),
      crossObserverObservedDeathCopies,
      sameObserverObservedDeathCopies,
      observedDeathObserverHistogram,
      uniqueKillCandidates: kills.length,
      ourKillCandidates: ourKills.length,
      ourDeathCandidates: ourDeaths.length,
      unclassifiedCanonicalCandidates: unclassifiedCanonicalKills.length,
      friendlyCanonicalCandidates: friendlyCanonicalKills.length,
      externalCanonicalCandidates: externalCanonicalKills.length,
      unclassifiedCanonicalSample: unclassifiedCanonicalKills.slice(-20).reverse().map(serializeUnclassifiedKill),
      duplicateKillLikeEvents: Math.max(0, rawKillLikeEvents - kills.length),
      multiObserverKillCandidates: kills.filter(k => k.devices.size > 1).length,
      fameResolvedCandidates: kills.filter(k => k.killFameResolved).length,
      fameUnresolvedCandidates: kills.filter(k => !k.killFameResolved).length,
      totalKillFame: ourKills.reduce((sum, k) => sum + num(k.killFame), 0),
      totalDeathFame: ourDeaths.reduce((sum, k) => sum + num(k.killFame), 0),
      multiObserverObservedDeaths: canonicalObservedDeaths.filter(k => k.observedDeathDevices.size > 1).length,
      deathDedupWindowMs: COMBAT_DEATH_DEDUP_MS,
      combatDeltaFingerprints: deltaFingerprints.size,
      overlappingDeltaFingerprints,
      devices,
      sampleKills: kills.slice(-30).reverse().map(k => ({
        map: k.map,
        killer: k.killer,
        killerGuilds: [...k.killerGuilds],
        victim: k.victim,
        victimGuilds: [...k.victimGuilds],
        occurredAt: k.occurredAt,
        receivedAt: k.receivedAt,
        rawEvents: k.rawEvents,
        observedDeathEvents: k.observedDeathEvents,
        observers: k.devices.size,
        observerDevices: [...k.devices],
        observedDeathObservers: k.observedDeathDevices.size,
        observedDeathObserverDevices: [...k.observedDeathDevices],
        observedDeathDeviceCounts: Object.fromEntries(k.observedDeathDeviceCounts),
        sourceTypes: [...k.sourceTypes],
        victimObjectIds: [...k.victimObjectIds],
        killerObjectIds: [...k.killerObjectIds],
        observedOccurredSpanMs:
          k.firstOccurredMs != null && k.lastOccurredMs != null
            ? Math.max(0, k.lastOccurredMs - k.firstOccurredMs)
            : null,
        observedReceivedSpanMs:
          k.firstReceivedMs != null && k.lastReceivedMs != null
            ? Math.max(0, k.lastReceivedMs - k.firstReceivedMs)
            : null,
        killerInRoster: k.killerInRoster,
        victimInRoster: k.victimInRoster,
        killerInFamily: k.killerInFamily,
        victimInFamily: k.victimInFamily,
        killFame: num(k.killFame),
        killFameResolved: !!k.killFameResolved,
        albionEventIds: [...k.albionEventIds],
        albionBattleIds: [...k.albionBattleIds]
      }))
    },
    meta: {
      totalEventos: rows.length,
      retentionDays: 3,
      mapsWithContext: maps.filter(x => x.map !== "Mapa desconhecido").length,
      fightGapMs: COMBAT_FIGHT_GAP_MS,
      zergDeathObserver: rawObservedDeaths > 0,
      damageFusionMode: "exact-fingerprint-conservative",
      killFameSource: "albion-gameinfo-background",
      killFameMatchWindowMs: killFame.__test.config().matchWindowMs,
      note: rawObservedDeaths > 0
        ? "Kills e mortes da zerg usam DiedEvent fundido entre observers. Dano/cura agora também expõem uma visão deduplicada conservadora: deltas exatamente iguais do mesmo jogador/mapa/janela de 1s são fundidos entre devices, preservando a maior multiplicidade vista por um único observer. O bruto continua disponível para auditoria."
        : "Este CTA ainda não possui player_death_observed (requer Combat Client v0.5.5+). Dano/cura expõem deduplicação conservadora por fingerprint exato; kills/mortes usam apenas os eventos locais legados."
    }
  };
}

function combatCacheTtl(event) {
  return String(event?.status || "").toLowerCase() === "open"
    ? COMBAT_CACHE_OPEN_TTL_MS
    : COMBAT_CACHE_CLOSED_TTL_MS;
}

function evictOldestCombatCache() {
  while (_combatCache.size > COMBAT_CACHE_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of _combatCache) {
      const at = Number(entry?.at) || 0;
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey == null) break;
    _combatCache.delete(oldestKey);
    _combatInFlight.delete(oldestKey);
  }
}

async function getCombatCached(db, eventId, options = {}) {
  const id = String(eventId || "");
  const nowFn = typeof options.now === "function" ? options.now : Date.now;
  const loader = typeof options.loader === "function" ? options.loader : getCombat;
  const getEvent = typeof options.getEvent === "function"
    ? options.getEvent
    : (eventKey => db.getEvent(eventKey));
  let now = Number(nowFn());

  let cached = _combatCache.get(id);
  if (cached && _combatInFlight.has(id)) return cached.promise;

  // 8 s é o menor TTL possível. Dentro desta janela nem precisamos consultar
  // o estado do CTA para saber que a entrada ainda é válida.
  if (cached && now - cached.at < COMBAT_CACHE_OPEN_TTL_MS) return cached.promise;

  const event = await Promise.resolve(getEvent(id)).catch(() => null);
  now = Number(nowFn());

  // Outro request pode ter preenchido o single-flight enquanto aguardávamos getEvent.
  cached = _combatCache.get(id);
  if (cached && _combatInFlight.has(id)) return cached.promise;

  const ttl = combatCacheTtl(event);
  if (cached && now - cached.at < ttl) return cached.promise;

  let promise;
  promise = Promise.resolve().then(() => loader(db, id));
  _combatCache.set(id, { at: now, promise });
  _combatInFlight.add(id);
  evictOldestCombatCache();

  try {
    return await promise;
  } catch (e) {
    const current = _combatCache.get(id);
    if (current?.promise === promise) _combatCache.delete(id);
    throw e;
  } finally {
    const current = _combatCache.get(id);
    if (current?.promise === promise) _combatInFlight.delete(id);
  }
}

function invalidateCombatCache(eventId) {
  const key = String(eventId || "");
  _combatCache.delete(key);
  _combatInFlight.delete(key);
}

function resetCombatCache() {
  _combatCache.clear();
  _combatInFlight.clear();
}

function jsonShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function previewValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.length <= 120 ? value : value.slice(0, 120) + "…";
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return {
      length: value.length,
      sample: value.slice(0, 5).map(previewValue)
    };
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 8)) out[k] = previewValue(v);
    return out;
  }
  return String(value).slice(0, 120);
}

function dotNetTicksToDate(value, fallback) {
  const ticks = Number(value);
  if (!Number.isFinite(ticks)) return fallback instanceof Date ? fallback : new Date(fallback);
  const ms = (ticks - 621355968000000000) / 10000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? (fallback instanceof Date ? fallback : new Date(fallback)) : d;
}

async function applyGuildPresenceProbe({ payload, deviceId, occurredAt, dbClient = pool }) {
  if (!payload || String(payload.eventName || "") !== "GuildPlayerUpdated") return;
  const parameters = payload.parameters && typeof payload.parameters === "object" ? payload.parameters : {};
  const playerName = String(parameters["1"] || "").trim();
  const playerKey = normName(playerName);
  if (!playerKey) return;

  const hasOnlineFlag = Object.prototype.hasOwnProperty.call(parameters, "2");
  const online = hasOnlineFlag ? parameters["2"] === true : false;
  const stateAt = dotNetTicksToDate(parameters["3"], occurredAt);
  const playerId = parameters["0"] && typeof parameters["0"] === "object"
    ? String(parameters["0"].previewBase64 || "").trim() || null
    : null;
  const lastSeenAt = online ? null : stateAt;

  await dbClient.query(`
    INSERT INTO albion_guild_presence(
      player_key, player_name, player_id, online, last_seen_at,
      state_at, last_event_at, observer_device, updated_at
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
    ON CONFLICT(player_key) DO UPDATE SET
      player_name=EXCLUDED.player_name,
      player_id=COALESCE(EXCLUDED.player_id, albion_guild_presence.player_id),
      online=EXCLUDED.online,
      last_seen_at=CASE
        WHEN EXCLUDED.online THEN albion_guild_presence.last_seen_at
        ELSE EXCLUDED.last_seen_at
      END,
      state_at=EXCLUDED.state_at,
      last_event_at=EXCLUDED.last_event_at,
      observer_device=EXCLUDED.observer_device,
      updated_at=now()
    WHERE EXCLUDED.state_at >= albion_guild_presence.state_at
  `, [playerKey, playerName, playerId, online, lastSeenAt, stateAt, occurredAt, deviceId]);
}

async function getGuildPresence() {
  const { rows } = await pool.query(`
    WITH heartbeat AS (
      SELECT DISTINCT ON (device_id)
             device_id,
             player_name AS heartbeat_player_name,
             payload AS heartbeat_payload,
             occurred_at AS heartbeat_occurred_at,
             received_at AS heartbeat_received_at
        FROM albion_telemetry_events
       WHERE type='client_heartbeat'
       ORDER BY device_id, received_at DESC, occurred_at DESC
    )
    SELECT gp.player_name, gp.player_id, gp.online, gp.last_seen_at, gp.state_at,
           gp.last_event_at, gp.observer_device,
           hb.heartbeat_player_name, hb.heartbeat_payload,
           hb.heartbeat_occurred_at, hb.heartbeat_received_at
      FROM albion_guild_presence gp
      LEFT JOIN heartbeat hb ON hb.device_id=gp.observer_device
     ORDER BY gp.online DESC,
              CASE WHEN gp.online THEN gp.state_at END DESC NULLS LAST,
              gp.last_seen_at DESC NULLS LAST,
              lower(gp.player_name)
  `);

  const { rows: heartbeatRows } = await pool.query(`
    WITH ranked AS (
      SELECT device_id, player_name, payload, occurred_at, received_at,
             ROW_NUMBER() OVER (
               PARTITION BY device_id
               ORDER BY received_at DESC, occurred_at DESC
             ) AS rn
        FROM albion_telemetry_events
       WHERE type='client_heartbeat'
    )
    SELECT device_id, player_name, payload, occurred_at, received_at
      FROM ranked
     WHERE rn=1
     ORDER BY received_at DESC
  `);

  const now = Date.now();
  function ageMs(value) {
    if (!value) return Number.POSITIVE_INFINITY;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
  }

  const members = rows.map(r => {
    const stateFreshAt = r.last_event_at || r.state_at || null;
    const stateFresh = ageMs(stateFreshAt) <= GUILD_STATE_FRESH_MS;
    const observerActive = ageMs(r.heartbeat_received_at) <= OBSERVER_HEARTBEAT_FRESH_MS;
    const confirmed = stateFresh && observerActive;
    const online = !!r.online;
    return {
      playerName: r.player_name,
      playerId: r.player_id,
      online,
      lastSeenAt: r.last_seen_at,
      stateAt: r.state_at,
      lastEventAt: r.last_event_at,
      observerDevice: r.observer_device,
      observerHeartbeatAt: r.heartbeat_received_at,
      observerHeartbeatOccurredAt: r.heartbeat_occurred_at,
      observerActive,
      stateFresh,
      freshness: confirmed ? "fresh" : "stale",
      presenceClass: online
        ? (confirmed ? "online_confirmed" : "online_stale")
        : (confirmed ? "offline_confirmed" : "offline_stale"),
      effectiveStatus: confirmed ? (online ? "online" : "offline") : "unknown"
    };
  });

  const observers = heartbeatRows.map(r => ({
    deviceId: r.device_id,
    playerName: r.player_name,
    lastHeartbeatAt: r.received_at,
    heartbeatOccurredAt: r.occurred_at,
    active: ageMs(r.received_at) <= OBSERVER_HEARTBEAT_FRESH_MS,
    version: r.payload?.version || null,
    gameDetected: typeof r.payload?.gameDetected === "boolean" ? r.payload.gameDetected : null,
    currentCtaId: r.payload?.currentCtaId || null
  }));

  const onlineConfirmedCount = members.filter(m => m.presenceClass === "online_confirmed").length;
  const onlineStaleCount = members.filter(m => m.presenceClass === "online_stale").length;
  const offlineConfirmedCount = members.filter(m => m.presenceClass === "offline_confirmed").length;
  const offlineStaleCount = members.filter(m => m.presenceClass === "offline_stale").length;
  const recentStateCount = members.filter(m => m.stateFresh).length;

  let dataFreshAt = null;
  for (const m of members) {
    for (const value of [m.stateAt, m.lastEventAt]) {
      if (!value) continue;
      if (!dataFreshAt || new Date(value) > new Date(dataFreshAt)) dataFreshAt = value;
    }
  }

  return {
    onlineCount: onlineConfirmedCount,
    onlineKnownCount: members.filter(m => m.online).length,
    onlineConfirmedCount,
    onlineStaleCount,
    offlineConfirmedCount,
    offlineStaleCount,
    unconfirmedTrackedCount: onlineStaleCount + offlineStaleCount,
    totalTracked: members.length,
    recentStateCount,
    activeObserverCount: observers.filter(o => o.active).length,
    totalObserverCount: observers.length,
    stateFreshSeconds: Math.round(GUILD_STATE_FRESH_MS / 1000),
    observerFreshSeconds: Math.round(OBSERVER_HEARTBEAT_FRESH_MS / 1000),
    generatedAt: dataFreshAt,
    dataFreshAt,
    observers,
    members
  };
}

async function getGuildPresenceProbeDiagnostics({ minutes = 30, limit = 200, player = "" } = {}) {
  const safeMinutes = Math.max(1, Math.min(24 * 60, Number(minutes) || 30));
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const safePlayer = String(player || "").trim().slice(0, 120) || null;

  const { rows } = await pool.query(`
    SELECT event_id, device_id, player_name, payload, occurred_at, received_at
      FROM albion_telemetry_events
     WHERE type='guild_presence_probe'
       AND occurred_at >= now() - ($1::text || ' minutes')::interval
       AND (
         $3::text IS NULL
         OR lower(COALESCE(payload->'parameters'->>'1', '')) = lower($3)
       )
     ORDER BY occurred_at DESC
     LIMIT $2
  `, [safeMinutes, safeLimit, safePlayer]);

  const byEvent = new Map();
  for (const row of rows) {
    const payload = row.payload || {};
    const eventName = String(payload.eventName || "unknown");
    if (!byEvent.has(eventName)) {
      byEvent.set(eventName, {
        eventName,
        eventCode: payload.eventCode ?? null,
        count: 0,
        parameterKeys: {}
      });
    }

    const group = byEvent.get(eventName);
    group.count++;
    const parameters = payload.parameters && typeof payload.parameters === "object"
      ? payload.parameters
      : {};

    for (const [key, value] of Object.entries(parameters)) {
      if (!group.parameterKeys[key]) {
        group.parameterKeys[key] = { types: [], sample: previewValue(value) };
      }
      const shape = jsonShape(value);
      if (!group.parameterKeys[key].types.includes(shape)) {
        group.parameterKeys[key].types.push(shape);
      }
    }
  }

  const heartbeatRows = await pool.query(`
    WITH ranked AS (
      SELECT device_id, player_name, payload, occurred_at, received_at,
             ROW_NUMBER() OVER (
               PARTITION BY device_id
               ORDER BY received_at DESC, occurred_at DESC
             ) AS rn
        FROM albion_telemetry_events
       WHERE type='client_heartbeat'
    )
    SELECT device_id, player_name, payload, occurred_at, received_at
      FROM ranked
     WHERE rn=1
     ORDER BY received_at DESC
  `).then(r => r.rows);

  const now = Date.now();
  const heartbeatDevices = heartbeatRows.map(row => {
    const received = row.received_at ? new Date(row.received_at).getTime() : 0;
    return {
      deviceId: row.device_id,
      playerName: row.player_name,
      receivedAt: row.received_at,
      occurredAt: row.occurred_at,
      active: received > 0 && now - received <= OBSERVER_HEARTBEAT_FRESH_MS,
      version: row.payload?.version || null,
      gameDetected: typeof row.payload?.gameDetected === "boolean" ? row.payload.gameDetected : null,
      currentCtaId: row.payload?.currentCtaId || null
    };
  });

  let currentPresence = null;
  if (safePlayer) {
    const current = await pool.query(`
      SELECT player_name, player_id, online, last_seen_at, state_at, last_event_at, observer_device
        FROM albion_guild_presence
       WHERE player_key=$1
       LIMIT 1
    `, [normName(safePlayer)]).then(r => r.rows[0] || null);
    if (current) {
      const hb = heartbeatDevices.find(x => x.deviceId === current.observer_device) || null;
      currentPresence = {
        playerName: current.player_name,
        playerId: current.player_id,
        online: !!current.online,
        lastSeenAt: current.last_seen_at,
        stateAt: current.state_at,
        lastEventAt: current.last_event_at,
        observerDevice: current.observer_device,
        observerHeartbeat: hb
      };
    }
  }

  const recentLimit = safePlayer ? safeLimit : Math.min(50, safeLimit);
  return {
    windowMinutes: safeMinutes,
    player: safePlayer,
    total: rows.length,
    heartbeat: {
      activeWithinSeconds: Math.round(OBSERVER_HEARTBEAT_FRESH_MS / 1000),
      totalDevices: heartbeatDevices.length,
      activeDevices: heartbeatDevices.filter(x => x.active).length,
      devices: heartbeatDevices
    },
    currentPresence,
    events: [...byEvent.values()].sort((a, b) => b.count - a.count),
    recent: rows.slice(0, recentLimit).map(row => ({
      eventId: row.event_id,
      deviceId: row.device_id,
      observer: row.player_name,
      eventName: row.payload?.eventName || null,
      eventCode: row.payload?.eventCode ?? null,
      parameters: row.payload?.parameters || {},
      occurredAt: row.occurred_at,
      receivedAt: row.received_at
    }))
  };
}

function installRoutes(app, { db, requireMember, requireEditor, requireDeviceManager }) {
  if (!pool) throw new Error("telemetry.initSchema(pool) deve rodar antes de installRoutes");

  app.post("/api/telemetry/pairing/create", async (req, res) => {
    try {
      const sess = requireDeviceManager ? requireDeviceManager(req, res) : null;
      if (!sess) return;

      const body = req.body || {};
      const label = String(body.label || "").trim().slice(0, 120) || null;
      const playerName = String(body.playerName || "").trim().slice(0, 120) || null;
      const code = String(crypto.randomInt(100000, 1000000));
      const hash = tokenHash("pair:" + code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.query(
        `INSERT INTO albion_telemetry_pairing_codes(code_hash, label, player_name, created_by, expires_at)
         VALUES($1,$2,$3,$4,$5)`,
        [hash, label, playerName, String(sess.id || ""), expiresAt]
      );

      res.json({ ok: true, code, expiresAt: expiresAt.toISOString(), label, playerName });
    } catch (e) {
      console.error("/api/telemetry/pairing/create:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.post("/api/telemetry/pair", async (req, res) => {
    try {
      const body = req.body || {};
      const code = String(body.code || "").trim();
      const deviceId = String(body.deviceId || "").trim();
      const playerName = String(body.playerName || "").trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "code" });
      if (!deviceId) return res.status(400).json({ error: "device_id" });

      const hash = tokenHash("pair:" + code);
      const { rows } = await pool.query(
        `SELECT * FROM albion_telemetry_pairing_codes
          WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()
          LIMIT 1`,
        [hash]
      );
      const pairing = rows[0];
      if (!pairing) return res.status(401).json({ error: "invalid_or_expired_code" });

      const token = createAgentToken();
      const agentHash = tokenHash(token);
      const boundPlayer = playerName || pairing.player_name || null;
      const label = pairing.label || (boundPlayer ? boundPlayer + "-PC" : deviceId);

      await pool.query("BEGIN");
      try {
        await pool.query(
          `INSERT INTO albion_telemetry_agent_tokens(token_hash, label, device_id, player_name, last_seen)
           VALUES($1,$2,$3,$4,now())`,
          [agentHash, label, deviceId, boundPlayer]
        );
        await pool.query(
          `UPDATE albion_telemetry_pairing_codes SET used_at=now() WHERE code_hash=$1`,
          [hash]
        );
        await pool.query("COMMIT");
      } catch (e) {
        await pool.query("ROLLBACK");
        throw e;
      }

      res.json({ ok: true, token, label, deviceId, playerName: boundPlayer });
    } catch (e) {
      console.error("/api/telemetry/pair:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/agents", async (req, res) => {
    try {
      const sess = requireDeviceManager ? requireDeviceManager(req, res) : null;
      if (!sess) return;
      const { rows } = await pool.query(
        `SELECT token_hash, label, device_id, player_name, created_at, last_seen, revoked_at
           FROM albion_telemetry_agent_tokens
          ORDER BY created_at DESC
          LIMIT 200`
      );
      res.json(rows.map(r => ({
        id: r.token_hash,
        label: r.label,
        deviceId: r.device_id,
        playerName: r.player_name,
        createdAt: r.created_at,
        lastSeen: r.last_seen,
        revokedAt: r.revoked_at
      })));
    } catch (e) {
      console.error("/api/telemetry/agents:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.post("/api/telemetry/agents/revoke-id", async (req, res) => {
    try {
      const sess = requireDeviceManager ? requireDeviceManager(req, res) : null;
      if (!sess) return;
      const id = String((req.body || {}).id || "").trim();
      if (!/^[a-f0-9]{64}$/i.test(id)) return res.status(400).json({ error: "id" });
      await pool.query(
        `UPDATE albion_telemetry_agent_tokens SET revoked_at=now() WHERE token_hash=$1`,
        [id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("/api/telemetry/agents/revoke-id:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.post("/api/telemetry/agents/create", async (req, res) => {
    try {
      const master = process.env.TELEMETRY_INGEST_KEY || "";
      if (!master || !safeSecretEqual(bearer(req), master)) return res.status(401).json({ error: "unauthorized" });

      const body = req.body || {};
      const label = String(body.label || "").trim().slice(0, 120) || null;
      const playerName = String(body.playerName || "").trim().slice(0, 120) || null;
      const token = createAgentToken();
      const hash = tokenHash(token);

      await pool.query(
        `INSERT INTO albion_telemetry_agent_tokens(token_hash, label, player_name)
         VALUES($1,$2,$3)`,
        [hash, label, playerName]
      );

      res.json({ ok: true, token, label, playerName });
    } catch (e) {
      console.error("/api/telemetry/agents/create:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.post("/api/telemetry/agents/revoke", async (req, res) => {
    try {
      const master = process.env.TELEMETRY_INGEST_KEY || "";
      if (!master || !safeSecretEqual(bearer(req), master)) return res.status(401).json({ error: "unauthorized" });
      const token = String((req.body || {}).token || "").trim();
      if (!token) return res.status(400).json({ error: "token" });
      await pool.query(
        `UPDATE albion_telemetry_agent_tokens SET revoked_at=now() WHERE token_hash=$1`,
        [tokenHash(token)]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("/api/telemetry/agents/revoke:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/context", async (req, res) => {
    try {
      const deviceId = String(req.query.deviceId || "").trim();
      const requestedPlayer = String(req.query.playerName || "").trim();
      const auth = await authenticateTelemetry(req, { deviceId, playerName: requestedPlayer, allowMaster: true });
      if (!auth) return res.status(401).json({ error: "unauthorized" });

      const playerName = requestedPlayer || String(auth.agent?.player_name || "").trim();

      // O vínculo do client segue a FILA dos CTAs, não proximidade de horário e
      // não a inscrição individual do observer. Se 15:20 continua aberto, nenhum
      // client pode saltar para 17:20. Ao finalizar 15:20, 17:20 vira o primeiro.
      const cta = await resolveEarliestOpenCta();

      res.json({
        ok: true,
        playerName: playerName || null,
        cta: cta ? { id: String(cta.id), time: cta.time_label, status: cta.status } : null,
      });
    } catch (e) {
      console.error("/api/telemetry/context:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.post("/api/telemetry/ingest", async (req, res) => {
    try {
      const body = req.body || {};
      const device = body.device || {};
      const deviceId = String(device.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ error: "device_id" });

      const detectedPlayer = String(device.playerName || "").trim();
      const auth = await authenticateTelemetry(req, { deviceId, playerName: detectedPlayer, allowMaster: true });
      if (!auth) return res.status(401).json({ error: "unauthorized" });

      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length || events.length > 500) return res.status(400).json({ error: "events" });

      // O CTA informado pelo client e apenas uma dica. O servidor revalida o contexto
      // para impedir que um currentCtaId antigo "grude" todos os lotes no CTA mais recente.
      let clientCtaEventId = body.ctaEventId != null && String(body.ctaEventId).trim() !== ""
        ? String(body.ctaEventId).trim()
        : null;
      if (!clientCtaEventId) {
        const hbCta = events
          .map(e => (e.payload ?? e.Payload ?? {}))
          .map(p => p.currentCtaId)
          .find(v => v != null && String(v).trim() !== "");
        if (hbCta) clientCtaEventId = String(hbCta).trim();
      }

      // Regra autoritativa da fila:
      // TODA telemetria vai para o CTA aberto mais antigo/mais cedo.
      // Party, jogador, relógio do client ou currentCtaId NÃO podem saltar um CTA
      // ainda aberto. Finalizou/cancelou o atual -> o próximo aberto assume.
      const active = await resolveEarliestOpenCta();

      // A dica do client só é usada se não existir nenhum CTA aberto no servidor.
      let ctaEventId = active ? String(active.id) : clientCtaEventId;
      if (ctaEventId) {
        const ev = await db.getEvent(ctaEventId).catch(() => null);
        if (!ev || ev.status !== "open") ctaEventId = null;
      }

      // O roster só é carregado quando o lote contém uma morte candidata a Kill Fame.
      // Assim, mortes puramente inimigas são descartadas antes da fila/API sem custo
      // permanente para batches que não carregam DiedEvent letal.
      const hasFameCandidates = events.some(e => {
        const type = String(e?.type || e?.Type || "").trim();
        const payload = e?.payload ?? e?.Payload ?? {};
        return type === "player_death_observed" &&
          payload?.isLethal !== false &&
          payload?.killer &&
          payload?.victim;
      });
      let fameRosterKeys = new Set();
      if (ctaEventId && hasFameCandidates) {
        const roster = await db.getSignups(ctaEventId).catch(() => []);
        fameRosterKeys = new Set((roster || []).map(row => normName(row?.username)).filter(Boolean));
      }

      await pool.query(`
        INSERT INTO albion_telemetry_devices(device_id, player_name, version)
        VALUES($1,$2,$3)
        ON CONFLICT(device_id) DO UPDATE SET player_name=EXCLUDED.player_name, version=EXCLUDED.version, last_seen=now()
      `, [deviceId, device.playerName || null, device.version || null]);

      let inserted = 0, duplicate = 0;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const presenceProbes = [];
          const zoneChanges = [];
          const fameEnrichmentQueue = [];
          for (const e of events) {
            const eventId = String(e.eventId || e.EventId || "").trim();
            const type = String(e.type || e.Type || "").trim();
            const occurredAt = e.occurredAt || e.OccurredAt || new Date().toISOString();
            const playerName = e.playerName ?? e.PlayerName ?? null;
            const payload = e.payload ?? e.Payload ?? {};
            if (!eventId || !type) continue;
            const q = await client.query(`
              INSERT INTO albion_telemetry_events(event_id, cta_event_id, device_id, type, occurred_at, player_name, payload)
              VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
              ON CONFLICT(event_id) DO NOTHING
            `, [eventId, ctaEventId, deviceId, type, occurredAt, playerName, JSON.stringify(payload || {})]);
            if (q.rowCount) {
              inserted++;
              if (type === "guild_presence_probe") {
                presenceProbes.push({ payload, deviceId, occurredAt });
              }
              if (type === "zone_change") {
                zoneChanges.push({
                  ctaEventId,
                  deviceId,
                  playerName: playerName || device.playerName || null,
                  payload,
                  occurredAt
                });
              }
              if (
                type === "player_death_observed" &&
                payload?.isLethal !== false &&
                payload?.killer &&
                payload?.victim &&
                shouldEnrichKillFame(payload, fameRosterKeys)
              ) {
                fameEnrichmentQueue.push({ eventId, payload, occurredAt });
              }
            } else {
              duplicate++;
            }
          }

          // Dois observers podem receber o mesmo burst de GuildPlayerUpdated em ordens
          // diferentes. Ordenar as chaves antes dos UPSERTs garante a mesma ordem de locks
          // entre transacoes concorrentes e evita o ciclo de deadlock visto em producao.
          presenceProbes.sort((a, b) => {
            const aName = normName(a.payload?.parameters?.["1"]);
            const bName = normName(b.payload?.parameters?.["1"]);
            return aName.localeCompare(bName);
          });
          for (const probe of presenceProbes) {
            await applyGuildPresenceProbe({ ...probe, dbClient: client });
          }

          await client.query("COMMIT");

          if (zoneChangeHandler && zoneChanges.length) {
            for (const change of zoneChanges) {
              Promise.resolve(zoneChangeHandler(change)).catch((e) =>
                console.error("zone_change handler:", e)
              );
            }
          }
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        }
      } finally {
        client.release();
      }

      if (ctaEventId) notifyTelemetry(ctaEventId, { inserted, deviceId });
      res.json({ ok: true, inserted, duplicate, ctaEventId });

      if (fameEnrichmentQueue?.length) {
        const timer = setTimeout(() => {
          for (const item of fameEnrichmentQueue) {
            killFame.queueEnrichment({
              pool,
              eventId: item.eventId,
              payload: item.payload,
              occurredAt: item.occurredAt,
              onResolved: (resolvedCtaId) => {
                invalidateCombatCache(resolvedCtaId);
                notifyTelemetry(resolvedCtaId, { kind: "kill_fame_resolved" });
              }
            });
          }
        }, 0);
        timer.unref?.();
      }
    } catch (e) {
      console.error("/api/telemetry/ingest:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/guild-presence", async (req, res) => {
    try {
      if (!requireMember || !requireMember(req, res)) return;
      res.json(await getGuildPresence());
    } catch (e) {
      console.error("/api/telemetry/guild-presence:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/guild-presence-probes", async (req, res) => {
    try {
      if (!requireEditor || !requireEditor(req, res)) return;
      const data = await getGuildPresenceProbeDiagnostics({
        minutes: req.query.minutes,
        limit: req.query.limit,
        player: req.query.player
      });
      res.json(data);
    } catch (e) {
      console.error("/api/telemetry/guild-presence-probes:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/confirm", async (req, res) => {
    if (!requireMember(req, res)) return;
    const id = String(req.query.event || "");
    let cached = _confirmCache.get(id);
    if (!cached || (Date.now() - cached.at) >= CONFIRM_TTL_MS) {
      const fresh = await getConfirm(db, id).catch(e => { console.error("telemetry confirm:", e); return null; });
      cached = fresh ? { at: Date.now(), payload: fresh } : null;
      if (cached) _confirmCache.set(id, cached);
    }
    if (!cached) return res.status(404).json({ error: "event" });
    res.json(cached.payload);
  });

  app.get("/api/telemetry/loot-ctas", async (req, res) => {
    if (!requireMember(req, res)) return;
    try {
      const { rows } = await pool.query(`
        SELECT e.id, e.time_label, e.status, e.created_at,
               COALESCE(e.closed_at, e.created_at) AS closed_at,
               COALESCE(
                 e.remind_30 + interval '30 minutes',
                 e.remind_10 + interval '10 minutes',
                 MIN(t.occurred_at),
                 e.created_at
               ) AS cta_at,
               COUNT(t.event_id)::int AS loot_events
          FROM cta_events e
          LEFT JOIN albion_telemetry_events t
            ON t.cta_event_id=e.id AND t.type='loot'
         WHERE (
           e.status='open'
           OR (
             e.status='closed'
             AND COALESCE(e.closed_at, e.created_at) >= now() - interval '3 days'
           )
         )
         GROUP BY e.id
         ORDER BY CASE WHEN e.status='open' THEN 0 ELSE 1 END,
                  COALESCE(e.closed_at, e.created_at) DESC
         LIMIT 100
      `);
      res.json(rows.map(r => ({
        id: String(r.id),
        time: r.time_label,
        status: r.status,
        createdAt: r.created_at,
        closedAt: r.closed_at,
        ctaAt: r.cta_at,
        lootEvents: Number(r.loot_events || 0),
        lootEventsRaw: Number(r.loot_events || 0)
      })));
    } catch (e) {
      console.error("/api/telemetry/loot-ctas:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/loot", async (req, res) => {
    if (!requireMember(req, res)) return;
    const id = String(req.query.event || "");
    res.json(await getLoot(db, id).catch(e => { console.error("telemetry loot:", e); return { error: "server" }; }));
  });

  app.get("/api/telemetry/combat-ctas", async (req, res) => {
    if (!requireMember(req, res)) return;
    try {
      const { rows } = await pool.query(`
        SELECT e.id, e.time_label, e.status, e.created_at,
               COALESCE(e.closed_at, e.created_at) AS closed_at,
               COALESCE(
                 e.remind_30 + interval '30 minutes',
                 e.remind_10 + interval '10 minutes',
                 MIN(t.occurred_at),
                 e.created_at
               ) AS cta_at,
               COUNT(t.event_id)::int AS combat_events
          FROM cta_events e
          LEFT JOIN albion_telemetry_events t
            ON t.cta_event_id=e.id
           AND t.type IN ('combat_delta','death','kill','knockout','knocked_out','combat_result','player_death_observed')
         WHERE (
           e.status='open'
           OR (
             e.status='closed'
             AND COALESCE(e.closed_at, e.created_at) >= now() - interval '3 days'
           )
         )
         GROUP BY e.id
         ORDER BY CASE WHEN e.status='open' THEN 0 ELSE 1 END,
                  COALESCE(e.closed_at, e.created_at) DESC
         LIMIT 100
      `);
      res.json(rows.map(r => ({
        id: String(r.id),
        time: r.time_label,
        status: r.status,
        createdAt: r.created_at,
        closedAt: r.closed_at,
        ctaAt: r.cta_at,
        combatEvents: Number(r.combat_events || 0)
      })));
    } catch (e) {
      console.error("/api/telemetry/combat-ctas:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/combat", async (req, res) => {
    if (!requireMember(req, res)) return;
    const id = String(req.query.event || "");
    res.json(await getCombatCached(db, id).catch(e => { console.error("telemetry combat:", e); return { error: "server" }; }));
  });

  app.get("/api/navigation/zones", async (req, res) => {
    if (!requireMember(req, res)) return;
    try {
      const q = String(req.query.q || "").trim();
      const blackOnly = String(req.query.blackOnly || "1") !== "0";
      res.json({
        zones: navigation.searchZones(q, { limit: 25, blackOnly }),
        graph: navigation.stats(),
      });
    } catch (e) {
      console.error("/api/navigation/zones:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/navigation/state", async (req, res) => {
    if (!requireMember(req, res)) return;
    try {
      const id = String(req.query.event || "").trim();
      const state = await getNavigationState(db, id || null);
      if (!state) return res.status(404).json({ error: "navigation" });
      res.json(state);
    } catch (e) {
      console.error("/api/navigation/state:", e);
      res.status(500).json({ error: "server" });
    }
  });

  app.get("/api/telemetry/devices", async (req, res) => {
    if (!requireMember(req, res)) return;
    const { rows } = await pool.query(`SELECT device_id, player_name, version, first_seen, last_seen FROM albion_telemetry_devices ORDER BY last_seen DESC LIMIT 100`);
    res.json(rows);
  });

  app.get("/api/telemetry/stream", (req, res) => {
    if (!requireMember(req, res)) return;
    const id = String(req.query.event || "");
    if (!id) return res.status(400).end();
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    });
    res.socket?.setKeepAlive?.(true);
    if (res.flushHeaders) res.flushHeaders();
    if (!telemetryStreams.has(id)) telemetryStreams.set(id, new Set());
    telemetryStreams.get(id).add(res);
    res.write(`data: ${JSON.stringify({ kind: "ready", eventId: id })}\n\n`);
    const ping = setInterval(() => { try { res.write(":\n\n"); } catch (_) {} }, 25000);
    req.on("close", () => { clearInterval(ping); const set = telemetryStreams.get(id); if (set) set.delete(res); });
  });
}

module.exports = {
  initSchema,
  installRoutes,
  notifyTelemetry,
  setZoneChangeHandler,
  getNavigationState,
  getConfirm,
  getPlayerEquipment,
  getLoot,
  getCombat,
  getPresenceSnapshotRows,
  getPresenceArea,
  getGuildPresence,
  __test: {
    presenceForcesForWindow,
    presenceAreaSummary,
    getCombatCached,
    resetCombatCache,
    invalidateCombatCache,
    combatCacheTtl,
    shouldEnrichKillFame,
    isImortaisFamilyGuildName
  },
  getGuildPresenceProbeDiagnostics
};
