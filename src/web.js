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

// ---- config do login (OAuth2 Discord) ----
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID || "1541617852056862801";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const GUILD_ID      = process.env.GUILD_ID || "683411304408416285";
const REDIRECT      = process.env.OAUTH_REDIRECT || "https://cta-imortais.up.railway.app/auth/callback";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;
const CALLER_TAG_ID = process.env.CALLER_TAG_ID || null;
const BOMB_LEADER_ROLE_ID = process.env.BOMB_LEADER_ROLE_ID || null;

const sessions = new Map(); // sid -> { id, name, canEdit, roles }
const states = new Map();   // state -> timestamp (CSRF)

function parseCookies(req) {
  const h = req.headers.cookie || ""; const o = {};
  h.split(";").forEach(function (p) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function sessionOf(req) { const sid = parseCookies(req).sid; return sid ? sessions.get(sid) : null; }
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
  const isMackna = String(name || "").trim().toLowerCase() === "mackna";
  const hasWarMasterRole = !!(STAFF_ROLE_ID && roles.includes(STAFF_ROLE_ID));
  return !!(isOwner || isMackna || hasWarMasterRole);
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
  const isMackna = String(name || "").trim().toLowerCase() === "mackna";
  const isWarMaster = !!(STAFF_ROLE_ID && roles.includes(STAFF_ROLE_ID));
  return !!(isOwner || isMackna || isWarMaster);
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
    return { display: idx + 1, name: `Party ${idx + 1}`, filled, total: party.slots.length, slots };
  });
  return {
    event: { id: ev.id, time: ev.time_label, status: ev.status },
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
      const sid = crypto.randomUUID();
      sessions.set(sid, {
        id: me.id,
        name,
        canEdit: canEditRoles(roles, me.id),
        canManageDevices: canManageDevices(roles, me.id, name),
        canManageBomb: canManageBomb(roles, me.id, name),
        canManageCastleRoaming: canManageCastleRoaming(roles, me.id, name),
        isSiteAdmin: isSiteAdmin(roles, me.id, name),
        isMember: !!member,
        roles
      });
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
    const sid = parseCookies(req).sid; if (sid) sessions.delete(sid);
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
    const time = String((req.body || {}).time || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return res.status(400).json({ error: "time" });
    res.json(_act.openCTA ? await _act.openCTA(time, sess.id, (req.body || {}).image) : { ok: false, error: "indisponível" });
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

  app.post("/api/setweapon", async (req, res) => {
    const sess = requireEditor(req, res); if (!sess) return;
    const { event, userId, weapon } = req.body || {};
    const w = String(weapon || "").trim();
    if (!w || !WEAPONS[w.toUpperCase()]) return res.status(400).json({ error: "weapon" });
    const ev = await db.getEvent(event).catch(() => null);
    if (!ev) return res.status(404).json({ error: "event" });
    await db.pool.query("UPDATE cta_signups SET weapon=$3 WHERE event_id=$1 AND user_id=$2", [ev.id, userId, w.toUpperCase()]);
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
  .crest{ width:34px; height:36px; flex:0 0 auto; filter:drop-shadow(0 2px 6px rgba(217,59,69,.3)); }
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
  .field input{ width:100%; background:var(--bg); border:1px solid var(--line2); color:var(--text); border-radius:11px; padding:12px 14px; font-size:15px; font-family:var(--sans); margin-bottom:14px; }
  .note{ font-size:12px; color:var(--faint); margin:-4px 0 16px; }
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
</style>
</head>
<body>
<header>
  <svg class="crest" viewBox="0 0 34 38" fill="none"><path d="M17 1 33 6v13c0 9-7 15-16 18C8 34 1 28 1 19V6L17 1Z" fill="#12161e" stroke="#d93b45" stroke-width="1.5"/><path d="M17 8v22M9 14h16" stroke="#d9aa52" stroke-width="1.6" stroke-linecap="round"/></svg>
  <div class="brand"><h1>IMORTAIS</h1><small>CTA WAR ROOM</small></div>
  <span id="live">conectando…</span>
  <span id="auth"></span>
</header>
<div class="shell">
  <aside id="side">
    <div class="navtitle">OPERAÇÃO</div>
    <div class="nav on" data-view="board">⚔ Formação ao vivo</div>
    <div class="nav" data-view="mural">📣 Mural da guilda</div>
    <div class="nav" id="nav-stats">📊 Meu desempenho</div>
    <div class="navtitle">DADOS DO JOGO</div>
    <div class="nav" data-view="confirm">🎯 Confirmação pelo jogo</div>
    <div class="nav" data-view="loot">📦 Registros &amp; Loot</div>
    <div class="nav" data-view="combat">⚔️ Combate</div>
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
    <div id="view-confirm" style="display:none"></div>
    <div id="view-loot" style="display:none"></div>
    <div id="view-combat" style="display:none"></div>
    <div id="view-devices" style="display:none"></div>
  </main>
</div>

<div class="modal" id="m-open"><div class="sheet"><button class="x" onclick="mclose('m-open')">✕</button>
  <h2>Abrir CTA</h2><p class="sub">Escolha o horário e, se quiser, uma arte pro chamado.</p>
  <div class="timegrid" id="open-times"></div>
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
  var ROLE={Tank:'tank',Support:'support',Melee:'dps',Ranged:'range',Healer:'heal'};
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function flash(m,c){ var l=document.getElementById('live'); l.textContent=m; l.style.color=c||'var(--muted)'; }
  function mopen(id){ document.getElementById(id).classList.add('open'); }
  function mclose(id){ document.getElementById(id).classList.remove('open'); }

  function show(v){
    var vs={board:'view-board',mural:'view-mural',confirm:'view-confirm',loot:'view-loot',combat:'view-combat',devices:'view-devices'};
    for(var k in vs){ var el=document.getElementById(vs[k]); if(el) el.style.display=(k===v)?'':'none'; }
    Array.prototype.forEach.call(document.querySelectorAll('.nav[data-view]'),function(b){ b.classList.toggle('on', b.getAttribute('data-view')===v); });
    if(v==='confirm') renderConfirm();
    if(v==='loot') renderLoot();
    if(v==='combat') renderCombat();
    if(v==='devices') renderDevices();
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
    s.options.forEach(function(w){ var o=document.createElement('option'); o.value=w; o.textContent=w; if(w===s.weapon)o.selected=true; sel.appendChild(o); });
    wspan.style.display='none'; wspan.parentNode.insertBefore(sel,wspan.nextSibling); sel.focus();
    function close(){ if(sel.parentNode) sel.parentNode.removeChild(sel); wspan.style.display=''; }
    sel.addEventListener('change',function(){ var v=sel.value; close(); if(v!==s.weapon) doSetWeapon(s.userId,v); });
    sel.addEventListener('blur',close);
  }

  function render(data){
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
      var ph=document.createElement('div'); ph.className='ph'; ph.innerHTML='<span class="name">'+esc(pt.name)+'</span><span class="ct">'+pt.filled+'/'+pt.total+'</span><div class="meter"><i style="width:'+pct+'%"></i></div>'; sec.appendChild(ph);
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
    es=new EventSource('/api/stream?event='+encodeURIComponent(id));
    es.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); flash('● ao vivo · sincronizado com Discord','var(--green)'); }catch(e){} };
    es.onerror=function(){ flash('● reconectando…','var(--gold)'); };
    tes=new EventSource('/api/telemetry/stream?event='+encodeURIComponent(id));
    tes.onmessage=function(){
      var active=document.querySelector('.nav[data-view].on');
      var v=active&&active.getAttribute('data-view');
      if(v==='confirm') renderConfirm();
      if(v==='loot') renderLoot();
      if(v==='combat') renderCombat();
      if(v==='devices') renderDevices();
    };
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

  function openOpenModal(){
    selTime=null; selImg=null;
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
  document.getElementById('open-file').addEventListener('change',function(e){
    var f=e.target.files[0]; if(!f) return;
    var rd=new FileReader(); rd.onload=function(){ selImg=rd.result; document.getElementById('drop-txt').innerHTML='✅ '+esc(f.name)+'<br><img src="'+selImg+'">'; }; rd.readAsDataURL(f);
  });
  document.getElementById('open-go').onclick=function(){ if(!selTime){ flash('● escolha um horário','var(--red)'); return; } mclose('m-open'); post('/api/cta/open',{time:selTime,image:selImg||null}); };
  document.getElementById('flash-go').onclick=function(){ var t=(document.getElementById('flash-time').value||'').trim(); if(!t) return; mclose('m-flash'); post('/api/cta/flashmass',{time:t}); };

  function loadEvents(){
    fetch('/api/events').then(function(r){return r.json();}).then(function(list){
      var bar=document.getElementById('ctas'); bar.innerHTML='';
      if(!list.length){ bar.innerHTML='<span style="color:var(--muted)">Nenhum CTA aberto.</span>'; document.getElementById('board').innerHTML='<div class="empty-note">Nenhum CTA aberto agora.</div>'; document.getElementById('reserves').innerHTML=''; document.getElementById('status').innerHTML='<h2>Sem CTA</h2><p>Abra um CTA pra começar.</p>'; current=null; if(es){es.close();es=null;} if(tes){tes.close();tes=null;} renderCaller(); return; }
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

  // ===================== DADOS DO JOGO — TELEMETRIA REAL =====================
  function fmtS(v){ if(v==null) return '—'; if(v>=1e6) return (v/1e6).toFixed(v>=1e7?0:1).replace('.',',')+'M'; if(v>=1e3) return Math.round(v/1e3)+'K'; return String(v); }
  function liveBadge(note){ return '<div class="preview" style="color:#8ce5ad;background:#10241a;border-color:#214f31">● Telemetria conectada'+(note?' · '+esc(note):'')+'</div>'; }
  function loading(id,title){ document.getElementById(id).innerHTML='<div class="modhead">'+title+'</div><div class="empty-note">Carregando telemetria…</div>'; }
  function noCta(id,title){ document.getElementById(id).innerHTML='<div class="modhead">'+title+'</div><div class="empty-note">Selecione/abra um CTA para visualizar estes dados.</div>'; }
  function fetchTelemetry(path){ return fetch(path).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }); }

  function topList(arr, fmt){ arr=arr||[]; var mx=arr.reduce(function(a,b){return Math.max(a,b.v||0);},1);
    if(!arr.length) return '<div class="empty-note">Sem dados ainda.</div>';
    return '<div class="toplist">'+arr.map(function(r,i){ return '<div class="toprow"><span class="rk">'+(i+1)+'</span><span class="nm">'+esc(r.n)+'</span><span class="bar"><i style="width:'+Math.round((r.v||0)/mx*100)+'%"></i></span><span class="val">'+fmt(r.v||0)+'</span></div>'; }).join('')+'</div>'; }

  function renderConfirm(){
    if(!current){ noCta('view-confirm','🎯 Confirmação pelo jogo'); return; }
    loading('view-confirm','🎯 Confirmação pelo jogo');
    fetchTelemetry('/api/telemetry/confirm?event='+encodeURIComponent(current)).then(function(d){
      var r=d.resumo||{};
      var html=liveBadge((d.meta&&d.meta.partySnapshots!=null)?(d.meta.partySnapshots+' agente(s)/snapshot(s) ativos'):'')+'<div class="modhead">🎯 Confirmação pelo jogo</div>'
        +'<div class="statgrid">'
        +'<div class="stat g"><div class="k">Confirmado</div><div class="v">'+(r.confirmado||0)+'</div></div>'
        +'<div class="stat r"><div class="k">Faltando no jogo</div><div class="v">'+(r.faltando||0)+'</div></div>'
        +'<div class="stat a"><div class="k">Presente não escalado</div><div class="v">'+(r.extra||0)+'</div></div>'
        +'<div class="stat p"><div class="k">Divergência</div><div class="v">'+(r.divergencia||0)+'</div></div></div>';
      (d.pts||[]).forEach(function(pt){
        html+='<div class="panel"><h3>'+esc(pt.pt)+'</h3><table class="dtable"><thead><tr><th>Jogador</th><th>Arma escalada</th><th>Status</th><th>Observação</th></tr></thead><tbody>';
        (pt.linhas||[]).forEach(function(l){
          var lbl={ok:'Confirmado',miss:'Faltando no jogo',extra:'Presente não escalado',div:'Divergência'}[l.st]||l.st;
          html+='<tr><td><b>'+esc(l.n)+'</b></td><td>'+esc(l.arma)+'</td><td><span class="pill '+esc(l.st)+'">'+esc(lbl)+'</span></td><td style="color:var(--muted)">'+esc(l.obs||'')+'</td></tr>';
        });
        html+='</tbody></table></div>';
      });
      if(d.meta&&d.meta.note) html+='<div class="note">'+esc(d.meta.note)+'</div>';
      document.getElementById('view-confirm').innerHTML=html;
    }).catch(function(){ document.getElementById('view-confirm').innerHTML='<div class="modhead">🎯 Confirmação pelo jogo</div><div class="empty-note">Sem telemetria disponível ou erro ao carregar.</div>'; });
  }

  function renderLoot(){
    if(!current){ noCta('view-loot','📦 Registros & Loot'); return; }
    loading('view-loot','📦 Registros & Loot');
    fetchTelemetry('/api/telemetry/loot?event='+encodeURIComponent(current)).then(function(d){
      var r=d.resumo||{};
      var html=liveBadge((d.meta&&d.meta.totalEventos!=null)?(d.meta.totalEventos+' eventos de loot'):'')+'<div class="modhead">📦 Registros &amp; Loot</div>'
        +'<div class="statgrid">'
        +'<div class="stat b"><div class="k">Capturado</div><div class="v">'+fmtS(r.capturado)+'</div></div>'
        +'<div class="stat g"><div class="k">Entregue</div><div class="v">'+fmtS(r.entregue)+'</div></div>'
        +'<div class="stat a"><div class="k">Pendente</div><div class="v">'+fmtS(r.pendente)+'</div></div>'
        +'<div class="stat p"><div class="k">Divergências</div><div class="v">'+fmtS(r.divergencias)+'</div></div></div>'
        +'<div class="split"><div class="panel"><h3>Top looters</h3>'+topList(d.top||[],fmtS)+'</div>'
        +'<div class="panel"><h3>Itens recentes</h3><table class="dtable"><thead><tr><th>Jogador</th><th>Item</th><th>Qtd</th><th>Valor</th><th>Status</th></tr></thead><tbody>'
        +(d.itens||[]).map(function(i){ return '<tr><td><b>'+esc(i.jog)+'</b></td><td>'+esc(i.item)+'</td><td>'+i.qtd+'</td><td>'+fmtS(i.v)+'</td><td><span class="pill '+esc(i.st)+'">'+esc(i.st)+'</span></td></tr>'; }).join('')
        +'</tbody></table></div></div>';
      if(d.meta&&d.meta.note) html+='<div class="note">'+esc(d.meta.note)+'</div>';
      document.getElementById('view-loot').innerHTML=html;
    }).catch(function(){ document.getElementById('view-loot').innerHTML='<div class="modhead">📦 Registros & Loot</div><div class="empty-note">Sem dados de loot ou erro ao carregar.</div>'; });
  }

  function renderCombat(){
    if(!current){ noCta('view-combat','⚔️ Combate'); return; }
    loading('view-combat','⚔️ Combate');
    fetchTelemetry('/api/telemetry/combat?event='+encodeURIComponent(current)).then(function(d){
      var r=d.resumo||{};
      var html=liveBadge((d.meta&&d.meta.totalEventos!=null)?(d.meta.totalEventos+' eventos de combate'):'')+'<div class="modhead">⚔️ Combate</div>'
        +'<div class="statgrid">'
        +'<div class="stat r"><div class="k">Dano</div><div class="v">'+fmtS(r.damage)+'</div></div>'
        +'<div class="stat g"><div class="k">Cura</div><div class="v">'+fmtS(r.healing)+'</div></div>'
        +'<div class="stat a"><div class="k">Mortes</div><div class="v">'+fmtS(r.mortes)+'</div></div>'
        +'<div class="stat b"><div class="k">Fights</div><div class="v">'+fmtS(r.fights)+'</div></div></div>'
        +'<div class="panel"><h3>Resumo por PT</h3><table class="dtable"><thead><tr><th>PT</th><th>Dano</th><th>Cura</th><th>Mortes</th></tr></thead><tbody>'
        +(d.porPt||[]).map(function(x){ return '<tr><td><b>'+esc(x.pt)+'</b></td><td>'+fmtS(x.dmg)+'</td><td>'+fmtS(x.heal)+'</td><td>'+fmtS(x.mortes)+'</td></tr>'; }).join('')
        +'</tbody></table></div>'
        +'<div class="split"><div class="panel"><h3>Top dano</h3>'+topList(d.topDmg||[],fmtS)+'</div>'
        +'<div class="panel"><h3>Top cura</h3>'+topList(d.topHeal||[],fmtS)+'</div></div>';
      if(d.meta&&d.meta.note) html+='<div class="note">'+esc(d.meta.note)+'</div>';
      document.getElementById('view-combat').innerHTML=html;
    }).catch(function(){ document.getElementById('view-combat').innerHTML='<div class="modhead">⚔️ Combate</div><div class="empty-note">Sem dados de combate ou erro ao carregar.</div>'; });
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
  boot();
  setInterval(function(){ if(authState.member){ loadEvents(); loadNews(); } }, 20000);
</script>
</body>
</html>`;

module.exports = { startWebServer, notifyRosterChange, buildRosterData };
