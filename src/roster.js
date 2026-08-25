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
  findOpenSlot: (w, s) => findBestSlot(w, s),
};
