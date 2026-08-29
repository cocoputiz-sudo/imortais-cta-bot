// ============================================================================
// ENGINE DE ATRIBUIÇÃO — Fase 1
// - PT1 tem prioridade absoluta (enche primeiro); PT2+ por peso global
// - tetos: unica (máx 1) e tetoPorPt (nº PTs - 1, ex: 4 PTs => máx 3)
// - nudge de troca: só entre armas da MESMA família funcional
// ============================================================================
const { PARTIES, WEAPONS, WEAPON_FAMILY } = require("./comps");

const U = (w) => (w || "").trim().toUpperCase();

function capFor(weapon, numParties) {
  const meta = WEAPONS[U(weapon)] || {};
  if (meta.unica) return 1;
  if (meta.tetoPorPt) return Math.max(1, numParties - 1); // 4 PTs => 3
  return Infinity;
}

function countWeapon(weapon, signups) {
  return signups.filter((s) => s.party_index != null && U(s.weapon) === U(weapon)).length;
}

function slotWeight(slot, weapon) {
  const hit = slot.accepts.find((a) => U(a.weapon) === U(weapon));
  return hit ? hit.weight : null;
}

// Acha a melhor vaga. PT1 primeiro (menor peso dentro da pt1); se nada na pt1,
// vai pra pt2..ptN por peso global. Respeita teto de cópias.
function findBestSlot(weapon, signups, numParties = PARTIES.length) {
  if (countWeapon(weapon, signups) >= capFor(weapon, numParties)) return null;

  const taken = new Set();
  for (const s of signups)
    if (s.party_index != null) taken.add(`${s.party_index}:${s.slot_index}`);

  // ---- passo 1: tenta PT1 (prioridade absoluta) ----
  let best1 = null;
  for (let i = 0; i < PARTIES[0].slots.length; i++) {
    if (taken.has(`0:${i}`)) continue;
    if (PARTIES[0].slots[i].locked) continue; // vaga do caller: nao auto-preenche
    const w = slotWeight(PARTIES[0].slots[i], weapon);
    if (w == null) continue;
    if (!best1 || w < best1.weight) best1 = { partyIndex: 0, slotIndex: i, weight: w };
    if (best1 && best1.weight === 1) break;
  }
  if (best1) return best1;

  // ---- passo 2: PT2..ptN por peso global ----
  let best = null;
  for (let p = 1; p < numParties; p++) {
    for (let i = 0; i < PARTIES[p].slots.length; i++) {
      if (taken.has(`${p}:${i}`)) continue;
      const w = slotWeight(PARTIES[p].slots[i], weapon);
      if (w == null) continue;
      if (!best || w < best.weight) best = { partyIndex: p, slotIndex: i, weight: w };
      if (best && best.weight === 1) return best;
    }
  }
  return best;
}

// -------------------  NUDGE DE TROCA  --------------------------------------
// Sugere trocar de arma SOMENTE se:
//  - existe vaga aberta de peso 1 que aceita uma arma IRMÃ (mesma família)
//  - essa arma irmã respeita o teto
//  - a vaga sugerida é "melhor" (peso menor) que a atual, OU está na PT1
//    e a pessoa não está na PT1
function suggestUpgrade(chosenWeapon, myAssignment, signups, numParties = PARTIES.length) {
  if (!myAssignment) return null;
  const fam = WEAPON_FAMILY[U(chosenWeapon)];
  if (!fam) return null; // arma sem família não gera nudge

  const taken = new Set();
  for (const s of signups)
    if (s.party_index != null) taken.add(`${s.party_index}:${s.slot_index}`);
  taken.add(`${myAssignment.partyIndex}:${myAssignment.slotIndex}`);

  // varre PT1 primeiro, depois as outras
  const order = [0, ...Array.from({length:numParties-1},(_,k)=>k+1)];
  for (const p of order) {
    for (let i = 0; i < PARTIES[p].slots.length; i++) {
      if (taken.has(`${p}:${i}`)) continue;
      if (PARTIES[p].slots[i].locked) continue; // nao sugere a vaga do caller
      for (const a of PARTIES[p].slots[i].accepts) {
        if (a.weight !== 1) continue;
        if (U(a.weapon) === U(chosenWeapon)) continue;
        if (WEAPON_FAMILY[U(a.weapon)] !== fam) continue; // só irmã
        if (countWeapon(a.weapon, signups) >= capFor(a.weapon, numParties)) continue;
        // é upgrade? vaga peso1 melhor que a atual, ou pt1 e a pessoa não tá na pt1
        const betterWeight = a.weight < myAssignment.weight;
        const intoPt1 = p === 0 && myAssignment.partyIndex !== 0;
        if (betterWeight || intoPt1)
          return { weapon: a.weapon, partyIndex: p, slotIndex: i };
      }
    }
  }
  return null;
}


// ==========================================================================
// ENGINE DE REALOCAÇÃO POR AFINIDADE (Fase 2)
// Recalcula a alocação INTEIRA a cada mudança (determinístico, sem cascata).
// Prioridade de encaixe: (1) arma EXATA na vaga, (2) mesma FAMÍLIA (afinidade).
// PT1 primeiro, peso menor primeiro. Respeita tetos. Caller (locked) fica fixo.
// ==========================================================================

// score de uma arma numa vaga: exato (custo = peso) ou afinidade (peso + 10).
// null = a arma não serve nem por afinidade.
// pesos efetivos de uma vaga, considerando regras dinâmicas (contexto).
// ctx.scInPt1 = quantos Shadow Caller já estão alocados na PT1.
// Na vaga scDynamic (PT1 v8): se já tem SC na PT1, despriorize SC.
function effectiveAccepts(slot, ctx) {
  if (!slot.scDynamic || !ctx || !ctx.scInPt1) return slot.accepts;
  // já tem SC na PT1 -> Pútrido(1), Execrado(1), Danação(2), Shadow Caller(3)
  const remap = { "PÚTRIDO": 1, "EXECRADO": 1, "DANAÇÃO": 2, "SHADOW CALLER": 3 };
  return slot.accepts.map((a) => {
    const w = remap[U(a.weapon)];
    return w != null ? { weapon: a.weapon, weight: w } : a;
  });
}

function affinityScore(slot, weapon, ctx) {
  const accepts = effectiveAccepts(slot, ctx);
  const exact = accepts.find((a) => U(a.weapon) === U(weapon));
  if (exact) return { kind: "exact", cost: exact.weight };
  const fam = WEAPON_FAMILY[U(weapon)];
  if (!fam) return null;
  const kin = accepts.find((a) => WEAPON_FAMILY[U(a.weapon)] === fam);
  if (kin) return { kind: "affinity", cost: kin.weight + 10 };
  return null;
}

// resolve a alocação de todos os inscritos.
// retorna { assignment: Map(user_id -> {partyIndex, slotIndex, kind}), reserves: [user_id] }
// conta quantas cópias de uma arma estão numa PT específica (na alocação atual).
// assignment: Map(user_id -> {partyIndex, slotIndex}); precisa cruzar com signups.
// como o solve não tem os signups por user_id aqui, contamos via um mapa auxiliar.
function countWeaponInParty(assignment, weapon, partyIndex) {
  let n = 0;
  for (const [, loc] of assignment) {
    if (loc && loc.partyIndex === partyIndex && loc._weapon && U(loc._weapon) === U(weapon)) n++;
  }
  return n;
}

function solve(signups, numParties = PARTIES.length) {
  // vagas disponíveis (menos as locked), em ordem: pt asc, vaga asc
  const cells = [];
  for (let p = 0; p < numParties; p++)
    for (let i = 0; i < PARTIES[p].slots.length; i++) {
      if (PARTIES[p].slots[i].locked) continue;
      cells.push({ p, i, slot: PARTIES[p].slots[i] });
    }

  const assignment = new Map();
  const usedCells = new Set();
  const usedUsers = new Set();
  const weaponCount = {};

  // caller / locked: quem já está numa vaga locked fica fixo
  for (const su of signups) {
    if (su.party_index != null && PARTIES[su.party_index]?.slots[su.slot_index]?.locked) {
      assignment.set(su.user_id, { partyIndex: su.party_index, slotIndex: su.slot_index, kind: "caller", _weapon: su.weapon });
      usedUsers.add(su.user_id);
      usedCells.add(`${su.party_index}:${su.slot_index}`);
      weaponCount[U(su.weapon)] = (weaponCount[U(su.weapon)] || 0) + 1;
    }
  }

  // dois passes: primeiro coloca todos que dão match EXATO, depois AFINIDADE.
  // dentro de cada passe, percorre as vagas na ordem de prioridade e pega o
  // melhor candidato livre pra cada vaga.
  for (const pass of ["exact", "affinity"]) {
    for (const cell of cells) {
      if (usedCells.has(`${cell.p}:${cell.i}`)) continue;
      // contexto p/ regras dinâmicas: quantos Shadow Caller já estão na PT1
      const scInPt1 = countWeaponInParty(assignment, "SHADOW CALLER", 0);
      const ctx = { scInPt1 };
      let best = null;
      for (const su of signups) {
        if (usedUsers.has(su.user_id)) continue;
        if (U(su.weapon) === "LOOTER") continue; // looter não compete por arma
        const sc = affinityScore(cell.slot, su.weapon, ctx);
        if (!sc || sc.kind !== pass) continue;
        const cap = capFor(su.weapon, numParties);
        if ((weaponCount[U(su.weapon)] || 0) >= cap) continue;
        // desempate: menor custo; PT1 já vem antes pela ordem das cells
        if (!best || sc.cost < best.cost) best = { su, cost: sc.cost, kind: sc.kind };
      }
      if (best) {
        assignment.set(best.su.user_id, { partyIndex: cell.p, slotIndex: cell.i, kind: best.kind, _weapon: best.su.weapon });
        usedUsers.add(best.su.user_id);
        usedCells.add(`${cell.p}:${cell.i}`);
        weaponCount[U(best.su.weapon)] = (weaponCount[U(best.su.weapon)] || 0) + 1;
      }
    }
  }

  // PASSE DO LOOTER: prioridade mínima. Preenche buracos que sobraram, FORA da PT1.
  // Roda por último -> qualquer arma real já pegou sua vaga; o looter só tampa o resto.
  const looters = signups.filter((su) => !usedUsers.has(su.user_id) && U(su.weapon) === "LOOTER");
  for (const su of looters) {
    let placed = false;
    for (const cell of cells) {
      if (cell.p === 0) continue;                 // nunca na PT1
      if (usedCells.has(`${cell.p}:${cell.i}`)) continue;
      assignment.set(su.user_id, { partyIndex: cell.p, slotIndex: cell.i, kind: "looter", _weapon: "LOOTER" });
      usedUsers.add(su.user_id);
      usedCells.add(`${cell.p}:${cell.i}`);
      placed = true;
      break;
    }
    // se não achou buraco fora da PT1 -> fica de fora (reserva)
  }

  const reserves = signups.filter((su) => !usedUsers.has(su.user_id)).map((su) => su.user_id);
  return { assignment, reserves };
}

// roda o solver e devolve, pra cada inscrito, a posição nova + se MUDOU de vaga.
// retorna [{user_id, username, weapon, presence, partyIndex, slotIndex, moved, kind}]
function reallocate(signups, numParties = PARTIES.length) {
  const { assignment } = solve(signups, numParties);
  return signups.map((su) => {
    const a = assignment.get(su.user_id);
    const np = a ? a.partyIndex : null;
    const ns = a ? a.slotIndex : null;
    const moved = su.party_index !== np || su.slot_index !== ns;
    return {
      user_id: su.user_id, username: su.username, weapon: su.weapon,
      presence: su.presence, partyIndex: np, slotIndex: ns, moved, kind: a?.kind,
    };
  });
}

// rótulo curto por vaga (pra planilha não estourar o limite do Discord)
function shortLabel(slot) {
  const ws = slot.accepts.map((a) => a.weapon);
  if (slot.locked) return "👑 CALLER";
  if (ws.length === 1) return ws[0];
  if (ws.includes("SHADOW CALLER") || ws.includes("DANAÇÃO") || ws.includes("PÚTRIDO")) return "DEBUFF";
  if (ws.includes("CAÇA ESPÍRITOS") || ws.includes("ENTALHADA")) return "DEBUFF MELEE";
  if (ws.includes("RAMPANTE") || ws.includes("POSTULENTO")) return "NATURE";
  if (slot.role === "Healer") return "HEALER";
  if (slot.role === "Tank") return "TANK";
  if (slot.role === "Support") return "SUPORTE";
  return "DPS";
}

// -------------------  RENDER  ----------------------------------------------
function renderRoster(signups, numParties = PARTIES.length) {
  const bySlot = new Map();
  const reserves = [];
  for (const su of signups) {
    if (su.party_index != null) bySlot.set(`${su.party_index}:${su.slot_index}`, su);
    else reserves.push(su);
  }
  const blocks = [];
  for (let p = 0; p < numParties; p++) {
    const party = PARTIES[p];
    const lines = [];
    let filled = 0;
    for (let i = 0; i < party.slots.length; i++) {
      const slot = party.slots[i];
      const su = bySlot.get(`${p}:${i}`);
      const n = String(i + 1).padStart(2, "0");
      if (su) {
        filled++;
        const flag = su.presence === "online" ? "🟢" : "🕐";
        lines.push(`\`${n}\` ${su.weapon} — **${su.username}** ${flag}`);
      } else {
        lines.push(`\`${n}\` ${shortLabel(slot)} — *vazio*`);
      }
    }
    blocks.push(`__**${party.name}** (${filled}/${party.slots.length})__\n${lines.join("\n")}`);
  }
  if (reserves.length)
    blocks.push(`__**Reserva / sem vaga**__\n` + reserves.map((r) => `• **${r.username}** — ${r.weapon}`).join("\n"));
  return blocks;
}

module.exports = {
  findBestSlot, suggestUpgrade, renderRoster,
  solve, reallocate, affinityScore,
  findOpenSlot: (w, s) => findBestSlot(w, s),
};
