// ============================================================================
// ATTENDANCE — Camada 2 (cálculo)
// Cruza: pings no CTA (cta_signups) + presença em call (voice_presence) +
//        confirmações no bomb (bomb_confirms).
// Classifica cada pessoa por CTA: INTEGRAL / PARCIAL / MENÇÃO / (nada).
// Marca FANTASMA: pingou no CTA mas não apareceu na call.
// ============================================================================
const db = require("./db");

// dado o time_label ("17:20") e a data do evento, calcula a janela.
// padrão: janela = ping -> +1h40; chegada válida na 1ª meia hora; ficar até 10min antes do fim.
function windowFor(event) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((event.time_label || "").trim());
  if (!m) return null;
  const base = new Date(event.created_at); // dia do CTA
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
    parseInt(m[1], 10), parseInt(m[2], 10), 0, 0));
  // janela: começa no ping, batalha começa +40min, termina +1h40 do ping
  const end = new Date(start.getTime() + 100 * 60000);          // +1h40 (ex 17:20 -> 19:00)
  const arrivalLimit = new Date(start.getTime() + 40 * 60000);  // chegar até +40min (ex 18:00)
  const stayUntil = new Date(end.getTime() - 10 * 60000);       // ficar até 10min antes (ex 18:50)
  return { start, end, arrivalLimit, stayUntil };
}

// soma o tempo (min) que a pessoa esteve na call dentro da janela, e o 1º join / último leave
function presenceInWindow(sessions, win) {
  let totalMs = 0, firstJoin = null, lastLeave = null;
  for (const s of sessions) {
    const j = new Date(s.joined_at);
    const l = s.left_at ? new Date(s.left_at) : win.end; // ainda na call = conta até o fim da janela
    const from = j > win.start ? j : win.start;
    const to = l < win.end ? l : win.end;
    if (to <= from) continue;
    totalMs += (to - from);
    if (!firstJoin || j < firstJoin) firstJoin = j;
    if (!lastLeave || l > lastLeave) lastLeave = l;
  }
  return { minutes: Math.round(totalMs / 60000), firstJoin, lastLeave };
}

// classifica uma pessoa num CTA
// pingou: bool (tem signup com vaga no cta) ; pres: resultado de presenceInWindow
function classify(pingou, pres, win) {
  const esteve = pres.minutes > 0;
  if (!esteve && pingou) return "FANTASMA";      // pingou mas não apareceu
  if (!esteve) return null;                        // nem pingou nem veio: fora
  const chegouCedo = pres.firstJoin && pres.firstJoin <= win.arrivalLimit;
  const ficouAteFim = pres.lastLeave && pres.lastLeave >= win.stayUntil;
  if (pingou && chegouCedo && ficouAteFim) return "INTEGRAL";
  if (pingou) return "PARCIAL";
  // não pingou mas esteve: MENÇÃO só se entrou antes dos 10 min finais
  if (pres.firstJoin && pres.firstJoin < win.stayUntil) return "MENCAO";
  return null; // entrou só no fim sem pingar -> ignorado
}

// processa UM evento -> Map(user_id -> {username, level, minutes, pingou, bomb})
async function processEvent(event) {
  const win = windowFor(event);
  if (!win) return new Map();

  const signups = await db.getSignups(event.id);        // quem pingou (com vaga ou reserva)
  const bombConfirms = await db.getBombConfirms(event.id);
  const presPrep = await db.getPresenceInWindow(event.guild_id, "prep", win.start, win.end);
  const presBomb = await db.getPresenceInWindow(event.guild_id, "bomb", win.start, win.end);

  // agrupa presença por user
  const byUser = new Map();
  const ensure = (uid, uname) => {
    if (!byUser.has(uid)) byUser.set(uid, { username: uname, prepSessions: [], bombSessions: [], pingou: false, bombConfirmou: false });
    const o = byUser.get(uid); if (uname) o.username = uname; return o;
  };
  for (const p of presPrep) ensure(p.user_id, p.username).prepSessions.push(p);
  for (const p of presBomb) ensure(p.user_id, p.username).bombSessions.push(p);
  for (const s of signups) { const o = ensure(s.user_id, s.username); if (s.party_index != null) o.pingou = true; }
  for (const b of bombConfirms) if (b.coming) ensure(b.user_id, b.username).bombConfirmou = true;

  const result = new Map();
  for (const [uid, o] of byUser) {
    const pres = presenceInWindow(o.prepSessions, win);
    const level = classify(o.pingou, pres, win);
    const bombPres = presenceInWindow(o.bombSessions, win);
    const fmt = (d) => d ? new Date(d).toISOString().slice(11, 16) : null; // HH:MM UTC
    result.set(uid, {
      username: o.username,
      level,                              // INTEGRAL|PARCIAL|MENCAO|FANTASMA|null
      minutes: pres.minutes,
      pingou: o.pingou,
      bomb: o.bombConfirmou || bombPres.minutes > 0, // confirmou OU esteve na bomb squad
      bombMinutes: bombPres.minutes,
      // detalhe pro drill-down:
      prepIn: fmt(pres.firstJoin), prepOut: fmt(pres.lastLeave), prepMin: pres.minutes,
      bombIn: fmt(bombPres.firstJoin), bombOut: fmt(bombPres.lastLeave), bombMin: bombPres.minutes,
    });
  }
  return result;
}

// agrega vários eventos num período -> ranking por pessoa
async function buildReport(guildId, startUTC, endUTC) {
  const events = await db.getEventsInRange(guildId, startUTC, endUTC);
  const perUser = new Map(); // uid -> stats acumulados

  const ensure = (uid, uname) => {
    if (!perUser.has(uid))
      perUser.set(uid, { username: uname, integral: 0, parcial: 0, mencao: 0, fantasma: 0, bomb: 0, ctasPossiveis: 0, minutos: 0, detail: {} });
    const o = perUser.get(uid); if (uname) o.username = uname; return o;
  };

  let ctaCount = 0;
  const peak = { prep: 0, bomb: 0 };
  for (const ev of events) {
    ctaCount++;
    const dateKey = new Date(ev.created_at).toISOString().slice(0, 10); // YYYY-MM-DD
    const res = await processEvent(ev);
    for (const [uid, r] of res) {
      const o = ensure(uid, r.username);
      if (r.level === "INTEGRAL") o.integral++;
      else if (r.level === "PARCIAL") o.parcial++;
      else if (r.level === "MENCAO") o.mencao++;
      else if (r.level === "FANTASMA") o.fantasma++;
      if (r.bomb) o.bomb++;
      o.minutos += r.minutes;
      // guarda o detalhe por data -> CTA (só se teve alguma presença ou classificação)
      if (r.level) {
        (o.detail[dateKey] ||= []).push({
          cta: ev.time_label, level: r.level,
          prepIn: r.prepIn, prepOut: r.prepOut, prepMin: r.prepMin,
          bombIn: r.bombIn, bombOut: r.bombOut, bombMin: r.bombMin,
        });
      }
    }
  }

  // score ponderado + categoria
  const rows = [];
  for (const [uid, o] of perUser) {
    const score = o.integral * 3 + o.parcial * 1 + o.mencao * 0 - o.fantasma * 1;
    let cat;
    const comparecimentos = o.integral + o.parcial;
    if (o.fantasma >= 2 && comparecimentos === 0) cat = "Fantasma";
    else if (o.integral >= Math.ceil(ctaCount * 0.7)) cat = "Pilar";
    else if (comparecimentos >= Math.ceil(ctaCount * 0.4)) cat = "Regular";
    else if (comparecimentos > 0) cat = "Intermitente";
    else cat = "Ausente";
    rows.push({ user_id: uid, ...o, score, cat });
  }
  rows.sort((a, b) => b.score - a.score || b.integral - a.integral);

  return { ctaCount, rows, events };
}

module.exports = { windowFor, presenceInWindow, classify, processEvent, buildReport };
