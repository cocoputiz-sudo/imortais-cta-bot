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
        slots.push({ n: i + 1, filled: true, weapon: su.weapon, username: su.username, presence: su.presence, manual: !!su.manual });
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
    reserves: reserves.map((r) => ({ username: r.username, weapon: r.weapon })),
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

function startWebServer(client) {
  _client = client;
  const app = express();

  app.get("/api/events", async (_req, res) => {
    res.json(await openEventsAll().catch(() => []));
  });

  app.get("/api/roster", async (req, res) => {
    const ev = await db.getEvent(req.query.event).catch(() => null);
    if (!ev) return res.status(404).json({ error: "not found" });
    res.json(await buildRosterData(ev));
  });

  app.get("/api/stream", async (req, res) => {
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
  #live { margin-left:auto; font-size:12px; color:var(--green); }
  #ctas { display:flex; gap:8px; flex-wrap:wrap; padding:12px 18px; }
  .cta-btn { background:var(--card); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:6px 12px; cursor:pointer; font-size:13px; }
  .cta-btn.on { border-color:var(--acc); color:#fff; background:#241417; }
  .none { color:var(--dim); }
  #board { display:flex; gap:14px; overflow-x:auto; padding:6px 18px 18px; align-items:flex-start; }
  .pt { min-width:300px; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; flex:0 0 auto; }
  .pt-h { font-weight:700; padding:10px 12px; border-bottom:1px solid var(--line); background:#12151b; }
  .slot { display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid #1f232b; }
  .slot:last-child { border-bottom:0; }
  .slot .n { color:var(--dim); font-variant-numeric:tabular-nums; width:22px; }
  .slot.filled { background:#141b16; }
  .slot .w { color:#c7cdd6; }
  .slot .u { font-weight:600; margin-left:2px; }
  .slot .opts { color:var(--dim); }
  .slot .vazio { color:#5a6270; font-style:italic; margin-left:auto; }
  .slot .lock, .slot .dot { margin-left:auto; }
  .slot .dot { margin-left:6px; }
  #reserves { padding:0 18px 30px; }
  .rz-h { color:var(--dim); font-weight:700; margin:10px 0 6px; }
  .rz-i { color:#c7cdd6; padding:3px 0; }
  footer { color:#5a6270; text-align:center; padding:20px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>🛡️ IMORTAIS — Planilha ao vivo</h1>
  <span id="live">● conectando…</span>
</header>
<div id="ctas"></div>
<div id="board"></div>
<div id="reserves"></div>
<footer>Telão em tempo real · edição em breve (Fase 2)</footer>
<script>
  var current=null, es=null;
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function render(data){
    var board=document.getElementById('board'); board.innerHTML='';
    (data.parties||[]).forEach(function(pt){
      var col=document.createElement('div'); col.className='pt';
      var h=document.createElement('div'); h.className='pt-h'; h.textContent=pt.name+' ('+pt.filled+'/'+pt.total+')'; col.appendChild(h);
      pt.slots.forEach(function(s){
        var row=document.createElement('div'); row.className='slot'+(s.filled?' filled':'');
        var n=('0'+s.n).slice(-2);
        if(s.filled){
          var dot=s.presence==='online'?'🟢':'🕐';
          row.innerHTML='<span class="n">'+n+'</span><span class="w">'+esc(s.weapon)+'</span><span class="u">'+esc(s.username)+'</span>'+(s.manual?'<span class="lock">🔒</span>':'')+'<span class="dot">'+dot+'</span>';
        } else {
          var opts=s.locked?'👑 CALLER':((s.options||[]).slice(0,3).join(' / ')+(((s.options||[]).length>3)?'…':''));
          row.innerHTML='<span class="n">'+n+'</span><span class="opts">'+esc(opts)+'</span><span class="vazio">vazio</span>';
        }
        col.appendChild(row);
      });
      board.appendChild(col);
    });
    var rz=document.getElementById('reserves'); rz.innerHTML='';
    if(data.reserves && data.reserves.length){
      var t=document.createElement('div'); t.className='rz-h'; t.textContent='⏳ Aguardando PT ('+data.reserves.length+')'; rz.appendChild(t);
      data.reserves.forEach(function(r){ var d=document.createElement('div'); d.className='rz-i'; d.textContent=r.username+' — '+r.weapon; rz.appendChild(d); });
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
  loadEvents(); setInterval(loadEvents, 15000);
</script>
</body>
</html>`;

module.exports = { startWebServer, notifyRosterChange, buildRosterData };
