// ============================================================================
// COMPS DO BOMB — IMORTAIS
// PT avulsa de bomb (fora das 4 do CTA). Duas comps montáveis: INVI e MELEE.
// KITE não é montada pelo bot (só lista os nomes de quem confirmou).
//
// Estrutura de vaga: { role, accepts:[{weapon,weight}], locked? }
// (mesmo formato do comps.js pra reaproveitar a engine de encaixe)
// ============================================================================
const slot = (role, accepts, extra = {}) => ({
  role,
  accepts: accepts.map((a) => (Array.isArray(a) ? { weapon: a[0], weight: a[1] } : { weapon: a, weight: 1 })),
  ...extra,
});

// --- BOMB INVI ---
// Caller (Bruxo) + 6 Arco Plangente + singles
const BOMB_INVI = [
  { ...slot("Tank", [["BRUXO DE UMA MÃO", 1]]), locked: true }, // caller
  slot("Ranged", [["ARCO PLANGENTE", 1]]),
  slot("Ranged", [["ARCO PLANGENTE", 1]]),
  slot("Ranged", [["ARCO PLANGENTE", 1]]),
  slot("Ranged", [["ARCO PLANGENTE", 1]]),
  slot("Ranged", [["ARCO PLANGENTE", 1]]),
  slot("Ranged", [["ARCO PLANGENTE", 1]]),
  slot("Support", [["EXECRADO", 1]]),
  slot("Ranged", [["PRISMA", 1]]),
  slot("Ranged", [["CANÇÃO", 1]]),
  slot("Melee", [["CRAVADAS", 1]]),
  slot("Support", [["CAÇA ESPÍRITOS", 1]]),
  slot("Support", [["PÚTRIDO", 1]]),
  slot("Healer", [["QUEDA SANTA", 1], ["EXALTADO", 1], ["CORROMPIDO", 2]]), // ??? CONFERIR healer
  slot("Support", [["OCULTO", 1]]),
  slot("Tank", [["MAÇA PESADA", 1]]),
];

// --- BOMB MELEE ---
// Caller (Golem) + 6 DPS MELEE (Braçadeiras OU Fúria Contida) + singles
const BOMB_MELEE = [
  { ...slot("Tank", [["GOLEM", 1]]), locked: true }, // caller
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["QUEBRA REINOS", 1]]),
  slot("Ranged", [["CANÇÃO", 1]]),
  slot("Support", [["SHADOW CALLER", 1]]), // Chama Sombra
  slot("Healer", [["QUEDA SANTA", 1], ["EXALTADO", 1], ["CORROMPIDO", 2]]),
  slot("Support", [["OCULTO", 1]]),
  slot("Support", [["CAÇA ESPÍRITOS", 1]]),
  slot("Tank", [["MAÇA PESADA", 1], ["JURADOR", 1], ["MAÇA PÉTREA", 1]]),
];

const BOMB_COMPS = {
  invi: { name: "Bomb Invi", slots: BOMB_INVI },
  melee: { name: "Bomb Melee", slots: BOMB_MELEE },
  // kite: não é montada pelo bot
};

// armas exclusivas do bomb (pra somar ao catálogo do menu)
const BOMB_WEAPONS = {
  "ARCO PLANGENTE": { role: "Ranged" },
  "EXECRADO":       { role: "Support" },
  "OCULTO":         { role: "Support" },
};

const KITE_MIN = 13; // Kite só libera com >= 13 confirmados

module.exports = { BOMB_COMPS, BOMB_WEAPONS, KITE_MIN };
