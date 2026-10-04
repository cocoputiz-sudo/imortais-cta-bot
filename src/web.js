// ============================================================================
// SITE / TELÃO AO VIVO — Fase 1 (somente leitura, público)
// Sobe um servidor web DENTRO do processo do bot, lendo o MESMO banco. Mostra a
// planilha do CTA ao vivo (as PTs, quem pingou em cada vaga, a reserva) e atualiza
// em tempo real via SSE toda vez que a planilha muda no Discord.
// Fases seguintes: login pelo Discord + arrastar-e-soltar que grava no banco e
// reflete na thread do Discord.
// ============================================================================
const express = require("express");
const db = require("./db");
const { PARTIES, WEAPONS } = require("./comps");
const crypto = require("crypto");
const telemetry = require("./telemetry");
const path = require("path");

// ---- config do login (OAuth2 Discord) ----
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID || "1541617852056862801";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const GUILD_ID      = process.env.GUILD_ID || "683411304408416285";
const REDIRECT      = process.env.OAUTH_REDIRECT || "https://cta-imortais.up.railway.app/auth/callback";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;
const CALLER_TAG_ID = process.env.CALLER_TAG_ID || null;
const BOMB_LEADER_ROLE_ID = process.env.BOMB_LEADER_ROLE_ID || null;
const SITE_ADMIN_IDS = new Set(String(process.env.SITE_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));

// Sessao stateless: cookie assinado (HMAC). Sobrevive a deploy/restart sem estado em memoria.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET nao definido: sessoes serao perdidas a cada deploy. Defina no Railway para mante-las.");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return body + "." + mac;
}
function verifySession(token) {
  if (!token || token.indexOf(".") < 0) return null;
  const i = token.lastIndexOf(".");
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data; try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (_) { return null; }
  if (!data || typeof data.exp !== "number" || Date.now() > data.exp) return null;
  return data;
}
const states = new Map();   // state -> timestamp (CSRF)
setInterval(() => { const now = Date.now(); for (const [st, t] of states) { if (now - t > 10 * 60 * 1000) states.delete(st); } }, 5 * 60 * 1000);

function parseCookies(req) {
  const h = req.headers.cookie || ""; const o = {};
  h.split(";").forEach(function (p) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function sessionOf(req) { const sid = parseCookies(req).sid; return sid ? verifySession(sid) : null; }
function requireMember(req, res) {
  const sess = sessionOf(req);
  if (!sess) { res.status(401).json({ error: "login" }); return null; }
  if (!sess.isMember) { res.status(403).json({ error: "not_member" }); return null; }
  return sess;
}
function requireEditor(req, res) {
  const sess = requireMember(req, res);
  if (!sess) return null;
  if (!sess.canEdit) { res.status(403).json({ error: "no_edit" }); return null; }
  return sess;
}
function canEditRoles(roles, userId) {
  const g = _client && _client.guilds && _client.guilds.cache.get(GUILD_ID);
  const isOwner = g && g.ownerId === userId;
  return !!(isOwner || (STAFF_ROLE_ID && roles.includes(STAFF_ROLE_ID)) || (CALLER_TAG_ID && roles.includes(CALLER_TAG_ID)));
}
function canManageDevices(roles, userId, name) {
  const g = _client && _client.guilds && _client.guilds.cache.get(GUILD_ID);
  const isOwner = g && g.ownerId === userId;
  const isAdminId = SITE_ADMIN_IDS.has(String(userId));
  const hasWarMasterRole = !!(STAFF_ROLE_ID && roles.includes(STAFF_ROLE_ID));
  return !!(isOwner || isAdminId || hasWarMasterRole);
}
function requireDeviceManager(req, res) {
  const sess = requireMember(req, res);
  if (!sess) return null;
  if (!sess.canManageDevices) { res.status(403).json({ error: "no_device_admin" }); return null; }
  return sess;
}
function isSiteAdmin(roles, userId, name) {
  const g = _client && _client.guilds && _client.guilds.cache.get(GUILD_ID);
  const isOwner = g && g.ownerId === userId;
  const isAdminId = SITE_ADMIN_IDS.has(String(userId));
  const isWarMaster = !!(STAFF_ROLE_ID && roles.includes(STAFF_ROLE_ID));
  return !!(isOwner || isAdminId || isWarMaster);
}
function canManageBomb(roles, userId, name) {
  return !!(isSiteAdmin(roles, userId, name) || (BOMB_LEADER_ROLE_ID && roles.includes(BOMB_LEADER_ROLE_ID)));
}
function canManageCastleRoaming(roles, userId, name) {
  return !!(
    isSiteAdmin(roles, userId, name) ||
    (BOMB_LEADER_ROLE_ID && roles.includes(BOMB_LEADER_ROLE_ID)) ||
    (CALLER_TAG_ID && roles.includes(CALLER_TAG_ID))
  );
}

let _client = null;
const streams = new Map(); // eventId(string) -> Set(res)

function plOf(ev) { try { return db.parsePartyList(ev); } catch { return [0]; } }

async function buildRosterData(ev) {
  const pl = plOf(ev);
  const signups = await db.getSignups(ev.id);
  const reallocationLocks = new Set(db.parseReallocationLocks(ev));
  let coreSet = new Set();
  try { const cr = await db.pool.query("SELECT user_id FROM players WHERE guild_id=$1 AND core_verified=true", [ev.guild_id]); coreSet = new Set(cr.rows.map((r) => String(r.user_id))); } catch (_) { /* players pode não existir */ }
  const bySlot = new Map();
  const reserves = [];
  for (const s of signups) {
    if (s.party_index != null) bySlot.set(`${s.party_index}:${s.slot_index}`, s);
    else reserves.push(s);
  }
  const parties = pl.map((p, idx) => {
    const party = PARTIES[p];
    const slots = [];
    let filled = 0;
    for (let i = 0; i < party.slots.length; i++) {
      const slot = party.slots[i];
      const su = bySlot.get(`${p}:${i}`);
      if (su) {
        filled++;
        slots.push({ n: i + 1, filled: true, role: slot.role, locked: !!slot.locked, weapon: su.weapon, username: su.username, presence: su.presence, manual: !!su.manual, userId: su.user_id, core: coreSet.has(String(su.user_id)), options: [...slot.accepts].sort((a, b) => a.weight - b.weight).map((a) => a.weapon) });
      } else {
        const options = [...slot.accepts].sort((a, b) => a.weight - b.weight).map((a) => a.weapon);
        slots.push({ n: i + 1, filled: false, role: slot.role, locked: !!slot.locked, options });
      }
    }
    return {
      display: idx + 1,
      rawParty: p,
      name: `Party ${idx + 1}`,
      filled,
      total: party.slots.length,
      reallocationLocked: reallocationLocks.has(p),
      slots
    };
  });
  return {
    event: { id: ev.id, time: ev.time_label, status: ev.status, reallocationLocks: [...reallocationLocks] },
    parties,
    reserves: reserves.map((r) => ({ username: r.username, weapon: r.weapon, userId: r.user_id, core: coreSet.has(String(r.user_id)) })),
  };
}

async function openEventsAll() {
  const out = [];
  if (!_client) return out;
  for (const g of _client.guilds.cache.values()) {
    const evs = await db.getOpenEvents(g.id).catch(() => []);
    for (const e of evs) out.push({ id: e.id, time: e.time_label });
  }
  return out;
}

async function notifyRosterChange(eventId) {
  const set = streams.get(String(eventId));
  if (!set || !set.size) return;
  const ev = await db.getEvent(eventId).catch(() => null);
  if (!ev) return;
  const payload = `data: ${JSON.stringify(await buildRosterData(ev))}\n\n`;
  for (const res of set) { try { res.write(payload); } catch { /* ignore */ } }
}

let _act = {};
function startWebServer(client, opts) {
  _client = client;
  _act = opts || {};
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  telemetry.installRoutes(app, { db, requireMember, requireEditor, requireDeviceManager });

  app.get("/api/health", async (_req, res) => {
    let database = false;
    try {
      await db.pool.query("SELECT 1");
      database = true;
    } catch (_) {}
    const discord = !!(_client && typeof _client.isReady === "function" && _client.isReady());
    const ok = database && discord;
    res.status(ok ? 200 : 503).json({ ok, database, discord, at: new Date().toISOString() });
  });

  app.get("/api/events", async (req, res) => {
    if (!requireMember(req, res)) return;
    res.json(await openEventsAll().catch(() => []));
  });

  app.get("/api/roster", async (req, res) => {
    if (!requireMember(req, res)) return;
    const ev = await db.getEvent(req.query.event).catch(() => null);
    if (!ev) return res.status(404).json({ error: "not found" });
    res.json(await buildRosterData(ev));
  });

  app.get("/api/stream", async (req, res) => {
    const sess = sessionOf(req);
    if (!sess) return res.status(401).end();
    if (!sess.isMember) return res.status(403).end();
    const id = String(req.query.event || "");
    if (!id) return res.status(400).end();
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (res.flushHeaders) res.flushHeaders();
    if (!streams.has(id)) streams.set(id, new Set());
    streams.get(id).add(res);
    const ev = await db.getEvent(id).catch(() => null);
    if (ev) res.write(`data: ${JSON.stringify(await buildRosterData(ev))}\n\n`);
    const ping = setInterval(() => { try { res.write(":\n\n"); } catch { /* ignore */ } }, 25000);
    req.on("close", () => { clearInterval(ping); const s = streams.get(id); if (s) s.delete(res); });
  });

  app.get("/auth/login", (_req, res) => {
    if (!CLIENT_SECRET) return res.status(503).send("Login ainda não configurado (falta DISCORD_CLIENT_SECRET no Railway).");
    const state = crypto.randomBytes(16).toString("hex");
    states.set(state, Date.now());
    const url = "https://discord.com/api/oauth2/authorize?" + new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code",
      scope: "identify guilds.members.read", state, prompt: "none",
    }).toString();
    res.redirect(url);
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state || !states.has(state)) return res.status(400).send("Login inválido. <a href='/'>Voltar</a>");
      states.delete(state);
      const tok = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
      }).then((r) => r.json());
      if (!tok || !tok.access_token) return res.status(401).send("Falha no login. <a href='/'>Voltar</a>");
      const auth = { Authorization: `Bearer ${tok.access_token}` };
      const me = await fetch("https://discord.com/api/users/@me", { headers: auth }).then((r) => r.json());
      const member = await fetch(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, { headers: auth })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const roles = (member && member.roles) || [];
      const name = me.global_name || me.username || "?";
      const sess = {
        id: me.id,
        name,
        canEdit: canEditRoles(roles, me.id),
        canManageDevices: canManageDevices(roles, me.id, name),
        canManageBomb: canManageBomb(roles, me.id, name),
        canManageCastleRoaming: canManageCastleRoaming(roles, me.id, name),
        isSiteAdmin: isSiteAdmin(roles, me.id, name),
        isMember: !!member,
        exp: Date.now() + SESSION_TTL_MS
      };
      const sid = signSession(sess);
      res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
      res.redirect("/");
    } catch (e) { console.error("oauth:", e); res.status(500).send("Erro no login. <a href='/'>Voltar</a>"); }
  });

  app.get("/auth/me", (req, res) => {
    const s = sessionOf(req);
    res.json(s ? {
      logged: true,
      name: s.name,
      canEdit: s.canEdit,
      canManageDevices: !!s.canManageDevices,
      canManageBomb: !!s.canManageBomb,
      canManageCastleRoaming: !!s.canManageCastleRoaming,
      isSiteAdmin: !!s.isSiteAdmin,
      member: !!s.isMember
    } : { logged: false });
  });

  app.get("/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/");
  });

  app.post("/api/move", async (req, res) => {
    const sess = sessionOf(req);
    if (!sess) return res.status(401).json({ error: "login" });
    if (!sess.isMember) return res.status(403).json({ error: "not_member" });
    if (!sess.canEdit) return res.status(403).json({ error: "no_edit" });
    try {
      const { event, userId, party, slot } = req.body || {};
      const ev = await db.getEvent(event).catch(() => null);
      if (!ev) return res.status(404).json({ error: "event" });
      const pl = plOf(ev);
      const rawTo = pl[Number(party) - 1];
      const slotIndex = Number(slot) - 1;
      if (rawTo == null || !PARTIES[rawTo]) return res.status(400).json({ error: "party" });
      const targetSlot = PARTIES[rawTo].slots[slotIndex];
      if (!targetSlot || targetSlot.locked) return res.status(400).json({ error: "slot" });
      const signups = await db.getSignups(ev.id);
      const A = signups.find((x) => String(x.user_id) === String(userId));
      if (!A) return res.status(404).json({ error: "user" });
      const B = signups.find((x) => x.party_index === rawTo && x.slot_index === slotIndex && String(x.user_id) !== String(userId));
      if (B) {
        if (A.party_index != null) {
          // troca: B vai pra vaga antiga do A
          await db.pool.query("UPDATE cta_signups SET party_index=$3, slot_index=$4, manual=true WHERE event_id=$1 AND user_id=$2", [ev.id, B.user_id, A.party_index, A.slot_index]);
        } else {
          // A vinha da reserva: B volta pra reserva (o motor reencaixa)
          await db.pool.query("UPDATE cta_signups SET party_index=NULL, slot_index=NULL, manual=false WHERE event_id=$1 AND user_id=$2", [ev.id, B.user_id]);
        }
      }
      await db.pool.query("UPDATE cta_signups SET party_index=$3, slot_index=$4, manual=true WHERE event_id=$1 AND user_id=$2", [ev.id, A.user_id, rawTo, slotIndex]);
      if (_act.applyEdit) await _act.applyEdit(ev.id);
      res.json({ ok: true });
    } catch (e) { console.error("/api/move:", e); res.status(500).json({ error: "server" }); }
  });

  app.get("/api/caller", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const times = (_act.presetTimes && _act.presetTimes()) || [];
    const open = await openEventsAll().catch(() => []);
    res.json({ presetTimes: times, open });
  });
  app.post("/api/cta/open", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const body = req.body || {};
    const time = String(body.time || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: "time" });

    const brief = {
      useDeparture: !!body.useDeparture,
      departure: String(body.departure || "").trim().slice(0, 120),
      useGear: !!body.useGear,
      gearTier: String(body.gearTier || "T8").trim().slice(0, 16),
      gearCount: Math.max(1, Math.min(9, Number(body.gearCount) || 2)),
    };
    if (brief.useDeparture && !brief.departure) return res.status(400).json({ error: "Informe o local de saída." });
    if (brief.useGear && !brief.gearTier) return res.status(400).json({ error: "Informe o tier do gear." });

    res.json(_act.openCTA
      ? await _act.openCTA(time, sess.id, body.image, brief)
      : { ok: false, error: "indisponível" });
  });
  app.post("/api/cta/flashmass", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const time = String((req.body || {}).time || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: "time" });
    res.json(_act.flashmass ? await _act.flashmass(time, sess.id) : { ok: false, error: "indisponível" });
  });
  app.post("/api/cta/finish", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    res.json(_act.finishCTA ? await _act.finishCTA((req.body || {}).event, sess.id) : { ok: false, error: "indisponível" });
  });
  app.post("/api/cta/show", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const { event, tipo } = req.body || {};
    if (!["flex", "press", "pt6teste"].includes(tipo)) return res.status(400).json({ error: "tipo" });
    res.json(_act.showPT ? await _act.showPT(event, tipo, sess.id) : { ok: false, error: "indisponível" });
  });
  app.post("/api/cta/removept", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const { event, party } = req.body || {};
    res.json(_act.removePT ? await _act.removePT(event, Number(party), sess.id) : { ok: false, error: "indisponível" });
  });
  app.post("/api/cta/reallocation-lock", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const { event, party, locked } = req.body || {};
    const visual = Number(party);
    if (![1, 2].includes(visual)) return res.status(400).json({ error: "A trava está disponível somente para PT1 e PT2." });
    res.json(_act.setPartyReallocationLock
      ? await _act.setPartyReallocationLock(event, visual, !!locked, sess.id)
      : { ok: false, error: "indisponível" });
  });

  app.post("/api/navigation/objective", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const body = req.body || {};
    const targetZone = String(body.targetZone || "").trim();
    if (!targetZone) return res.status(400).json({ error: "Informe o mapa de destino." });
    const input = {
      targetZone,
      type: String(body.type || "OBJETIVO").trim(),
      rarity: String(body.rarity || "").trim(),
      minutes: Math.max(0, Math.min(240, Number(body.minutes) || 0)),
      seconds: Math.max(0, Math.min(59, Number(body.seconds) || 0)),
    };
    const result = _act.setNavigationObjective
      ? await _act.setNavigationObjective(null, input, sess.id)
      : { ok: false, error: "indisponível" };
    res.status(result && result.ok === false ? 400 : 200).json(result);
  });

  app.post("/api/navigation/pickup", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const body = req.body || {};
    const waypoint = String(body.waypoint || "").trim();
    const deliveryZoneId = String(body.deliveryZoneId || "").trim();
    const deliveryZoneName = String(body.deliveryZoneName || "").trim();
    if (!waypoint || !deliveryZoneId || !deliveryZoneName) {
      return res.status(400).json({ error: "waypoint/delivery" });
    }
    const result = _act.startNavigationCarry
      ? await _act.startNavigationCarry(null, waypoint, deliveryZoneId, deliveryZoneName, sess.id)
      : { ok: false, error: "indisponível" };
    res.status(result && result.ok === false ? 400 : 200).json(result);
  });

  app.post("/api/navigation/complete", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const body = req.body || {};
    const waypoint = String(body.waypoint || "").trim();
    if (!waypoint) return res.status(400).json({ error: "waypoint" });
    const result = _act.completeNavigationObjective
      ? await _act.completeNavigationObjective(null, waypoint, sess.id)
      : { ok: false, error: "indisponível" };
    res.status(result && result.ok === false ? 400 : 200).json(result);
  });

  app.post("/api/navigation/remove", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const body = req.body || {};
    const waypoint = String(body.waypoint || "").trim();
    if (!waypoint) return res.status(400).json({ error: "waypoint" });
    const result = _act.removeNavigationObjective
      ? await _act.removeNavigationObjective(null, waypoint, sess.id)
      : { ok: false, error: "indisponível" };
    res.status(result && result.ok === false ? 400 : 200).json(result);
  });

  app.post("/api/navigation/clear", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const result = _act.clearNavigationObjective
      ? await _act.clearNavigationObjective(null, sess.id)
      : { ok: false, error: "indisponível" };
    res.status(result && result.ok === false ? 400 : 200).json(result);
  });

  app.post("/api/setweapon", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const { event, userId, weapon } = req.body || {};
    const w = String(weapon || "").trim();
    if (!w || !WEAPONS[w.toUpperCase()]) return res.status(400).json({ error: "weapon" });
    const ev = await db.getEvent(event).catch(() => null);
    if (!ev) return res.status(404).json({ error: "event" });
    // Fixa a pessoa na vaga atual (manual=true) para o motor nao reposiciona-la depois da troca de arma.
    await db.pool.query("UPDATE cta_signups SET weapon=$3, manual=(COALESCE(manual,false) OR (party_index IS NOT NULL AND slot_index IS NOT NULL)) WHERE event_id=$1 AND user_id=$2", [ev.id, userId, w.toUpperCase()]);
    if (_act.applyEdit) await _act.applyEdit(ev.id);
    res.json({ ok: true });
  });

  app.get("/api/news", async (req, res) => {
    const sess = requireMember(req, res); if (!sess) return;
    res.json(_act.fetchNews ? await _act.fetchNews() : []);
  });
  app.get("/api/me/stats", async (req, res) => {
    const sess = requireMember(req, res); if (!sess) return;
    const r = _act.myStats ? await _act.myStats(sess.id, GUILD_ID) : null;
    res.json(r || { error: "indisponível" });
  });
  app.get("/api/scout", async (req, res) => {
    const sess = requireMember(req, res); if (!sess) return;
    try {
      const r = _act.scoutOverview ? await _act.scoutOverview(GUILD_ID) : null;
      res.json(r || { season: null, ctaCount: 0, rows: [] });
    } catch (e) {
      console.error("/api/scout:", e?.message || e);
      res.status(500).json({ error: "server" });
    }
  });
  app.use("/assets", express.static(path.join(__dirname, "..", "assets"), {
    maxAge: "1d",
    immutable: false
  }));

  app.get("/", (_req, res) => res.type("html").send(PAGE));

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🌐 Telão/site no ar na porta ${port}`));
}

// ----------------------------------------------------------------------------
// PÁGINA (telão) — vanilla JS, sem template literals no cliente (pra não colidir
// com este template). Conecta no SSE e re-renderiza a cada mudança.
// ----------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>IMORTAIS · War Room</title>
<link rel="icon" type="image/png" href="/assets/imortais-war-room-logo.png?v=3">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    color-scheme:dark;
    --bg:#080b10; --panel:#10151d; --panel2:#151c26; --line:#243040; --line2:#33425a;
    --text:#edf2f7; --muted:#8190a5; --faint:#5a6678;
    --red:#d93b45; --red2:#a92631; --gold:#d9aa52; --green:#42c77a; --amber:#e2b95e;
    --tank:#5e87ff; --support:#b576ff; --dps:#ef6672; --range:#e2b95e; --heal:#4bd28a;
    --disp:'Cinzel',Georgia,serif; --sans:'Inter',system-ui,sans-serif;
  }
  *{box-sizing:border-box;}
  body{ margin:0; color:var(--text); font-family:var(--sans); font-size:14px;
    background:radial-gradient(circle at 50% -20%,#1a2433 0,#0b0f15 34%,var(--bg) 70%); background-attachment:fixed;
    padding-top:env(safe-area-inset-top,0); }
  a{color:inherit;}
  header{ height:64px; padding:0 22px; display:flex; align-items:center; gap:14px; border-bottom:1px solid var(--line); background:rgba(8,11,16,.92); position:sticky; top:0; z-index:20; backdrop-filter:blur(10px); }
  .crest{ width:44px; height:44px; flex:0 0 44px; object-fit:contain; border-radius:50%; filter:drop-shadow(0 2px 8px rgba(0,220,235,.18)); display:block; }
  .brand h1{ font-family:var(--disp); font-weight:900; font-size:19px; letter-spacing:2px; margin:0; line-height:1; }
  .brand small{ display:block; margin-top:3px; font-size:10px; letter-spacing:3px; color:var(--gold); font-weight:700; }
  #live{ margin-left:22px; color:var(--green); font-size:12px; }
  #auth{ margin-left:auto; display:flex; align-items:center; gap:12px; font-size:13px; color:var(--muted); }
  #auth a{ color:#7fb0ff; text-decoration:none; } #auth a:hover{ text-decoration:underline; }
  .shell{ display:grid; grid-template-columns:224px 1fr; min-height:calc(100vh - 64px); }
  aside{ border-right:1px solid var(--line); padding:16px 12px; background:#0b0f15; }
  .navtitle{ font-size:10px; color:#5a6678; font-weight:800; letter-spacing:.14em; margin:14px 10px 6px; }
  .nav{ display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:9px; color:#a9b5c5; margin:3px 0; cursor:pointer; font-weight:600; font-size:13.5px; border-left:3px solid transparent; }
  .nav:hover{ background:#141a22; }
  .nav.on{ background:#1a202a; color:#fff; border-left-color:var(--red); }
  .nav.soon{ color:#4f5a6b; cursor:default; } .nav.soon:hover{ background:transparent; }
  .nav.soon .tagsoon{ margin-left:auto; font-size:9px; letter-spacing:.1em; color:#455063; border:1px solid #2a3546; border-radius:5px; padding:2px 5px; }
  main{ padding:20px 24px 40px; min-width:0; }
  /* topline */
  .topline{ display:flex; align-items:center; gap:9px; margin-bottom:14px; flex-wrap:wrap; }
  .tab{ border:1px solid var(--line); background:var(--panel); color:#c9d2df; border-radius:9px; padding:8px 13px; cursor:pointer; font-weight:600; font-size:13px; }
  .tab.on{ border-color:#87343d; background:#271317; color:#fff; }
  .spacer{ flex:1; }
  .btn{ border:0; border-radius:9px; padding:9px 14px; font-family:var(--sans); font-weight:800; font-size:13px; cursor:pointer; }
  .primary{ background:linear-gradient(180deg,var(--red),var(--red2)); color:#fff; }
  .primary:hover{ filter:brightness(1.07); }
  .ghost{ border:1px solid var(--line); background:#111720; color:#c9d2df; font-weight:600; }
  .ghost:hover{ border-color:var(--red); }
  .gold{ border:1px solid var(--gold); background:transparent; color:var(--gold); font-weight:700; }
  .danger{ border:1px solid #7a2a2a; background:transparent; color:#ff9a9a; font-weight:700; }
  .ptx{ margin-left:8px; border:1px solid #7a2a2a; background:transparent; color:#ff9a9a; border-radius:6px; width:22px; height:22px; cursor:pointer; font-weight:700; line-height:1; flex:0 0 auto; }
  .ptx:hover{ background:#2a1315; }
  .ptlock{ border:1px solid #4d617d; background:#101923; color:#9eb0c8; border-radius:7px; min-height:26px; padding:4px 8px; cursor:pointer; font:800 8px var(--sans); white-space:nowrap; flex:0 0 auto; }
  .ptlock:hover{ border-color:#7c93b2; color:#e3ebf5; }
  .ptlock.on{ border-color:#b0842e; background:#2d220d; color:#f1c864; }
  .catdot{ display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; vertical-align:middle; flex:0 0 auto; }
  .catleg{ display:flex; flex-wrap:wrap; gap:10px; margin:8px 0 4px; font-size:11px; color:var(--muted); }
  .catleg span{ display:inline-flex; align-items:center; gap:4px; }
  .catleg i{ width:9px; height:9px; border-radius:50%; display:inline-block; }
  /* hero */
  .hero{ display:grid; grid-template-columns:1.3fr .7fr; gap:12px; margin-bottom:14px; }
  .card{ background:linear-gradient(180deg,#121923,#0e131b); border:1px solid var(--line); border-radius:13px; padding:15px 17px; }
  .status h2{ margin:0 0 6px; font-size:17px; font-family:var(--disp); font-weight:700; letter-spacing:1px; }
  .status p{ margin:0; color:var(--muted); }
  .badges{ display:flex; gap:7px; margin-top:12px; flex-wrap:wrap; }
  .badge{ font-size:11px; padding:5px 9px; border-radius:999px; background:#18202b; color:#aeb9c7; }
  .badge.ok{ color:#8ce5ad; background:#10241a; }
  .actions h3{ margin:0 0 10px; font-size:10px; color:var(--muted); letter-spacing:.12em; font-weight:800; }
  .actionrow{ display:flex; flex-wrap:wrap; gap:7px; }
  .actionrow:empty::before{ content:'Somente leitura'; color:var(--faint); font-size:12px; }
  /* legend */
  .legend{ display:flex; gap:14px; margin:2px 2px 12px; color:var(--muted); font-size:11px; flex-wrap:wrap; }
  .legend i{ display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; vertical-align:middle; }
  /* board */
  .board{ display:grid; grid-template-columns:repeat(2,minmax(500px,1fr)); gap:12px; }
  .party{ background:var(--panel); border:1px solid var(--line); border-radius:13px; overflow:hidden; }
  .ph{ height:44px; padding:0 14px; display:flex; align-items:center; gap:8px; background:#0d1219; border-bottom:1px solid var(--line); }
  .ph .name{ font-family:var(--disp); font-weight:700; font-size:14px; letter-spacing:1px; }
  .ph .ct{ color:var(--muted); font-weight:600; font-size:12px; }
  .meter{ margin-left:auto; width:84px; height:5px; background:#222a35; border-radius:10px; overflow:hidden; }
  .meter i{ display:block; height:100%; background:var(--green); }
  .slots{ display:grid; grid-template-columns:1fr 1fr; }
  .col+.col{ border-left:1px solid var(--line); }
  .slot{ min-height:40px; display:grid; grid-template-columns:24px 8px minmax(96px,1fr) 1fr auto; align-items:center; gap:7px; padding:5px 11px; border-bottom:1px solid #1a222e; }
  .slot:last-child{ border-bottom:0; }
  .slot:hover{ background:#141c26; }
  .num{ color:#59687b; font-variant-numeric:tabular-nums; font-size:12px; }
  .role{ width:7px; height:22px; border-radius:4px; background:#39445a; }
  .role-tank{ background:var(--tank);} .role-support{ background:var(--support);} .role-dps{ background:var(--dps);} .role-range{ background:var(--range);} .role-heal{ background:var(--heal);}
  .weapon{ font-size:12px; color:#aab5c4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .weapon.wedit{ cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px; }
  .player{ font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .slot.empty .player{ color:#4d5968; font-weight:500; font-style:italic; }
  .slot.empty .weapon{ color:#5a6678; }
  .tail{ display:inline-flex; align-items:center; gap:6px; justify-self:end; }
  .core{ color:var(--gold); }
  .lock{ color:#5a6678; font-size:11px; }
  .pres{ width:8px; height:8px; border-radius:50%; }
  .pres.on{ background:var(--green); box-shadow:0 0 6px rgba(66,199,122,.6);} .pres.wait{ background:var(--amber); }
  .slot.drag{ cursor:grab; } .slot.drag:active{ cursor:grabbing; }
  .slot.over{ outline:2px solid var(--red); outline-offset:-2px; background:#241417; }
  .wsel{ background:var(--bg); color:var(--text); border:1px solid var(--red); border-radius:6px; font-size:12px; padding:1px 3px; grid-column:3; }
  /* reserve */
  .reserve{ margin-top:14px; background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:13px 15px; }
  .reservehead{ font-family:var(--disp); font-weight:700; font-size:13px; letter-spacing:1px; }
  .reservehead span{ color:var(--muted); margin-left:8px; font-family:var(--sans); font-weight:500; }
  .chips{ display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
  .chip{ border:1px solid var(--line); background:#141b24; border-radius:8px; padding:7px 10px; color:#c5cfdb; font-size:13px; }
  .chip b{ color:#fff; } .chip.drag{ cursor:grab; }
  /* mural */
  .mural{ background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:18px 22px; margin-bottom:14px; }
  .mural-h{ display:flex; align-items:baseline; gap:12px; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--line); }
  .mural-title{ font-family:var(--disp); font-weight:700; font-size:13px; letter-spacing:1px; color:var(--gold); }
  .mural-meta{ margin-left:auto; font-size:12px; color:var(--faint); }
  .news-body h2{ font-family:var(--disp); font-weight:700; font-size:18px; margin:2px 0 8px; color:var(--gold); }
  .news-body h3{ font-family:var(--disp); font-weight:700; font-size:15px; margin:14px 0 6px; }
  .news-body h4{ font-size:14px; margin:10px 0 4px; }
  .news-body p{ margin:6px 0; color:#d3d7de; line-height:1.55; max-width:76ch; }
  .news-body blockquote{ margin:6px 0; padding:5px 0 5px 14px; border-left:3px solid var(--line2); color:var(--muted); font-size:13.5px; }
  .news-body strong{ color:var(--text); }
  .empty-note{ color:var(--faint); text-align:center; padding:34px; }
  .gate{ padding:70px 18px; color:var(--muted); text-align:center; font-size:15px; line-height:1.7; }
  .gate-btn{ display:inline-block; margin-top:10px; background:var(--panel); border:1px solid var(--line2); color:#7fb0ff; padding:10px 20px; border-radius:10px; text-decoration:none; }
  /* modais */
  .modal{ display:none; position:fixed; inset:0; z-index:40; background:rgba(4,6,9,.74); backdrop-filter:blur(3px); align-items:center; justify-content:center; padding:18px; }
  .modal.open{ display:flex; }
  .sheet{ background:linear-gradient(180deg,var(--panel2),var(--panel)); border:1px solid var(--line2); border-radius:16px; width:100%; max-width:520px; padding:22px 24px; position:relative; box-shadow:0 30px 80px -30px #000; }
  .sheet h2{ font-family:var(--disp); font-weight:700; font-size:18px; letter-spacing:1px; margin:0 0 4px; }
  .sheet .sub{ color:var(--muted); font-size:13px; margin:0 0 18px; }
  .x{ position:absolute; top:14px; right:16px; background:none; border:0; color:var(--muted); font-size:20px; cursor:pointer; }
  .timegrid{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; }
  .time{ background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:11px; padding:14px 0; font-size:15px; font-weight:800; cursor:pointer; text-align:center; }
  .time:hover{ border-color:var(--red); }
  .time.on{ border-color:var(--red); background:#271317; color:#fff; }
  .drop{ display:block; border:1.5px dashed var(--line2); border-radius:12px; padding:18px; text-align:center; color:var(--muted); font-size:13px; cursor:pointer; margin-bottom:18px; }
  .drop:hover{ border-color:var(--red); color:var(--text); }
  .drop .ic{ font-size:24px; display:block; margin-bottom:6px; } .drop small{ color:var(--faint); } .drop img{ max-height:110px; border-radius:8px; margin-top:6px; }
  .cta-brief{ margin:0 0 16px; padding:13px; border:1px solid var(--line); border-radius:12px; background:#0c1118; }
  .cta-brief-title{ margin-bottom:9px; color:var(--muted); font-size:9px; font-weight:900; letter-spacing:.11em; }
  .brief-toggle{ display:flex; align-items:center; gap:8px; margin:8px 0 6px; color:#d4dde9; font-size:12px; font-weight:800; cursor:pointer; }
  .brief-toggle input{ accent-color:var(--red); width:16px; height:16px; }
  .brief-input,.brief-select{ width:100%; background:var(--bg); border:1px solid var(--line2); color:var(--text); border-radius:9px; padding:9px 11px; font:600 12px var(--sans); }
  .brief-input:disabled,.brief-select:disabled{ opacity:.38; cursor:not-allowed; }
  .brief-gear-row{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .brief-fixed{ display:grid; gap:4px; margin-top:12px; padding:9px 10px; border:1px solid #2a3a2f; border-radius:9px; background:#0d1b13; color:#91d7a8; font-size:10px; }
  .brief-fixed b{ color:#6f9f80; font-size:8px; letter-spacing:.08em; }
  .field input{ width:100%; background:var(--bg); border:1px solid var(--line2); color:var(--text); border-radius:11px; padding:12px 14px; font-size:15px; font-family:var(--sans); margin-bottom:14px; }
  .note{ font-size:12px; color:var(--faint); margin:-4px 0 16px; }
  .auditpt{ margin-bottom:12px; }
  .audithead{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .audithead h3{ margin:0; }
  .auditbad{ margin-left:auto; color:#ff9a9a; font-size:12px; font-weight:800; }
  .auditgood{ margin-left:auto; color:#8ce5ad; font-size:12px; font-weight:800; }
  .auditsplit{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .audittitle{ color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-weight:800; margin:4px 0 7px; }
  .auditline{ display:grid; grid-template-columns:28px minmax(120px,1fr) auto minmax(120px,1fr); align-items:center; gap:8px; min-height:34px; padding:5px 8px; border-bottom:1px solid #1a222e; }
  .auditline:last-child{ border-bottom:0; }
  .auditline.missing{ background:rgba(217,59,69,.035); }
  .auditline.intruder{ background:rgba(181,118,255,.035); }
  .auditstatus{ justify-self:start; }
  .auditdetail{ color:var(--muted); font-size:12px; text-align:right; }
  .auditok{ color:#8ce5ad; padding:8px 4px; font-size:12px; }
  .auditcorrect{ margin-top:10px; border-top:1px solid var(--line); padding-top:8px; }
  .auditcorrect summary{ color:var(--muted); cursor:pointer; font-size:12px; }
  .auditgrid{ display:grid; grid-template-columns:1fr 1fr; gap:0 12px; margin-top:8px; }
  .lootctas{ display:flex; gap:8px; flex-wrap:wrap; }
  @media(max-width:900px){ .auditsplit,.auditgrid{ grid-template-columns:1fr; } .auditline{grid-template-columns:28px 1fr auto;} .auditdetail{grid-column:2 / -1;text-align:left;} }
  .sheet .go{ width:100%; padding:13px; font-size:15px; }
  .big{ font-family:var(--disp); font-size:42px; font-weight:900; line-height:1; margin:6px 0 4px; }
  .big small{ font-family:var(--sans); font-size:15px; color:var(--muted); font-weight:400; }
  .srow{ padding:6px 0; color:#c7cdd6; font-size:14px; border-top:1px solid var(--line); }
  .srow:first-of-type{ border-top:0; }
  @media(max-width:1050px){ .shell{ grid-template-columns:1fr;} aside{ display:none;} .board{ grid-template-columns:1fr;} .hero{ grid-template-columns:1fr;} }
  /* ---- telas de dados do jogo (prévia/mock) ---- */
  .preview{ display:inline-block; margin-bottom:14px; font-size:11px; letter-spacing:.06em; color:#e0b04a; background:#241d0c; border:1px solid #5a4a1e; border-radius:8px; padding:6px 11px; }
  .modhead{ font-family:var(--disp); font-weight:700; font-size:20px; letter-spacing:1px; margin:2px 0 12px; }
  .statgrid{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .stat{ background:linear-gradient(180deg,#121923,#0e131b); border:1px solid var(--line); border-radius:13px; padding:14px 16px; }
  .stat .k{ font-size:11px; color:var(--muted); letter-spacing:.1em; font-weight:700; text-transform:uppercase; }
  .stat .v{ font-family:var(--disp); font-size:28px; font-weight:900; margin-top:6px; }
  .stat.g .v{ color:var(--green);} .stat.r .v{ color:var(--dps);} .stat.a .v{ color:var(--amber);} .stat.p .v{ color:var(--support);} .stat.b .v{ color:var(--tank);}
  .panel{ background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:14px 16px; margin-bottom:14px; }
  .panel h3{ margin:0 0 10px; font-size:12px; color:var(--muted); letter-spacing:.1em; font-weight:800; text-transform:uppercase; }
  .input{ width:100%; margin-top:5px; background:var(--bg); border:1px solid var(--line2); color:var(--text); border-radius:9px; padding:10px 11px; font:inherit; outline:none; }
  .input:focus{ border-color:#7fb0ff; }
  label{ color:var(--muted); font-size:12px; }
  .dtable{ width:100%; border-collapse:collapse; font-size:13px; }
  .dtable th{ text-align:left; color:var(--muted); font-weight:700; font-size:11px; letter-spacing:.06em; padding:6px 8px; border-bottom:1px solid var(--line); }
  .dtable td{ padding:7px 8px; border-bottom:1px solid #1a222e; }
  .dtable tr:hover td{ background:#141c26; }
  .pill{ display:inline-block; font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; }
  .pill.ok{ color:#8ce5ad; background:#10241a; } .pill.miss{ color:#ffb0b0; background:#2a1315; } .pill.extra{ color:#eccf8a; background:#2a230f; } .pill.div{ color:#d6b8ff; background:#231a30; }
  .pill.capturado{ color:#9bc7ff; background:#102033; } .pill.entregue{ color:#8ce5ad; background:#10241a; } .pill.pendente{ color:#eccf8a; background:#2a230f; } .pill.divergencia{ color:#d6b8ff; background:#231a30; }
  .toplist{ display:flex; flex-direction:column; gap:6px; }
  .toprow{ display:flex; align-items:center; gap:10px; padding:7px 10px; background:var(--bg); border-radius:9px; }
  .toprow .rk{ width:22px; color:var(--muted); font-weight:800; text-align:center; }
  .toprow .nm{ font-weight:700; } .toprow .val{ margin-left:auto; color:var(--gold); font-weight:700; font-variant-numeric:tabular-nums; }
  .toprow .bar{ flex:0 0 120px; height:6px; background:#222a35; border-radius:6px; overflow:hidden; } .toprow .bar i{ display:block; height:100%; background:linear-gradient(90deg,var(--red),var(--amber)); }
  .split{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media(max-width:1050px){ .statgrid{ grid-template-columns:repeat(2,1fr);} .split{ grid-template-columns:1fr;} }

  /* ===== CTA validation dashboard v2 ===== */
  .cv2-shell{display:grid;gap:12px}
  .cv2-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;background:linear-gradient(180deg,#111a27,#0d151f);border:1px solid var(--line);border-radius:13px}
  .cv2-title{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .cv2-title h2{margin:0;font-family:var(--disp);font-size:22px}
  .cv2-title .cta{color:var(--gold);font-size:13px;font-weight:800}
  .cv2-sub{margin-top:5px;color:var(--muted);font-size:11px}
  .cv2-live{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;padding:7px 10px;border:1px solid #245b3e;border-radius:999px;background:#0d2419;color:#8ce5ad;font-size:10px;font-weight:800}
  .cv2-live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px rgba(66,199,122,.65)}
  .cv2-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
  .cv2-kpi{min-width:0;padding:12px 13px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(180deg,#111923,#0d131b)}
  .cv2-kpi .k{color:var(--muted);font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
  .cv2-kpi .v{margin-top:4px;font-family:var(--disp);font-size:27px;font-weight:900}
  .cv2-kpi .s{margin-top:2px;color:var(--faint);font-size:9px}
  .cv2-kpi.good{border-color:#22583b}.cv2-kpi.good .v{color:#62db91}
  .cv2-kpi.bad{border-color:#68292f}.cv2-kpi.bad .v{color:#ff747d}
  .cv2-kpi.warn{border-color:#66501f}.cv2-kpi.warn .v{color:#ecc45f}
  .cv2-kpi.purple{border-color:#493169}.cv2-kpi.purple .v{color:#b88aff}
  .cv2-kpi.blue{border-color:#294d78}.cv2-kpi.blue .v{color:#76adff}
  .cv2-minibar{height:5px;margin-top:8px;overflow:hidden;border-radius:999px;background:#202a36}
  .cv2-minibar i{display:block;height:100%;border-radius:999px;background:currentColor}
  .cv2-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;align-items:start}
  .cv2-main{min-width:0}
  .cv2-side{min-width:0;position:sticky;top:78px;display:grid;gap:10px}
  .cv2-panel{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:linear-gradient(180deg,#101821,#0d131a)}
  .cv2-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 12px;border-bottom:1px solid var(--line)}
  .cv2-panel-head h3{margin:0;font-size:12px}
  .cv2-panel-head small{color:var(--muted);font-size:9px}
  .cv2-panel-head.danger{border-bottom-color:#65272d;background:linear-gradient(180deg,rgba(103,25,31,.45),rgba(58,15,19,.28))}
  .cv2-distribution{padding:13px 14px}
  .cv2-segmentbar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:#202a37}
  .cv2-segmentbar i{display:block;height:100%}
  .cv2-distlegend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:11px}
  .cv2-distitem{display:grid;grid-template-columns:auto 1fr auto;gap:6px;align-items:center;color:var(--muted);font-size:9px}
  .cv2-distitem i{width:8px;height:8px;border-radius:50%}
  .cv2-distitem b{color:var(--text);font-size:10px}
  .cv2-party-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:10px}
  .cv2-party{position:relative;padding:11px;border:1px solid var(--line);border-radius:11px;background:linear-gradient(180deg,#111923,#0d131b);cursor:pointer;transition:border-color .12s ease,opacity .12s ease,box-shadow .12s ease,transform .12s ease}
  .cv2-party:hover{transform:translateY(-1px);border-color:#4a6688}
  .cv2-party.problem{border-color:#573034}
  .cv2-party.selected{border-color:#4a97ff!important;box-shadow:0 0 0 1px rgba(74,151,255,.30) inset}
  .cv2-party.dim{opacity:.42}
  .cv2-party-badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border:1px solid #6b2a31;border-radius:999px;background:#2d1115;color:#ff8790;font:900 8px var(--sans);vertical-align:middle}
  .cv2-party-badge.ok{border-color:#25593b;background:#0d281a;color:#7fe3a4}
  .cv2-filterbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:10px 0}
  .cv2-filterbtn{appearance:none;border:1px solid #2b3a50;border-radius:8px;background:#101822;color:#93a3b8;padding:7px 11px;font:800 9px var(--sans);cursor:pointer}
  .cv2-filterbtn:hover{border-color:#53709a;color:#dbe7f5}
  .cv2-filterbtn.on{border-color:#4a97ff;background:#16283c;color:#82bfff;box-shadow:0 0 0 1px rgba(74,151,255,.14) inset}
  .cv2-filterhint{margin-left:auto;color:var(--muted);font-size:9px}
  .cv2-pt-stack{display:grid;gap:11px;margin:10px 0 12px}
  .cv2-pt-audit{overflow:hidden;border:1px solid #2a3a50;border-radius:11px;background:linear-gradient(180deg,#111923,#0d131b)}
  .cv2-pt-audit.selected{border-color:#4a97ff;box-shadow:0 0 0 1px rgba(74,151,255,.18) inset}
  .cv2-pt-audit-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid #243244;background:#111a25}
  .cv2-pt-audit-head h3{margin:0;font-family:var(--disp);font-size:17px}
  .cv2-pt-audit-meta{display:flex;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:8px}
  .cv2-pt-audit-meta b{color:var(--text)}
  .cv2-pt-audit-tablebox{overflow-x:auto}
  .cv2-pt-audit-table{width:100%;min-width:850px;border-collapse:collapse;font-size:10px}
  .cv2-pt-audit-table th{text-align:left;padding:7px 9px;color:var(--muted);font-size:8px;letter-spacing:.05em;background:#101823;border-bottom:1px solid #223044}
  .cv2-pt-audit-table td{padding:8px 9px;border-bottom:1px solid #1b2736;vertical-align:middle}
  .cv2-pt-audit-table tr:last-child td{border-bottom:0}
  .cv2-pt-audit-player b{display:block;font-size:10px}.cv2-pt-audit-player span{display:block;margin-top:2px;color:var(--muted);font-size:8px}
  .cv2-pt-status{display:inline-block;padding:3px 6px;border-radius:999px;font-size:8px;font-weight:900;white-space:nowrap}
  .cv2-pt-status.ok{background:#10351f;color:#7ee3a4;border:1px solid #28633f}
  .cv2-pt-status.miss{background:#3a2b0d;color:#f2ca70;border:1px solid #6f551c}
  .cv2-pt-status.wrong{background:#35194f;color:#cda2ff;border:1px solid #613b85}
  .cv2-pt-status.intruder{background:#3b1519;color:#ff9299;border:1px solid #733038}
  .cv2-party-head{display:flex;align-items:flex-start;justify-content:space-between;gap:7px}
  .cv2-party-name{font-family:var(--disp);font-size:17px;font-weight:900}
  .cv2-party-score{font-size:14px;font-weight:900}
  .cv2-party-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:4px;color:var(--muted);font-size:8px}
  .cv2-ring-wrap{display:flex;justify-content:center;margin:8px 0}
  .cv2-ring{width:68px;height:68px;border-radius:50%;display:grid;place-items:center;position:relative}
  .cv2-ring:after{content:"";position:absolute;inset:7px;border-radius:50%;background:#101821;border:1px solid #26354a}
  .cv2-ring b{z-index:1;font-size:14px}
  .cv2-slotmap{display:grid;grid-template-columns:repeat(10,1fr);gap:3px}
  .cv2-slot{position:relative;aspect-ratio:1;border-radius:3px;border:1px solid #334052;background:#1c2632}
  .cv2-slot.ok{border-color:#2d9c5c;background:#1d7446}
  .cv2-slot.miss{border-color:#a77b26;background:#614817}
  .cv2-slot.off{border-color:#b23741;background:#71242c}
  .cv2-slot.wrong{border-color:#8052ba;background:#4b2d73}
  .cv2-slot.empty{opacity:.4}
  .cv2-slot:hover:after{content:attr(data-tip);position:absolute;z-index:30;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);padding:5px 7px;border:1px solid var(--line2);border-radius:6px;background:#080c12;color:#dce4ee;font-size:9px;white-space:nowrap;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,.42)}
  .cv2-legend{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 10px;color:var(--muted);font-size:8px}
  .cv2-legend span{display:inline-flex;align-items:center;gap:4px}.cv2-legend i{width:7px;height:7px;border-radius:2px}
  .cv2-tablebox{overflow:auto}
  .cv2-table{width:100%;min-width:840px;border-collapse:collapse;font-size:10px}
  .cv2-table th{text-align:left;padding:8px 9px;color:var(--muted);font-size:8px;letter-spacing:.06em;background:#121b27;border-bottom:1px solid var(--line)}
  .cv2-table td{padding:8px 9px;border-bottom:1px solid #1a2430;vertical-align:middle}
  .cv2-table tr:last-child td{border-bottom:0}.cv2-table tbody tr:hover td{background:#131c27}
  .cv2-player{font-weight:800}.cv2-muted{color:var(--muted)}.cv2-good{color:#7fe3a4}.cv2-warn{color:#edc463}.cv2-bad{color:#ff7f87}.cv2-purple{color:#c29bff}
  .cv2-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border-radius:999px;border:1px solid var(--line);font-size:8px;font-weight:900;white-space:nowrap}
  .cv2-pill.good{color:#7fe3a4;border-color:#25593b;background:#0d281a}
  .cv2-pill.warn{color:#edc463;border-color:#68521f;background:#2a210d}
  .cv2-pill.bad{color:#ff7f87;border-color:#672a30;background:#2b1115}
  .cv2-pill.purple{color:#c29bff;border-color:#4f3473;background:#21162f}
  .cv2-pill.neutral{color:#a6b2c2}
  .cv2-attention{display:grid;grid-template-columns:29px minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px 11px;border-bottom:1px solid #1a2430}
  .cv2-attention:last-child{border-bottom:0}
  .cv2-attention-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:#281419;color:#ff737d;font-weight:900}
  .cv2-attention b{display:block;font-size:10px}.cv2-attention small{display:block;margin-top:2px;color:var(--muted);font-size:8px;line-height:1.3}
  .cv2-severity{padding:3px 5px;border:1px solid #69272d;border-radius:6px;background:#2c1115;color:#ff7e87;font-size:7px;font-weight:900}
  .cv2-severity.medium{border-color:#69531f;background:#2b220e;color:#ebc567}
  .cv2-indicator{padding:10px 11px;border-bottom:1px solid #1a2430}.cv2-indicator:last-child{border-bottom:0}
  .cv2-indicator-top{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:9px;color:var(--muted)}
  .cv2-indicator-top b{color:var(--text);font-size:13px}
  .cv2-indicator-bar{height:5px;margin-top:7px;overflow:hidden;border-radius:999px;background:#202b38}.cv2-indicator-bar i{display:block;height:100%;border-radius:999px}
  .cv2-extras{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
  .cv2-extra{padding:11px}.cv2-extra h3{margin:0 0 8px;color:var(--muted);font-size:9px;letter-spacing:.08em;text-transform:uppercase}
  .cv2-extra-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .cv2-extra-player{padding:7px 8px;border:1px solid #202d3d;border-radius:8px;background:#101923;font-size:9px}
  .cv2-count{padding:2px 7px;border-radius:999px;background:#67232a;color:#ffd6d9;font-size:8px;font-weight:900}
  .cv2-equip-hover{cursor:help;text-decoration:underline;text-decoration-style:dotted;text-decoration-color:#536987;text-underline-offset:3px}
  .cv2-equip-mark{display:inline-block;margin-left:5px;color:#7487a2;font-size:9px;text-decoration:none}
  .cv2-equip-pop{position:fixed;z-index:1200;width:382px;max-width:calc(100vw - 20px);padding:12px;border:1px solid #40536f;border-radius:12px;background:linear-gradient(180deg,#121b29,#0a111a);box-shadow:0 18px 55px rgba(0,0,0,.58);pointer-events:none;display:none}
  .cv2-equip-pop.open{display:block}
  .cv2-equip-pop-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
  .cv2-equip-pop-head b{font-size:13px}.cv2-equip-pop-head span{color:#91a0b5;font-size:9px}
  .cv2-equip-ip{padding:4px 7px;border:1px solid #3d506c;border-radius:7px;background:#0d1622;color:#cdd9e7;font-size:9px;font-weight:800;white-space:nowrap}
  .cv2-equip-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px}
  .cv2-equip-item{min-width:0;text-align:center;padding:6px 3px;border:1px solid #24344a;border-radius:8px;background:#0d151f}
  .cv2-equip-icon{width:48px;height:48px;display:block;margin:0 auto 3px;object-fit:contain;filter:drop-shadow(0 4px 7px rgba(0,0,0,.35))}
  .cv2-equip-item.empty{opacity:.35}.cv2-equip-item.empty .cv2-equip-icon{visibility:hidden}
  .cv2-equip-slot{display:block;color:#718198;font-size:7px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv2-equip-tier{display:block;margin-top:1px;color:#dbe5f0;font-size:8px;font-weight:800}
  .cv2-equip-foot{margin-top:8px;color:#66778e;font-size:8px}
  @media(max-width:1300px){.cv2-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.cv2-party-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.cv2-layout{grid-template-columns:1fr}.cv2-side{position:static;grid-template-columns:1fr 1fr}}
  @media(max-width:760px){.cv2-head{align-items:flex-start;flex-direction:column}.cv2-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.cv2-party-grid{grid-template-columns:1fr 1fr}.cv2-side{display:block}.cv2-panel{margin-bottom:10px}.cv2-distlegend,.cv2-extra-grid{grid-template-columns:1fr 1fr}}

  /* ===== Navegação / Waze ZvZ ===== */
  .nav2-shell{display:grid;gap:14px}
  .nav2-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:15px 16px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(180deg,#101924,#0c121a)}
  .nav2-head h2{margin:0;font-family:var(--disp);font-size:20px}.nav2-head p{margin:5px 0 0;color:var(--muted);font-size:11px}
  .nav2-status{font-size:10px;border:1px solid #2b5940;background:#0d2418;color:#74dda0;border-radius:999px;padding:5px 9px;font-weight:800;white-space:nowrap}
  .nav2-layout{display:grid;grid-template-columns:minmax(300px,.8fr) minmax(420px,1.4fr);gap:14px}
  .nav2-card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:14px}
  .nav2-card h3{margin:0 0 10px;font-family:var(--disp);font-size:15px}
  .nav2-form{display:grid;gap:9px}.nav2-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .nav2-field label{display:block;margin:0 0 5px;color:var(--muted);font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
  .nav2-field input,.nav2-field select{width:100%;background:#0b1118;border:1px solid var(--line2);color:var(--text);border-radius:8px;padding:9px 10px;font:600 11px var(--sans)}
  .nav2-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
  .nav2-objective{padding:14px;border:1px solid #4d3c73;background:linear-gradient(180deg,#191229,#100d19);border-radius:11px}
  .nav2-objective .kind{font:900 17px var(--disp)}.nav2-objective .target{margin-top:7px;font-size:18px;font-weight:900}
  .nav2-objective .timer{margin-top:6px;color:#d1b7ff;font-size:12px}
  .nav2-current{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:11px}
  .nav2-stat{border:1px solid #273649;border-radius:9px;background:#0c131c;padding:10px}.nav2-stat small{display:block;color:var(--muted);font-size:8px;text-transform:uppercase}.nav2-stat b{display:block;margin-top:4px;font-size:15px}
  .nav2-next{margin-top:11px;border:1px solid #315d83;border-radius:10px;background:#0e2030;padding:12px}
  .nav2-next small{color:#80a9c9;font-size:8px;font-weight:900}.nav2-next strong{display:block;margin-top:4px;font-size:22px}
  .nav2-route{display:grid;gap:6px;margin-top:11px}.nav2-step{display:grid;grid-template-columns:26px 1fr auto;align-items:center;gap:8px;padding:8px 9px;border:1px solid #243244;border-radius:8px;background:#0c131b}
  .nav2-step .n{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#172333;color:#8da5c2;font-size:9px;font-weight:900}
  .nav2-step .zone{font-weight:800}.nav2-step .go{color:#8bc9ff;font-weight:900;font-size:11px;white-space:nowrap}
  .nav2-spread{display:grid;gap:6px;margin-top:10px}.nav2-spread-row{display:flex;justify-content:space-between;gap:10px;padding:7px 8px;border-bottom:1px solid #1e2a38;color:#aebccc;font-size:10px}
  .nav2-queue{display:grid;gap:9px;margin-top:11px}
  .nav2-qitem{border:1px solid #2d3b4f;border-radius:10px;background:#0c131c;padding:11px}
  .nav2-qtop{display:flex;align-items:flex-start;gap:8px}.nav2-qnum{display:grid;place-items:center;min-width:25px;height:25px;border-radius:50%;background:#172333;color:#a8bdd8;font-size:10px;font-weight:900}
  .nav2-qmain{min-width:0;flex:1}.nav2-qkind{font-size:11px;font-weight:900}.nav2-qtarget{margin-top:3px;font-size:14px;font-weight:900}
  .nav2-qmeta{display:flex;gap:7px;flex-wrap:wrap;margin-top:7px;font-size:9px;color:#91a2b8}.nav2-qmeta span{border:1px solid #28374a;border-radius:999px;padding:3px 6px}
  .nav2-mass{margin-top:8px;padding:8px 9px;border-radius:8px;background:#10251a;border:1px solid #28543a;color:#8fe0ad;font-size:11px;font-weight:900}
  .nav2-mass.late{background:#2b1115;border-color:#79323a;color:#ff9da5}
  .nav2-leg{margin-top:8px;padding-top:8px;border-top:1px solid #202c3a;color:#9fb0c5;font-size:9px}
  .nav2-legsteps{margin-top:5px;display:flex;gap:5px;flex-wrap:wrap}.nav2-legsteps span{background:#111b27;border:1px solid #25364a;border-radius:6px;padding:3px 5px}
  .nav2-qactions{display:flex;gap:6px;margin-top:9px}.nav2-qactions button{font-size:9px;padding:6px 8px}
  .nav2-empty{padding:18px;color:var(--muted);text-align:center;border:1px dashed #2b394b;border-radius:10px}
  @media(max-width:900px){.nav2-layout{grid-template-columns:1fr}.nav2-current{grid-template-columns:1fr}.nav2-row{grid-template-columns:1fr}}

</style>
</head>
<body>
<header>
  <img class="crest" src="/assets/imortais-war-room-logo.png?v=3" alt="IMORTAIS" onerror="this.style.display='none'">
  <div class="brand"><h1>IMORTAIS</h1><small>CTA WAR ROOM</small></div>
  <span id="live">conectando…</span>
  <span id="auth"></span>
</header>
<div class="shell">
  <aside id="side">
    <div class="navtitle">OPERAÇÃO</div>
    <div class="nav on" data-view="board">⚔ Formação ao vivo</div>
    <div class="nav" data-view="navigation">🧭 Navegação</div>
    <div class="nav" data-view="mural">📣 Mural da guilda</div>
    <div class="nav" id="nav-stats">📊 Meu desempenho</div>
    <div class="navtitle">DADOS DO JOGO</div>
    <div class="nav" data-view="scout">📊 Scout</div>
    <div class="nav" data-view="confirm">🎯 Validação do CTA</div>
    <div class="nav" data-view="loot">📦 Registros &amp; Loot</div>
    <div class="nav" data-view="combat">⚔️ Combate</div>
    <div class="nav" data-view="guild">🟢 Guilda online</div>
      <div class="nav" data-view="devices">🖥️ Dispositivos</div>
    <div class="navtitle">EM BREVE</div>
    <div class="nav soon" id="nav-bomb">💥 Bomb <span class="tagsoon">EM BREVE</span></div>
    <div class="nav soon" id="nav-castelo">🏰 Castelo <span class="tagsoon">EM BREVE</span></div>
    <div class="nav soon" id="nav-roaming">🧭 Roaming <span class="tagsoon">EM BREVE</span></div>
  </aside>
  <main id="main">
    <div id="gate"></div>

    <div id="view-board">
      <div class="topline">
        <div class="tabs" id="ctas" style="display:flex;gap:9px;flex-wrap:wrap"></div>
        <div class="spacer"></div>
        <div id="cmd-actions" style="display:flex;gap:9px;flex-wrap:wrap"></div>
      </div>
      <div class="hero">
        <div class="card status" id="status"><h2>Sem CTA selecionado</h2><p>Abra ou selecione um CTA.</p></div>
        <div class="card actions"><h3>COMANDO RÁPIDO</h3><div class="actionrow" id="cmd-sel"></div></div>
      </div>
      <div class="legend">
        <span><i style="background:var(--tank)"></i>Tank</span>
        <span><i style="background:var(--support)"></i>Suporte</span>
        <span><i style="background:var(--dps)"></i>DPS melee</span>
        <span><i style="background:var(--range)"></i>Ranged</span>
        <span><i style="background:var(--heal)"></i>Healer</span>
        <span>⭐ Core</span><span>🔒 Manual</span>
      </div>
      <div class="board" id="board"></div>
      <div id="reserves"></div>
    </div>

    <div id="view-mural" style="display:none"><div id="news"></div></div>
    <div id="view-navigation" style="display:none"></div>
    <div id="view-scout" style="display:none"></div>
    <div id="view-confirm" style="display:none"></div>
    <div id="view-loot" style="display:none"></div>
    <div id="view-combat" style="display:none"></div>
    <div id="view-devices" style="display:none"></div>
    <div id="view-guild" style="display:none"></div>
  </main>
</div>

<div class="modal" id="m-open"><div class="sheet"><button class="x" onclick="mclose('m-open')">✕</button>
  <h2>Abrir CTA</h2><p class="sub">Escolha o horário e configure as informações padronizadas do chamado.</p>
  <div class="timegrid" id="open-times"></div>

  <div class="cta-brief">
    <div class="cta-brief-title">INFORMAÇÕES DO DISCORD</div>

    <label class="brief-toggle"><input type="checkbox" id="open-departure-check"><span>Local de saída</span></label>
    <input class="brief-input" id="open-departure" placeholder="Ex.: Martlock Portal" maxlength="120" disabled>

    <label class="brief-toggle"><input type="checkbox" id="open-gear-check"><span>Número de gears e tier</span></label>
    <div class="brief-gear-row">
      <input class="brief-input" id="open-gear-tier" value="T8" placeholder="T8" maxlength="16" disabled>
      <select class="brief-select" id="open-gear-count" disabled>
        <option value="1">1 ficha</option>
        <option value="2" selected>2 fichas</option>
        <option value="3">3 fichas</option>
        <option value="4">4 fichas</option>
        <option value="5">5 fichas</option>
      </select>
    </div>

    <div class="brief-fixed">
      <b>SEMPRE SERÁ ENVIADO</b>
      <span># FOOD .2</span>
      <span># POÇÃO: GIGANTIFICADORA T7</span>
    </div>
  </div>

  <label class="drop"><span class="ic">🖼️</span><span id="drop-txt">Clique pra escolher a arte do CTA</span><br><small>opcional · PNG ou JPG</small><input type="file" id="open-file" accept="image/*" style="display:none"></label>
  <button class="btn primary go" id="open-go">Abrir CTA</button>
</div></div>
<div class="modal" id="m-flash"><div class="sheet"><button class="x" onclick="mclose('m-flash')">✕</button>
  <h2>⚡ Flashmass</h2><p class="sub">Massa relâmpago com ping do @imortal.</p>
  <div class="field"><input id="flash-time" placeholder="21:20"></div>
  <p class="note">Usa a arte padrão do flashmass — não precisa subir imagem.</p>
  <button class="btn gold go" id="flash-go">⚡ Disparar flashmass</button>
</div></div>
<div class="modal" id="m-stats"><div class="sheet"><button class="x" onclick="mclose('m-stats')">✕</button><div id="stats-body"></div></div></div>

<script>
  var authState={
    logged:false,member:false,canEdit:false,canManageDevices:false,
    canManageBomb:false,canManageCastleRoaming:false,isSiteAdmin:false,name:''
  };
  var current=null, es=null, tes=null, selTime=null, selImg=null;
  var lootSelectedEvent=null;
  var _viewCache={};
  function setView(id,html){ if(_viewCache[id]===html) return; _viewCache[id]=html; var el=document.getElementById(id); if(el) el.innerHTML=html; }
  var combatSelectedEvent=null;
  var confirmPartySelection={};
  var telemetryRefreshTimer=null, telemetryRefreshPending=false, confirmPollTimer=null;
  var ROLE={Tank:'tank',Support:'support',Melee:'dps',Ranged:'range',Healer:'heal'};
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  var liveText='● conectando…', liveColor='var(--amber)', liveRestoreTimer=null, streamLive=false;
  function paintLive(){ var l=document.getElementById('live'); if(!l)return; l.textContent=liveText; l.style.color=liveColor; }
  function setLive(text,color){ liveText=text; liveColor=color; paintLive(); }
  function flash(m,c){
    var l=document.getElementById('live'); if(!l)return;
    l.textContent=m; l.style.color=c||'var(--muted)';
    if(liveRestoreTimer) clearTimeout(liveRestoreTimer);
    liveRestoreTimer=setTimeout(paintLive,2500);
  }
  function checkConnection(){
    if(liveText.indexOf('desconectado')>=0 || liveText.indexOf('erro')>=0) setLive('● reconectando…','var(--amber)');
    fetch('/api/health',{cache:'no-store'})
      .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(x){
        if(x.ok && x.j && x.j.ok){
          setLive(streamLive?'● conectado · CTA ao vivo':'● conectado','var(--green)');
        } else if(x.j && !x.j.discord){
          setLive('● Discord desconectado','var(--red)');
        } else if(x.j && !x.j.database){
          setLive('● banco indisponível','var(--red)');
        } else {
          setLive('● erro de conexão','var(--red)');
        }
      })
      .catch(function(){ setLive('● desconectado','var(--red)'); });
  }
  function mopen(id){ document.getElementById(id).classList.add('open'); }
  function mclose(id){ document.getElementById(id).classList.remove('open'); }

  function show(v){
    var vs={board:'view-board',navigation:'view-navigation',mural:'view-mural',scout:'view-scout',confirm:'view-confirm',loot:'view-loot',combat:'view-combat',devices:'view-devices',guild:'view-guild'};
    for(var k in vs){ var el=document.getElementById(vs[k]); if(el) el.style.display=(k===v)?'':'none'; }
    Array.prototype.forEach.call(document.querySelectorAll('.nav[data-view]'),function(b){ b.classList.toggle('on', b.getAttribute('data-view')===v); });
    if(v==='navigation') renderNavigation();
    if(v==='scout') renderScout();
    if(v==='confirm') renderConfirm();
    if(v==='loot') renderLoot();
    if(v==='combat') renderCombat();
    if(v==='devices') renderDevices();
    if(v==='guild') renderGuild();
  }

  function renderAuthHeader(){
    var el=document.getElementById('auth');
    if(authState.logged){
      var tag = authState.canEdit ? 'CALLER' : (authState.member ? 'MEMBRO' : 'FORA');
      el.innerHTML='<span>'+tag+' · <b style="color:var(--text)">'+esc(authState.name)+'</b></span> <a href="/auth/logout">sair</a>';
    } else { el.innerHTML='<a href="/auth/login">Entrar com Discord</a>'; }
  }
  function openStats(){
    var b=document.getElementById('stats-body'); b.innerHTML='carregando…'; mopen('m-stats');
    fetch('/api/me/stats').then(function(r){return r.json();}).then(function(s){
      if(s.season===false){ b.innerHTML='<h2>📊 Meu desempenho</h2>Nenhuma temporada ativa.'; return; }
      if(!s.found){ b.innerHTML='<h2>📊 Meu desempenho — Temporada '+s.season+'</h2>Você ainda não pontuou nesta temporada.'; return; }
      b.innerHTML='<h2>📊 Meu desempenho — Temporada '+s.season+'</h2>'
        +'<div class="big">#'+s.rank+' <small>de '+s.total+'</small></div>'
        +'<div class="srow"><b>'+s.score+'</b> pontos · '+esc(s.cat)+'</div>'
        +'<div class="srow">✅ Veio: <b>'+s.came+'</b> de '+s.ctaCount+' CTAs <span style="color:var(--faint)">('+s.integral+' integrais · '+s.parcial+' parciais · '+s.rapida+' rápidas)</span></div>'
        +'<div class="srow">📣 Pingou que viria: <b>'+s.pinged+'</b></div>'
        +'<div class="srow">🔴 Faltou (pingou e não veio): <b>'+s.fantasma+'</b></div>';
    }).catch(function(){ b.innerHTML='Erro ao carregar.'; });
  }

  function loadNews(){
    fetch('/api/news').then(function(r){return r.json();}).then(function(list){
      var box=document.getElementById('news');
      if(!list||!list.length){ box.innerHTML='<div class="mural"><div class="empty-note">📭 Nenhuma notícia por enquanto.</div></div>'; return; }
      box.innerHTML=list.map(function(n){
        var when=new Date(n.time).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        return '<div class="mural"><div class="mural-h"><span class="mural-title">📣 Mural da guilda</span><span class="mural-meta">'+esc(n.author)+' · '+when+'</span></div><div class="news-body">'+n.html+'</div></div>';
      }).join('');
    }).catch(function(){});
  }

  function post(url,body){
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
      .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){
        if(!r.ok||j.ok===false){ flash('● '+(j.error||'não foi possível'),'var(--red)'); }
        else { flash('● feito','var(--green)'); setTimeout(function(){ loadEvents(); },700); }
      }); }).catch(function(){ flash('● erro','var(--red)'); });
  }
  function doMove(uid,party,slot){ if(current) post('/api/move',{event:current,userId:uid,party:party,slot:slot}); }
  function doSetWeapon(uid,weapon){ if(current) post('/api/setweapon',{event:current,userId:uid,weapon:weapon}); }
  function openWeaponPicker(wspan,s){
    if(!s.options||!s.options.length) return;
    if(wspan.nextSibling && wspan.nextSibling.className==='wsel') return;
    var sel=document.createElement('select'); sel.className='wsel';
    var opts=s.options.slice(); if(s.weapon && opts.indexOf(s.weapon)<0) opts.unshift(s.weapon);
    opts.forEach(function(w){ var o=document.createElement('option'); o.value=w; o.textContent=w; if(w===s.weapon)o.selected=true; sel.appendChild(o); });
    wspan.style.display='none'; wspan.parentNode.insertBefore(sel,wspan.nextSibling); sel.focus();
    function close(){ if(sel.parentNode) sel.parentNode.removeChild(sel); wspan.style.display=''; if(pendingRenderData){ var pd=pendingRenderData; pendingRenderData=null; render(pd); } }
    sel.addEventListener('change',function(){ var v=sel.value; close(); if(v!==s.weapon) doSetWeapon(s.userId,v); });
    sel.addEventListener('blur',close);
  }

  var pendingRenderData=null;
  function render(data){
    if(document.querySelector('.wsel')){ pendingRenderData=data; return; }
    // status
    var alloc=0, total=0; (data.parties||[]).forEach(function(pt){ pt.slots.forEach(function(s){ if(s.filled) alloc++; }); });
    var wait=(data.reserves||[]).length; total=alloc+wait;
    var st=document.getElementById('status');
    st.innerHTML='<h2>CTA '+esc((data.event&&data.event.time)||'')+' UTC · Formação</h2>'
      +'<p>'+total+' inscritos · '+alloc+' alocados · '+wait+' aguardando PT</p>'
      +'<div class="badges"><span class="badge ok">● '+(data.parties||[]).length+' PTs ativas</span><span class="badge">atualizado agora</span></div>';
    // board
    var board=document.getElementById('board'); board.innerHTML='';
    (data.parties||[]).forEach(function(pt){
      var sec=document.createElement('section'); sec.className='party';
      var pct=pt.total?Math.round(pt.filled/pt.total*100):0;
      var ph=document.createElement('div'); ph.className='ph';
      var xbtn=(authState.canEdit && pt.display>1)?'<button class="ptx" title="Remover esta PT">✕</button>':'';
      var lockbtn=(authState.canEdit && pt.display<=2)
        ? '<button class="ptlock '+(pt.reallocationLocked?'on':'')+'" data-realloc-lock="'+pt.display+'">'
          +(pt.reallocationLocked?'🔓 DESTRAVAR RE-ALOCAÇÃO PT'+pt.display:'🔒 TRAVAR RE-ALOCAÇÃO PT'+pt.display)
          +'</button>'
        : '';
      ph.innerHTML='<span class="name">'+esc(pt.name)+'</span><span class="ct">'+pt.filled+'/'+pt.total+'</span><div class="meter"><i style="width:'+pct+'%"></i></div>'+lockbtn+xbtn;
      sec.appendChild(ph);
      if(lockbtn){
        var lb=ph.querySelector('[data-realloc-lock]');
        if(lb) lb.onclick=function(){
          if(current) post('/api/cta/reallocation-lock',{event:current,party:pt.display,locked:!pt.reallocationLocked});
        };
      }
      if(xbtn){ var xb=ph.querySelector('.ptx'); if(xb) xb.onclick=function(){ if(current && confirm('Remover a '+pt.name+'? A galera dela volta pra reserva.')) post('/api/cta/removept',{event:current,party:pt.display}); }; }
      var slots=document.createElement('div'); slots.className='slots';
      var left=document.createElement('div'); left.className='col'; var right=document.createElement('div'); right.className='col';
      var half=Math.ceil(pt.slots.length/2);
      pt.slots.forEach(function(s,idx){
        var row=document.createElement('div'); row.className='slot'+(s.filled?'':' empty');
        var n=('0'+s.n).slice(-2);
        var rc=ROLE[s.role]||'';
        if(s.filled){
          var dot=s.presence==='online'?'pres on':'pres wait';
          row.innerHTML='<span class="num">'+n+'</span><i class="role role-'+rc+'"></i><span class="weapon">'+esc(s.weapon)+'</span><span class="player">'+esc(s.username)+'</span><span class="tail">'+(s.core?'<span class="core">⭐</span>':'')+(s.manual?'<span class="lock">🔒</span>':'')+'<span class="'+dot+'"></span></span>';
        } else {
          var opts=s.locked?'👑 CALLER':((s.options||[]).slice(0,2).join(' / ')+(((s.options||[]).length>2)?'…':''));
          row.innerHTML='<span class="num">'+n+'</span><i class="role role-'+rc+'" style="opacity:.4"></i><span class="weapon">'+esc(opts)+'</span><span class="player">vazio</span><span class="tail"></span>';
        }
        if(authState.canEdit){
          if(s.filled && !s.locked){
            row.classList.add('drag'); row.setAttribute('draggable','true');
            row.addEventListener('dragstart',function(e){ e.dataTransfer.setData('text/plain',s.userId); e.dataTransfer.effectAllowed='move'; });
            var wsp=row.querySelector('.weapon');
            if(wsp && s.options && s.options.length){ wsp.classList.add('wedit'); wsp.title='trocar arma'; (function(span,slot){ span.addEventListener('click',function(e){ e.stopPropagation(); openWeaponPicker(span,slot); }); })(wsp,s); }
          }
          if(!s.locked){
            row.addEventListener('dragover',function(e){ e.preventDefault(); row.classList.add('over'); });
            row.addEventListener('dragleave',function(){ row.classList.remove('over'); });
            row.addEventListener('drop',function(e){ e.preventDefault(); row.classList.remove('over'); var uid=e.dataTransfer.getData('text/plain'); if(uid) doMove(uid,pt.display,s.n); });
          }
        }
        (idx<half?left:right).appendChild(row);
      });
      slots.appendChild(left); slots.appendChild(right); sec.appendChild(slots); board.appendChild(sec);
    });
    // reserva
    var rz=document.getElementById('reserves'); rz.innerHTML='';
    if(data.reserves && data.reserves.length){
      var wrap=document.createElement('div'); wrap.className='reserve';
      wrap.innerHTML='<div class="reservehead">AGUARDANDO PT <span>'+data.reserves.length+' jogadores</span></div>';
      var chips=document.createElement('div'); chips.className='chips';
      data.reserves.forEach(function(r){ var d=document.createElement('div'); d.className='chip'; d.innerHTML='<b>'+esc(r.username)+'</b> · '+esc(r.weapon)+(r.core?' <span class="core">⭐</span>':''); if(authState.canEdit && r.userId){ d.classList.add('drag'); d.setAttribute('draggable','true'); d.addEventListener('dragstart',function(e){ e.dataTransfer.setData('text/plain',r.userId); e.dataTransfer.effectAllowed='move'; }); } chips.appendChild(d); });
      wrap.appendChild(chips); rz.appendChild(wrap);
    }
  }

  function connect(id){
    current=id; if(es) es.close(); if(tes) tes.close();
    if(confirmPollTimer){ clearInterval(confirmPollTimer); confirmPollTimer=null; }
    es=new EventSource('/api/stream?event='+encodeURIComponent(id));
    es.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); streamLive=true; setLive('● conectado · CTA ao vivo','var(--green)'); }catch(e){} };
    es.onerror=function(){ streamLive=false; setLive('● reconectando…','var(--amber)'); };
    tes=new EventSource('/api/telemetry/stream?event='+encodeURIComponent(id));
    tes.onmessage=function(){
      telemetryRefreshPending=true;
      if(telemetryRefreshTimer) return;
      telemetryRefreshTimer=setTimeout(function(){
        telemetryRefreshTimer=null;
        if(!telemetryRefreshPending) return;
        telemetryRefreshPending=false;
        var active=document.querySelector('.nav[data-view].on');
        var v=active&&active.getAttribute('data-view');
        if(v==='navigation') renderNavigation(true);
        if(v==='confirm') renderConfirm(true);
        if(v==='loot') renderLoot(true);
        if(v==='combat') renderCombat(true);
        if(v==='devices') renderDevices();
      },3000);
    };
    // A validação também depende do estado vivo do Discord e da planilha do bot.
    // Esses dados podem mudar sem qualquer pacote novo do Combat Client.
    confirmPollTimer=setInterval(function(){
      if(!current || String(current)!==String(id)) return;
      var active=document.querySelector('.nav[data-view].on');
      var view=active&&active.getAttribute('data-view');
      if(view==='confirm') renderConfirm(true);
      if(view==='navigation') renderNavigation(true);
    },5000);
  }

  function renderCaller(){
    var acts=document.getElementById('cmd-actions'), sel=document.getElementById('cmd-sel');
    if(!authState.canEdit){ acts.innerHTML=''; sel.innerHTML=''; return; }
    acts.innerHTML='<button class="btn ghost" id="c-flash">⚡ Flashmass</button><button class="btn primary" id="c-open">+ Abrir CTA</button>';
    document.getElementById('c-open').onclick=openOpenModal;
    document.getElementById('c-flash').onclick=function(){ mopen('m-flash'); };
    if(current){
      sel.innerHTML='<button class="btn ghost" data-show="flex">+ PT Flex</button><button class="btn ghost" data-show="press">+ Press</button><button class="btn ghost" data-show="pt6teste">+ pt6teste</button><button class="btn danger" id="c-finish">🏁 Finalizar CTA</button>';
      Array.prototype.forEach.call(sel.querySelectorAll('[data-show]'),function(b){ b.onclick=function(){ if(current) post('/api/cta/show',{event:current,tipo:b.getAttribute('data-show')}); }; });
      document.getElementById('c-finish').onclick=function(){ if(current && confirm('Finalizar este CTA?')) post('/api/cta/finish',{event:current}); };
    } else { sel.innerHTML=''; }
  }

  function syncOpenBriefControls(){
    var depOn=document.getElementById('open-departure-check').checked;
    var gearOn=document.getElementById('open-gear-check').checked;
    document.getElementById('open-departure').disabled=!depOn;
    document.getElementById('open-gear-tier').disabled=!gearOn;
    document.getElementById('open-gear-count').disabled=!gearOn;
  }

  function openOpenModal(){
    selTime=null; selImg=null;
    document.getElementById('open-file').value='';
    document.getElementById('open-departure-check').checked=false;
    document.getElementById('open-departure').value='';
    document.getElementById('open-gear-check').checked=false;
    document.getElementById('open-gear-tier').value='T8';
    document.getElementById('open-gear-count').value='2';
    syncOpenBriefControls();
    document.getElementById('drop-txt').textContent='Clique pra escolher a arte do CTA';
    document.getElementById('open-go').textContent='Abrir CTA';
    fetch('/api/caller').then(function(r){return r.json();}).then(function(c){
      var openT={}; (c.open||[]).forEach(function(e){ openT[e.time]=true; });
      var avail=(c.presetTimes||[]).filter(function(t){ return !openT[t]; });
      var grid=document.getElementById('open-times');
      grid.innerHTML = avail.length? avail.map(function(t){ return '<button class="time" data-t="'+t+'">'+t+'</button>'; }).join('') : '<span style="color:var(--muted)">Todos os horários já estão abertos.</span>';
      Array.prototype.forEach.call(grid.querySelectorAll('.time'),function(b){ b.onclick=function(){ grid.querySelectorAll('.time').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); selTime=b.getAttribute('data-t'); document.getElementById('open-go').textContent='Abrir CTA às '+selTime; }; });
      mopen('m-open');
    });
  }
  document.getElementById('open-departure-check').addEventListener('change',syncOpenBriefControls);
  document.getElementById('open-gear-check').addEventListener('change',syncOpenBriefControls);
  document.getElementById('open-file').addEventListener('change',function(e){
    var f=e.target.files[0]; if(!f) return;
    var rd=new FileReader(); rd.onload=function(){ selImg=rd.result; document.getElementById('drop-txt').innerHTML='✅ '+esc(f.name)+'<br><img src="'+selImg+'">'; }; rd.readAsDataURL(f);
  });
  document.getElementById('open-go').onclick=function(){
    if(!selTime){ flash('● escolha um horário','var(--red)'); return; }
    var useDeparture=document.getElementById('open-departure-check').checked;
    var departure=(document.getElementById('open-departure').value||'').trim();
    var useGear=document.getElementById('open-gear-check').checked;
    var gearTier=(document.getElementById('open-gear-tier').value||'T8').trim();
    var gearCount=Number(document.getElementById('open-gear-count').value||2);
    if(useDeparture&&!departure){ flash('● informe o local de saída','var(--red)'); return; }
    if(useGear&&!gearTier){ flash('● informe o tier do gear','var(--red)'); return; }
    mclose('m-open');
    post('/api/cta/open',{
      time:selTime,
      image:selImg||null,
      useDeparture:useDeparture,
      departure:departure,
      useGear:useGear,
      gearTier:gearTier,
      gearCount:gearCount
    });
  };
  document.getElementById('flash-go').onclick=function(){ var t=(document.getElementById('flash-time').value||'').trim(); if(!t) return; mclose('m-flash'); post('/api/cta/flashmass',{time:t}); };

  function loadEvents(){
    fetch('/api/events').then(function(r){return r.json();}).then(function(list){
      var bar=document.getElementById('ctas'); bar.innerHTML='';
      if(!list.length){ bar.innerHTML='<span style="color:var(--muted)">Nenhum CTA aberto.</span>'; document.getElementById('board').innerHTML='<div class="empty-note">Nenhum CTA aberto agora.</div>'; document.getElementById('reserves').innerHTML=''; document.getElementById('status').innerHTML='<h2>Sem CTA</h2><p>Abra um CTA pra começar.</p>'; current=null; streamLive=false; if(es){es.close();es=null;} if(tes){tes.close();tes=null;} checkConnection(); renderCaller(); return; }
      var stillOpen=false;
      list.forEach(function(e){
        if(e.id===current) stillOpen=true;
        var b=document.createElement('button'); b.textContent='CTA '+e.time; b.className='tab'+(e.id===current?' on':'');
        b.onclick=function(){ Array.prototype.forEach.call(document.querySelectorAll('#ctas .tab'),function(x){x.classList.remove('on');}); b.classList.add('on'); connect(e.id); renderCaller(); };
        bar.appendChild(b);
      });
      if(!stillOpen){ var first=document.querySelector('#ctas .tab'); if(first){ first.classList.add('on'); connect(list[0].id); } }
      renderCaller();
    }).catch(function(){});
  }

  Array.prototype.forEach.call(document.querySelectorAll('.nav[data-view]'),function(b){ b.onclick=function(){ show(b.getAttribute('data-view')); }; });
  document.getElementById('nav-stats').onclick=openStats;
  Array.prototype.forEach.call(document.querySelectorAll('.modal'),function(m){ m.addEventListener('click',function(e){ if(e.target===m) m.classList.remove('open'); }); });

  // ===================== NAVEGAÇÃO / WAZE ZVZ =====================
  var navZoneSearchTimer=null;
  var navDraftByEvent={};
  function navDraftKey(){ return 'global'; }
  function navFormIsFocused(){
    var a=document.activeElement;
    return !!(a && a.closest && a.closest('#view-navigation .nav2-form'));
  }
  function navReadDraftFromDom(){
    var key=navDraftKey(); if(!key) return null;
    var target=document.getElementById('nav-target');
    var type=document.getElementById('nav-type');
    var rarity=document.getElementById('nav-rarity');
    var min=document.getElementById('nav-min');
    var sec=document.getElementById('nav-sec');
    if(!target||!type||!rarity||!min||!sec) return navDraftByEvent[key]||null;
    var d={
      targetZone:target.value||'',
      type:type.value||'VORTEX',
      rarity:rarity.value||'',
      minutes:min.value||'',
      seconds:sec.value||'0',
      dirty:true
    };
    navDraftByEvent[key]=d;
    return d;
  }
  function navDraftForObjective(){
    var key=navDraftKey();
    var d=key?navDraftByEvent[key]:null;
    if(d) return d;
    return { targetZone:'', type:'VORTEX', rarity:'', minutes:'', seconds:'0', dirty:false };
  }
  function navCountdown(seconds){
    if(seconds==null) return 'sem limite';
    var s=Math.max(0,Number(seconds)||0), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), r=Math.floor(s%60);
    return (h?h+'h ':'')+String(m).padStart(2,'0')+':'+String(r).padStart(2,'0');
  }
  function navDelta(seconds){
    if(seconds==null||!isFinite(Number(seconds))) return '—';
    var s=Math.floor(Number(seconds)), neg=s<0; s=Math.abs(s);
    var h=Math.floor(s/3600), m=Math.floor((s%3600)/60), r=s%60;
    var txt=(h?h+'h ':'')+m+'m '+String(r).padStart(2,'0')+'s';
    return neg?'-'+txt:txt;
  }
  function navKind(o){
    if(!o) return 'OBJETIVO';
    var rarity=String(o.rarity||'').toUpperCase(), type=String(o.type||'OBJETIVO').toUpperCase();
    var emoji=rarity==='ROXO'?'🟣':rarity==='AZUL'?'🔵':rarity==='AMARELO'?'🟡':rarity==='VERDE'?'🟢':rarity==='VERMELHO'?'🔴':type==='NODE'?'💎':type==='ORBS'?'🔮':'🎯';
    return emoji+' '+esc(type)+(rarity?' '+esc(rarity):'');
  }
  function navIsTransport(type){
    var t=String(type||'').toUpperCase();
    return t==='VORTEX'||t==='ORBS';
  }
  function navTransportName(type){
    return String(type||'').toUpperCase()==='ORBS'?'ORB':'VORTEX';
  }
  function navRarityChoices(type,selected){
    var t=String(type||'').toUpperCase();
    var arr=t==='NODE'
      ? ['4.4','5.4','6.4','7.4','8.4']
      : t==='ORBS'
        ? []
        : ['ROXO','AZUL','AMARELO','VERDE','VERMELHO'];
    return '<option value="">—</option>'+arr.map(function(x){return '<option'+(String(selected||'')===x?' selected':'')+'>'+x+'</option>';}).join('');
  }
  function syncNavRarityOptions(){
    var type=document.getElementById('nav-type'), rarity=document.getElementById('nav-rarity');
    if(!type||!rarity) return;
    var t=String(type.value||'').toUpperCase();
    var old=rarity.value||'';
    var valid=t==='NODE'
      ? ['4.4','5.4','6.4','7.4','8.4']
      : t==='ORBS'
        ? []
        : ['ROXO','AZUL','AMARELO','VERDE','VERMELHO'];
    rarity.innerHTML=navRarityChoices(type.value,valid.indexOf(old)>=0?old:'');
    rarity.disabled=t==='ORBS';
  }
  function syncNavDestinationHints(clearInvalid){
    var type=document.getElementById('nav-type'), target=document.getElementById('nav-target'), dl=document.getElementById('nav-zone-list');
    if(!type||!target||!dl) return;
    var t=String(type.value||'').toUpperCase();
    target.disabled=false;
    if(navIsTransport(t)){
      target.placeholder='Mapa onde '+navTransportName(t)+' está, ex.: Flammog Fork';
      if(clearInvalid) target.value='';
      dl.innerHTML='';
    } else {
      target.placeholder='Ex.: Flammog Fork';
    }
  }
  function bindNavigationForm(){
    var target=document.getElementById('nav-target');
    var type=document.getElementById('nav-type');
    var rarity=document.getElementById('nav-rarity');
    var min=document.getElementById('nav-min');
    var sec=document.getElementById('nav-sec');

    function keepDraft(){ navReadDraftFromDom(); }

    if(target){
      target.oninput=function(){
        keepDraft();
        if(navZoneSearchTimer) clearTimeout(navZoneSearchTimer);
        navZoneSearchTimer=setTimeout(function(){
          var liveTarget=document.getElementById('nav-target');
          if(!liveTarget) return;
          fetch('/api/navigation/zones?q='+encodeURIComponent(liveTarget.value||''))
            .then(function(r){return r.json();})
            .then(function(d){
              var dl=document.getElementById('nav-zone-list'); if(!dl)return;
              dl.innerHTML=(d.zones||[]).map(function(z){return '<option value="'+esc(z.name)+'"></option>';}).join('');
            }).catch(function(){});
        },180);
      };
    }
    if(type) type.onchange=function(){
      syncNavRarityOptions();
      syncNavDestinationHints(true);
      keepDraft();
    };
    syncNavDestinationHints(false);
    [rarity,min,sec].forEach(function(el){
      if(!el) return;
      el.onchange=keepDraft;
      el.oninput=keepDraft;
    });

    var set=document.getElementById('nav-set');
    if(set) set.onclick=function(){
      var selectedType=document.getElementById('nav-type').value;
      var dest=(document.getElementById('nav-target').value||'').trim();
      if(!dest){ flash('● informe o destino','var(--red)'); return; }
      var payload={
        targetZone:dest,
        type:selectedType,
        rarity:document.getElementById('nav-rarity').value,
        minutes:Number(document.getElementById('nav-min').value||0),
        seconds:Number(document.getElementById('nav-sec').value||0)
      };
      fetch('/api/navigation/objective',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
        .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'erro');return j;});})
        .then(function(){
          delete navDraftByEvent[navDraftKey()];
          flash('● objetivo adicionado à rota','var(--green)');
          renderNavigation();
        })
        .catch(function(e){flash('● '+e.message,'var(--red)');});
    };

    var clear=document.getElementById('nav-clear');
    if(clear) clear.onclick=function(){
      if(!confirm('Limpar TODA a fila global de objetivos da navegação?')) return;
      fetch('/api/navigation/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})
        .then(function(r){return r.json();})
        .then(function(){
          delete navDraftByEvent[navDraftKey()];
          flash('● fila de objetivos limpa','var(--green)');
          renderNavigation();
        })
        .catch(function(){flash('● erro ao limpar','var(--red)');});
    };

    Array.prototype.forEach.call(document.querySelectorAll('[data-nav-pickup]'),function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute('data-nav-pickup');
        var deliveryId=btn.getAttribute('data-delivery-id')||'';
        var deliveryName=btn.getAttribute('data-delivery-name')||'';
        fetch('/api/navigation/pickup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          waypoint:id,deliveryZoneId:deliveryId,deliveryZoneName:deliveryName
        })})
          .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'erro');return j;});})
          .then(function(){flash('● objetivo pego · iniciando transporte','var(--green)');renderNavigation();})
          .catch(function(e){flash('● '+e.message,'var(--red)');});
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-nav-complete]'),function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute('data-nav-complete');
        fetch('/api/navigation/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({waypoint:id})})
          .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'erro');return j;});})
          .then(function(){flash('● objetivo concluído','var(--green)');renderNavigation();})
          .catch(function(e){flash('● '+e.message,'var(--red)');});
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav-remove]'),function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute('data-nav-remove');
        if(!confirm('Remover este objetivo da rota?')) return;
        fetch('/api/navigation/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({waypoint:id})})
          .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'erro');return j;});})
          .then(function(){flash('● objetivo removido','var(--green)');renderNavigation();})
          .catch(function(e){flash('● '+e.message,'var(--red)');});
      };
    });
  }

  function renderNavigation(silent){
    if(silent && navFormIsFocused()) return;
    if(!silent) loading('view-navigation','🧭 Navegação');

    fetchTelemetry('/api/navigation/state').then(function(d){
      var queue=d.objectives||[], o=d.objective||null, cur=d.current||null, inst=d.instruction||null;
      var legs=(d.itinerary&&d.itinerary.legs)||[];
      var draft=navDraftForObjective();
      var form=authState.canEdit
        ? '<div class="nav2-card"><h3>ADICIONAR OBJETIVO À ROTA</h3><div class="nav2-form">'
          +'<div class="nav2-field"><label>Mapa de destino</label><input id="nav-target" list="nav-zone-list" placeholder="Ex.: Flammog Fork" value="'+esc(draft.targetZone||'')+'"><datalist id="nav-zone-list"></datalist></div>'
          +'<div class="nav2-row"><div class="nav2-field"><label>Tipo</label><select id="nav-type">'
          +['VORTEX','ORBS','NODE','TERRITÓRIO','CASTELO','OUTPOST','OBJETIVO'].map(function(x){return '<option'+(String(draft.type||'VORTEX')===x?' selected':'')+'>'+x+'</option>';}).join('')
          +'</select></div><div class="nav2-field"><label>Raridade / tier</label><select id="nav-rarity">'+navRarityChoices(draft.type,draft.rarity)+'</select></div></div>'
          +'<div class="nav2-row"><div class="nav2-field"><label>Tempo restante: minutos</label><input id="nav-min" type="number" min="0" max="240" value="'+esc(draft.minutes==null?'':draft.minutes)+'"></div>'
          +'<div class="nav2-field"><label>Segundos</label><input id="nav-sec" type="number" min="0" max="59" value="'+esc(draft.seconds==null?'0':draft.seconds)+'"></div></div>'
          +'<div class="nav2-actions"><button class="btn primary" id="nav-set">＋ Adicionar à rota</button>'
          +(queue.length?'<button class="btn danger" id="nav-clear">Limpar fila</button>':'')+'</div>'
          +'<div style="color:var(--faint);font-size:9px;margin-top:6px">VORTEX/ORB: informe o mapa onde o objetivo foi encontrado. Se já estivermos nesse mapa, o Waze prioriza ficar para a coleta quando isso não fizer outro objetivo ser perdido; chegando cedo, manda aguardar o horário. Vortex entrega em Thunderrock Upland, Rivercopse Curve, Giantweald Woods ou Deepwood Pines. Orb entrega nos HOs de Thunderrock Upland, Deepwood Pines, Murdergulch Trail, Sandmount Ascent ou Timberscar Copse. NODE: 4.4 / 5.4 / 6.4 / 7.4 / 8.4. ETA inicial: '+esc((d.itinerary&&d.itinerary.secondsPerMap)||90)+'s por mapa.</div>'
          +'</div></div>'
        : '';

      var currentHtml=cur
        ? '<div class="nav2-current"><div class="nav2-stat"><small>Mapa atual do zerg</small><b>'+esc((cur.zone&&cur.zone.name)||cur.clusterName||'?')+'</b></div>'
          +'<div class="nav2-stat"><small>Clients confirmando</small><b>'+esc(cur.observers||0)+'</b></div></div>'
        : '<div class="nav2-empty">📡 Aguardando <b>zone_change</b> do Combat Client v0.5.8+.</div>';

      var next='';
      if(o&&cur){
        var firstLeg=legs[0]||{}, firstType=String(o.type||'').toUpperCase(), firstTransport=navIsTransport(firstType), firstName=navTransportName(firstType), firstCarrying=String(o.status||'').toLowerCase()==='carrying';
        if(inst&&inst.waiting){
          next='<div class="nav2-next"><small>AGUARDAR NO MAPA</small><strong>⏳ '+esc(o.targetZoneName)+'</strong><div style="margin-top:4px;color:#8eacc4;font-size:10px">Já estamos no mapa certo. Faltam '+esc(navDelta(inst.waitSeconds||0))+' para o objetivo; não saia para voltar depois.</div></div>';
        } else if(inst&&inst.arrived){
          if(firstTransport&&!firstCarrying) next='<div class="nav2-next"><small>'+esc(firstName)+' #1</small><strong>🔮 PEGAR EM '+esc(o.targetZoneName)+'</strong><div style="margin-top:4px;color:#8eacc4;font-size:10px">Depois clique em “'+esc(firstName)+' pego”; o Waze muda para a rota de entrega em '+esc(o.deliveryZoneName||firstLeg.delivery&&firstLeg.delivery.zoneName||'?')+'.</div></div>';
          else if(firstCarrying) next='<div class="nav2-next"><small>ENTREGA · '+esc(firstName)+'</small><strong>📦 '+esc(o.deliveryZoneName||firstLeg.delivery&&firstLeg.delivery.zoneName||'?')+'</strong><div style="margin-top:4px;color:#8eacc4;font-size:10px">Depois de entregar, marque como entregue.</div></div>';
          else next='<div class="nav2-next"><small>OBJETIVO #1</small><strong>✅ '+esc(o.targetZoneName)+'</strong></div>';
        } else if(inst) {
          next='<div class="nav2-next"><small>'+(firstCarrying?'TRANSPORTANDO '+esc(firstName):'PRÓXIMA SAÍDA')+'</small><strong>'+esc(inst.exit)+' → '+esc(inst.next&&inst.next.name||'?')+'</strong><div style="margin-top:4px;color:#8eacc4;font-size:10px">'+esc(inst.mapsRemaining)+' mapa(s) restantes nesta etapa</div></div>';
        } else next='<div class="nav2-next"><small>ROTA</small><strong>⚠️ AGUARDANDO POSIÇÃO/ROTA</strong></div>';
      }

      var queueHtml='';
      if(queue.length){
        queueHtml='<div class="nav2-queue">'+legs.map(function(leg){
          var obj=leg.objective||{};
          var massClass=(leg.massInSeconds!=null&&Number(leg.massInSeconds)<=0)?' late':'';
          var massClock=leg.massBy?new Date(leg.massBy).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'';
          var waitingHere=Number(leg.index)===1&&Number(leg.waitSeconds||0)>0&&leg.pickup&&Number(leg.pickup.maps||0)===0;
          var mass=waitingHere
            ? '<div class="nav2-mass">⏳ AGUARDAR AQUI · '+navDelta(leg.waitSeconds||0)+' até o objetivo</div>'
            : leg.massInSeconds==null
              ? ''
              : '<div class="nav2-mass'+massClass+'">'+(Number(leg.massInSeconds)<=0?'🚨 MASSAR/SAIR AGORA':'📣 MASSAR/SAIR EM '+navDelta(leg.massInSeconds)+(massClock?' · ATÉ '+esc(massClock):''))+'</div>';
          var deadline=obj.expiresAt
            ? '<span>⏳ '+(obj.ready?'PRONTO':navCountdown(obj.remainingSeconds))+'</span>'
            : '<span>⏳ sem limite</span>';
          function stepHtml(route,label){
            if(!route||!route.ok||!route.steps) return '';
            return '<div class="nav2-leg"><b>'+esc(label)+'</b><div class="nav2-legsteps">'+route.steps.slice(0,8).map(function(s){
              return s.next
                ? '<span>'+esc(s.zone&&s.zone.name||'?')+' · <b>'+esc(s.exit)+'</b> → '+esc(s.next.name)+'</span>'
                : '<span>✅ '+esc(s.zone&&s.zone.name||'?')+'</span>';
            }).join('')+'</div></div>';
          }
          var objectiveType=String(obj.type||'').toUpperCase();
          var isTransport=navIsTransport(objectiveType);
          var transportName=navTransportName(objectiveType);
          var carrying=String(obj.status||'').toLowerCase()==='carrying';
          var routeSteps='';
          if(isTransport&&!carrying){
            routeSteps=stepHtml(leg.pickup&&leg.pickup.route,'1. BUSCAR '+transportName+': '+(leg.from||'posição atual')+' → '+obj.targetZoneName)
              +stepHtml(leg.delivery&&leg.delivery.route,'2. CARREGAR '+transportName+': '+obj.targetZoneName+' → '+((leg.delivery&&leg.delivery.zoneName)||obj.deliveryZoneName||'?'));
          } else if(carrying){
            routeSteps=stepHtml(leg.delivery&&leg.delivery.route,'TRANSPORTAR '+transportName+': '+(leg.from||'posição atual')+' → '+((leg.delivery&&leg.delivery.zoneName)||obj.deliveryZoneName||'?'));
          } else {
            routeSteps=stepHtml(leg.route,'TRAJETO: '+(leg.from||'posição atual')+' → '+(leg.to||'?'));
          }
          var acts='';
          if(authState.canEdit){
            var arrivedHere=Number(leg.index)===1&&leg.route&&leg.route.ok&&leg.route.steps&&leg.route.steps.length===1;
            if(isTransport&&!carrying&&leg.delivery&&leg.delivery.zoneId){
              if(arrivedHere&&Number(leg.waitSeconds||0)<=0){
                acts='<div class="nav2-qactions"><button class="btn primary" data-nav-pickup="'+esc(obj.id)+'" data-delivery-id="'+esc(leg.delivery.zoneId)+'" data-delivery-name="'+esc(leg.delivery.zoneName)+'">🔮 '+esc(transportName)+' pego</button><button class="btn danger" data-nav-remove="'+esc(obj.id)+'">✕ Remover</button></div>';
              } else {
                acts='<div class="nav2-qactions"><button class="btn ghost" disabled>'+(arrivedHere?'⏳ Aguardar '+esc(navDelta(leg.waitSeconds||0)):'🔒 Aguardar vez')+'</button><button class="btn danger" data-nav-remove="'+esc(obj.id)+'">✕ Remover</button></div>';
              }
            } else if(carrying){
              acts='<div class="nav2-qactions"><button class="btn ghost" '+(arrivedHere?'data-nav-complete="'+esc(obj.id)+'"':'disabled')+'>'+(arrivedHere?'✓ Entregue':'📦 Em transporte')+'</button><button class="btn danger" data-nav-remove="'+esc(obj.id)+'">✕ Remover</button></div>';
            } else {
              var canComplete=arrivedHere&&Number(leg.waitSeconds||0)<=0;
              acts='<div class="nav2-qactions"><button class="btn ghost" '+(canComplete?'data-nav-complete="'+esc(obj.id)+'"':'disabled')+'>'+(canComplete?'✓ Concluído':(arrivedHere?'⏳ Aguardar '+esc(navDelta(leg.waitSeconds||0)):'🔒 Aguardar vez'))+'</button><button class="btn danger" data-nav-remove="'+esc(obj.id)+'">✕ Remover</button></div>';
            }
          }
          var targetLine=isTransport
            ? (carrying?'📦 Entregar em '+esc(obj.deliveryZoneName||leg.delivery&&leg.delivery.zoneName||'?'):'🔮 Buscar '+esc(transportName)+' em '+esc(obj.targetZoneName)+' → entregar em '+esc(obj.deliveryZoneName||leg.delivery&&leg.delivery.zoneName||'?'))
            : esc(obj.targetZoneName);
          var transportMeta=isTransport
            ? (carrying
                ? '<span>📦 '+esc(leg.delivery&&leg.delivery.maps!=null?leg.delivery.maps:'?')+' mapa(s) de transporte</span>'
                : '<span>🔎 '+esc(leg.pickup&&leg.pickup.maps!=null?leg.pickup.maps:'?')+' buscar + 📦 '+esc(leg.delivery&&leg.delivery.maps!=null?leg.delivery.maps:'?')+' transportar</span>')
            : '';
          return '<div class="nav2-qitem"><div class="nav2-qtop"><span class="nav2-qnum">'+esc(leg.index)+'</span><div class="nav2-qmain">'
            +'<div class="nav2-qkind">'+navKind(obj)+(carrying?' · CARREGANDO':'')+'</div><div class="nav2-qtarget">'+targetLine+'</div>'
            +'<div class="nav2-qmeta">'+(carrying?'':deadline)+transportMeta
            +(leg.maps!=null?'<span>🗺️ total '+esc(leg.maps)+' mapa(s)</span>':'')
            +(leg.travelSeconds!=null?'<span>🚕 ~'+navDelta(leg.travelSeconds)+'</span>':'')
            +(leg.slackSeconds!=null?'<span>margem '+navDelta(leg.slackSeconds)+'</span>':'')
            +'</div>'+(carrying?'':mass)+routeSteps
            +acts+'</div></div></div>';
        }).join('')+'</div>';
      } else {
        queueHtml='<div class="nav2-empty">Nenhum objetivo pendente. Adicione os objetivos sem se preocupar com a ordem; o bot monta a sequência.</div>';
      }

      var spread=(d.positions&&d.positions.zones)||[];
      var spreadHtml=spread.length
        ? '<div class="nav2-spread"><h3 style="margin:12px 0 0">POSIÇÃO DOS CLIENTS</h3>'+spread.map(function(z){
            return '<div class="nav2-spread-row"><span>'+esc((z.zone&&z.zone.name)||z.clusterName||'?')+'</span><b>'+esc(z.count)+' client(s)</b></div>';
          }).join('')+'</div>'
        : '';

      var opt=(d.itinerary&&d.itinerary.optimization)||{};
      var optimizerNote='<div style="margin:0 0 10px;padding:8px 9px;border:1px solid #3a4b61;border-radius:8px;background:#0d151f;color:#9fb4cd;font-size:9px">🧠 <b>ORDEM AUTOMÁTICA</b> · primeiro evita perder horários; se Vortex/Orb já estiver no mapa atual, prefere ficar e aguardar a coleta em vez de sair e voltar, desde que isso não faça outro objetivo ser perdido. Depois otimiza horários, entrega e distância.</div>';
      var right='<div class="nav2-card"><h3>ROTA OTIMIZADA</h3>'+optimizerNote+currentHtml+next+queueHtml+spreadHtml+'</div>';
      var html='<div class="nav2-shell"><div class="nav2-head"><div><h2>🧭 Waze da Black</h2><p>Navegação global da guilda: funciona com ou sem CTA aberto. Você cadastra os objetivos sem ordenar e o bot escolhe a sequência usando deadline e distância entre mapas.</p></div>'
        +'<span class="nav2-status">'+esc(queue.length)+' objetivo(s) · '+esc((d.graph&&d.graph.zones)||0)+' mapas</span></div>'
        +'<div class="nav2-layout">'+form+right+'</div></div>';
      setView('view-navigation',html);
      bindNavigationForm();
    }).catch(function(){
      setView('view-navigation','<div class="modhead">🧭 Navegação</div><div class="empty-note">Não foi possível carregar a navegação.</div>');
    });
  }

  // ===================== DADOS DO JOGO — TELEMETRIA REAL =====================
  function fmtS(v){ if(v==null) return '—'; if(v>=1e6) return (v/1e6).toFixed(v>=1e7?0:1).replace('.',',')+'M'; if(v>=1e3) return Math.round(v/1e3)+'K'; return String(v); }
  function pad2(v){ return String(v).padStart(2,'0'); }
  function fmtUtcDate(ts){
    var d=new Date(ts||0); if(!isFinite(d.getTime())) return 'data desconhecida';
    return pad2(d.getUTCDate())+'/'+pad2(d.getUTCMonth()+1)+'/'+d.getUTCFullYear();
  }
  function fmtUtcTime(ts,withSeconds){
    var d=new Date(ts||0); if(!isFinite(d.getTime())) return '—';
    return pad2(d.getUTCHours())+':'+pad2(d.getUTCMinutes())+(withSeconds?(':'+pad2(d.getUTCSeconds())):'');
  }
  function fmtUtcDateTime(ts,withSeconds){
    var d=new Date(ts||0); if(!isFinite(d.getTime())) return '—';
    return fmtUtcDate(d)+' '+fmtUtcTime(d,!!withSeconds)+' UTC';
  }
  function ctaHistoryLabel(x){
    x=x||{};
    var stamp=x.ctaAt||x.createdAt||x.closedAt;
    var day=fmtUtcDate(stamp);
    var time=String(x.time||'').trim() || fmtUtcTime(stamp,false);
    return day+' · CTA '+time+' UTC';
  }
  function liveBadge(note){ return '<div class="preview" style="color:#8ce5ad;background:#10241a;border-color:#214f31">● Telemetria conectada'+(note?' · '+esc(note):'')+'</div>'; }
  function loading(id,title){ document.getElementById(id).innerHTML='<div class="modhead">'+title+'</div><div class="empty-note">Carregando telemetria…</div>'; }
  function noCta(id,title){ document.getElementById(id).innerHTML='<div class="modhead">'+title+'</div><div class="empty-note">Selecione/abra um CTA para visualizar estes dados.</div>'; }
  function fetchTelemetry(path){ return fetch(path).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }); }

  function topList(arr, fmt){ arr=arr||[]; var mx=arr.reduce(function(a,b){return Math.max(a,b.v||0);},1);
    if(!arr.length) return '<div class="empty-note">Sem dados ainda.</div>';
    return '<div class="toplist">'+arr.map(function(r,i){ return '<div class="toprow"><span class="rk">'+(i+1)+'</span><span class="nm">'+esc(r.n)+'</span><span class="bar"><i style="width:'+Math.round((r.v||0)/mx*100)+'%"></i></span><span class="val">'+fmt(r.v||0)+'</span></div>'; }).join('')+'</div>'; }

  // ===================== SCOUT / DESEMPENHO =====================
  var scoutCache=null;
  function renderScout(silent){
    if(!silent) loading('view-scout','📊 Scout');
    fetch('/api/scout').then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }).then(function(d){
      scoutCache=d;
      var rows=d.rows||[];
      var season=d.season||null;
      if(!season){
        setView('view-scout','<div class="modhead">📊 Scout</div><div class="empty-note">Nenhuma temporada encontrada.</div>');
        return;
      }
      var roleOptions=['Todos','Tank','Support','Healer','Melee','Ranged','Looter','Sem função'];
      var head='<div class="modhead">📊 Scout · Temporada '+esc(season.number)+(season.active?' · em andamento':' · encerrada')+'</div>'
        +'<div class="statgrid">'
        +'<div class="stat b"><div class="k">CTAs encerrados</div><div class="v">'+fmtS(d.ctaCount||0)+'</div></div>'
        +'<div class="stat g"><div class="k">CTAs com histórico</div><div class="v">'+fmtS(d.capturedCtas||0)+'</div></div>'
        +'<div class="stat a"><div class="k">Jogadores</div><div class="v">'+fmtS(rows.length)+'</div></div>'
        +'</div>'
        +'<div class="panel"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">'
        +'<div><div class="note">Buscar jogador</div><input id="scout-q" class="brief-input" placeholder="Nome..." style="min-width:220px"></div>'
        +'<div><div class="note">Função</div><select id="scout-role" class="brief-select">'+roleOptions.map(function(x){return '<option value="'+esc(x)+'">'+esc(x)+'</option>';}).join('')+'</select></div>'
        +'</div><div class="note" style="margin-top:10px">Os números de combate são os mesmos valores deduplicados da tela Combate. Cobertura indica em quantos CTAs com presença existe dado de combate do jogador. Ainda não há nota automática de Core.</div></div>'
        +'<div id="scout-table"></div>';
      setView('view-scout',head);
      function draw(){
        var q=(document.getElementById('scout-q').value||'').trim().toLowerCase();
        var role=document.getElementById('scout-role').value;
        var list=rows.filter(function(x){
          if(q && String(x.playerName||'').toLowerCase().indexOf(q)<0) return false;
          if(role!=='Todos' && String(x.role||'Sem função')!==role) return false;
          return true;
        });
        var body='<div class="panel"><div style="overflow-x:auto"><table class="dtable"><thead><tr>'
          +'<th>Jogador</th><th>Função</th><th>Core</th><th>Presença</th><th>Min</th><th>Dano/min</th><th>Cura/min</th><th>Kills</th><th>Mortes</th><th>Fights</th><th>PT correta</th><th>IP médio</th><th>Cobertura</th><th>Confiança</th>'
          +'</tr></thead><tbody>';
        body += list.length ? list.map(function(x){
          var pc=x.partyCorrectPct==null?'—':(x.partyCorrectPct+'%');
          var ip=x.avgItemPower==null?'—':fmtS(x.avgItemPower);
          var cov=(x.coveragePct||0)+'%';
          return '<tr>'
            +'<td><b>'+esc(x.playerName||'?')+'</b></td>'
            +'<td>'+esc(x.role||'Sem função')+'</td>'
            +'<td>'+(x.coreVerified?'⭐':'—')+'</td>'
            +'<td><b>'+esc(x.presencePct||0)+'%</b> <span style="color:var(--faint)">('+fmtS(x.attendedCtas||0)+'/'+fmtS(d.ctaCount||0)+')</span></td>'
            +'<td>'+fmtS(x.voiceMinutes||0)+'</td>'
            +'<td>'+fmtS(x.damagePerMinute||0)+'</td>'
            +'<td>'+fmtS(x.healingPerMinute||0)+'</td>'
            +'<td>'+fmtS(x.kills||0)+'</td>'
            +'<td>'+fmtS(x.deaths||0)+'</td>'
            +'<td>'+fmtS(x.fights||0)+'</td>'
            +'<td>'+esc(pc)+'</td>'
            +'<td>'+esc(ip)+'</td>'
            +'<td>'+esc(cov)+' <span style="color:var(--faint)">('+fmtS(x.combatCtas||0)+' CTAs)</span></td>'
            +'<td>'+esc(x.confidence||'baixa')+'</td>'
            +'</tr>';
        }).join('') : '<tr><td colspan="14" style="color:var(--faint)">Nenhum jogador com esse filtro.</td></tr>';
        body+='</tbody></table></div></div>';
        document.getElementById('scout-table').innerHTML=body;
      }
      document.getElementById('scout-q').addEventListener('input',draw);
      document.getElementById('scout-role').addEventListener('change',draw);
      draw();
    }).catch(function(){
      setView('view-scout','<div class="modhead">📊 Scout</div><div class="empty-note">Não foi possível carregar os dados do Scout.</div>');
    });
  }

  function renderConfirm(silent){
    if(!current){ noCta('view-confirm','🎯 Validação do CTA'); return; }
    if(!silent) loading('view-confirm','🎯 Validação do CTA');

    fetchTelemetry('/api/telemetry/confirm?event='+encodeURIComponent(current)).then(function(d){
      var r=d.resumo||{}, m=d.meta||{}, evt=d.event||{};
      var groups=(d.issuesByParty||[]).slice().sort(function(a,b){return Number(a.party)-Number(b.party);});
      var allRows=[];
      (d.pts||[]).forEach(function(g){ (g.linhas||[]).forEach(function(x){ allRows.push(x); }); });

      var filterKey=String(current);
      if(!Object.prototype.hasOwnProperty.call(confirmPartySelection,filterKey)){
        var stored=null;
        try{ stored=sessionStorage.getItem('imortais:confirm-party-filter:'+filterKey); }catch(_e){}
        confirmPartySelection[filterKey]=(stored&&stored!=='all'&&Number.isFinite(Number(stored)))?Number(stored):null;
      }
      var selectedParty=confirmPartySelection[filterKey];
      var availableParties=groups.map(function(g){return Number(g.party);}).filter(function(p){return Number.isFinite(p);});
      if(selectedParty!=null&&availableParties.indexOf(Number(selectedParty))<0){
        selectedParty=null;
        confirmPartySelection[filterKey]=null;
      }
      function savePartyFilter(value){
        confirmPartySelection[filterKey]=value==null?null:Number(value);
        try{ sessionStorage.setItem('imortais:confirm-party-filter:'+filterKey,value==null?'all':String(value)); }catch(_e){}
      }
      var filteredRows=selectedParty==null
        ? allRows
        : allRows.filter(function(x){return Number(x.plannedParty)===Number(selectedParty)||Number(x.actualParty)===Number(selectedParty);});

      function clamp(v){ return Math.max(0,Math.min(100,Number(v)||0)); }
      function pct(v,total){ return total?clamp(Math.round((Number(v)||0)/total*100)):0; }
      function age(ts){
        if(!ts) return 'sem snapshot';
        var n=Number(ts), t=Number.isFinite(n)?n:new Date(ts).getTime();
        if(!Number.isFinite(t)) return 'sem snapshot';
        var sec=Math.max(0,Math.round((Date.now()-t)/1000));
        if(sec<60) return sec+'s atrás';
        if(sec<3600) return Math.floor(sec/60)+'min atrás';
        return Math.floor(sec/3600)+'h atrás';
      }
      function metric(cls,title,value,sub,progress){
        return '<div class="cv2-kpi '+cls+'"><div class="k">'+esc(title)+'</div><div class="v">'+esc(value)+'</div><div class="s">'+esc(sub||'')+'</div>'
          +(progress==null?'':'<div class="cv2-minibar" style="color:currentColor"><i style="width:'+clamp(progress)+'%"></i></div>')+'</div>';
      }
      function albionPill(st){
        if(st==='online') return '<span class="cv2-pill good">ALBION ON</span>';
        if(st==='offline') return '<span class="cv2-pill bad">ALBION OFF</span>';
        return '<span class="cv2-pill neutral">ALBION —</span>';
      }
      function discordPill(flag){
        return flag?'<span class="cv2-pill good">NA CALL</span>':'<span class="cv2-pill warn">FORA DA CALL</span>';
      }
      function statusPill(x){
        if(x.categoria==='pronto') return '<span class="cv2-pill good">PRONTO</span>';
        if(x.categoria==='pt_errada') return '<span class="cv2-pill purple">PT ERRADA</span>';
        if(x.categoria==='off_pingou') return '<span class="cv2-pill bad">PINGOU · OFF</span>';
        if(x.categoria==='fora_pt') return '<span class="cv2-pill warn">FORA DA PT</span>';
        if(x.categoria==='online_fora_call') return '<span class="cv2-pill warn">FORA DA CALL</span>';
        return '<span class="cv2-pill neutral">INDEFINIDO</span>';
      }
      function textClass(x){
        if(x.categoria==='pronto') return 'cv2-good';
        if(x.categoria==='pt_errada') return 'cv2-purple';
        if(x.categoria==='off_pingou') return 'cv2-bad';
        if(x.categoria==='fora_pt'||x.categoria==='online_fora_call') return 'cv2-warn';
        return 'cv2-muted';
      }
      function partyStats(g){
        var correct=(g.correct||[]).length, missing=(g.missing||[]).length, intruders=(g.intruders||[]).length;
        var planned=correct+missing;
        return {correct:correct,missing:missing,intruders:intruders,planned:planned,score:planned?Math.round(correct/planned*100):0,problems:missing+intruders};
      }
      function slotState(x){
        if(!x) return 'empty';
        if(x.categoria==='off_pingou'||x.albion==='offline') return 'off';
        if(x.st==='wrong'||x.categoria==='pt_errada') return 'wrong';
        if(x.st==='ok') return 'ok';
        return 'miss';
      }
      function slotMap(g){
        var bySlot={};
        (g.correct||[]).forEach(function(x){ if(x.slot!=null) bySlot[Number(x.slot)]=x; });
        (g.missing||[]).forEach(function(x){ if(x.slot!=null&&!bySlot[Number(x.slot)]) bySlot[Number(x.slot)]=x; });
        var out='<div class="cv2-slotmap">';
        for(var i=1;i<=20;i++){
          var x=bySlot[i]||null;
          var tip=x?('Slot '+i+' · '+x.n+' · '+(x.categoriaLabel||x.obs||'')):('Slot '+i+' · sem dado');
          out+='<i class="cv2-slot '+slotState(x)+'" data-tip="'+esc(tip)+'"></i>';
        }
        return out+'</div>';
      }
      function ringColor(score){
        if(score>=90) return '#42c77a';
        if(score>=80) return '#4a97ff';
        if(score>=70) return '#e2b95e';
        return '#ef6672';
      }

      var total=Math.max(Number(r.inscritos)||0,1);
      var head='<div class="cv2-head"><div><div class="cv2-title"><h2>🎯 Validação do CTA</h2><span class="cta">CTA '+esc(evt.time||'?')+' UTC · #'+esc(evt.id||current)+'</span></div>'
        +'<div class="cv2-sub">Escala x party observada x Discord x estado do Albion · último estado de party '+esc(age(m.latestPartyAt))+'</div></div>'
        +'<div class="cv2-live"><i></i> telemetria conectada</div></div>';

      var kpis='<div class="cv2-kpis">'
        +metric('purple','Prontidão',String(r.prontidao||0)+'%',String(r.corretos||0)+' de '+String(r.inscritos||0)+' inscritos na PT correta',r.prontidao||0)
        +metric('good','Na PT correta',r.corretos||0,'posição confirmada',pct(r.corretos,total))
        +metric('bad','PT errada',r.ptErrada||0,'precisam trocar de PT',pct(r.ptErrada,total))
        +metric('warn','Não vistos em PT',r.foraParty||0,'sem party observada',pct(r.foraParty,total))
        +metric('blue','Na call Discord',r.discord||0,'presença na call de preparação',pct(r.discord,total))
        +'</div>';

      var residual=Math.max(0,total-(Number(r.corretos)||0)-(Number(r.ptErrada)||0)-(Number(r.foraParty)||0));
      var dist='<div class="cv2-panel"><div class="cv2-panel-head"><h3>Status de validação do CTA</h3><small>'+esc(String(r.inscritos||0))+' inscritos</small></div>'
        +'<div class="cv2-distribution"><div class="cv2-segmentbar">'
        +'<i style="width:'+pct(r.corretos,total)+'%;background:#42c77a"></i>'
        +'<i style="width:'+pct(r.ptErrada,total)+'%;background:#9a6cff"></i>'
        +'<i style="width:'+pct(r.foraParty,total)+'%;background:#e2b95e"></i>'
        +'<i style="width:'+pct(residual,total)+'%;background:#53637a"></i></div>'
        +'<div class="cv2-distlegend">'
        +'<div class="cv2-distitem"><i style="background:#42c77a"></i><span>PT correta</span><b>'+esc(r.corretos||0)+'</b></div>'
        +'<div class="cv2-distitem"><i style="background:#9a6cff"></i><span>PT errada</span><b>'+esc(r.ptErrada||0)+'</b></div>'
        +'<div class="cv2-distitem"><i style="background:#e2b95e"></i><span>Não visto</span><b>'+esc(r.foraParty||0)+'</b></div>'
        +'<div class="cv2-distitem"><i style="background:#53637a"></i><span>Outros estados</span><b>'+esc(residual)+'</b></div>'
        +'</div></div></div>';

      function ptSituation(x,party){
        if(Number(x.plannedParty)===party&&Number(x.actualParty)===party) return {label:'CORRETO',cls:'ok',order:0};
        if(Number(x.plannedParty)===party&&x.actualParty==null) return {label:'DEVERIA ESTAR AQUI · NÃO VISTO',cls:'miss',order:1};
        if(Number(x.plannedParty)===party&&Number(x.actualParty)!==party) return {label:'DEVERIA ESTAR AQUI · ESTÁ '+esc(x.actualPartyLabel||('PT '+x.actualParty)),cls:'wrong',order:2};
        if(Number(x.actualParty)===party&&Number(x.plannedParty)!==party) return {label:'NÃO DEVERIA ESTAR AQUI · '+(x.plannedParty!=null?('ESCALADO PT '+x.plannedParty):'SEM ESCALA'),cls:'intruder',order:3};
        return {label:'—',cls:'',order:9};
      }
      function ptAuditSection(g){
        var party=Number(g.party), seen={}, rows=[];
        function push(x){
          if(!x||!x.n) return;
          var key=String(x.n).toLowerCase()+'|'+String(x.plannedParty)+'|'+String(x.actualParty);
          if(seen[key]) return;
          seen[key]=1; rows.push(x);
        }
        (g.correct||[]).forEach(push);
        (g.missing||[]).forEach(push);
        (g.intruders||[]).forEach(push);
        (d.gameNoSignup||[]).forEach(function(x){if(Number(x.actualParty)===party) push(x);});
        rows.sort(function(a,b){
          var sa=ptSituation(a,party), sb=ptSituation(b,party);
          if(sa.order!==sb.order) return sa.order-sb.order;
          var as=Number(a.slot), bs=Number(b.slot);
          if(Number.isFinite(as)&&Number.isFinite(bs)&&as!==bs) return as-bs;
          return String(a.n).localeCompare(String(b.n),'pt-BR');
        });
        var planned=allRows.filter(function(x){return Number(x.plannedParty)===party;});
        var correct=planned.filter(function(x){return Number(x.actualParty)===party;}).length;
        var missing=planned.filter(function(x){return x.actualParty==null;}).length;
        var wrong=planned.filter(function(x){return x.actualParty!=null&&Number(x.actualParty)!==party;}).length;
        var intruders=rows.filter(function(x){return Number(x.actualParty)===party&&Number(x.plannedParty)!==party;}).length;
        var body=rows.length?rows.map(function(x){
          var s=ptSituation(x,party);
          return '<tr><td class="cv2-pt-audit-player"><b>'+esc(x.n)+'</b><span>'+esc(x.arma||'')+'</span></td>'
            +'<td>'+esc(x.slot==null?'—':x.slot)+'</td>'
            +'<td>'+esc(x.plannedParty!=null?('PT '+x.plannedParty):'SEM ESCALA')+'</td>'
            +'<td>'+esc(x.actualPartyLabel||'NÃO VISTO')+'</td>'
            +'<td><span class="cv2-pt-status '+s.cls+'">'+s.label+'</span></td>'
            +'<td>'+discordPill(!!x.discord)+'</td><td>'+albionPill(x.albion||'unknown')+'</td></tr>';
        }).join(''):'<tr><td colspan="7" class="cv2-muted" style="padding:14px">Nenhum jogador relacionado a esta PT.</td></tr>';
        return '<section class="cv2-pt-audit '+(selectedParty===party?'selected':'')+'"><div class="cv2-pt-audit-head"><h3>PT '+party+'</h3>'
          +'<div class="cv2-pt-audit-meta"><span>Escalados <b>'+planned.length+'</b></span><span>Corretos <b>'+correct+'</b></span>'
          +'<span>Não vistos <b>'+missing+'</b></span><span>Em outra PT <b>'+wrong+'</b></span><span>Intrusos <b>'+intruders+'</b></span></div></div>'
          +'<div class="cv2-pt-audit-tablebox"><table class="cv2-pt-audit-table"><thead><tr><th>JOGADOR</th><th>SLOT</th><th>DEVERIA</th><th>ESTÁ</th><th>SITUAÇÃO</th><th>DISCORD</th><th>ALBION</th></tr></thead><tbody>'+body+'</tbody></table></div></section>';
      }

      var partyCards='';
      groups.forEach(function(g){
        var s=partyStats(g), color=ringColor(s.score), party=Number(g.party);
        var extraIntruders=(d.gameNoSignup||[]).filter(function(x){return Number(x.actualParty)===party;}).length;
        var problemCount=s.missing+s.intruders+extraIntruders;
        var selected=selectedParty!=null&&Number(selectedParty)===party;
        partyCards+='<div class="cv2-party '+(s.problems||extraIntruders?'problem ':'')+(selected?'selected ':'')+(selectedParty!=null&&!selected?'dim':'')+'" data-confirm-party="'+party+'"><div class="cv2-party-head"><div><div class="cv2-party-name">PT '+party+' <span class="cv2-party-badge '+(problemCount?'':'ok')+'">'+problemCount+'</span></div>'
          +'<div class="cv2-party-meta"><span>'+s.correct+' corretos</span><span>'+s.missing+' não vistos</span><span>'+(s.intruders+extraIntruders)+' intrusos</span></div></div>'
          +'<div class="cv2-party-score" style="color:'+color+'">'+s.correct+'/20</div></div>'
          +'<div class="cv2-ring-wrap"><div class="cv2-ring" style="background:conic-gradient('+color+' '+clamp(s.score)+'%,#202b3a 0)"><b>'+s.score+'%</b></div></div>'
          +slotMap(g)+'</div>';
      });
      if(!partyCards) partyCards='<div class="empty-note">Ainda não há party observada suficiente para montar o painel das PTs.</div>';

      var filterbar='<div class="cv2-filterbar"><button class="cv2-filterbtn '+(selectedParty==null?'on':'')+'" data-confirm-party-all="1">TODAS</button>'
        +availableParties.map(function(p){return '<button class="cv2-filterbtn '+(Number(selectedParty)===p?'on':'')+'" data-confirm-party-btn="'+p+'">PT '+p+'</button>';}).join('')
        +'<span class="cv2-filterhint">TODAS: PT1, depois PT2, depois PT3 · clique numa PT apenas para isolar</span></div>';

      var auditGroups=selectedParty==null?groups:groups.filter(function(g){return Number(g.party)===Number(selectedParty);});
      var partyAudit='<div class="cv2-pt-stack">'+auditGroups.map(ptAuditSection).join('')+'</div>';

      var parties=filterbar+'<div class="cv2-party-grid">'+partyCards+'</div>'
        +'<div class="cv2-legend"><span><i style="background:#1d7446;border:1px solid #2d9c5c"></i>correto</span>'
        +'<span><i style="background:#614817;border:1px solid #a77b26"></i>não visto</span>'
        +'<span><i style="background:#71242c;border:1px solid #b23741"></i>offline</span>'
        +'<span><i style="background:#4b2d73;border:1px solid #8052ba"></i>PT errada</span>'
        +'<span><i style="background:#1c2632;border:1px solid #334052"></i>sem dado</span></div>'
        +partyAudit;

      var equipmentByPlayer={};
      allRows.forEach(function(x){
        if(x&&x.equipment){
          equipmentByPlayer[String(x.n||'').trim().toLowerCase()]={
            name:x.n,
            itemPower:x.itemPower,
            inspected:!!x.equipmentInspected,
            observedAt:x.equipmentObservedAt,
            equipment:x.equipment
          };
        }
      });

      function attr(s){
        return esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      }

      var tableRows=filteredRows.map(function(x){
        var planned=x.plannedParty!=null?('PT '+x.plannedParty):'Reserva';
        var actual=x.actualPartyLabel||'Não visto';
        var equipKey=String(x.n||'').trim().toLowerCase();
        var hasEquip=!!equipmentByPlayer[equipKey];
        var playerName=hasEquip
          ? '<span class="cv2-player cv2-equip-hover" data-equip-player="'+attr(equipKey)+'">'+esc(x.n)+'<span class="cv2-equip-mark">▦</span></span>'
          : '<span class="cv2-player">'+esc(x.n)+'</span>';
        return '<tr><td>'+playerName+'<br><span class="cv2-muted">'+esc(x.arma||'')+'</span></td>'
          +'<td>'+esc(x.slot==null?'—':(''+x.slot))+'</td><td>'+esc(planned)+'</td>'
          +'<td class="'+(x.st==='wrong'?'cv2-purple':x.game?'cv2-good':'cv2-warn')+'">'+esc(actual)+'</td>'
          +'<td>'+discordPill(!!x.discord)+'</td><td>'+albionPill(x.albion||'unknown')+'</td><td>'+statusPill(x)+'</td>'
          +'<td class="'+textClass(x)+'">'+esc(x.obs||'—')+'</td></tr>';
      }).join('');
      if(!tableRows) tableRows='<tr><td colspan="8" class="cv2-muted" style="text-align:center;padding:22px">Nenhum jogador inscrito neste CTA.</td></tr>';

      var table='<div class="cv2-panel"><div class="cv2-panel-head"><h3>'+(selectedParty==null?'Tabela completa · TODAS AS PTS':'Tabela completa · PT '+selectedParty)+'</h3><small>'+(selectedParty==null?'detalhes completos e equipamento':'escalados ou detectados nesta PT')+'</small></div><div class="cv2-tablebox"><table class="cv2-table">'
        +'<thead><tr><th>JOGADOR</th><th>SLOT</th><th>ESCALA</th><th>JOGO</th><th>DISCORD</th><th>ALBION</th><th>ESTADO</th><th>OBSERVAÇÃO</th></tr></thead>'
        +'<tbody>'+tableRows+'</tbody></table></div></div>';

      var attention=[], seen={};
      function addAttention(key,item){ if(seen[key]) return; seen[key]=true; attention.push(item); }
      groups.forEach(function(g){
        var party=Number(g.party);
        (g.intruders||[]).forEach(function(x){
          addAttention('wrong:'+String(x.n).toLowerCase(),{party:Number(x.plannedParty)||party,icon:'↔',title:x.n+' está na PT errada',detail:'Está '+(x.actualPartyLabel||('PT '+party))+' · deveria PT '+(x.plannedParty||'?'),severity:'CRÍTICO',weight:0});
        });
        (g.missing||[]).forEach(function(x){
          if(x.actualParty!=null&&x.plannedParty!=null&&Number(x.actualParty)!==Number(x.plannedParty)) return;
          if(x.categoria==='off_pingou'||x.albion==='offline'){
            addAttention('off:'+String(x.n).toLowerCase(),{party:party,icon:'✖',title:x.n+' pingou e está offline',detail:'Escalado para PT '+party,severity:'CRÍTICO',weight:0});
          }else{
            addAttention('missing:'+String(x.n).toLowerCase(),{party:party,icon:'!',title:x.n+' não foi visto na PT',detail:'Escalado para PT '+party,severity:'ALTO',weight:1});
          }
        });
      });
      allRows.forEach(function(x){
        if(x.categoria==='online_fora_call'){
          addAttention('call:'+String(x.n).toLowerCase(),{party:x.plannedParty,icon:'🎧',title:x.n+' está fora da call',detail:x.actualPartyLabel?('Detectado em '+x.actualPartyLabel):'Online no Albion',severity:'MÉDIO',weight:2});
        }else if(x.categoria==='fora_pt'){
          addAttention('forapt:'+String(x.n).toLowerCase(),{party:x.plannedParty,icon:'!',title:x.n+' está na call, mas fora da PT',detail:'Escalado para PT '+(x.plannedParty||'?'),severity:'ALTO',weight:1});
        }
      });
      if(selectedParty!=null) attention=attention.filter(function(x){return Number(x.party)===Number(selectedParty);});
      attention.sort(function(a,b){ return a.weight-b.weight||String(a.title).localeCompare(String(b.title)); });

      var attentionHtml=attention.length?attention.slice(0,12).map(function(it){
        return '<div class="cv2-attention"><div class="cv2-attention-icon">'+esc(it.icon)+'</div><div><b>'+esc(it.title)+'</b><small>'+esc(it.detail)+'</small></div>'
          +'<span class="cv2-severity '+(it.severity==='MÉDIO'?'medium':'')+'">'+esc(it.severity)+'</span></div>';
      }).join(''):'<div class="auditok" style="padding:14px">✅ Nenhuma divergência crítica detectada.</div>';

      function indicator(label,value,color){
        return '<div class="cv2-indicator"><div class="cv2-indicator-top"><span>'+esc(label)+'</span><b>'+esc(value||0)+'</b></div>'
          +'<div class="cv2-indicator-bar"><i style="width:'+pct(value,total)+'%;background:'+color+'"></i></div></div>';
      }
      var side='<div class="cv2-panel"><div class="cv2-panel-head danger"><h3>⚠ Precisa de atenção'+(selectedParty==null?'':' · PT '+selectedParty)+'</h3><span class="cv2-count">'+attention.length+'</span></div>'+attentionHtml+'</div>'
        +'<div class="cv2-panel"><div class="cv2-panel-head"><h3>Indicadores gerais</h3><small>'+esc(String(r.inscritos||0))+' inscritos</small></div>'
        +indicator('Na call Discord',r.discord||0,'#4a97ff')
        +indicator('Detectados nas PTs',r.jogo||0,'#42c77a')
        +indicator('Na PT correta',r.corretos||0,'#d9aa52')
        +indicator('Na PT errada',r.ptErrada||0,'#9a6cff')
        +indicator('Não vistos em PT',r.foraParty||0,'#ef6672')+'</div>';

      var extras='';
      if(selectedParty==null&&(d.discordNoPing||[]).length){
        extras+='<div class="cv2-panel cv2-extra"><h3>Na call sem inscrição · '+d.discordNoPing.length+'</h3><div class="cv2-extra-grid">'
          +(d.discordNoPing||[]).map(function(x){ return '<div class="cv2-extra-player"><b>'+esc(x.n)+'</b><br><span class="cv2-muted">'+esc(x.actualPartyLabel||'somente na call')+'</span></div>'; }).join('')
          +'</div></div>';
      }
      if(selectedParty==null&&(d.gameNoSignup||[]).length){
        extras+='<div class="cv2-panel cv2-extra"><h3>Na PT sem escala · '+d.gameNoSignup.length+'</h3><div class="cv2-extra-grid">'
          +(d.gameNoSignup||[]).map(function(x){ return '<div class="cv2-extra-player"><b>'+esc(x.n)+'</b><br><span class="cv2-muted">'+esc(x.actualPartyLabel||'detectado no jogo')+'</span></div>'; }).join('')
          +'</div></div>';
      }
      if(extras) extras='<div class="cv2-extras">'+extras+'</div>';

      var html='<div class="cv2-shell">'+head+kpis+'<div class="cv2-layout"><div class="cv2-main">'+dist+parties+table+extras+'</div><aside class="cv2-side">'+side+'</aside></div></div>';
      setView('view-confirm',html);

      Array.prototype.forEach.call(document.querySelectorAll('[data-confirm-party],[data-confirm-party-btn]'),function(el){
        el.onclick=function(){
          var raw=el.getAttribute('data-confirm-party')||el.getAttribute('data-confirm-party-btn');
          var p=Number(raw);
          if(!Number.isFinite(p)) return;
          savePartyFilter(p);
          renderConfirm(true);
        };
      });
      var allBtn=document.querySelector('[data-confirm-party-all]');
      if(allBtn){
        allBtn.onclick=function(){
          savePartyFilter(null);
          renderConfirm(true);
        };
      }

      function equipmentTier(uniqueName){
        var id=String(uniqueName||'');
        var t=/^T(\\d+)_/i.exec(id);
        var e=/@(\\d+)/.exec(id);
        return t?('T'+t[1]+'.'+(e?e[1]:'0')):'';
      }
      function equipmentIconUrl(uniqueName){
        return 'https://render.albiononline.com/v1/item/'+encodeURIComponent(String(uniqueName||''));
      }
      function ensureEquipmentPopover(){
        var pop=document.getElementById('cv2-equipment-popover');
        if(pop) return pop;
        pop=document.createElement('div');
        pop.id='cv2-equipment-popover';
        pop.className='cv2-equip-pop';
        document.body.appendChild(pop);
        return pop;
      }
      function showEquipmentPopover(anchor,state){
        if(!state||!state.equipment) return;
        var pop=ensureEquipmentPopover();
        var slots=[
          ['Arma','mainHand'],['Off-hand','offHand'],['Capacete','head'],['Peito','chest'],['Bota','shoes'],
          ['Capa','cape'],['Bolsa','bag'],['Poção','potion'],['Food','food'],['Montaria','mount']
        ];
        var items=slots.map(function(s){
          var id=state.equipment[s[1]]||'';
          if(!id) return '<div class="cv2-equip-item empty"><img class="cv2-equip-icon" alt=""><span class="cv2-equip-slot">'+esc(s[0])+'</span><span class="cv2-equip-tier">—</span></div>';
          return '<div class="cv2-equip-item" title="'+attr(id)+'"><img class="cv2-equip-icon" loading="lazy" referrerpolicy="no-referrer" src="'+attr(equipmentIconUrl(id))+'" alt="'+attr(s[0])+'" onerror="this.style.visibility=\\'hidden\\'"><span class="cv2-equip-slot">'+esc(s[0])+'</span><span class="cv2-equip-tier">'+esc(equipmentTier(id)||'item')+'</span></div>';
        }).join('');
        var ip=Number(state.itemPower)||0;
        var observed=state.observedAt?age(state.observedAt):'snapshot atual';
        pop.innerHTML='<div class="cv2-equip-pop-head"><div><b>'+esc(state.name||'Jogador')+'</b><br><span>equipamento observado pelo Combat Client</span></div>'
          +(ip>0?'<div class="cv2-equip-ip">IP '+Math.round(ip)+'</div>':'')+'</div>'
          +'<div class="cv2-equip-grid">'+items+'</div>'
          +'<div class="cv2-equip-foot">Snapshot '+esc(observed)+' · apenas visualização do equipamento detectado</div>';
        pop.classList.add('open');
        var rect=anchor.getBoundingClientRect();
        var w=Math.min(382,window.innerWidth-20);
        var left=rect.right+10;
        if(left+w>window.innerWidth-10) left=Math.max(10,rect.left-w-10);
        var top=rect.top-8;
        var estimatedHeight=270;
        if(top+estimatedHeight>window.innerHeight-10) top=Math.max(10,window.innerHeight-estimatedHeight-10);
        pop.style.left=left+'px';
        pop.style.top=top+'px';
      }
      function hideEquipmentPopover(){
        var pop=document.getElementById('cv2-equipment-popover');
        if(pop) pop.classList.remove('open');
      }
      Array.prototype.forEach.call(document.querySelectorAll('[data-equip-player]'),function(el){
        el.onmouseenter=function(){
          var key=el.getAttribute('data-equip-player')||'';
          showEquipmentPopover(el,equipmentByPlayer[key]);
        };
        el.onmouseleave=hideEquipmentPopover;
      });
    }).catch(function(e){
      setView('view-confirm','<div class="modhead">🎯 Validação do CTA</div><div class="empty-note">Erro ao carregar auditoria: '+esc(e.message)+'</div>');
    });
  }

  function renderLoot(silent){
    if(!silent) loading('view-loot','📦 Registros & Loot');

    fetch('/api/telemetry/loot-ctas')
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(ctas){
        ctas=ctas||[];
        var preferred=lootSelectedEvent || current || (ctas[0]&&ctas[0].id) || null;
        var selected=ctas.find(function(x){return String(x.id)===String(preferred);}) || ctas[0] || null;

        if(!selected){
          document.getElementById('view-loot').innerHTML='<div class="modhead">📦 Registros & Loot</div><div class="empty-note">Nenhum CTA disponível para conferência nos últimos 3 dias.</div>';
          return;
        }

        lootSelectedEvent=String(selected.id);

        fetchTelemetry('/api/telemetry/loot?event='+encodeURIComponent(lootSelectedEvent)).then(function(d){
          var r=d.resumo||{};
          var lootNote=(d.meta&&d.meta.eventosUnicos!=null)
            ? (d.meta.eventosUnicos+' loots únicos · '+(d.meta.duplicadosColapsados||0)+' cópias deduplicadas · '+(d.meta.eventosConsiderados||0)+' considerados')
            : ((d.meta&&d.meta.totalEventos!=null)?(d.meta.totalEventos+' eventos de loot'):'');
          var filterBadge=(d.meta&&d.meta.filtroAtivo)
            ? '<div class="preview" style="color:#8ce5ad;background:#10241a;border-color:#214f31">🔒 Loot observado pelos Combat Clients · entram IMORTAIS, IMORTAIS ACADEMY e IMORTAIS 2; telemetria antiga sem guild usa a formação/party do CTA</div>'
            : '';

          var picker='<div class="panel"><h3>CTA PARA CONFERÊNCIA</h3><div class="lootctas">'
            +ctas.map(function(x){
              var on=String(x.id)===String(lootSelectedEvent);
              var label=ctaHistoryLabel(x)+(x.status==='closed'?' · encerrado':' · ao vivo');
              return '<button class="tab loot-cta'+(on?' on':'')+'" data-id="'+esc(x.id)+'">'+esc(label)+' <span style="color:var(--muted)">('+(x.lootEventsRaw==null?x.lootEvents:x.lootEventsRaw)+' brutos)</span></button>';
            }).join('')
            +'</div><div class="note" style="margin-top:10px">CTAs encerrados ficam disponíveis aqui por 3 dias para conferência de loot.</div></div>';

          var html=picker+liveBadge(lootNote)+filterBadge+'<div class="modhead">📦 Registros &amp; Loot · '+esc(ctaHistoryLabel(selected))+'</div>'
            +'<div class="statgrid">'
            +'<div class="stat b"><div class="k">Capturado</div><div class="v">'+fmtS(r.capturado)+'</div></div>'
            +'<div class="stat g"><div class="k">Entregue</div><div class="v">'+fmtS(r.entregue)+'</div></div>'
            +'<div class="stat a"><div class="k">Pendente</div><div class="v">'+fmtS(r.pendente)+'</div></div>'
            +'<div class="stat p"><div class="k">Divergências</div><div class="v">'+fmtS(r.divergencias)+'</div></div></div>'
            +'<div class="split"><div class="panel"><h3>Top looters</h3>'+topList(d.top||[],fmtS)+'</div>'
            +'<div class="panel"><h3>Itens recentes · deduplicados</h3><table class="dtable"><thead><tr><th>Quando (UTC)</th><th>Jogador</th><th>Item</th><th>Qtd</th><th>Origem</th><th>Valor</th><th>Observers</th><th>Status</th></tr></thead><tbody>'
            +(d.itens||[]).map(function(i){ return '<tr><td>'+esc(fmtUtcDateTime(i.at,true))+'</td><td><b>'+esc(i.jog)+'</b></td><td>'+esc(i.item)+'</td><td>'+i.qtd+'</td><td>'+esc(i.origem||'—')+'</td><td>'+fmtS(i.v)+'</td><td>'+esc(i.observers||1)+(Number(i.deduped||0)>0?' <span style="color:var(--muted)">('+(i.deduped)+' cópia'+(Number(i.deduped)===1?'':'s')+' fundida'+(Number(i.deduped)===1?'':'s')+')</span>':'')+'</td><td><span class="pill '+esc(i.st)+'">'+esc(i.st)+'</span></td></tr>'; }).join('')
            +'</tbody></table></div></div>';
          if(d.meta&&d.meta.note) html+='<div class="note">'+esc(d.meta.note)+'</div>';
          setView('view-loot',html);

          Array.prototype.forEach.call(document.querySelectorAll('.loot-cta'),function(b){
            b.onclick=function(){
              lootSelectedEvent=b.getAttribute('data-id');
              renderLoot(false);
            };
          });
        });
      })
      .catch(function(){
        document.getElementById('view-loot').innerHTML='<div class="modhead">📦 Registros & Loot</div><div class="empty-note">Sem dados de loot ou erro ao carregar.</div>';
      });
  }

  function renderCombat(silent){
    if(!silent) loading('view-combat','⚔️ Combate');
    fetch('/api/telemetry/combat-ctas')
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(ctas){
        ctas=ctas||[];
        var preferred=combatSelectedEvent || current || (ctas[0]&&ctas[0].id) || null;
        var selected=ctas.find(function(x){return String(x.id)===String(preferred);}) || ctas[0] || null;

        if(!selected){
          document.getElementById('view-combat').innerHTML='<div class="modhead">⚔️ Combate</div><div class="empty-note">Nenhum CTA com dados de combate disponível nos últimos 3 dias.</div>';
          return;
        }

        combatSelectedEvent=String(selected.id);

        fetchTelemetry('/api/telemetry/combat?event='+encodeURIComponent(combatSelectedEvent)).then(function(d){
          var r=d.resumo||{};
          var picker='<div class="panel"><h3>CTA PARA CONFERÊNCIA</h3><div class="lootctas">'
            +ctas.map(function(x){
              var on=String(x.id)===String(combatSelectedEvent);
              var label=ctaHistoryLabel(x)+(x.status==='closed'?' · encerrado':' · ao vivo');
              return '<button class="tab combat-cta'+(on?' on':'')+'" data-id="'+esc(x.id)+'">'+esc(label)+' <span style="color:var(--muted)">('+x.combatEvents+')</span></button>';
            }).join('')
            +'</div><div class="note" style="margin-top:10px">Os rankings detalhados de combate ficam disponíveis por 3 dias após o encerramento do CTA.</div></div>';

          var a=d.audit||{};
          var devices=a.devices||[];
          var maps=d.maps||[];
          var battleMin=(d.meta&&d.meta.battleMinRelevantEvents)||5;
          var observerHist=a.observedDeathObserverHistogram||{};
          var observerHistText=Object.keys(observerHist).sort(function(x,y){return Number(x)-Number(y);}).map(function(k){
            return k+' observer'+(Number(k)===1?'':'s')+': '+observerHist[k];
          }).join(' · ');
          var unclassified=a.unclassifiedCanonicalSample||[];
          var unclassifiedRows=unclassified.map(function(x){
            var when=x.occurredAt?fmtUtcDateTime(x.occurredAt,true):'—';
            var label=x.classification==='ambos_nossos'?'AMBOS NOSSOS':'NENHUM NOSSO';
            return '<tr><td>'+esc(when)+'</td><td>'+esc(x.map||'Mapa desconhecido')+'</td><td><b>'+esc(x.killer||'?')+'</b></td><td><b>'+esc(x.victim||'?')+'</b></td>'
              +'<td>'+esc((x.killerGuilds||[]).join(', ')||'—')+'</td><td>'+esc((x.victimGuilds||[]).join(', ')||'—')+'</td>'
              +'<td>'+esc(label)+'</td><td>'+fmtS(x.observedDeathObservers||x.observers||0)+'</td></tr>';
          }).join('');
          var deathObserver=!!(d.meta&&d.meta.zergDeathObserver);
          var killLabel=deathObserver?'Kills da zerg':'Kills candidatas';
          var deathLabel=deathObserver?'Mortes da zerg':'Mortes candidatas';
          function renderFightBlock(f){
            var fr=f.resumo||{}, fd=f.resumoDedup||fr, fa=f.audit||{}, players=f.players||[], fwhen='';
            if(f.firstAt&&f.lastAt){
              var ffi=fmtUtcDateTime(f.firstAt,false);
              var fla=fmtUtcDateTime(f.lastAt,false);
              fwhen=ffi+' → '+fla;
            }
            var playerTable='<div style="overflow-x:auto;margin-top:12px"><table class="dtable"><thead><tr>'
              +'<th>#</th><th>Jogador</th><th>PT</th><th>Dano dedup.</th><th>Cura dedup.</th><th>Kills</th><th>Mortes</th><th>Dano bruto</th><th>Cura bruta</th>'
              +'</tr></thead><tbody>'
              +(players.length?players.map(function(p,i){
                return '<tr><td>'+(i+1)+'</td><td><b>'+esc(p.n||'?')+'</b></td><td>'+esc(p.pt||'Sem PT')+'</td>'
                  +'<td><b>'+fmtS(p.damage||0)+'</b></td><td>'+fmtS(p.healing||0)+'</td>'
                  +'<td>'+fmtS(p.kills||0)+'</td><td>'+fmtS(p.deaths||0)+'</td>'
                  +'<td style="color:var(--muted)">'+fmtS(p.rawDamage||0)+'</td><td style="color:var(--muted)">'+fmtS(p.rawHealing||0)+'</td></tr>';
              }).join(''):'<tr><td colspan="9" style="color:var(--faint)">Sem jogadores suficientes para o relatório.</td></tr>')
              +'</tbody></table></div>';
            return '<div class="preview" style="margin-top:12px;padding:14px">'
              +'<div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b>⚔️ Battle Report · Batalha '+esc(f.n||'?')+'</b><span style="color:var(--muted)">'+esc(fwhen)+'</span></div>'
              +'<div class="statgrid" style="margin-top:10px">'
              +'<div class="stat r"><div class="k">Dano dedup. · conservador</div><div class="v">'+fmtS(fd.damage||0)+'</div></div>'
              +'<div class="stat g"><div class="k">Cura dedup. · conservador</div><div class="v">'+fmtS(fd.healing||0)+'</div></div>'
              +'<div class="stat b"><div class="k">'+esc(killLabel)+'</div><div class="v">'+fmtS(fr.killsCandidate||0)+'</div></div>'
              +'<div class="stat a"><div class="k">'+esc(deathLabel)+'</div><div class="v">'+fmtS(fr.deathsCandidate||0)+'</div></div></div>'
              +'<div class="split"><div><h3>🏆 Top DPS · dedup.</h3>'+topList(f.topDmgDedup||f.topDmg||[],fmtS)+'</div>'
              +'<div><h3>☠️ Top Kills</h3>'+topList(f.topKillsCandidate||[],fmtS)+'</div></div>'
              +'<h3 style="margin-top:14px">📋 Jogadores da batalha</h3>'+playerTable
              +'<div class="note">Bruto: '+fmtS(fr.damage||0)+' dano · '+fmtS(fr.healing||0)+' cura. Fusão: '+fmtS(fa.rawCombatDeltaEvents||0)+' deltas brutos → '+fmtS(fa.canonicalDeltaEvents||0)+' preservados; '+fmtS(fa.collapsedCombatDeltaEvents||0)+' colapsados por fingerprint exato. '+fmtS((f.observers||[]).length)+' observer(s).</div>'
              +'</div>';
          }
          function renderMapBlock(m){
            var mr=m.resumo||{}, md=m.resumoDedup||mr, ma=m.audit||{}, fights=m.fights||[];
            var when='';
            if(m.firstAt&&m.lastAt){
              var fi=fmtUtcDateTime(m.firstAt,false);
              var la=fmtUtcDateTime(m.lastAt,false);
              when=' · '+fi+' → '+la;
            }
            return '<div class="panel">'
              +'<h3>🗺️ '+esc(m.map||'Mapa desconhecido')+when+'</h3>'
              +'<div class="statgrid">'
              +'<div class="stat r"><div class="k">Dano dedup. · conservador</div><div class="v">'+fmtS(md.damage||0)+'</div></div>'
              +'<div class="stat g"><div class="k">Cura dedup. · conservador</div><div class="v">'+fmtS(md.healing||0)+'</div></div>'
              +'<div class="stat b"><div class="k">'+esc(killLabel)+'</div><div class="v">'+fmtS(mr.killsCandidate||0)+'</div></div>'
              +'<div class="stat a"><div class="k">'+esc(deathLabel)+'</div><div class="v">'+fmtS(mr.deathsCandidate||0)+'</div></div></div>'
              +'<div class="split"><div><h3>🏆 Top DPS do mapa · dedup.</h3>'+topList(m.topDmgDedup||m.topDmg||[],fmtS)+'</div>'
              +'<div><h3>☠️ Top Kills do mapa</h3>'+topList(m.topKillsCandidate||[],fmtS)+'</div></div>'
              +'<div class="note">Bruto do mapa: '+fmtS(mr.damage||0)+' dano · '+fmtS(mr.healing||0)+' cura. '+fmtS(ma.rawCombatDeltaEvents||0)+' deltas → '+fmtS(ma.canonicalDeltaEvents||0)+' preservados; '+fmtS(ma.collapsedCombatDeltaEvents||0)+' colapsados. '+fmtS(m.totalEvents||0)+' eventos totais · '+fmtS((m.observers||[]).length)+' observer(s) · '+fmtS(ma.reportableFights==null?fights.length:ma.reportableFights)+' Battle Report(s) exibidos'+(ma.suppressedFights?(' · '+fmtS(ma.suppressedFights)+' confronto(s) pequeno(s) ocultado(s)'):'')+'.</div>'
              +(fights.length?fights.map(renderFightBlock).join(''):'<div class="empty-note">Nenhuma batalha atingiu o volume mínimo para Battle Report.</div>')
              +'</div>';
          }
          var rd=d.resumoDedup||r;
          var html=picker+liveBadge((d.meta&&d.meta.totalEventos!=null)?(d.meta.totalEventos+' eventos de combate'):'')+'<div class="modhead">⚔️ Combate · '+esc(ctaHistoryLabel(selected))+'</div>'
            +'<div class="statgrid">'
            +'<div class="stat r"><div class="k">Dano dedup. · conservador</div><div class="v">'+fmtS(rd.damage||0)+'</div></div>'
            +'<div class="stat g"><div class="k">Cura dedup. · conservador</div><div class="v">'+fmtS(rd.healing||0)+'</div></div>'
            +'<div class="stat a"><div class="k">'+esc(deathObserver?'Mortes da zerg':'Mortes candidatas · legado')+'</div><div class="v">'+fmtS(r.mortes)+'</div></div>'
            +'<div class="stat b"><div class="k">'+esc(deathObserver?'Kills da zerg':'Kills candidatas · legado')+'</div><div class="v">'+fmtS(a.ourKillCandidates||0)+'</div></div></div>'            +(function(){              var ks=d.killScore||{byGuild:[],totals:{}};              var rows=ks.byGuild||[]; var t=ks.totals||{};              var we=t.weKilled||0, they=t.wereKilled||0;              var saldo=we-they; var saldoTxt=(saldo>0?'+':'')+saldo;              var saldoCor=saldo>0?'#35c46a':(saldo<0?'#d9534f':'#e2b95e');              var head='<div class="panel"><h3>\u2694\uFE0F Placar de kills \u00b7 guilda vs guilda</h3>'                +'<div class="statgrid">'                +'<div class="stat g"><div class="k">N\u00f3s matamos</div><div class="v">'+fmtS(we)+'</div></div>'                +'<div class="stat r"><div class="k">Perdemos</div><div class="v">'+fmtS(they)+'</div></div>'                +'<div class="stat b"><div class="k">Saldo</div><div class="v" style="color:'+saldoCor+'">'+saldoTxt+'</div></div></div>';              if(!rows.length){ return head+'<div class="empty-note">Ainda n\u00e3o h\u00e1 abates registrados entre n\u00f3s e inimigos neste CTA.</div></div>'; }              var body='<table class="dtable"><thead><tr><th>Guilda inimiga</th><th>Matamos</th><th>Perdemos</th><th>Saldo</th></tr></thead><tbody>';              body+=rows.map(function(x){                var sd=(x.weKilledThem||0)-(x.theyKilledUs||0);                var cor=sd>0?'#35c46a':(sd<0?'#d9534f':'var(--faint)');                return '<tr><td><b>'+esc(x.guild||'Sem guilda')+'</b></td>'                  +'<td style="color:#35c46a">'+fmtS(x.weKilledThem||0)+'</td>'                  +'<td style="color:#d9534f">'+fmtS(x.theyKilledUs||0)+'</td>'                  +'<td style="color:'+cor+';font-weight:700">'+(sd>0?'+':'')+sd+'</td></tr>';              }).join('');              body+='</tbody></table>';              return head+body+'<div class="note">Confronto direto: abates entre a nossa fam\u00edlia (IMORTAIS / Academy / IMORTAIS 2) e cada guilda inimiga. Fogo amigo e mortes entre inimigos n\u00e3o entram.</div></div>';            })()            +'<div class="panel"><h3>🗺️ Batalhas por mapa</h3><div class="note">Cada mapa é tratado separadamente e uma nova luta é segmentada após mais de 2 minutos sem eventos de combate. Para evitar histórico fantasma, só é exibido Battle Report quando kills da nossa zerg + mortes da nossa zerg somam pelo menos '+fmtS(battleMin)+'. Eventos anteriores ao Combat Client v0.5.4 podem aparecer em “Mapa desconhecido”.</div></div>'
            +(maps.length?maps.map(renderMapBlock).join(''):'<div class="panel"><div class="empty-note">Ainda não há eventos de combate com mapa neste CTA.</div></div>')
            +'<div class="panel"><h3>Resumo por PT · bruto</h3><table class="dtable"><thead><tr><th>PT</th><th>Dano</th><th>Cura</th><th>Mortes</th></tr></thead><tbody>'
            +(d.porPt||[]).map(function(x){ return '<tr><td><b>'+esc(x.pt)+'</b></td><td>'+fmtS(x.dmg)+'</td><td>'+fmtS(x.heal)+'</td><td>'+fmtS(x.mortes)+'</td></tr>'; }).join('')
            +'</tbody></table></div>'
            +'<div class="split"><div class="panel"><h3>🏆 Top DPS · dedup. conservador</h3>'+topList(d.topDmgDedup||d.topDmg||[],fmtS)+'</div>'
            +'<div class="panel"><h3>💚 Top Heal · dedup. conservador</h3>'+topList(d.topHealDedup||d.topHeal||[],fmtS)+'</div></div>'
            +'<div class="split"><div class="panel"><h3>☠️ Top Kills · candidato</h3>'+topList(d.topKillsCandidate||[],fmtS)+'</div>'
            +'<div class="panel"><h3>🧪 Auditoria de mortes/abates</h3>'
            +'<div class="srow">DiedEvent observados brutos: <b>'+(a.rawObservedDeaths||0)+'</b></div>'
            +'<div class="srow">Mortes canônicas vindas de DiedEvent: <b>'+(a.canonicalObservedDeaths==null?'—':a.canonicalObservedDeaths)+'</b></div>'
            +'<div class="srow">Cópias de DiedEvent colapsadas: <b>'+(a.collapsedObservedDeathCopies==null?'—':a.collapsedObservedDeathCopies)+'</b></div>'
            +'<div class="srow">Cópias causadas por outro observer: <b>'+(a.crossObserverObservedDeathCopies==null?'—':a.crossObserverObservedDeathCopies)+'</b></div>'
            +'<div class="srow">Duplicações dentro do mesmo observer: <b>'+(a.sameObserverObservedDeathCopies==null?'—':a.sameObserverObservedDeathCopies)+'</b></div>'
            +'<div class="srow">Mortes vistas por mais de 1 observer: <b>'+(a.multiObserverObservedDeaths==null?'—':a.multiObserverObservedDeaths)+'</b></div>'
            +(observerHistText?'<div class="srow">Distribuição por observers: <b>'+esc(observerHistText)+'</b></div>':'')
            +'<div class="srow">Eventos kill/death totais: <b>'+(a.rawKillLikeEvents||0)+'</b></div>'
            +'<div class="srow">Mortes/abates canônicos candidatos: <b>'+(a.uniqueKillCandidates||0)+'</b></div>'
            +'<div class="srow">'+esc(deathObserver?'Kills da nossa zerg':'Kills candidatas da nossa zerg')+': <b>'+(a.ourKillCandidates||0)+'</b></div>'
            +'<div class="srow">'+esc(deathObserver?'Mortes da nossa zerg':'Mortes candidatas da nossa zerg')+': <b>'+(a.ourDeathCandidates||0)+'</b></div>'
            +'<div class="srow">Canônicos fora de kill/morte nossa: <b>'+(a.unclassifiedCanonicalCandidates==null?'—':a.unclassifiedCanonicalCandidates)+'</b></div>'
            +'<div class="srow">↳ ambos considerados nossos: <b>'+(a.friendlyCanonicalCandidates==null?'—':a.friendlyCanonicalCandidates)+'</b></div>'
            +'<div class="srow">↳ nenhum considerado nosso: <b>'+(a.externalCanonicalCandidates==null?'—':a.externalCanonicalCandidates)+'</b></div>'
            +'<div class="srow">Eventos kill/death repetidos colapsados: <b>'+(a.duplicateKillLikeEvents||0)+'</b></div>'
            +'<div class="note">As cópias colapsadas agora são separadas entre observações do mesmo óbito vindas de devices diferentes e reenvios repetidos do próprio device. A mesma morte é fundida por mapa + vítima quando occurred_at ou received_at cai na janela de '+fmtS(Math.round((a.deathDedupWindowMs||30000)/1000))+'s.</div>'
            +'</div></div>'
            +(unclassifiedRows?'<div class="panel"><h3>🔎 Canônicos fora de kill/morte nossa</h3><div class="note" style="margin-bottom:10px">Casos em que killer e vítima foram ambos classificados como nossos ou ambos como externos. Servem para auditar os eventos que não entram nos totais da zerg.</div><div style="overflow-x:auto"><table class="dtable"><thead><tr><th>Hora</th><th>Mapa</th><th>Killer</th><th>Vítima</th><th>Guild killer</th><th>Guild vítima</th><th>Classificação</th><th>Observers</th></tr></thead><tbody>'+unclassifiedRows+'</tbody></table></div></div>':'')
            +'<div class="panel"><h3>🧮 Auditoria de dano/cura</h3>'
            +'<div class="srow">Deltas brutos: <b>'+fmtS(a.rawCombatDeltaEvents||0)+'</b></div>'
            +'<div class="srow">Deltas preservados na fusão: <b>'+fmtS(a.canonicalCombatDeltaEvents||0)+'</b></div>'
            +'<div class="srow">Deltas colapsados: <b>'+fmtS(a.collapsedCombatDeltaEvents||0)+'</b></div>'
            +'<div class="srow">Fingerprints vistos por mais de 1 observer: <b>'+fmtS(a.multiObserverDeltaCandidates||0)+'</b></div>'
            +'<div class="note">A fusão é conservadora: só une deltas exatamente iguais do mesmo jogador, mapa e janela de 1 segundo. O bruto continua armazenado e exibido para comparação.</div></div>'
            +'<div class="panel"><h3>🖥️ Observers de combate</h3><table class="dtable"><thead><tr><th>Device</th><th>Eventos</th><th>combat_delta</th><th>DiedEvent bruto</th><th>Kill/death</th><th>Dano bruto</th><th>Cura bruta</th></tr></thead><tbody>'
            +(devices.length?devices.map(function(x){return '<tr><td><b>'+esc(x.deviceId)+'</b></td><td>'+fmtS(x.eventos)+'</td><td>'+fmtS(x.combatDelta)+'</td><td>'+fmtS(x.observedDeaths||0)+'</td><td>'+fmtS(x.killLike)+'</td><td>'+fmtS(x.damage)+'</td><td>'+fmtS(x.healing)+'</td></tr>';}).join(''):'<tr><td colspan="7" style="color:var(--faint)">Nenhum observer com combate neste CTA.</td></tr>')
            +'</tbody></table>'
            +'<div class="note">Fingerprint de deltas iguais entre devices: '+fmtS(a.overlappingDeltaFingerprints||0)+' de '+fmtS(a.combatDeltaFingerprints||0)+'. É um indicador de sobreposição, não uma correção automática.</div></div>';
          if(d.meta&&d.meta.note) html+='<div class="note">'+esc(d.meta.note)+'</div>';
          setView('view-combat',html);

          Array.prototype.forEach.call(document.querySelectorAll('.combat-cta'),function(b){
            b.onclick=function(){
              combatSelectedEvent=b.getAttribute('data-id');
              renderCombat();
            };
          });
        });
      })
      .catch(function(){
        document.getElementById('view-combat').innerHTML='<div class="modhead">⚔️ Combate</div><div class="empty-note">Sem dados de combate ou erro ao carregar.</div>';
      });
  }


  var guildRefreshTimer=null;
  function renderGuild(silent){
    if(!silent) loading('view-guild','🟢 Guilda online');
    fetch('/api/telemetry/guild-presence').then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }).then(function(d){
      var members=d.members||[];
      var online=d.onlineConfirmedCount||0;
      var staleOnline=d.onlineStaleCount||0;
      var total=d.totalTracked||0;
      var recent=d.recentStateCount||0;
      var observers=d.activeObserverCount||0;
      function ago(ts){ if(!ts) return '—'; var s=Math.max(0,Math.round((Date.now()-new Date(ts).getTime())/1000)); if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'min'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
      function presenceBadge(m){
        if(m.presenceClass==='online_confirmed') return '<span class="pill ok">ONLINE CONFIRMADO</span>';
        if(m.presenceClass==='online_stale') return '<span class="pill" style="color:#e2b95e;border-color:#6f5a2b">ONLINE NÃO CONFIRMADO</span>';
        if(m.presenceClass==='offline_confirmed') return '<span class="pill miss">OFFLINE CONFIRMADO</span>';
        return '<span class="pill" style="color:var(--faint);border-color:#2a3550">OFFLINE ANTIGO</span>';
      }
      var rows=members.map(function(m){
        var visto=m.online?(m.effectiveStatus==='online'?'agora':'último estado: online'):(m.lastSeenAt?ago(m.lastSeenAt)+' atrás':'—');
        var hb=m.observerHeartbeatAt?(ago(m.observerHeartbeatAt)+' atrás'):'—';
        var hbBadge=m.observerActive?'<span class="pill ok">VIVO</span>':'<span class="pill" style="color:var(--faint);border-color:#2a3550">STALE</span>';
        return '<tr><td><b>'+esc(m.playerName||'?')+'</b></td><td>'+presenceBadge(m)+'</td><td>'+esc(visto)+'</td><td>'+ago(m.lastEventAt||m.stateAt)+' atrás</td><td style="color:var(--faint)">'+esc(m.observerDevice||'—')+'</td><td>'+hbBadge+' <span style="color:var(--faint)">'+esc(hb)+'</span></td></tr>';
      }).join('');
      var fresh=d.dataFreshAt?ago(d.dataFreshAt)+' atrás':'sem dado';
      var html=liveBadge('último dado Albion '+fresh)
        +'<div class="modhead">🟢 Guilda online</div>'
        +'<div class="statgrid"><div class="stat g"><div class="k">Online confirmado</div><div class="v">'+online+'</div></div>'
        +'<div class="stat a"><div class="k">Online não confirmado</div><div class="v">'+staleOnline+'</div></div>'
        +'<div class="stat b"><div class="k">Estados recentes</div><div class="v">'+recent+'</div></div>'
        +'<div class="stat p"><div class="k">Observers ativos</div><div class="v">'+observers+'</div></div></div>'
        +'<div class="statgrid"><div class="stat b"><div class="k">Rastreados</div><div class="v">'+total+'</div></div>'
        +'<div class="stat"><div class="k">Observers conhecidos</div><div class="v">'+(d.totalObserverCount||0)+'</div></div></div>'
        +'<div class="panel"><table class="dtable"><thead><tr><th>Jogador</th><th>Status</th><th>Ultimo visto</th><th>Estado recebido</th><th>Observer</th><th>Heartbeat</th></tr></thead><tbody>'
        +(rows||'<tr><td colspan="6" style="color:var(--faint)">Nenhum jogador rastreado ainda.</td></tr>')
        +'</tbody></table></div>'
        +'<div class="note">Estado e frescor são separados. ONLINE não confirmado continua sendo o último estado conhecido e não vira OFFLINE por timeout. Para entrar em “Online confirmado”, o estado precisa ser recente e o observer precisa ter heartbeat ativo. A cobertura depende da quantidade de Combat Clients observando a guilda.</div>';
      setView('view-guild',html);
    }).catch(function(e){
      setView('view-guild','<div class="modhead">🟢 Guilda online</div><div class="empty-note">Erro ao carregar presenca: '+esc(e.message)+'</div>');
    });
    if(guildRefreshTimer) clearTimeout(guildRefreshTimer);
    guildRefreshTimer=setTimeout(function(){ var a=document.querySelector('.nav[data-view].on'); if(a&&a.getAttribute('data-view')==='guild') renderGuild(true); },20000);
  }

  function renderDevices(){
    var el=document.getElementById('view-devices');
    if(!el) return;
    el.innerHTML='<div class="modhead">🖥️ Dispositivos · Combat Client</div><div class="empty-note">Carregando…</div>';
    Promise.all([
      fetch('/auth/me').then(function(r){return r.json();}),
      fetch('/api/telemetry/agents').then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    ]).then(function(all){
      var me=all[0], agents=all[1]||[];
      if(!me.canManageDevices){
        el.innerHTML='<div class="modhead">🖥️ Dispositivos · Combat Client</div><div class="empty-note">Acesso restrito ao Mackna, dono da guilda e Mestre de Guerra.</div>';
        return;
      }
      var html='<div class="modhead">🖥️ Dispositivos · Combat Client</div>'
        +'<div class="panel"><h3>Vincular novo PC</h3>'
        +'<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end">'
        +'<label>Nome do dispositivo<input id="pair-label" class="input" placeholder="Ex: BadMack-PC"></label>'
        +'<label>Personagem (opcional)<input id="pair-player" class="input" placeholder="Ex: BadMack"></label>'
        +'<button class="btn primary" id="pair-generate">Gerar código</button>'
        +'</div><div id="pair-result" style="margin-top:14px"></div></div>'
        +'<div class="panel"><h3>Dispositivos vinculados</h3>'
        +'<table class="dtable"><thead><tr><th>Dispositivo</th><th>Personagem</th><th>Último contato</th><th>Status</th><th></th></tr></thead><tbody>'
        +agents.map(function(a){
          var revoked=!!a.revokedAt;
          var last=a.lastSeen?new Date(a.lastSeen).toLocaleString('pt-BR'):'—';
          return '<tr><td><b>'+esc(a.label||a.deviceId||'Sem nome')+'</b><br><span style="color:var(--muted)">'+esc(a.deviceId||'não vinculado')+'</span></td>'
            +'<td>'+esc(a.playerName||'—')+'</td><td>'+esc(last)+'</td>'
            +'<td><span class="pill '+(revoked?'miss':'ok')+'">'+(revoked?'Revogado':'Ativo')+'</span></td>'
            +'<td>'+(revoked?'':'<button class="btn danger agent-revoke" data-id="'+esc(a.id)+'">Revogar</button>')+'</td></tr>';
        }).join('')
        +'</tbody></table></div>';
      el.innerHTML=html;

      var gen=document.getElementById('pair-generate');
      if(gen) gen.onclick=function(){
        var body={label:(document.getElementById('pair-label').value||'').trim(),playerName:(document.getElementById('pair-player').value||'').trim()};
        fetch('/api/telemetry/pairing/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
          .then(function(r){return r.json().then(function(j){if(!r.ok) throw new Error(j.error||'erro');return j;});})
          .then(function(j){
            document.getElementById('pair-result').innerHTML='<div class="preview" style="font-size:18px;color:#fff">Código de pareamento: <b style="font-size:28px;letter-spacing:.12em">'+esc(j.code)+'</b><br><span style="font-size:12px;color:var(--muted)">Válido por 10 minutos e uso único.</span></div>';
          }).catch(function(e){ document.getElementById('pair-result').textContent='Erro: '+e.message; });
      };
      Array.prototype.forEach.call(document.querySelectorAll('.agent-revoke'),function(b){
        b.onclick=function(){
          if(!confirm('Revogar este dispositivo?')) return;
          fetch('/api/telemetry/agents/revoke-id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.getAttribute('data-id')})})
            .then(function(){ renderDevices(); });
        };
      });
    }).catch(function(e){
      el.innerHTML='<div class="modhead">🖥️ Dispositivos · Combat Client</div><div class="empty-note">Erro ao carregar dispositivos: '+esc(e.message)+'</div>';
    });
  }

  function boot(){
    fetch('/auth/me').then(function(r){return r.json();}).then(function(a){
      authState={
        logged:!!a.logged,
        member:!!a.member,
        canEdit:!!a.canEdit,
        canManageDevices:!!a.canManageDevices,
        canManageBomb:!!a.canManageBomb,
        canManageCastleRoaming:!!a.canManageCastleRoaming,
        isSiteAdmin:!!a.isSiteAdmin,
        name:a.name||''
      };
      renderAuthHeader();
      var devicesNav=document.querySelector('.nav[data-view="devices"]');
      if(devicesNav) devicesNav.style.display=authState.canManageDevices?'':'none';
      var navBomb=document.getElementById('nav-bomb');
      var navCastelo=document.getElementById('nav-castelo');
      var navRoaming=document.getElementById('nav-roaming');
      if(navBomb) navBomb.style.display=authState.canManageBomb?'':'none';
      if(navCastelo) navCastelo.style.display=authState.canManageCastleRoaming?'':'none';
      if(navRoaming) navRoaming.style.display=authState.canManageCastleRoaming?'':'none';
      if(authState.logged && authState.member){
        document.getElementById('gate').innerHTML='';
        document.getElementById('side').style.visibility='visible';
        show('board'); loadNews(); loadEvents();
      } else {
        document.getElementById('side').style.visibility='hidden';
        document.getElementById('view-board').style.display='none';
        document.getElementById('view-mural').style.display='none';
        document.getElementById('live').textContent='';
        document.getElementById('gate').innerHTML = authState.logged
          ? '<div class="gate">⛔ Você não é membro do servidor IMORTAIS.<br>O conteúdo é restrito à guilda.</div>'
          : '<div class="gate">🔒 War Room restrita aos IMORTAIS.<br>Entre com o Discord pra ver.<br><a class="gate-btn" href="/auth/login">Entrar com Discord</a></div>';
      }
    }).catch(function(){ document.getElementById('gate').innerHTML='<div class="gate">Erro ao carregar.</div>'; });
  }
  checkConnection();
  boot();
  setInterval(checkConnection,10000);
  setInterval(function(){ if(authState.member){ loadEvents(); loadNews(); } }, 20000);
</script>
</body>
</html>`;

module.exports = { startWebServer, notifyRosterChange, buildRosterData };