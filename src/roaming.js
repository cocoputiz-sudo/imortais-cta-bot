// ============================================================================
// ROAMING — conteúdo avulso com montagem de PT, attendance por tempo e
// divisão de prata proporcional ao tempo de presença.
// ============================================================================

// comps por número de vagas: quantas de cada função
const ROAMING_COMPS = {
  12: { Caller: 1, Tank: 3, Support: 1, DPS: 4, Healer: 3 },
  16: { Caller: 1, Tank: 4, Support: 2, DPS: 5, Healer: 4 },
  20: { Caller: 1, Tank: 4, Support: 4, DPS: 7, Healer: 4 },
};

// tamanhos válidos
const TAMANHOS = Object.keys(ROAMING_COMPS).map(Number);

// gera a lista de vagas (ordem: caller, tanks, supports, dps, healers)
function slotsFor(vagas) {
  const comp = ROAMING_COMPS[vagas];
  if (!comp) return null;
  const slots = [];
  for (const [funcao, qtd] of Object.entries(comp))
    for (let i = 0; i < qtd; i++) slots.push(funcao);
  return slots; // ex: ["Caller","Tank","Tank","Tank","Support","DPS",...]
}

// normaliza função digitada -> nome canônico
const FUNC_MAP = {
  caller: "Caller", call: "Caller",
  tank: "Tank",
  sup: "Support", suporte: "Support", support: "Support",
  dps: "DPS", melee: "DPS", range: "DPS", ranged: "DPS",
  heal: "Healer", healer: "Healer", cura: "Healer",
};
function normFunc(txt) {
  const t = (txt || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return FUNC_MAP[t] || null;
}

// soma o tempo (min) de presença de cada user dentro do roaming (do start ao fim)
// sessions: linhas de roaming_presence ; start/end: janela do roaming
function presenceMinutes(sessions, startUTC, endUTC) {
  const byUser = {};
  for (const s of sessions) {
    const j = new Date(s.joined_at);
    const l = s.left_at ? new Date(s.left_at) : endUTC;
    const from = j > startUTC ? j : startUTC;
    const to = l < endUTC ? l : endUTC;
    if (to <= from) continue;
    byUser[s.user_id] = (byUser[s.user_id] || 0) + (to - from);
  }
  // converte pra minutos
  const out = {};
  for (const [uid, ms] of Object.entries(byUser)) out[uid] = Math.round(ms / 60000);
  return out;
}

// calcula a divisão da prata.
// elegível = pingou função (está em signupsByUser) E >= minMinutos de presença.
// divisão proporcional ao tempo (Leitura A).
// retorna [{user_id, username, minutos, valor, elegivel, motivo}]
function dividir(valor, signups, presenceMin, minMinutos = 10) {
  const signupUsers = new Set(signups.map((s) => s.user_id));
  const nomes = {}; for (const s of signups) nomes[s.user_id] = s.username;

  // todos os que têm presença ou ping
  const todos = new Set([...Object.keys(presenceMin), ...signupUsers]);
  const linhas = [];
  const elegiveis = [];
  for (const uid of todos) {
    const min = presenceMin[uid] || 0;
    const pingou = signupUsers.has(uid);
    let elegivel = true, motivo = "";
    if (!pingou) { elegivel = false; motivo = "não pingou função"; }
    else if (min < minMinutos) { elegivel = false; motivo = `< ${minMinutos} min na call`; }
    linhas.push({ user_id: uid, username: nomes[uid] || "?", minutos: min, elegivel, motivo, valor: 0 });
    if (elegivel) elegiveis.push(uid);
  }
  const totalMin = elegiveis.reduce((s, uid) => s + (presenceMin[uid] || 0), 0);
  if (totalMin > 0) {
    for (const l of linhas) {
      if (l.elegivel) l.valor = Math.round(valor * (l.minutos / totalMin));
    }
  }
  linhas.sort((a, b) => b.valor - a.valor || b.minutos - a.minutos);
  return linhas;
}

module.exports = { ROAMING_COMPS, TAMANHOS, slotsFor, normFunc, presenceMinutes, dividir };
