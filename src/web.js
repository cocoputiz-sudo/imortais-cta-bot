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

// ---- config do login (OAuth2 Discord) ----
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID || "1541617852056862801";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const GUILD_ID      = process.env.GUILD_ID || "683411304408416285";
const REDIRECT      = process.env.OAUTH_REDIRECT || "https://cta-imortais.up.railway.app/auth/callback";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;
const CALLER_TAG_ID = process.env.CALLER_TAG_ID || null;

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
        slots.push({ n: i + 1, filled: true, locked: !!slot.locked, weapon: su.weapon, username: su.username, presence: su.presence, manual: !!su.manual, userId: su.user_id, core: coreSet.has(String(su.user_id)), options: [...slot.accepts].sort((a, b) => a.weight - b.weight).map((a) => a.weapon) });
      } else {
        const options = [...slot.accepts].sort((a, b) => a.weight - b.weight).map((a) => a.weapon);
        slots.push({ n: i + 1, filled: false, locked: !!slot.locked, options });
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
      sessions.set(sid, { id: me.id, name, canEdit: canEditRoles(roles, me.id), isMember: !!member, roles });
      res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
      res.redirect("/");
    } catch (e) { console.error("oauth:", e); res.status(500).send("Erro no login. <a href='/'>Voltar</a>"); }
  });

  app.get("/auth/me", (req, res) => {
    const s = sessionOf(req);
    res.json(s ? { logged: true, name: s.name, canEdit: s.canEdit, member: !!s.isMember } : { logged: false });
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>IMORTAIS · Sala de Guerra</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    color-scheme:dark;
    --bg:#12141b; --bg2:#0e1016; --surface:#1a1e27; --raised:#222836; --line:#2b313e; --line2:#39414f;
    --txt:#e9e5db; --dim:#9aa1af; --faint:#666d7b;
    --ember:#d63b31; --ember-soft:#f0857e; --ember-glow:rgba(214,59,49,.30);
    --gold:#c9a24b; --green:#54b981;
    --disp:'Cinzel',Georgia,serif; --sans:'Inter',system-ui,sans-serif;
  }
  *{box-sizing:border-box;}
  body{ margin:0; font-family:var(--sans); color:var(--txt);
    background:radial-gradient(1200px 600px at 50% -10%, rgba(214,59,49,.10), transparent 60%), linear-gradient(180deg,var(--bg),var(--bg2));
    background-attachment:fixed; min-height:100vh; padding-top:env(safe-area-inset-top,0); }
  a{color:inherit;}
  header{ display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(18,20,27,.92); backdrop-filter:blur(6px); z-index:10; }
  .crest{ width:32px; height:36px; flex:0 0 auto; filter:drop-shadow(0 2px 6px var(--ember-glow)); }
  .brand h1{ font-family:var(--disp); font-weight:900; font-size:21px; letter-spacing:2px; margin:0; line-height:1; }
  .brand p{ margin:3px 0 0; font-size:10px; letter-spacing:3px; color:var(--gold); font-weight:600; }
  #auth{ margin-left:auto; display:flex; align-items:center; gap:12px; font-size:13px; color:var(--dim); }
  #auth a{ color:#8ab4ff; text-decoration:none; }
  #auth a:hover{ text-decoration:underline; }
  #live{ font-size:12px; color:var(--green); }
  .nav{ max-width:1180px; margin:18px auto 0; padding:0 24px; display:flex; gap:20px; border-bottom:1px solid var(--line); }
  .nv{ background:transparent; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; color:var(--dim); font-family:var(--sans); font-weight:700; font-size:15px; padding:10px 2px; cursor:pointer; }
  .nv.on{ color:var(--txt); border-bottom-color:var(--ember); }
  .warroom{ max-width:1180px; margin:20px auto 8px; padding:0 24px; }
  /* central de comando */
  .cmd{ background:linear-gradient(180deg,var(--raised),var(--surface)); border:1px solid var(--line2); border-radius:16px; padding:16px 20px; box-shadow:0 18px 50px -24px rgba(0,0,0,.8); }
  .cmd-top{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .cmd-title{ font-family:var(--disp); font-weight:700; font-size:13px; letter-spacing:2px; color:var(--gold); }
  .tabs{ display:flex; gap:8px; flex-wrap:wrap; }
  .tab{ background:var(--bg); border:1px solid var(--line); color:var(--dim); border-radius:10px; padding:8px 14px; cursor:pointer; font-size:13px; font-weight:600; }
  .tab.on{ color:#fff; border-color:var(--ember); background:linear-gradient(180deg,rgba(214,59,49,.22),rgba(214,59,49,.06)); }
  .cmd-actions{ margin-left:auto; display:flex; gap:10px; flex-wrap:wrap; }
  .btn{ border:0; border-radius:11px; padding:10px 16px; font-family:var(--sans); font-weight:700; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
  .btn-primary{ background:linear-gradient(180deg,#e5443a,#b92f26); color:#fff; }
  .btn-primary:hover{ filter:brightness(1.06); }
  .btn-gold{ background:transparent; border:1px solid var(--gold); color:var(--gold); }
  .btn-danger{ background:transparent; border:1px solid #7a2a2a; color:#ff9a9a; }
  .cmd-sel{ margin-top:14px; padding-top:14px; border-top:1px solid var(--line); display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .cmd-sel:empty{ display:none; }
  .cmd-sel .lbl{ font-size:12px; color:var(--faint); font-weight:600; letter-spacing:1px; }
  .chip{ background:var(--bg); border:1px solid var(--line); color:var(--txt); border-radius:9px; padding:8px 13px; cursor:pointer; font-size:13px; font-weight:600; }
  .chip:hover{ border-color:var(--ember); }
  /* board */
  .board-wrap{ max-width:1180px; margin:14px auto 40px; padding:0 24px; }
  .board{ display:flex; gap:16px; overflow-x:auto; padding-bottom:6px; align-items:flex-start; }
  .pt{ min-width:560px; flex:0 0 auto; background:var(--surface); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
  .pt-h{ display:flex; align-items:baseline; gap:10px; padding:12px 16px; border-bottom:1px solid var(--line); }
  .pt-h .name{ font-family:var(--disp); font-weight:700; font-size:15px; letter-spacing:1px; }
  .pt-h .count{ margin-left:auto; font-size:12px; color:var(--dim); font-variant-numeric:tabular-nums; }
  .pt-body{ display:flex; }
  .col{ flex:1 1 0; min-width:0; }
  .col + .col{ border-left:1px solid var(--line); }
  .slot{ display:flex; align-items:center; gap:9px; padding:7px 14px; border-bottom:1px solid #1d222c; font-size:13.5px; }
  .slot:last-child{ border-bottom:0; }
  .slot .n{ color:var(--faint); width:20px; font-variant-numeric:tabular-nums; font-size:12px; }
  .slot.filled{ background:linear-gradient(90deg,rgba(84,185,129,.06),transparent 40%); }
  .slot .w{ color:#bfc6d1; }
  .slot .w.wedit{ cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px; }
  .slot .sep{ width:1px; align-self:stretch; background:var(--line2); margin:0 8px; }
  .slot .u{ font-weight:600; }
  .slot .opts{ color:var(--faint); }
  .slot .empty{ color:#4d5563; font-style:italic; margin-left:auto; }
  .slot .tail{ margin-left:auto; display:inline-flex; align-items:center; gap:7px; }
  .core{ color:var(--gold); }
  .pres{ width:8px; height:8px; border-radius:50%; }
  .pres.on{ background:var(--green); box-shadow:0 0 6px rgba(84,185,129,.6); }
  .pres.wait{ background:var(--gold); }
  .lock{ color:var(--faint); font-size:12px; }
  .slot.drag{ cursor:grab; } .slot.drag:active{ cursor:grabbing; }
  .slot.over{ outline:2px solid var(--ember); outline-offset:-2px; background:#241417; }
  .wsel{ background:var(--bg); color:var(--txt); border:1px solid var(--ember); border-radius:6px; font-size:12px; padding:1px 4px; max-width:180px; }
  .reserve{ min-width:300px; flex:0 0 auto; background:var(--surface); border:1px dashed var(--line2); border-radius:14px; padding:12px 16px; }
  .reserve h3{ font-family:var(--disp); font-weight:700; font-size:13px; letter-spacing:1px; color:var(--gold); margin:0 0 8px; }
  .reserve .rz-i{ padding:5px 0; color:#bfc6d1; font-size:13.5px; }
  .reserve .rz-i.drag{ cursor:grab; }
  /* mural / notícias */
  .mural{ background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:18px 22px; box-shadow:0 14px 40px -26px #000; margin-bottom:14px; }
  .mural-h{ display:flex; align-items:baseline; gap:12px; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--line); }
  .mural-title{ font-family:var(--disp); font-weight:700; font-size:14px; letter-spacing:1px; color:var(--gold); }
  .mural-meta{ margin-left:auto; font-size:12px; color:var(--faint); }
  .news-body h2{ font-family:var(--disp); font-weight:700; font-size:19px; margin:2px 0 8px; color:var(--gold); }
  .news-body h3{ font-family:var(--disp); font-weight:700; font-size:15px; margin:14px 0 6px; }
  .news-body h4{ font-size:14px; margin:10px 0 4px; }
  .news-body p{ margin:6px 0; color:#d3d7de; font-size:14px; line-height:1.55; max-width:74ch; }
  .news-body blockquote{ margin:6px 0; padding:6px 0 6px 14px; border-left:3px solid var(--line2); color:var(--dim); font-size:13.5px; }
  .news-body strong{ color:var(--txt); }
  .enter{ text-align:center; margin-top:18px; }
  .enter .btn{ font-size:15px; padding:14px 24px; }
  .empty-note{ color:var(--faint); text-align:center; padding:30px; }
  /* gate */
  .gate{ padding:60px 18px; color:var(--dim); text-align:center; font-size:15px; line-height:1.7; }
  .gate-btn{ display:inline-block; margin-top:10px; background:var(--surface); border:1px solid var(--line2); color:#8ab4ff; padding:10px 20px; border-radius:10px; text-decoration:none; }
  /* modais */
  .modal{ display:none; position:fixed; inset:0; z-index:30; background:rgba(6,7,10,.72); backdrop-filter:blur(3px); align-items:center; justify-content:center; padding:18px; }
  .modal.open{ display:flex; }
  .sheet{ background:linear-gradient(180deg,var(--raised),var(--surface)); border:1px solid var(--line2); border-radius:18px; width:100%; max-width:520px; padding:22px 24px; position:relative; box-shadow:0 30px 80px -30px #000; }
  .sheet h2{ font-family:var(--disp); font-weight:700; font-size:18px; letter-spacing:1px; margin:0 0 4px; }
  .sheet .sub{ color:var(--dim); font-size:13px; margin:0 0 18px; }
  .x{ position:absolute; top:14px; right:16px; background:none; border:0; color:var(--dim); font-size:20px; cursor:pointer; }
  .timegrid{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; }
  .time{ background:var(--bg); border:1px solid var(--line); color:var(--txt); border-radius:11px; padding:14px 0; font-size:15px; font-weight:700; cursor:pointer; text-align:center; }
  .time:hover{ border-color:var(--ember); }
  .time.on{ border-color:var(--ember); background:linear-gradient(180deg,rgba(214,59,49,.25),rgba(214,59,49,.05)); color:#fff; }
  .drop{ display:block; border:1.5px dashed var(--line2); border-radius:12px; padding:20px; text-align:center; color:var(--dim); font-size:13px; cursor:pointer; margin-bottom:18px; }
  .drop:hover{ border-color:var(--ember); color:var(--txt); }
  .drop .ic{ font-size:24px; display:block; margin-bottom:6px; }
  .drop small{ color:var(--faint); }
  .drop img{ max-height:120px; border-radius:8px; margin-top:6px; }
  .field input{ width:100%; background:var(--bg); border:1px solid var(--line2); color:var(--txt); border-radius:11px; padding:12px 14px; font-size:15px; font-family:var(--sans); margin-bottom:14px; }
  .note{ font-size:12px; color:var(--faint); margin:-4px 0 16px; }
  .sheet .go{ width:100%; justify-content:center; padding:13px; font-size:15px; }
  .big{ font-family:var(--disp); font-size:42px; font-weight:900; line-height:1; margin:6px 0 4px; }
  .big small{ font-family:var(--sans); font-size:15px; color:var(--dim); font-weight:400; }
  .srow{ padding:6px 0; color:#c7cdd6; font-size:14px; border-top:1px solid var(--line); }
  .srow:first-of-type{ border-top:0; }
  @media (max-width:620px){ .pt,.reserve{ min-width:88vw; } .timegrid{ grid-template-columns:repeat(2,1fr);} }
</style>
</head>
<body>
<header>
  <svg class="crest" viewBox="0 0 34 38" fill="none"><path d="M17 1 33 6v13c0 9-7 15-16 18C8 34 1 28 1 19V6L17 1Z" fill="#1a1e27" stroke="#d63b31" stroke-width="1.5"/><path d="M17 8v22M9 14h16" stroke="#c9a24b" stroke-width="1.6" stroke-linecap="round"/></svg>
  <div class="brand"><h1>IMORTAIS</h1><p>SALA DE GUERRA</p></div>
  <span id="auth"></span>
  <span id="live">conectando…</span>
</header>

<div class="nav" id="nav" style="display:none">
  <button class="nv on" data-view="mural">📣 Mural</button>
  <button class="nv" data-view="board">🗺️ Planilha ao vivo</button>
</div>

<div id="gate"></div>

<div id="view-mural" class="view" style="display:none">
  <div class="warroom">
    <div id="news"></div>
    <div class="enter"><button class="btn btn-primary" onclick="show('board')">🗺️ Entrar na Sala de Guerra · ver planilha ao vivo</button></div>
  </div>
</div>

<div id="view-board" class="view" style="display:none">
  <div class="warroom">
    <div class="cmd">
      <div class="cmd-top">
        <span class="cmd-title">CTAs</span>
        <div class="tabs" id="ctas"></div>
        <div class="cmd-actions" id="cmd-actions"></div>
      </div>
      <div class="cmd-sel" id="cmd-sel"></div>
    </div>
  </div>
  <div class="board-wrap"><div class="board" id="board"></div><div id="reserves" style="max-width:1180px;margin:0 auto;padding:0 24px 30px"></div></div>
</div>

<!-- modal abrir CTA -->
<div class="modal" id="m-open"><div class="sheet"><button class="x" onclick="mclose('m-open')">✕</button>
  <h2>Abrir CTA</h2><p class="sub">Escolha o horário e, se quiser, uma arte pra ilustrar o chamado.</p>
  <div class="timegrid" id="open-times"></div>
  <label class="drop" id="open-drop"><span class="ic">🖼️</span><span id="drop-txt">Clique pra escolher a arte do CTA</span><br><small>opcional · PNG ou JPG</small><input type="file" id="open-file" accept="image/*" style="display:none"></label>
  <button class="btn btn-primary go" id="open-go">Abrir CTA</button>
</div></div>

<!-- modal flashmass -->
<div class="modal" id="m-flash"><div class="sheet"><button class="x" onclick="mclose('m-flash')">✕</button>
  <h2>⚡ Flashmass</h2><p class="sub">Massa relâmpago com ping do @imortal.</p>
  <div class="field"><input id="flash-time" placeholder="21:20"></div>
  <p class="note">Usa a arte padrão do flashmass — não precisa subir imagem.</p>
  <button class="btn btn-gold go" id="flash-go">⚡ Disparar flashmass</button>
</div></div>

<!-- modal meu desempenho -->
<div class="modal" id="m-stats"><div class="sheet"><button class="x" onclick="mclose('m-stats')">✕</button><div id="stats-body"></div></div></div>

<script>
  var authState={logged:false,member:false,canEdit:false,name:''};
  var current=null, es=null, selTime=null, selImg=null;
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function flash(msg,color){ var l=document.getElementById('live'); l.textContent=msg; l.style.color=color||'var(--dim)'; }
  function mopen(id){ document.getElementById(id).classList.add('open'); }
  function mclose(id){ document.getElementById(id).classList.remove('open'); }

  function show(v){
    document.getElementById('view-mural').style.display = v==='mural'?'':'none';
    document.getElementById('view-board').style.display = v==='board'?'':'none';
    Array.prototype.forEach.call(document.querySelectorAll('.nv'),function(b){ b.classList.toggle('on', b.getAttribute('data-view')===v); });
    window.scrollTo(0,0);
  }

  function renderAuthHeader(){
    var el=document.getElementById('auth');
    if(authState.logged){
      var tag = authState.canEdit ? '✏️ edição liberada' : (authState.member ? '👁️ leitura' : '⛔ fora do servidor');
      el.innerHTML='<span>'+tag+' · '+esc(authState.name)+'</span> '+(authState.member?'<a href="#" id="mystats">📊 meu desempenho</a>':'')+' <a href="/auth/logout">sair</a>';
      var ms=document.getElementById('mystats'); if(ms) ms.onclick=function(e){ e.preventDefault(); openStats(); };
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
      if(!list || !list.length){ box.innerHTML='<div class="mural"><div class="empty-note">📭 Nenhuma notícia por enquanto.</div></div>'; return; }
      box.innerHTML=list.map(function(n){
        var when=new Date(n.time).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        return '<div class="mural"><div class="mural-h"><span class="mural-title">📣 Mural da guilda</span><span class="mural-meta">'+esc(n.author)+' · '+when+'</span></div><div class="news-body">'+n.html+'</div></div>';
      }).join('');
    }).catch(function(){});
  }

  function post(url,body){
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
      .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){
        if(!r.ok || j.ok===false){ flash('● '+(j.error||'não foi possível'),'var(--ember)'); }
        else { flash('● feito','var(--green)'); setTimeout(function(){ loadEvents(); },700); }
      }); }).catch(function(){ flash('● erro','var(--ember)'); });
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
    var board=document.getElementById('board'); board.innerHTML='';
    (data.parties||[]).forEach(function(pt){
      var col=document.createElement('div'); col.className='pt';
      var h=document.createElement('div'); h.className='pt-h'; h.innerHTML='<span class="name">'+esc(pt.name)+'</span><span class="count">'+pt.filled+' / '+pt.total+'</span>'; col.appendChild(h);
      var body=document.createElement('div'); body.className='pt-body';
      var left=document.createElement('div'); left.className='col';
      var right=document.createElement('div'); right.className='col';
      var half=Math.ceil(pt.slots.length/2);
      pt.slots.forEach(function(s,idx){
        var row=document.createElement('div'); row.className='slot'+(s.filled?' filled':'');
        var n=('0'+s.n).slice(-2);
        if(s.filled){
          var dot=s.presence==='online'?'pres on':'pres wait';
          row.innerHTML='<span class="n">'+n+'</span><span class="w">'+esc(s.weapon)+'</span><span class="sep"></span><span class="u">'+esc(s.username)+'</span><span class="tail">'+(s.core?'<span class="core">⭐</span>':'')+(s.manual?'<span class="lock">🔒</span>':'')+'<span class="'+dot+'"></span></span>';
        } else {
          var opts=s.locked?'👑 CALLER':((s.options||[]).slice(0,3).join(' / ')+(((s.options||[]).length>3)?'…':''));
          row.innerHTML='<span class="n">'+n+'</span><span class="opts">'+esc(opts)+'</span><span class="empty">vazio</span>';
        }
        if(authState.canEdit){
          if(s.filled && !s.locked){
            row.classList.add('drag'); row.setAttribute('draggable','true');
            row.addEventListener('dragstart',function(e){ e.dataTransfer.setData('text/plain',s.userId); e.dataTransfer.effectAllowed='move'; });
            var wsp=row.querySelector('.w');
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
      body.appendChild(left); body.appendChild(right); col.appendChild(body); board.appendChild(col);
    });
    var rz=document.getElementById('reserves'); rz.innerHTML='';
    if(data.reserves && data.reserves.length){
      var wrap=document.createElement('div'); wrap.className='reserve';
      var t=document.createElement('h3'); t.textContent='⏳ AGUARDANDO PT ('+data.reserves.length+')'; wrap.appendChild(t);
      data.reserves.forEach(function(r){ var d=document.createElement('div'); d.className='rz-i'; d.innerHTML=esc(r.username)+' — '+esc(r.weapon)+(r.core?' <span class="core">⭐</span>':''); if(authState.canEdit && r.userId){ d.classList.add('drag'); d.setAttribute('draggable','true'); d.addEventListener('dragstart',function(e){ e.dataTransfer.setData('text/plain',r.userId); e.dataTransfer.effectAllowed='move'; }); } wrap.appendChild(d); });
      rz.appendChild(wrap);
    }
  }

  function connect(id){
    current=id; if(es) es.close();
    es=new EventSource('/api/stream?event='+encodeURIComponent(id));
    es.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); flash('● ao vivo','var(--green)'); }catch(e){} };
    es.onerror=function(){ flash('● reconectando…','var(--gold)'); };
  }

  function renderCaller(){
    var acts=document.getElementById('cmd-actions'), sel=document.getElementById('cmd-sel');
    if(!authState.canEdit){ acts.innerHTML=''; sel.innerHTML=''; return; }
    acts.innerHTML='<button class="btn btn-primary" id="c-open">+ Abrir CTA</button><button class="btn btn-gold" id="c-flash">⚡ Flashmass</button>';
    document.getElementById('c-open').onclick=openOpenModal;
    document.getElementById('c-flash').onclick=function(){ mopen('m-flash'); };
    if(current){
      sel.innerHTML='<span class="lbl">CTA selecionado —</span><button class="chip" data-show="flex">+ PT Flex</button><button class="chip" data-show="press">+ Press</button><button class="chip" data-show="pt6teste">+ pt6teste</button><button class="btn btn-danger" id="c-finish" style="margin-left:auto">🏁 Finalizar CTA</button>';
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
      grid.innerHTML = avail.length? avail.map(function(t){ return '<button class="time" data-t="'+t+'">'+t+'</button>'; }).join('') : '<span style="color:var(--dim)">Todos os horários já estão abertos.</span>';
      Array.prototype.forEach.call(grid.querySelectorAll('.time'),function(b){ b.onclick=function(){ grid.querySelectorAll('.time').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); selTime=b.getAttribute('data-t'); document.getElementById('open-go').textContent='Abrir CTA às '+selTime; }; });
      mopen('m-open');
    });
  }

  document.getElementById('open-file').addEventListener('change',function(e){
    var f=e.target.files[0]; if(!f) return;
    var rd=new FileReader(); rd.onload=function(){ selImg=rd.result; document.getElementById('drop-txt').innerHTML='✅ '+esc(f.name)+'<br><img src="'+selImg+'">'; }; rd.readAsDataURL(f);
  });
  document.getElementById('open-go').onclick=function(){
    if(!selTime){ flash('● escolha um horário','var(--ember)'); return; }
    mclose('m-open'); post('/api/cta/open',{time:selTime,image:selImg||null});
  };
  document.getElementById('flash-go').onclick=function(){
    var t=(document.getElementById('flash-time').value||'').trim(); if(!t) return; mclose('m-flash'); post('/api/cta/flashmass',{time:t});
  };

  function loadEvents(){
    fetch('/api/events').then(function(r){return r.json();}).then(function(list){
      var bar=document.getElementById('ctas'); bar.innerHTML='';
      if(!list.length){ bar.innerHTML='<span style="color:var(--dim)">Nenhum CTA aberto.</span>'; document.getElementById('board').innerHTML='<div class="empty-note">Nenhum CTA aberto agora.</div>'; document.getElementById('reserves').innerHTML=''; current=null; if(es){es.close();es=null;} renderCaller(); return; }
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

  Array.prototype.forEach.call(document.querySelectorAll('.nv'),function(b){ b.onclick=function(){ show(b.getAttribute('data-view')); }; });
  Array.prototype.forEach.call(document.querySelectorAll('.modal'),function(m){ m.addEventListener('click',function(e){ if(e.target===m) m.classList.remove('open'); }); });

  function boot(){
    fetch('/auth/me').then(function(r){return r.json();}).then(function(a){
      authState={logged:!!a.logged,member:!!a.member,canEdit:!!a.canEdit,name:a.name||''};
      renderAuthHeader();
      if(authState.logged && authState.member){
        document.getElementById('gate').innerHTML='';
        document.getElementById('nav').style.display='flex';
        show('mural'); loadNews(); loadEvents();
      } else {
        document.getElementById('nav').style.display='none';
        document.getElementById('view-mural').style.display='none';
        document.getElementById('view-board').style.display='none';
        document.getElementById('live').textContent='';
        document.getElementById('gate').innerHTML = authState.logged
          ? '<div class="gate">⛔ Você não é membro do servidor IMORTAIS.<br>O conteúdo é restrito à guilda.</div>'
          : '<div class="gate">🔒 Restrito aos IMORTAIS.<br>Entre com o Discord pra ver o mural e a planilha.<br><a class="gate-btn" href="/auth/login">Entrar com Discord</a></div>';
      }
    }).catch(function(){ document.getElementById('gate').innerHTML='<div class="gate">Erro ao carregar.</div>'; });
  }
  boot();
  setInterval(function(){ if(authState.member){ loadEvents(); loadNews(); } }, 20000);
</script>
</body>
</html>`;

module.exports = { startWebServer, notifyRosterChange, buildRosterData };
