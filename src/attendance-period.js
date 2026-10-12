"use strict";

// Datas de premiação em UTC: [início, fim), por DIA OPERACIONAL do CTA.
// Assim "27/09 até 04/10" e "04/10 até 11/10" nunca repetem o dia 04.
function parseDay(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) throw new RangeError("Use DD/MM/AAAA, por exemplo 27/09/2026.");
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  if (year < 2020 || year > 2100) throw new RangeError("Ano fora do intervalo permitido.");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    throw new RangeError("Data inválida: " + s);
  return date;
}
function formatDay(date) {
  return String(date.getUTCDate()).padStart(2, "0") + "/" +
    String(date.getUTCMonth() + 1).padStart(2, "0") + "/" + date.getUTCFullYear();
}
function parsePeriod(fromRaw, toRaw) {
  const start = parseDay(fromRaw), end = parseDay(toRaw);
  const days = Math.round((end - start) / 86400000);
  if (days < 1 || days > 93)
    throw new RangeError("O fim deve ser posterior ao início, com no máximo 93 dias. O dia final é exclusivo.");
  return { start, end, days, startLabel: formatDay(start), lastLabel: formatDay(new Date(end - 86400000)),
    exclusiveEndLabel: formatDay(end) };
}

function excludedRoleIds(env=process.env) {
  return new Set([
    env.STAFF_ROLE_ID, env.CALLER_TAG_ID, env.BOMB_LEADER_ROLE_ID,
    "1268568850971230331", // Mestre de Guerra: ID definido em index.js
    ...String(env.OFFICER_ROLE_IDS || "").split(","),
    ...String(env.ATTENDANCE_PRIZE_EXCLUDED_ROLE_IDS || "").split(",")
  ].map(String).map(s=>s.trim()).filter(s=>s && s !== "undefined"));
}
const EXCLUDED_ROLE_NAME = /(?:^|[\s_-])(?:officers?|oficia(?:l|is)|l[ií]der(?:es)?|leaders?|mestre\s+de\s+guerra|guild\s?master|guild\s?leader|callers?|gm)(?=$|[\s_-])/i;

function memberExclusionReason(member, guild, roleIds=excludedRoleIds()) {
  if (!member) return "Cargo não verificado";
  if (String(guild?.ownerId) === String(member.id || member.user?.id)) return "Dono do servidor";
  const perms = member.permissions;
  if (perms && (perms.has?.("Administrator") || perms.has?.("ManageGuild")))
    return "Administração do servidor";
  const roles = member.roles?.cache;
  if (!roles || typeof roles.values !== "function") return "Cargo não verificado";
  for (const role of roles.values()) {
    if (roleIds.has(String(role.id))) return "Cargo de liderança (ID)";
    if (EXCLUDED_ROLE_NAME.test(String(role.name || "").trim()))
      return "Cargo de liderança: " + String(role.name);
  }
  return null;
}

async function selectPrizeWinners(rows, guild, {limit=10, fetchMember, env=process.env}={}) {
  const winners=[], excluded=[], unresolved=[];
  const roleIds=excludedRoleIds(env);
  // A tabela original continua intacta. Para premiação é preciso ter ficado
  // pelo menos 30 minutos em algum CTA e pontuação positiva.
  const candidates=(rows||[]).filter(r => (Number(r.integral)||0)+(Number(r.parcial)||0)>0 && Number(r.score)>0);
  for (const row of candidates) {
    if (winners.length >= limit) break;
    let member;
    try {
      member=await (fetchMember ? fetchMember(String(row.user_id)) : guild?.members?.fetch(String(row.user_id)));
    } catch (_) {
      unresolved.push(row);
      continue; // nunca presumir que jogador desconhecido não é officer
    }
    const reason=memberExclusionReason(member,guild,roleIds);
    if (reason === "Cargo não verificado") unresolved.push(row);
    else if (reason) excluded.push({...row,exclusionReason:reason});
    else winners.push(row);
  }
  return {winners,excluded,unresolved,checkedAt:new Date().toISOString()};
}
module.exports={parseDay,formatDay,parsePeriod,excludedRoleIds,memberExclusionReason,selectPrizeWinners};
