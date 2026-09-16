// ============================================================================
// ENGINE DE ATRIBUIÇÃO — Fase 1 & 2
// ============================================================================
const { PARTIES, WEAPONS, WEAPON_FAMILY } = require("./comps");

const U = (w) => (w || "").trim().toUpperCase();

function capFor(weapon, numParties = 4) {
  const meta = WEAPONS[U(weapon)] || {};
  if (meta.unica) {
    if (U(weapon) === "URSINAS" && numParties >= 5) return 2; // PT1 e PT5 têm Ursinas
    return 1;
  }
  if (meta.tetoPorPt) return Math.max(1, numParties - 1);
  return Infinity;
}

function countWeapon(weapon, signups) {
  return signups.filter((s) => s.party_index != null && U(s.weapon) === U(weapon)).length;
}

function slotWeight(slot, weapon) {
  const hit = slot.accepts.find((a) => U(a.weapon) === U(weapon));
  return hit ? hit.weight : null;
}

function findBestSlot(weapon, signups, numParties = 4) {
  if (countWeapon(weapon, signups) >= capFor(weapon, numParties)) return null;

  const taken = new Set();
  for (const s of signups) {
    if (s.party_index != null) taken.add(`${s.party_index}:${s.slot_index}`);
  }

  // ---- passo 1: tenta PT1 (prioridade absoluta) ----
  let best1 = null;
  for (let i = 0; i < PARTIES[0].slots.length; i++) {
    if (taken.has(`0:${i}`)) continue;
    if (PARTIES[0].slots[i].locked) continue;
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

function suggestUpgrade(chosenWeapon, myAssignment, signups, numParties = 4) {
  if (!myAssignment) return null;
  const fam = WEAPON_FAMILY[U(chosenWeapon)];
  if (!fam) return null;

  const taken = new Set();
  for (const s of signups) {
    if (s.party_index != null) taken.add(`${s.party_index}:${s.slot_index}`);
  }
  taken.add(`${myAssignment.partyIndex}:${myAssignment.slotIndex}`);

  const order = [0, ...Array.from({ length: numParties - 1 }, (_, k) => k + 1)];
  for (const p of order) {
    for (let i = 0; i < PARTIES[p].slots.length; i++) {
      if (taken.has(`${p}:${i}`)) continue;
      if (PARTIES[p].slots[i].locked) continue;
      for (const a of PARTIES[p].slots[i].accepts) {
        if (a.weight !== 1) continue;
        if (U(a.weapon) === U(chosenWeapon)) continue;
        if (WEAPON_FAMILY[U(a.weapon)] !== fam) continue;
        if (countWeapon(a.weapon, signups) >= capFor(a.weapon, numParties)) continue;
        const betterWeight = a.weight < myAssignment.weight;
        const intoPt1 = p === 0 && myAssignment.partyIndex !== 0;
        if (betterWeight || intoPt1) {
          return { weapon: a.weapon, partyIndex: p, slotIndex: i };
        }
      }
    }
  }
  return null;
}

function effectiveAccepts(slot, ctx) {
  if (slot.scDynamic && ctx && ctx.scInPt1) {
    const remap = { "PÚTRIDO": 1, "EXECRADO": 1, "DANAÇÃO": 2, "SHADOW CALLER": 3 };
    return slot.accepts.map((a) => {
      const w = remap[U(a.weapon)];
      return w != null ? { weapon: a.weapon, weight: w } : a;
    });
  }
  if (slot.gaDynamic && ctx && ctx.gaInParty) {
    return slot.accepts.map((a) => (U(a.weapon) === "G.A" ? { weapon: a.weapon, weight: 9 } : a));
  }
  return slot.accepts;
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

function countWeaponInParty(assignment, weapon, partyIndex) {
  let n = 0;
  for (const [, loc] of assignment) {
    if (loc && loc.partyIndex === partyIndex && loc._weapon && U(loc._weapon) === U(weapon)) n++;
  }
  return n;
}

function solve(signups, numParties = 4, partyList = null) {
  // partyList: lista específica de índices de PT (ex castelo [4,0,1]). Se null, usa 0..numParties.
  const parties = partyList || Array.from({ length: numParties }, (_, k) => k);
  const cells = [];
  for (const p of parties) {
    for (let i = 0; i < PARTIES[p].slots.length; i++) {
      if (PARTIES[p].slots[i].locked) continue;
      cells.push({ p, i, slot: PARTIES[p].slots[i] });
    }
  }

  const assignment = new Map();
  const usedCells = new Set();
  const usedUsers = new Set();
  const weaponCount = {};

  for (const su of signups) {
    if (su.party_index != null && PARTIES[su.party_index]?.slots[su.slot_index]?.locked) {
      assignment.set(su.user_id, {
        partyIndex: su.party_index,
        slotIndex: su.slot_index,
        kind: "caller",
        _weapon: su.weapon,
      });
      usedUsers.add(su.user_id);
      usedCells.add(`${su.party_index}:${su.slot_index}`);
      weaponCount[U(su.weapon)] = (weaponCount[U(su.weapon)] || 0) + 1;
    }
  }

  for (const pass of ["exact", "affinity"]) {
    for (const cell of cells) {
      if (usedCells.has(`${cell.p}:${cell.i}`)) continue;
      const scInPt1 = countWeaponInParty(assignment, "SHADOW CALLER", 0);
      const gaInParty = countWeaponInParty(assignment, "G.A", cell.p);
      const ctx = { scInPt1, gaInParty };
      let best = null;
      for (const su of signups) {
        if (usedUsers.has(su.user_id)) continue;
        if (U(su.weapon) === "LOOTER") continue;
        const sc = affinityScore(cell.slot, su.weapon, ctx);
        if (!sc || sc.kind !== pass) continue;
        const cap = capFor(su.weapon, numParties);
        if ((weaponCount[U(su.weapon)] || 0) >= cap) continue;

        if (
          !best ||
          sc.cost < best.cost ||
          (sc.cost === best.cost && (su.ip || 0) > (best.su.ip || 0))
        ) {
          best = { su, cost: sc.cost, kind: sc.kind };
        }
      }
      if (best) {
        assignment.set(best.su.user_id, {
          partyIndex: cell.p,
          slotIndex: cell.i,
          kind: best.kind,
          _weapon: best.su.weapon,
          _ip: best.su.ip,
        });
        usedUsers.add(best.su.user_id);
        usedCells.add(`${cell.p}:${cell.i}`);
        weaponCount[U(best.su.weapon)] = (weaponCount[U(best.su.weapon)] || 0) + 1;
      }
    }
  }

  const looters = signups.filter((su) => !usedUsers.has(su.user_id) && U(su.weapon) === "LOOTER");
  for (const su of looters) {
    for (const cell of cells) {
      if (cell.p === 0) continue;
      if (usedCells.has(`${cell.p}:${cell.i}`)) continue;
      assignment.set(su.user_id, { partyIndex: cell.p, slotIndex: cell.i, kind: "looter", _weapon: "LOOTER" });
      usedUsers.add(su.user_id);
      usedCells.add(`${cell.p}:${cell.i}`);
      break;
    }
  }

  const reserves = signups.filter((su) => !usedUsers.has(su.user_id)).map((su) => su.user_id);
  return { assignment, reserves };
}

const ROLE_PRIMES = {
  Tank:    ["Tank", "Support"],
  Support: ["Support", "Tank"],
  Melee:   ["Melee", "Ranged"],
  Ranged:  ["Ranged", "Melee"],
  Healer:  ["Healer"],
};

function weaponRole(weapon) {
  return (WEAPONS[U(weapon)] || {}).role || null;
}

function consolidate(signups, numParties = 4, partyList = null) {
  const parties = partyList || Array.from({ length: numParties }, (_, k) => k);
  const base = reallocate(signups, numParties, partyList);
  const taken = new Set();
  for (const r of base) if (r.partyIndex != null) taken.add(`${r.partyIndex}:${r.slotIndex}`);

  const semVaga = base.filter((r) => r.partyIndex == null);

  for (const r of semVaga) {
    const role = weaponRole(r.weapon);
    if (!role) continue;
    const primos = ROLE_PRIMES[role] || [role];
    let colocado = false;
    // percorre as PTs da party_list, PULANDO a primeira (PT1 intocável)
    for (let pi = 1; pi < parties.length && !colocado; pi++) {
      const p = parties[pi];
      for (let i = 0; i < PARTIES[p].slots.length; i++) {
        if (taken.has(`${p}:${i}`)) continue;
        if (PARTIES[p].slots[i].locked) continue;
        const vagaRole = PARTIES[p].slots[i].role;
        if (primos.includes(vagaRole)) {
          r.partyIndex = p;
          r.slotIndex = i;
          r.moved = true;
          r.kind = "consolidado";
          taken.add(`${p}:${i}`);
          colocado = true;
          break;
        }
      }
    }
  }
  return base;
}

function reallocate(signups, numParties = 4, partyList = null) {
  const { assignment } = solve(signups, numParties, partyList);
  return signups.map((su) => {
    const a = assignment.get(su.user_id);
    const np = a ? a.partyIndex : null;
    const ns = a ? a.slotIndex : null;
    const moved = su.party_index !== np || su.slot_index !== ns;
    return {
      user_id: su.user_id,
      username: su.username,
      weapon: su.weapon,
      presence: su.presence,
      partyIndex: np,
      slotIndex: ns,
      moved,
      kind: a?.kind,
    };
  });
}

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

function renderRoster(signups, numParties = 4, partyList = null) {
  const bySlot = new Map();
  const reserves = [];
  for (const su of signups) {
    if (su.party_index != null) bySlot.set(`${su.party_index}:${su.slot_index}`, su);
    else reserves.push(su);
  }
  const blocks = [];
  const parties = partyList || Array.from({ length: numParties }, (_, k) => k);
  let displayNum = 0;
  for (const p of parties) {
    displayNum++;
    const party = PARTIES[p];
    const label = partyList ? `Party ${displayNum}` : party.name; // castelo renomeia 1,2,3
    const lines = [];
    let filled = 0;
    for (let i = 0; i < party.slots.length; i++) {
      const slot = party.slots[i];
      const su = bySlot.get(`${p}:${i}`);
      const n = String(i + 1).padStart(2, "0");
      if (su) {
        filled++;
        const flag = su.presence === "online" ? "🟢" : "🕐";
        const ipTag =
          su.ip && ["URSINAS", "CRAVADAS"].includes((su.weapon || "").toUpperCase())
            ? ` \`IP ${su.ip}\``
            : "";
        lines.push(`\`${n}\` ${su.weapon} — **${su.username}**${ipTag} ${flag}`);
      } else {
        // vaga vazia: mostra as armas possíveis (preferíveis primeiro), Opção A
        const armas = [...slot.accepts].sort((a,b)=>a.weight-b.weight).map(a=>a.weapon);
        const lista = armas.length <= 3 ? armas.join(" / ") : armas.slice(0,3).join(" / ") + "…";
        lines.push(`\`${n}\` ${slot.locked ? "👑 CALLER" : lista} — *vazio*`);
      }
    }
    blocks.push(`__**${label}** (${filled}/${party.slots.length})__\n${lines.join("\n")}`);
  }
  if (reserves.length) {
    blocks.push(
      `__**⏳ Aguardando PT** (sem vaga nas PTs abertas)__\n` +
        reserves.map((r) => `• **${r.username}** — ${r.weapon}`).join("\n")
    );
  }
  return blocks;
}

module.exports = {
  findBestSlot, suggestUpgrade, renderRoster,
  solve, reallocate, consolidate, affinityScore,
  findOpenSlot: (w, s) => findBestSlot(w, s),
};