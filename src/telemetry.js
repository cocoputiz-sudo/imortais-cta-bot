// ============================================================================
// IMORTAIS TELEMETRY — bridge entre o Combat Client e o CTA War Room
// ============================================================================
const crypto = require("crypto");

const telemetryStreams = new Map(); // eventId -> Set(res)
let pool = null;
const _confirmCache = new Map(); // eventId -> { at, payload }
const CONFIRM_TTL_MS = 2000;
const GUILD_STATE_FRESH_MS = Math.max(60_000, Number(process.env.GUILD_STATE_FRESH_MS) || 10 * 60 * 1000);
const OBSERVER_HEARTBEAT_FRESH_MS = Math.max(30_000, Number(process.env.OBSERVER_HEARTBEAT_FRESH_MS) || 60 * 1000);

function normName(v) {
  return String(v || "")
    .trim()
    .replace(/^[!\s]+/, "")
    .replace(/^\[[^\]]{1,16}\]\s*/i, "")
    .trim()
    .toLowerCase();
}

function normGuild(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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

async function resolveActiveCtaForPlayer(playerName) {
  const key = normName(playerName);
  if (!key) return null;

  const { rows } = await pool.query(
    `SELECT e.id, e.time_label, e.status, e.created_at, s.username
       FROM cta_events e
       JOIN cta_signups s ON s.event_id=e.id
      WHERE e.status='open'
      ORDER BY e.created_at DESC`
  );

  for (const row of rows) {
    if (normName(row.username) === key) return row;
  }
  return null;
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
      WHERE e.status='open'
      ORDER BY e.created_at DESC`
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
    .sort((a, b) => b.overlap - a.overlap || new Date(b.created_at) - new Date(a.created_at))[0] || null;
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

async function getConfirm(db, eventId) {
  const ev = await db.getEvent(eventId).catch(() => null);
  if (!ev) return null;

  const signups = await db.getSignups(eventId);
  const pl = db.parsePartyList(ev);
  const displayByRaw = new Map(pl.map((raw, idx) => [Number(raw), idx + 1]));

  // ----- Parties reais vistas pelos Combat Clients -----
  const party = await latestPartyMembers(eventId);
  const snapshotRows = party.snapshots || [];

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

async function getLoot(db, eventId) {
  const { rows } = await pool.query(`
    SELECT event_id, device_id, occurred_at, player_name, payload
    FROM albion_telemetry_events
    WHERE cta_event_id=$1 AND type='loot'
    ORDER BY occurred_at DESC
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

  let capturado = 0;
  let ignorados = 0;
  let legacyConsiderados = 0;
  let guildConsiderados = 0;
  const byPlayer = new Map();
  const itens = [];

  for (const r of rows) {
    const p = r.payload || {};
    const rawName = String(p.lootedBy || r.player_name || "?");
    const key = normName(rawName);
    const guild = String(p.lootedByGuild || p.guild || "").trim();

    let allowed = false;
    let displayName = rawName;
    let filterMode = "";

    if (guild) {
      const allowedGuilds = new Set(["imortais", "imortaisacademy", "imortais2"]);
      allowed = allowedGuilds.has(normGuild(guild));
      filterMode = "guild";
      if (allowed) guildConsiderados++;
    } else if (key && legacyAllowed.has(key)) {
      // Compatibilidade com telemetria anterior ao campo lootedByGuild.
      allowed = true;
      filterMode = "legacy_party";
      displayName = legacyAllowed.get(key) || rawName;
      legacyConsiderados++;
    }

    if (!allowed) {
      ignorados++;
      continue;
    }

    // AverageEstMarketValue enviado pelo Combat Client é VALOR UNITÁRIO.
    // O cálculo abaixo replica exatamente LootLoggerStats.RecordLoot do client.
    const unitValue = Math.max(0, num(p.estimatedValue));
    const quantity = Math.max(0, num(p.quantity, 0));
    const value = unitValue * quantity;

    capturado += value;
    byPlayer.set(displayName, (byPlayer.get(displayName) || 0) + value);

    if (itens.length < 100) {
      itens.push({
        jog: displayName,
        item: String(p.item || "?"),
        qtd: quantity,
        unit: unitValue,
        origem: String(p.lootedFrom || p.cluster || ""),
        guild: guild || null,
        filtro: filterMode,
        v: value,
        st: "capturado",
        at: r.occurred_at,
      });
    }
  }

  const top = [...byPlayer.entries()]
    .map(([n, v]) => ({ n, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 20);

  return {
    resumo: { capturado, entregue: null, pendente: null, divergencias: null },
    top,
    itens,
    meta: {
      totalEventos: rows.length,
      eventosConsiderados: rows.length - ignorados,
      eventosIgnorados: ignorados,
      guildConsiderados,
      legacyConsiderados,
      filtroAtivo: true,
      filtro: "guild_imortais_family",
      comparatorReady: false,
      note: legacyConsiderados > 0
        ? "Filtro ativo: guilds IMORTAIS, IMORTAIS ACADEMY e IMORTAIS 2 quando o client informa guild. Neste CTA há eventos antigos sem guild; neles o sistema usa como compatibilidade quem apareceu na formação/party do CTA."
        : "Filtro ativo: somente loot de jogadores cuja guild informada pelo Combat Client é IMORTAIS, IMORTAIS ACADEMY ou IMORTAIS 2. Entrega em baú ainda depende do Loot Comparator."
    }
  };
}

async function getCombat(db, eventId) {
  const { rows } = await pool.query(`
    SELECT type, player_name, payload, occurred_at
    FROM albion_telemetry_events
    WHERE cta_event_id=$1 AND type IN ('combat_delta','death','kill','knockout','knocked_out','combat_result')
    ORDER BY occurred_at ASC
  `, [eventId]);

  const signups = await db.getSignups(eventId).catch(() => []);
  const ev = await db.getEvent(eventId).catch(() => null);
  const pl = ev ? db.parsePartyList(ev) : [];
  const displayByRaw = new Map(pl.map((raw, idx) => [Number(raw), idx + 1]));
  const signupByName = new Map(signups.map(s => [normName(s.username), s]));
  const players = new Map();
  const ptAgg = new Map();
  let deaths = 0;

  function player(name) {
    const key = normName(name);
    if (!players.has(key)) players.set(key, { n: String(name || "?"), dmg: 0, heal: 0, mortes: 0 });
    return players.get(key);
  }
  function ptFor(name) {
    const s = signupByName.get(normName(name));
    if (!s || s.party_index == null) return "Sem PT";
    return `PT ${displayByRaw.get(Number(s.party_index)) || (Number(s.party_index) + 1)}`;
  }
  function pt(name) {
    if (!ptAgg.has(name)) ptAgg.set(name, { pt: name, dmg: 0, heal: 0, mortes: 0 });
    return ptAgg.get(name);
  }

  for (const r of rows) {
    const p = r.payload || {};
    if (r.type === "combat_delta") {
      const name = String(p.player || r.player_name || "?");
      const x = player(name), g = pt(ptFor(name));
      const dmg = num(p.damage), heal = num(p.healing);
      x.dmg += dmg; x.heal += heal; g.dmg += dmg; g.heal += heal;
    } else if (r.type === "death") {
      const name = String(p.victim || r.player_name || "?");
      player(name).mortes++; pt(ptFor(name)).mortes++; deaths++;
    }
  }

  const list = [...players.values()];
  return {
    resumo: {
      damage: list.reduce((a, x) => a + x.dmg, 0),
      healing: list.reduce((a, x) => a + x.heal, 0),
      mortes: deaths,
      fights: null,
    },
    porPt: [...ptAgg.values()].sort((a, b) => a.pt.localeCompare(b.pt, "pt-BR", { numeric: true })),
    topDmg: list.filter(x => x.dmg > 0).sort((a, b) => b.dmg - a.dmg).slice(0, 20).map(x => ({ n: x.n, v: x.dmg })),
    topHeal: list.filter(x => x.heal > 0).sort((a, b) => b.heal - a.heal).slice(0, 20).map(x => ({ n: x.n, v: x.heal })),
    meta: {
      totalEventos: rows.length,
      retentionDays: 3,
      note: "Ranking por CTA: dano, cura e mortes ficam disponíveis para conferência por 3 dias após o encerramento. Fight segmentation ainda não está disponível."
    }
  };
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

async function applyGuildPresenceProbe({ payload, deviceId, occurredAt }) {
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

  await pool.query(`
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
      let cta = await resolveActiveCtaForPlayer(playerName);
      if (!cta) cta = await resolveActiveCtaForDevice(deviceId);
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

      let ctaEventId = body.ctaEventId != null && String(body.ctaEventId).trim() !== "" ? String(body.ctaEventId).trim() : null;
      if (!ctaEventId) {
        let active = await resolveActiveCtaForPlayer(detectedPlayer);

        if (!active) {
          const partyEvent = events
            .filter(e => String(e.type || e.Type || "").trim() === "party_snapshot")
            .map(e => e.payload ?? e.Payload ?? {})
            .find(p => Array.isArray(p.members) && p.members.length);

          if (partyEvent) active = await resolveActiveCtaFromParty(partyEvent.members);
        }

        if (!active) active = await resolveActiveCtaForDevice(deviceId);
        ctaEventId = active ? String(active.id) : null;
      }
      if (ctaEventId) {
        const ev = await db.getEvent(ctaEventId).catch(() => null);
        if (!ev || ev.status !== "open") ctaEventId = null;
      }

      await pool.query(`
        INSERT INTO albion_telemetry_devices(device_id, player_name, version)
        VALUES($1,$2,$3)
        ON CONFLICT(device_id) DO UPDATE SET player_name=EXCLUDED.player_name, version=EXCLUDED.version, last_seen=now()
      `, [deviceId, device.playerName || null, device.version || null]);

      let inserted = 0, duplicate = 0;
      await pool.query("BEGIN");
      try {
        for (const e of events) {
          const eventId = String(e.eventId || e.EventId || "").trim();
          const type = String(e.type || e.Type || "").trim();
          const occurredAt = e.occurredAt || e.OccurredAt || new Date().toISOString();
          const playerName = e.playerName ?? e.PlayerName ?? null;
          const payload = e.payload ?? e.Payload ?? {};
          if (!eventId || !type) continue;
          const q = await pool.query(`
            INSERT INTO albion_telemetry_events(event_id, cta_event_id, device_id, type, occurred_at, player_name, payload)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
            ON CONFLICT(event_id) DO NOTHING
          `, [eventId, ctaEventId, deviceId, type, occurredAt, playerName, JSON.stringify(payload || {})]);
          if (q.rowCount) {
            inserted++;
            if (type === "guild_presence_probe") {
              await applyGuildPresenceProbe({ payload, deviceId, occurredAt });
            }
          } else {
            duplicate++;
          }
        }
        await pool.query("COMMIT");
      } catch (e) {
        await pool.query("ROLLBACK");
        throw e;
      }

      if (ctaEventId) notifyTelemetry(ctaEventId, { inserted, deviceId });
      res.json({ ok: true, inserted, duplicate, ctaEventId });
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
        lootEvents: Number(r.loot_events || 0)
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
               COUNT(t.event_id)::int AS combat_events
          FROM cta_events e
          LEFT JOIN albion_telemetry_events t
            ON t.cta_event_id=e.id
           AND t.type IN ('combat_delta','death','kill','knockout','knocked_out','combat_result')
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
    res.json(await getCombat(db, id).catch(e => { console.error("telemetry combat:", e); return { error: "server" }; }));
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

module.exports = { initSchema, installRoutes, notifyTelemetry, getConfirm, getLoot, getCombat, getGuildPresence, getGuildPresenceProbeDiagnostics };
