// ============================================================================
// COMPS DA IMORTAIS  —  transcritas da planilha oficial (prints de 17/08/2026)
// ============================================================================
// Cada party tem 20 vagas fixas. A ordem importa: o bot preenche de cima pra
// baixo. Um slot pode aceitar mais de uma arma usando "A/B" (ex.: healer flex).
//
// >>> ESTE É O ARQUIVO QUE VOCÊ EDITA quando o caller mudar a comp. <<<
// Só mexer aqui — nada de tocar no resto do código.
// ============================================================================

// Papéis (só pra cor/emoji no Discord; a atribuição é por ARMA, não por papel)
const ROLES = {
  Tank:    { emoji: "🛡️", color: 0x2b6cb0 },
  Support: { emoji: "🎺", color: 0xb7791f },
  Ranged:  { emoji: "🏹", color: 0x9b2c2c },
  Melee:   { emoji: "⚔️", color: 0x9b2c2c },
  Healer:  { emoji: "💚", color: 0x2f855a },
};

// Helper pra deixar a transcrição enxuta: s("GOLEM","Tank")
const s = (weapon, role) => ({ weapon, role });

const PARTIES = [
  {
    name: "Party 1",
    slots: [
      s("GOLEM", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("ARVORE", "Support"),
      s("JURADOR", "Support"),
      s("SHADOW CALLER", "Support"),
      s("DANAÇÃO", "Support"),
      s("CAÇA ESPÍRITOS", "Support"),
      s("SILENCE", "Support"),
      s("QUEBRA REINOS", "Ranged"),
      s("PRISMA", "Ranged"),
      s("CANÇÃO", "Ranged"),
      s("BRAÇADEIRAS", "Melee"),
      s("URSINAS", "Melee"),
      s("CRAVADAS", "Melee"),
      s("QUEDA SANTA", "Healer"),
      s("QUEDA SANTA", "Healer"),
      s("QUEDA SANTA", "Healer"),
      s("RAMPANTE/POSTULENTO", "Healer"),
    ],
  },
  {
    name: "Party 2",
    slots: [
      s("MAÇA PESADA", "Tank"),
      s("MARTELO", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("ARVORE", "Tank"),
      s("JURADOR", "Support"),
      s("JURADOR", "Support"),
      s("GA", "Support"),
      s("CAÇA ESPÍRITOS", "Support"),
      s("BEHEMOT", "Support"),
      s("CARROÇA", "Support"),
      s("QUEBRA REINOS", "Ranged"),
      s("QUEBRA REINOS", "Ranged"),
      s("BRAÇADEIRAS", "Ranged"),
      s("PRISMA", "Melee"),
      s("CANÇÃO", "Melee"),
      s("GALATINAS", "Melee"),
      s("QUEDA SANTA", "Healer"),
      s("CORROMPIDO", "Healer"),
      s("QUEDA SANTA", "Healer"),
      s("RAMPANTE/POSTULENTO", "Healer"),
    ],
  },
  {
    name: "Party 3",
    slots: [
      s("GOLEM", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("MAÇA PESADA", "Tank"),
      s("LOCUS", "Support"),
      s("BRAÇADEIRAS", "Support"),
      s("CANÇÃO", "Support"),
      s("PRESA DEMMO", "Melee"),
      s("GALATINAS", "Melee"),
      s("QUEBRA REINOS", "Melee"),
      s("QUEBRA REINOS", "Melee"),
      s("ASTRAL", "Melee"),
      s("ASTRAL", "Melee"),
      s("SINCELO", "Melee"),
      s("QUEBRA REINOS", "Melee"),
      s("QUEBRA REINOS", "Melee"),
      s("QUEDA SANTA", "Healer"),
      s("QUEDA SANTA", "Healer"),
      s("POSTULENTO", "Healer"),
      s("RAMPANTE/POSTULENTO", "Healer"),
    ],
  },
];

// ---------------------------------------------------------------------------
// Catálogo de armas distintas (gerado automaticamente das comps acima).
// Usado pra montar os menus de inscrição no Discord. Cada arma é listada sob
// o papel da primeira vez que aparece — serve só pra organizar o menu.
// ---------------------------------------------------------------------------
function buildWeaponCatalog() {
  const seen = new Map(); // weapon -> role
  for (const party of PARTIES) {
    for (const slot of party.slots) {
      // "RAMPANTE/POSTULENTO" vira duas opções selecionáveis
      for (const w of slot.weapon.split("/").map((x) => x.trim())) {
        if (!seen.has(w)) seen.set(w, slot.role);
      }
    }
  }
  const byRole = {};
  for (const [weapon, role] of seen) {
    (byRole[role] ||= []).push(weapon);
  }
  return byRole; // { Tank:[...], Support:[...], ... }
}

// Um slot aceita a arma escolhida? (trata o "A/B" dos slots flex)
function slotAccepts(slotWeapon, pickedWeapon) {
  return slotWeapon
    .split("/")
    .map((x) => x.trim().toUpperCase())
    .includes(pickedWeapon.trim().toUpperCase());
}

module.exports = {
  ROLES,
  PARTIES,
  WEAPON_CATALOG: buildWeaponCatalog(),
  slotAccepts,
};
