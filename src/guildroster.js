"use strict";

// ============================================================================
// LISTA DA GUILDA (exportada do jogo) x PINGS DO BOT x CALL DE PREPARAÇÃO
//
// O jogador abre a aba Guild no jogo (tecla G), copia a lista e cola no site.
// A lista é uma FOTO exata de quem está logado naquele instante. Este módulo
// lê a lista e responde, para cada membro:
//   - online e pingou (e na call)           -> pronto
//   - online e pingou, fora da call         -> falta entrar na call
//   - online na call, sem ping              -> falta pingar
//   - online, sem ping e fora da call       -> "equipando" (esquipando o CTA)
//   - idem, com cargo isento (CONTRIBUINTE) -> autorizado, não cobrar
//   - offline mas pingou                    -> pingou e não está logado
//   - offline mas na call                   -> só no Discord
// Nomes em pings/call que não existem na lista colada aparecem à parte, para
// o caller perceber apelido divergente ou lista desatualizada.
//
// Formato de entrada (o do export do jogo): uma linha por membro, colunas
// separadas por TAB, com aspas: "Nome"<TAB>"Online"<TAB>"Cargo1;Cargo2".
// "Last Seen" é "Online" ou "MM/DD/YYYY HH:MM:SS" (tratado como UTC).
// ============================================================================

const MAX_CHARS = 600_000;
const MAX_LINES = 3_000;
const DEFAULT_EXEMPT_ROLES = ["contribuinte"];

// Mesma regra de nomes usada no resto do projeto: tira "!", espaços e tags
// de guilda/nacionalidade do começo ([IM], [ESP]...), em minúsculas.
function normName(v) {
  let out = String(v || "").trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^[!\s]+/, "").replace(/^\[[^\]]{1,16}\]\s*/i, "");
  } while (out !== prev);
  return out.trim().toLowerCase();
}

// Divide uma linha respeitando aspas ("" dentro de aspas vira ").
function splitLine(line, delim) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseLastSeen(raw) {
  const s = String(raw || "").trim();
  if (/^online$/i.test(s)) return { online: true, lastSeenAt: null, unknown: false };
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const mo = +m[1], d = +m[2], y = +m[3], h = +m[4], mi = +m[5], se = +(m[6] || 0);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && se <= 59) {
      const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
      if (dt.getUTCMonth() === mo - 1) return { online: false, lastSeenAt: dt, unknown: false };
    }
  }
  return { online: false, lastSeenAt: null, unknown: true };
}

function detectDelimiter(text) {
  if (text.includes("\t")) return "\t";
  // Sem TAB: aceita CSV com vírgula (cargos continuam separados por ";").
  if (/"\s*,\s*"/.test(text) || /^[^,\n]+,[^,\n]+/m.test(text)) return ",";
  return null;
}

const HEADER_NAME = /^(character name|name|nome|personagem|jogador)$/i;

function parseGuildRoster(text) {
  const result = { ok: true, members: [], skipped: [], duplicates: 0, hadHeader: false, error: null };
  let src = String(text || "").replace(/^\uFEFF/, "");
  if (!src.trim()) return { ...result, ok: false, error: "empty" };
  if (src.length > MAX_CHARS) return { ...result, ok: false, error: "too_large" };

  const lines = src.split(/\r?\n/);
  if (lines.length > MAX_LINES) return { ...result, ok: false, error: "too_many_lines" };

  const delim = detectDelimiter(src);
  if (!delim) return { ...result, ok: false, error: "unknown_format" };

  let cols = { name: 0, seen: 1, roles: 2 };
  const byKey = new Map();

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    const cells = splitLine(line, delim);

    if (idx === lines.findIndex((l) => l.trim()) && HEADER_NAME.test(cells[0] || "")) {
      result.hadHeader = true;
      cells.forEach((c, i) => {
        const h = c.toLowerCase();
        if (/last seen|visto|última|ultima/.test(h)) cols.seen = i;
        else if (/roles|cargos?/.test(h)) cols.roles = i;
        else if (HEADER_NAME.test(c)) cols.name = i;
      });
      return;
    }

    const name = (cells[cols.name] || "").trim();
    if (!name) { result.skipped.push({ line: idx + 1, reason: "sem_nome" }); return; }
    if (cells.length < 2) { result.skipped.push({ line: idx + 1, reason: "poucas_colunas", text: line.slice(0, 60) }); return; }

    const seen = parseLastSeen(cells[cols.seen]);
    if (seen.unknown) { result.skipped.push({ line: idx + 1, reason: "ultimo_visto_invalido", text: line.slice(0, 60) }); return; }
    const roles = String(cells[cols.roles] || "").split(";").map((r) => r.trim()).filter(Boolean);

    const member = { name, key: normName(name), online: seen.online, lastSeenAt: seen.lastSeenAt, roles };
    const prev = byKey.get(member.key);
    if (prev) {
      result.duplicates++;
      if (!prev.online && member.online) byKey.set(member.key, member); // prefere a linha "Online"
      return;
    }
    byKey.set(member.key, member);
  });

  result.members = [...byKey.values()];
  if (!result.members.length) return { ...result, ok: false, error: "no_members" };
  return result;
}

function minutesSince(date, now) {
  if (!date) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
}

function classifyRoster({ members, signups = [], voice = [], exemptRoles = DEFAULT_EXEMPT_ROLES, now = new Date() }) {
  const exempt = new Set((exemptRoles || []).map((r) => String(r).trim().toLowerCase()).filter(Boolean));

  const pingByKey = new Map();
  for (const s of signups) {
    const k = normName(s.username);
    if (k && !pingByKey.has(k)) pingByKey.set(k, s);
  }
  const callByKey = new Map();
  for (const v of voice) {
    const k = normName(v.username);
    if (k && !callByKey.has(k)) callByKey.set(k, v);
  }

  const groups = {
    pronto: [], pingouForaDaCall: [], naCallSemPing: [], equipando: [],
    contribuinte: [], pingouOffline: [], soDiscord: [], semCorrespondencia: [],
  };
  const memberKeys = new Set(members.map((m) => m.key));

  const item = (m, ping, call) => ({
    name: m.name,
    roles: m.roles,
    online: m.online,
    lastSeenAt: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
    offlineMinutes: m.online ? null : minutesSince(m.lastSeenAt, now),
    pinged: !!ping,
    inCall: !!call,
    weapon: ping ? (ping.weapon || null) : null,
    discordName: (ping && ping.username) || (call && call.username) || null,
    userId: (ping && ping.user_id) || (call && call.user_id) || null,
    strike: m.roles.some((r) => /^strike\b/i.test(r)),
  });

  for (const m of members) {
    const ping = pingByKey.get(m.key);
    const call = callByKey.get(m.key);
    const it = item(m, ping, call);
    const isExempt = m.roles.some((r) => exempt.has(r.toLowerCase()));

    if (m.online) {
      if (ping && call) groups.pronto.push(it);
      else if (ping && !call) groups.pingouForaDaCall.push(it);
      else if (!ping && call) groups.naCallSemPing.push(it);
      else if (isExempt) groups.contribuinte.push(it);
      else groups.equipando.push(it);
    } else if (ping) {
      groups.pingouOffline.push(it);
    } else if (call) {
      groups.soDiscord.push(it);
    }
  }

  const unmatched = new Map();
  for (const [k, s] of pingByKey) if (!memberKeys.has(k)) unmatched.set(k, { name: s.username, pinged: true, inCall: callByKey.has(k), userId: s.user_id || null });
  for (const [k, v] of callByKey) if (!memberKeys.has(k)) {
    const cur = unmatched.get(k);
    if (cur) cur.inCall = true;
    else unmatched.set(k, { name: v.username, pinged: false, inCall: true, userId: v.user_id || null });
  }
  groups.semCorrespondencia = [...unmatched.values()];

  const byName = (a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });
  for (const k of Object.keys(groups)) groups[k].sort(byName);
  groups.pingouOffline.sort((a, b) => (a.offlineMinutes ?? 1e12) - (b.offlineMinutes ?? 1e12) || byName(a, b));

  const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
  const online = members.filter((m) => m.online).length;
  return {
    takenAt: now.toISOString(),
    totals: {
      roster: members.length,
      online,
      offline: members.length - online,
      pinged: pingByKey.size,
      inCall: callByKey.size,
    },
    counts,
    groups,
  };
}

// Lê do banco o que o cruzamento precisa: inscrições do CTA e quem está AGORA
// na call de preparação (sessões abertas, canal "prep").
async function loadInputs(db, eventId) {
  const event = await db.getEvent(eventId);
  if (!event) return null;
  const signups = await db.getSignups(event.id);
  const { rows: voice } = await db.pool.query(
    `SELECT DISTINCT ON (user_id) user_id, username
       FROM voice_presence
      WHERE guild_id=$1 AND channel_kind='prep' AND left_at IS NULL
      ORDER BY user_id, joined_at DESC`,
    [event.guild_id]
  );
  return { event, signups, voice };
}

// Ponto de entrada para a rota do site.
async function analyze(db, { text, eventId, exemptRoles, now } = {}) {
  const parsed = parseGuildRoster(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const inputs = await loadInputs(db, eventId);
  if (!inputs) return { ok: false, error: "event_not_found" };

  const result = classifyRoster({
    members: parsed.members,
    signups: inputs.signups,
    voice: inputs.voice,
    exemptRoles: exemptRoles || DEFAULT_EXEMPT_ROLES,
    now: now || new Date(),
  });
  return {
    ok: true,
    event: { id: inputs.event.id, timeLabel: inputs.event.time_label, status: inputs.event.status },
    parse: { members: parsed.members.length, skipped: parsed.skipped, duplicates: parsed.duplicates, hadHeader: parsed.hadHeader },
    ...result,
  };
}

module.exports = {
  parseGuildRoster, classifyRoster, loadInputs, analyze, normName,
  DEFAULT_EXEMPT_ROLES, MAX_CHARS, MAX_LINES,
};