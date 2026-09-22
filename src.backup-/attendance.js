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
// RECORTADOS na janela (não os horários brutos da sessão).
function presenceInWindow(sessions, win) {
  let totalMs = 0, firstJoin = null, lastLeave = null;
  for (const s of sessions) {
    const j = new Date(s.joined_at);
    const l = s.left_at ? new Date(s.left_at) : win.end; // ainda na call = conta até o fim da janela
    const from = j > win.start ? j : win.start;          // recorta início na janela
    const to = l < win.end ? l : win.end;                // recorta fim na janela
    if (to <= from) continue;                             // sessão fora da janela
    totalMs += (to - from);
    if (!firstJoin || from < firstJoin) firstJoin = from; // usa o recortado, não o bruto
    if (!lastLeave || to > lastLeave) lastLeave = to;
  }
  return { minutes: Math.round(totalMs / 60000), firstJoin, lastLeave };
}

// classifica uma pessoa num CTA — BASEADO NA PRESENÇA NA CALL (não no ping).
// O ping vira informação extra (selo), não requisito. Reflete como a guild
// realmente funciona: a galera vai pra call, poucos pingam.
// pingou: bool ; pres: resultado de presenceInWindow
function classify(pingou, pres, win) {
  const esteve = pres.minutes > 0;
  if (!esteve && pingou) return "FANTASMA";   // pingou mas não apareceu na call
  if (!esteve) return null;                     // nem veio nem pingou: fora do relatório
  const chegouCedo = pres.firstJoin && pres.firstJoin <= win.arrivalLimit;
  const ficouAteFim = pres.lastLeave && pres.lastLeave >= win.stayUntil;
  // INTEGRAL: chegou no começo E ficou até o fim (independente de pingar)
  if (chegouCedo && ficouAteFim) return "INTEGRAL";
  // PARCIAL: ficou um tempo relevante (>= 30 min) mas não o CTA todo
  if (pres.minutes >= 30) return "PARCIAL";
  // RÁPIDA: passou pouco tempo (< 30 min)
  return "RAPIDA";
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
      level,
      minutes: pres.minutes,
      pingou: o.pingou,
      bomb: o.bombConfirmou || bombPres.minutes > 0,
      bombMinutes: bombPres.minutes,
      prepIn: fmt(pres.firstJoin), prepOut: fmt(pres.lastLeave), prepMin: pres.minutes,
      bombIn: fmt(bombPres.firstJoin), bombOut: fmt(bombPres.lastLeave), bombMin: bombPres.minutes,
    });
  }
  return result;
}

// agrega vários eventos num período -> ranking por pessoa
async function buildReport(guildId, startUTC, endUTC) {
  const allEvents = await db.getEventsInRange(guildId, startUTC, endUTC);
  // deduplica: mesmo dia + mesmo horário = 1 CTA só (fica o mais recente).
  // evita contar em dobro quando houve /cta_change_time ou recriação.
  const byKey = new Map();
  for (const ev of allEvents) {
    const key = new Date(ev.created_at).toISOString().slice(0, 10) + " " + ev.time_label;
    const prev = byKey.get(key);
    if (!prev || new Date(ev.created_at) > new Date(prev.created_at)) byKey.set(key, ev);
  }
  const events = [...byKey.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const perUser = new Map(); // uid -> stats acumulados

  const ensure = (uid, uname) => {
    if (!perUser.has(uid))
      perUser.set(uid, { username: uname, integral: 0, parcial: 0, rapida: 0, fantasma: 0, bomb: 0, pingou: 0, minutos: 0, detail: {} });
    const o = perUser.get(uid); if (uname) o.username = uname; return o;
  };

  let ctaCount = 0;
  for (const ev of events) {
    ctaCount++;
    const dateKey = new Date(ev.created_at).toISOString().slice(0, 10);
    const res = await processEvent(ev);
    for (const [uid, r] of res) {
      const o = ensure(uid, r.username);
      if (r.level === "INTEGRAL") o.integral++;
      else if (r.level === "PARCIAL") o.parcial++;
      else if (r.level === "RAPIDA") o.rapida++;
      else if (r.level === "FANTASMA") o.fantasma++;
      if (r.bomb) o.bomb++;
      if (r.pingou) o.pingou++;
      o.minutos += r.minutes;
      if (r.level) {
        (o.detail[dateKey] ||= []).push({
          cta: ev.time_label, level: r.level, pingou: r.pingou,
          prepIn: r.prepIn, prepOut: r.prepOut, prepMin: r.prepMin,
          bombIn: r.bombIn, bombOut: r.bombOut, bombMin: r.bombMin,
        });
      }
    }
  }

  // score ponderado + categoria (baseado em PRESENÇA na call)
  const rows = [];
  for (const [uid, o] of perUser) {
    // Integral vale 3, Parcial 1, Rápida 0.5, Fantasma penaliza 1
    const score = o.integral * 3 + o.parcial * 1 + o.rapida * 0.5 - o.fantasma * 1;
    const presencas = o.integral + o.parcial;         // "foi de verdade"
    const qualquerPresenca = presencas + o.rapida;    // apareceu de algum jeito
    let cat;
    if (presencas >= Math.ceil(ctaCount * 0.7)) cat = "Pilar";        // foi em >=70% dos CTAs
    else if (presencas >= Math.ceil(ctaCount * 0.4)) cat = "Regular"; // >=40%
    else if (qualquerPresenca > 0) cat = "Intermitente";             // apareceu às vezes
    else if (o.fantasma > 0) cat = "Fantasma";                        // só pingou e sumiu
    else cat = "Ausente";                                             // nada
    rows.push({ user_id: uid, ...o, score: Math.round(score * 10) / 10, cat });
  }
  rows.sort((a, b) => b.score - a.score || b.integral - a.integral);

  return { ctaCount, rows, events };
}

module.exports = { windowFor, presenceInWindow, classify, processEvent, buildReport };

// ============================================================================
// AUDITORIA — lista os CTAs contados no período, com contagem de presentes e
// flags (presença baixa, virada de dia, eventos mesclados por duplicidade).
// ============================================================================
async function auditEvents(guildId, startUTC, endUTC) {
  const allEvents = await db.getEventsInRange(guildId, startUTC, endUTC);
  const byKey = new Map();
  for (const ev of allEvents) {
    const key = new Date(ev.created_at).toISOString().slice(0, 10) + " " + ev.time_label;
    const prev = byKey.get(key);
    if (!prev || new Date(ev.created_at) > new Date(prev.created_at)) byKey.set(key, ev);
  }
  const events = [...byKey.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const counted = [];
  for (const ev of events) {
    const res = await processEvent(ev);
    let present = 0, pinged = 0, fantasma = 0, integral = 0;
    for (const [, r] of res) {
      if (r.pingou) pinged++;
      if (r.level === "FANTASMA") fantasma++;
      else if (r.level) { present++; if (r.level === "INTEGRAL") integral++; }
    }
    counted.push({
      id: ev.id, time: ev.time_label,
      date: new Date(ev.created_at).toISOString().slice(0, 10),
      present, pinged, fantasma, integral,
      lowPresence: present < 5,
      midnight: /^(00:|01:)/.test((ev.time_label || "").trim()),
    });
  }
  return { counted, rawCount: allEvents.length, mergedCount: allEvents.length - events.length };
}

module.exports.auditEvents = auditEvents;
