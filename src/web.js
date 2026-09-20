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
const { PARTIES } = require("./comps");
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
        slots.push({ n: i + 1, filled: true, locked: !!slot.locked, weapon: su.weapon, username: su.username, presence: su.presence, manual: !!su.manual, userId: su.user_id });
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
    reserves: reserves.map((r) => ({ username: r.username, weapon: r.weapon, userId: r.user_id })),
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

let _applyEdit = null;
function startWebServer(client, opts) {
  _client = client;
  _applyEdit = (opts && opts.applyEdit) || null;
  const app = express();
  app.use(express.json());

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
      if (_applyEdit) await _applyEdit(ev.id);
      res.json({ ok: true });
    } catch (e) { console.error("/api/move:", e); res.status(500).json({ error: "server" }); }
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
<title>IMORTAIS · Planilha ao vivo</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#171a21; --line:#252a34; --txt:#e6e8ec; --dim:#8b93a1; --acc:#e23b3b; --green:#3ba55d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif; padding-top:env(safe-area-inset-top,0); }
  header { display:flex; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5; }
  header h1 { font-size:16px; margin:0; letter-spacing:.3px; }
  #auth { margin-left:auto; display:flex; gap:10px; align-items:center; font-size:13px; color:var(--dim); }
  #auth a { color:#8ab4ff; text-decoration:none; }
  #auth a:hover { text-decoration:underline; }
  #live { margin-left:14px; font-size:12px; color:var(--green); }
  #ctas { display:flex; gap:8px; flex-wrap:wrap; padding:12px 18px; }
  .cta-btn { background:var(--card); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:6px 12px; cursor:pointer; font-size:13px; }
  .cta-btn.on { border-color:var(--acc); color:#fff; background:#241417; }
  .none { color:var(--dim); }
  #board { display:flex; gap:14px; overflow-x:auto; padding:6px 18px 18px; align-items:flex-start; }
  .pt { min-width:560px; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; flex:0 0 auto; }
  .pt-body { display:flex; }
  .pt-col { flex:1 1 0; min-width:0; }
  .pt-col + .pt-col { border-left:1px solid var(--line); }
  .pt-h { font-weight:700; padding:10px 12px; border-bottom:1px solid var(--line); background:#12151b; }
  .slot { display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid #1f232b; }
  .slot:last-child { border-bottom:0; }
  .slot .n { color:var(--dim); font-variant-numeric:tabular-nums; width:22px; }
  .slot.filled { background:#141b16; }
  .slot .w { color:#c7cdd6; }
  .slot .sep { flex:0 0 auto; align-self:stretch; width:1px; background:var(--line); margin:0 8px; }
  .slot.drag, .rz-i.drag { cursor:grab; }
  .slot.drag:active, .rz-i.drag:active { cursor:grabbing; }
  .slot.over { outline:2px solid var(--acc); outline-offset:-2px; background:#241417; }
  .slot .u { font-weight:600; margin-left:2px; }
  .slot .opts { color:var(--dim); }
  .slot .vazio { color:#5a6270; font-style:italic; margin-left:auto; }
  .slot .lock, .slot .dot { margin-left:auto; }
  .slot .dot { margin-left:6px; }
  #reserves { padding:0 18px 30px; }
  .rz-h { color:var(--dim); font-weight:700; margin:10px 0 6px; }
  .rz-i { color:#c7cdd6; padding:3px 0; }
  footer { color:#5a6270; text-align:center; padding:20px; font-size:12px; }
  .gate { padding:60px 18px; color:var(--dim); text-align:center; font-size:15px; line-height:1.7; }
  .gate-btn { display:inline-block; margin-top:8px; background:var(--card); border:1px solid var(--line); color:#8ab4ff; padding:9px 18px; border-radius:8px; text-decoration:none; }
  .gate-btn:hover { border-color:var(--acc); }
</style>
</head>
<body>
<header>
  <h1>🛡️ IMORTAIS — Planilha ao vivo</h1>
  <span id="auth"></span>
  <span id="live">● conectando…</span>
</header>
<div id="ctas"></div>
<div id="board"></div>
<div id="reserves"></div>
<footer>Telão em tempo real · edição em breve (Fase 2)</footer>
<script>
  var current=null, es=null;
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function doMove(uid, party, slot){
    if(!current) return;
    fetch('/api/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:current,userId:uid,party:party,slot:slot})})
      .then(function(r){ if(!r.ok){ document.getElementById('live').textContent='● não foi possível mover'; document.getElementById('live').style.color='var(--acc)'; } })
      .catch(function(){});
    // a planilha se atualiza sozinha pelo SSE quando o bot reencaixa
  }
  function render(data){
    var board=document.getElementById('board'); board.innerHTML='';
    (data.parties||[]).forEach(function(pt){
      var col=document.createElement('div'); col.className='pt';
      var h=document.createElement('div'); h.className='pt-h'; h.textContent=pt.name+' ('+pt.filled+'/'+pt.total+')'; col.appendChild(h);
      var body=document.createElement('div'); body.className='pt-body';
      var left=document.createElement('div'); left.className='pt-col';
      var right=document.createElement('div'); right.className='pt-col';
      var half=Math.ceil(pt.slots.length/2);
      pt.slots.forEach(function(s, idx){
        var row=document.createElement('div'); row.className='slot'+(s.filled?' filled':'');
        var n=('0'+s.n).slice(-2);
        if(s.filled){
          var dot=s.presence==='online'?'🟢':'🕐';
          row.innerHTML='<span class="n">'+n+'</span><span class="w">'+esc(s.weapon)+'</span><span class="sep"></span><span class="u">'+esc(s.username)+'</span>'+(s.manual?'<span class="lock">🔒</span>':'')+'<span class="dot">'+dot+'</span>';
        } else {
          var opts=s.locked?'👑 CALLER':((s.options||[]).slice(0,3).join(' / ')+(((s.options||[]).length>3)?'…':''));
          row.innerHTML='<span class="n">'+n+'</span><span class="opts">'+esc(opts)+'</span><span class="vazio">vazio</span>';
        }
        (idx<half?left:right).appendChild(row);
        if(authState.canEdit){
          if(s.filled && !s.locked){
            row.classList.add('drag'); row.setAttribute('draggable','true');
            row.addEventListener('dragstart',function(e){ e.dataTransfer.setData('text/plain', s.userId); e.dataTransfer.effectAllowed='move'; });
          }
          if(!s.locked){
            row.addEventListener('dragover',function(e){ e.preventDefault(); row.classList.add('over'); });
            row.addEventListener('dragleave',function(){ row.classList.remove('over'); });
            row.addEventListener('drop',function(e){ e.preventDefault(); row.classList.remove('over'); var uid=e.dataTransfer.getData('text/plain'); if(uid) doMove(uid, pt.display, s.n); });
          }
        }
      });
      body.appendChild(left); body.appendChild(right);
      col.appendChild(body);
      board.appendChild(col);
    });
    var rz=document.getElementById('reserves'); rz.innerHTML='';
    if(data.reserves && data.reserves.length){
      var t=document.createElement('div'); t.className='rz-h'; t.textContent='⏳ Aguardando PT ('+data.reserves.length+')'; rz.appendChild(t);
      data.reserves.forEach(function(r){ var d=document.createElement('div'); d.className='rz-i'; d.textContent=r.username+' — '+r.weapon; if(authState.canEdit && r.userId){ d.classList.add('drag'); d.setAttribute('draggable','true'); d.addEventListener('dragstart',function(e){ e.dataTransfer.setData('text/plain', r.userId); e.dataTransfer.effectAllowed='move'; }); } rz.appendChild(d); });
    }
  }
  function connect(id){
    current=id;
    if(es) es.close();
    es=new EventSource('/api/stream?event='+encodeURIComponent(id));
    es.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); document.getElementById('live').textContent='● ao vivo'; document.getElementById('live').style.color='var(--green)'; }catch(e){} };
    es.onerror=function(){ document.getElementById('live').textContent='● reconectando…'; document.getElementById('live').style.color='#c9a227'; };
  }
  function loadEvents(){
    fetch('/api/events').then(function(r){return r.json();}).then(function(list){
      var bar=document.getElementById('ctas'); bar.innerHTML='';
      if(!list.length){ bar.innerHTML='<span class="none">Nenhum CTA aberto agora.</span>'; document.getElementById('board').innerHTML=''; document.getElementById('reserves').innerHTML=''; current=null; if(es){es.close();es=null;} document.getElementById('live').textContent='● aguardando CTA'; document.getElementById('live').style.color='var(--dim)'; return; }
      var stillOpen=false;
      list.forEach(function(e){
        if(e.id===current) stillOpen=true;
        var b=document.createElement('button'); b.textContent='CTA '+e.time; b.className='cta-btn'+(e.id===current?' on':'');
        b.onclick=function(){ Array.prototype.forEach.call(document.querySelectorAll('.cta-btn'),function(x){x.classList.remove('on');}); b.classList.add('on'); connect(e.id); };
        bar.appendChild(b);
      });
      if(!stillOpen){ var first=document.querySelector('.cta-btn'); if(first){ first.classList.add('on'); connect(list[0].id); } }
    }).catch(function(){});
  }
  var authState={logged:false,member:false,canEdit:false,name:''};
  function renderAuthHeader(){
    var el=document.getElementById('auth');
    if(authState.logged){
      var tag = authState.canEdit ? '✏️ edição liberada' : (authState.member ? '👁️ somente leitura' : '⛔ fora do servidor');
      el.innerHTML='<span>'+tag+' · '+esc(authState.name)+'</span> <a href="/auth/logout">sair</a>';
    } else { el.innerHTML='<a href="/auth/login">Entrar com Discord</a>'; }
  }
  function showGate(){
    document.getElementById('ctas').innerHTML='';
    document.getElementById('reserves').innerHTML='';
    if(es){es.close();es=null;} current=null;
    document.getElementById('live').textContent='';
    document.getElementById('board').innerHTML = authState.logged
      ? '<div class="gate">⛔ Você não é membro do servidor IMORTAIS.<br>A formação é restrita à guild.</div>'
      : '<div class="gate">🔒 Planilha restrita aos IMORTAIS.<br>Entra com o Discord pra ver.<br><a class="gate-btn" href="/auth/login">Entrar com Discord</a></div>';
  }
  function boot(){
    fetch('/auth/me').then(function(r){return r.json();}).then(function(a){
      authState={logged:!!a.logged, member:!!a.member, canEdit:!!a.canEdit, name:a.name||''};
      renderAuthHeader();
      if(authState.logged && authState.member) loadEvents(); else showGate();
    }).catch(function(){ authState={logged:false,member:false,canEdit:false,name:''}; renderAuthHeader(); showGate(); });
  }
  boot();
  setInterval(function(){ if(authState.member) loadEvents(); }, 15000);
</script>
</body>
</html>`;

module.exports = { startWebServer, notifyRosterChange, buildRosterData };
