// ============================================================================
// IMORTAIS TELEMETRY — bridge entre o Combat Client e o CTA War Room
// ============================================================================
const crypto = require("crypto");

const telemetryStreams = new Map(); // eventId -> Set(res)
let pool = null;

function normName(v) {
  return String(v || "").trim().toLowerCase();
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
  const name = String(playerName || "").trim();
  if (!name) return null;
  const { rows } = await pool.query(
    `SELECT e.id, e.time_label, e.status, e.created_at
       FROM cta_events e
       JOIN cta_signups s ON s.event_id=e.id
      WHERE e.status='open'
        AND lower(s.username)=lower($1)
      ORDER BY e.created_at DESC
      LIMIT 1`,
    [name]
  );
  return rows[0] || null;
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

async function latestPartyMembers(eventId, maxAgeSeconds = 120) {
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT device_id, payload, occurred_at,
             ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY occurred_at DESC) AS rn
      FROM albion_telemetry_events
      WHERE cta_event_id=$1 AND type='party_snapshot'
        AND occurred_at >= now() - ($2::text || ' seconds')::interval
    )
    SELECT device_id, payload, occurred_at FROM ranked WHERE rn=1
  `, [eventId, maxAgeSeconds]);

  const members = new Map();
  for (const row of rows) {
    const arr = row.payload && Array.isArray(row.payload.members) ? row.payload.members : [];
    for (const name of arr) {
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
  const party = await latestPartyMembers(eventId);

  const signupByName = new Map();
  const pts = new Map();
  let confirmado = 0, faltando = 0;

  for (const s of signups) {
    const key = normName(s.username);
    if (key) signupByName.set(key, s);
    const display = s.party_index == null ? "Reserva" : `PT ${displayByRaw.get(Number(s.party_index)) || (Number(s.party_index) + 1)}`;
    if (!pts.has(display)) pts.set(display, []);
    const seen = key && party.members.has(key);
    if (seen) confirmado++; else faltando++;
    pts.get(display).push({
      n: s.username,
      arma: s.weapon,
      st: seen ? "ok" : "miss",
      obs: seen ? `detectado por ${party.members.get(key).devices.length} agente(s)` : "na planilha, não detectado na party",
    });
  }

  const extras = [];
  for (const [key, m] of party.members.entries()) {
    if (!signupByName.has(key)) {
      extras.push({ n: m.name, arma: "—", st: "extra", obs: `no jogo, fora da planilha · ${m.devices.length} agente(s)` });
    }
  }
  if (extras.length) pts.set("Não escalados", extras);

  return {
    resumo: { confirmado, faltando, extra: extras.length, divergencia: 0 },
    pts: [...pts.entries()].map(([pt, linhas]) => ({ pt, linhas })),
    meta: {
      partySnapshots: party.snapshots.length,
      partyPlayers: party.members.size,
      note: "Comparação de presença ativa. Divergência de arma exige telemetria de equipamento, ainda não enviada pelo client v0.3."
    }
  };
}

async function getLoot(eventId) {
  const { rows } = await pool.query(`
    SELECT event_id, occurred_at, player_name, payload
    FROM albion_telemetry_events
    WHERE cta_event_id=$1 AND type='loot'
    ORDER BY occurred_at DESC
    LIMIT 5000
  `, [eventId]);

  let capturado = 0;
  const byPlayer = new Map();
  const itens = [];
  for (const r of rows) {
    const p = r.payload || {};
    const value = num(p.estimatedValue) * Math.max(1, num(p.quantity, 1));
    capturado += value;
    const name = String(p.lootedBy || r.player_name || "?");
    byPlayer.set(name, (byPlayer.get(name) || 0) + value);
    if (itens.length < 100) {
      itens.push({
        jog: name,
        item: String(p.item || "?"),
        qtd: Math.max(1, num(p.quantity, 1)),
        origem: String(p.lootedFrom || p.cluster || ""),
        v: value,
        st: "capturado",
        at: r.occurred_at,
      });
    }
  }

  const top = [...byPlayer.entries()].map(([n, v]) => ({ n, v })).sort((a, b) => b.v - a.v).slice(0, 20);
  return {
    resumo: { capturado, entregue: null, pendente: null, divergencias: null },
    top,
    itens,
    meta: {
      totalEventos: rows.length,
      comparatorReady: false,
      note: "O client v0.3 envia loot capturado. Entrega em baú ainda precisa de um hook específico do Loot Comparator."
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
    meta: { totalEventos: rows.length, note: "Fight segmentation ainda não é enviada pelo client v0.3; o total de fights fica indisponível por enquanto." }
  };
}

function installRoutes(app, { db, requireMember }) {
  if (!pool) throw new Error("telemetry.initSchema(pool) deve rodar antes de installRoutes");

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
      const cta = await resolveActiveCtaForPlayer(playerName);
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
        const active = await resolveActiveCtaForPlayer(detectedPlayer);
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
          if (q.rowCount) inserted++; else duplicate++;
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

  app.get("/api/telemetry/confirm", async (req, res) => {
    if (!requireMember(req, res)) return;
    const id = String(req.query.event || "");
    const data = await getConfirm(db, id).catch(e => { console.error("telemetry confirm:", e); return null; });
    if (!data) return res.status(404).json({ error: "event" });
    res.json(data);
  });

  app.get("/api/telemetry/loot", async (req, res) => {
    if (!requireMember(req, res)) return;
    const id = String(req.query.event || "");
    res.json(await getLoot(id).catch(e => { console.error("telemetry loot:", e); return { error: "server" }; }));
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

module.exports = { initSchema, installRoutes, notifyTelemetry, getConfirm, getLoot, getCombat };
