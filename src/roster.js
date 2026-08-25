// Lógica de atribuição de vagas + renderização da planilha no Discord.
// FASE 0: atribuição por arma EXATA, preenchendo Party 1 -> 2 -> 3.
// (A engine de peso/substituição — trocar maça pesada por pétrea etc. — é Fase 1.)

const { PARTIES, slotAccepts } = require("./comps");

// Dado o conjunto de inscrições já atribuídas, acha a primeira vaga aberta
// (varrendo pt1, depois pt2, depois pt3) que aceita a arma escolhida.
// Retorna { partyIndex, slotIndex } ou null se não houver vaga (vira reserva).
function findOpenSlot(weapon, signups) {
  const taken = new Set(); // "p:s" já ocupados
  for (const su of signups) {
    if (su.party_index != null && su.slot_index != null) {
      taken.add(`${su.party_index}:${su.slot_index}`);
    }
  }
  for (let p = 0; p < PARTIES.length; p++) {
    const slots = PARTIES[p].slots;
    for (let i = 0; i < slots.length; i++) {
      if (taken.has(`${p}:${i}`)) continue;
      if (slotAccepts(slots[i].weapon, weapon)) return { partyIndex: p, slotIndex: i };
    }
  }
  return null;
}

// Monta o texto da planilha preenchida, party por party, pro caller.
function renderRoster(signups) {
  // indexa por vaga
  const bySlot = new Map();
  const reserves = [];
  for (const su of signups) {
    if (su.party_index != null) bySlot.set(`${su.party_index}:${su.slot_index}`, su);
    else reserves.push(su);
  }

  const blocks = [];
  for (let p = 0; p < PARTIES.length; p++) {
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
        lines.push(`\`${n}\` ${slot.weapon} — **${su.username}** ${flag}`);
      } else {
        lines.push(`\`${n}\` ${slot.weapon} — *vazio*`);
      }
    }
    blocks.push(`__**${party.name}** (${filled}/${party.slots.length})__\n${lines.join("\n")}`);
  }

  if (reserves.length) {
    const rl = reserves.map((r) => `• **${r.username}** — ${r.weapon}`).join("\n");
    blocks.push(`__**Reserva / sem vaga exata**__\n${rl}`);
  }
  return blocks;
}

module.exports = { findOpenSlot, renderRoster };
