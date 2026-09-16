// ============================================================================
// COMPS DA IMORTAIS — Fase 1 (famílias de armas + pesos)
// ============================================================================
const ROLES = {
  Tank:    { emoji: "🛡️", color: 0x2b6cb0 },
  Support: { emoji: "🎺", color: 0xb7791f },
  Ranged:  { emoji: "🏹", color: 0x9b2c2c },
  Melee:   { emoji: "⚔️", color: 0x9b2c2c },
  Healer:  { emoji: "💚", color: 0x2f855a },
};

// ---------------------------------------------------------------------------
// CATÁLOGO DE ARMAS
// ---------------------------------------------------------------------------
const WEAPONS = {
  // Tanks
  "GOLEM":                     { role: "Tank" },
  "MAÇA PESADA":               { role: "Tank" },
  "MAÇA PÉTREA":               { role: "Tank" },
  "MARTELO DE BATALHA":        { role: "Tank" },
  "MAÇA DE UMA MÃO":           { role: "Tank" },
  "MARTELO DE UMA MÃO":        { role: "Tank" },
  "MAÇA PESADA W RUNA GUARDA": { role: "Tank" },
  "BRUXO DE UMA MÃO":          { role: "Tank" },
  "MONARCA":                   { role: "Tank" },
  "MANGUAL":                   { role: "Tank" },
  "CAMBRIANA":                 { role: "Tank" },
  "SEGANÍMICA":                { role: "Tank" },
  "CAJADO PRIMORDIAL":         { role: "Tank" },

  // Supports
  "ARVORE":                    { role: "Support" },
  "JURADOR":                   { role: "Support" },
  "G.A":                       { role: "Support" },
  "LOCUS":                     { role: "Support" },
  "SILENCE":                   { role: "Support" },
  "CARROÇA":                   { role: "Support" },
  "BEHEMOT":                   { role: "Support" },
  "SHADOW CALLER":             { role: "Support" },
  "DANAÇÃO":                   { role: "Support" },
  "PÚTRIDO":                   { role: "Support" },
  "CAÇA ESPÍRITOS":            { role: "Support", tetoPorPt: true },
  "ENTALHADA":                 { role: "Support", tetoPorPt: true },
  "EXECRADO":                  { role: "Support" },
  "OCULTO":                    { role: "Support" },

  // Melee / DPS
  "QUEBRA REINOS":             { role: "Melee" },
  "BRAÇADEIRAS":               { role: "Melee" },
  "URSINAS":                   { role: "Melee", unica: true },
  "CRAVADAS":                  { role: "Melee", unica: true },
  "GALATINAS":                 { role: "Melee" },
  "PRESA DEMONIACA":           { role: "Melee" },
  "CRIA REIS":                 { role: "Melee" },
  "LAMINA DA INFINIDADE":      { role: "Melee" },
  "FÚRIA CONTIDA":             { role: "Melee" },
  "SEGADEIRA":                 { role: "Melee" },
  "PATAS DE URSO":             { role: "Melee" },
  "DESSANGRADORA":             { role: "Melee" },

  // Ranged (Arco Longo já presente; Gelo Elevado inserido)
  "PRISMA":                    { role: "Ranged" },
  "CANÇÃO":                    { role: "Ranged" },
  "ASTRAL":                    { role: "Ranged" },
  "SINCELO":                   { role: "Ranged" },
  "ARCO PLANGENTE":            { role: "Ranged" },
  "ARCO LONGO":                { role: "Ranged" },
  "GELO ELEVADO":              { role: "Ranged" },

  // Healers (apenas os 5 oficiais do bot)
  "QUEDA SANTA":               { role: "Healer" },
  "EXALTADO":                  { role: "Healer" },
  "CORROMPIDO":                { role: "Healer" },
  "RAMPANTE":                  { role: "Healer" },
  "POSTULENTO":                { role: "Healer" },
};

// ---------------------------------------------------------------------------
// FAMÍLIAS reutilizáveis
// ---------------------------------------------------------------------------
const F = {
  // Todos os Healers Holy aceitos
  HEALER_HOLY: [
    ["QUEDA SANTA", 1],
    ["EXALTADO", 1],
    ["CORROMPIDO", 1],
  ],

  // Todos os Healers Nature aceitos
  HEALER_NATURE: [
    ["RAMPANTE", 1],
    ["POSTULENTO", 1],
  ],

  // Healer Holy padrão PT1..PT4 (QS/Exaltado peso 1, Corrompido peso 2)
  HEALER_QS: [
    ["QUEDA SANTA", 1],
    ["EXALTADO", 1],
    ["CORROMPIDO", 2],
  ],

  // Bracelete padrão PT1..PT4
  BRACELETE: [
    ["RAMPANTE", 1],
    ["POSTULENTO", 1],
  ],

  TANK_MACA: [["MAÇA PESADA", 1], ["MARTELO DE BATALHA", 1], ["MAÇA DE UMA MÃO", 1]],
  DPS_LIVRE: [
    ["BRAÇADEIRAS", 1], ["QUEBRA REINOS", 1], ["CANÇÃO", 1],
    ["PRESA DEMONIACA", 2], ["GALATINAS", 2], ["ASTRAL", 2], ["PRISMA", 2],
    ["SINCELO", 2], ["CRIA REIS", 2], ["LAMINA DA INFINIDADE", 2],
  ],
};

const slot = (role, accepts) => ({
  role,
  accepts: accepts.map((a) => (Array.isArray(a) ? { weapon: a[0], weight: a[1] } : { weapon: a, weight: 1 })),
});

// ---------------------------------------------------------------------------
// PARTY 1
// ---------------------------------------------------------------------------
const PARTY1 = [
  { ...slot("Tank", [["GOLEM", 1], ["MAÇA DE UMA MÃO", 1], ["BRUXO DE UMA MÃO", 1]]), locked: true }, // 01 caller
  slot("Tank",    [["MAÇA PESADA", 1]]),                                        // 02
  slot("Tank",    [["MAÇA PESADA", 1], ["MAÇA PÉTREA", 1], ["MARTELO DE BATALHA", 1]]), // 03
  slot("Tank",    [["MAÇA PESADA", 1], ["MAÇA PÉTREA", 1], ["MARTELO DE BATALHA", 1]]), // 04
  slot("Support", [["G.A", 1], ["ARVORE", 1]]),                                   // 05
  slot("Support", [["JURADOR", 1]]),                                            // 06
  slot("Support", [["SHADOW CALLER", 1]]),                                      // 07
  { ...slot("Support", [["SHADOW CALLER", 1], ["PÚTRIDO", 2], ["DANAÇÃO", 3], ["EXECRADO", 2]]), scDynamic: true }, // 08
  slot("Support", [["CAÇA ESPÍRITOS", 1], ["ENTALHADA", 1], ["EXECRADO", 2]]),                     // 09
  slot("Support", [["SILENCE", 1]]),                                            // 10
  slot("Melee",   [["QUEBRA REINOS", 1]]),                                      // 11
  slot("Melee",   [["PRISMA", 1]]),                                             // 12
  slot("Melee",   [["CANÇÃO", 1]]),                                             // 13
  slot("Melee",   [["BRAÇADEIRAS", 1], ["CANÇÃO", 1]]),                           // 14
  slot("Melee",   [["URSINAS", 1]]),                                            // 15
  slot("Melee",   [["CRAVADAS", 1]]),                                           // 16
  slot("Healer",  [["QUEDA SANTA", 1]]),                                       // 17
  slot("Healer",  F.HEALER_QS),                                               // 18
  slot("Healer",  [["QUEDA SANTA", 1], ["CORROMPIDO", 1]]),                      // 19
  slot("Healer",  F.BRACELETE),                                               // 20
];

// ---------------------------------------------------------------------------
// PARTY 2
// ---------------------------------------------------------------------------
const PARTY2 = [
  slot("Tank",    [["MAÇA PESADA", 2], ["MARTELO DE BATALHA", 2], ["MAÇA DE UMA MÃO", 2],
                   ["BRUXO DE UMA MÃO", 1], ["GOLEM", 1], ["MONARCA", 1]]),          // 01
  slot("Tank",    [["MAÇA PESADA", 1], ["MARTELO DE BATALHA", 1], ["MAÇA DE UMA MÃO", 1]]), // 02
  slot("Tank",    [["MAÇA PESADA", 1], ["MARTELO DE BATALHA", 1], ["MAÇA DE UMA MÃO", 1]]), // 03
  { ...slot("Tank",    [["ARVORE", 1], ["MAÇA PESADA", 1], ["MARTELO DE BATALHA", 1],
                   ["MAÇA DE UMA MÃO", 1], ["MONARCA", 1], ["SILENCE", 1]]), gaDynamic: true }, // 04
  slot("Support", [["JURADOR", 1], ["MAÇA PESADA W RUNA GUARDA", 2],
                   ["MARTELO DE BATALHA", 2], ["MAÇA DE UMA MÃO", 2], ["EXECRADO", 1]]),             // 05
  slot("Support", [["JURADOR", 1], ["LOCUS", 1], ["MAÇA PESADA W RUNA GUARDA", 2],
                   ["MARTELO DE BATALHA", 2], ["MAÇA DE UMA MÃO", 2], ["EXECRADO", 1]]),             // 06
  slot("Support", [["G.A", 1]]),                                                 // 07
  slot("Support", [["CAÇA ESPÍRITOS", 1], ["ENTALHADA", 1], ["SHADOW CALLER", 1],
                   ["DANAÇÃO", 1], ["PÚTRIDO", 2], ["EXECRADO", 1]]),                               // 08
  slot("Support", [["G.A", 1], ["SILENCE", 1], ["CARROÇA", 1], ["BEHEMOT", 1], ["EXECRADO", 1]]),       // 09
  slot("Support", [["G.A", 1], ["SILENCE", 1], ["CARROÇA", 1], ["BEHEMOT", 1], ["EXECRADO", 1]]),       // 10
  slot("Melee",   [["BRAÇADEIRAS", 1], ["QUEBRA REINOS", 1], ["CANÇÃO", 1],
                   ["PRESA DEMONIACA", 2], ["GALATINAS", 2], ["ASTRAL", 2], ["PRISMA", 2],
                   ["SINCELO", 2], ["CRIA REIS", 2], ["LAMINA DA INFINIDADE", 2]]),
  slot("Melee",   [["BRAÇADEIRAS", 1], ["QUEBRA REINOS", 1], ["CANÇÃO", 1],
                   ["PRESA DEMONIACA", 2], ["GALATINAS", 2], ["ASTRAL", 2], ["PRISMA", 2],
                   ["SINCELO", 2], ["CRIA REIS", 2], ["LAMINA DA INFINIDADE", 2]]),
  slot("Melee",   F.DPS_LIVRE),                                                // 13
  slot("Melee",   F.DPS_LIVRE),                                                // 14
  slot("Melee",   [["CANÇÃO", 1]]),                                             // 15
  slot("Melee",   [["GALATINAS", 1]]),                                          // 16
  slot("Healer",  F.HEALER_QS),                                               // 17
  slot("Healer",  F.HEALER_QS),                                               // 18
  slot("Healer",  F.HEALER_QS),                                               // 19
  slot("Healer",  F.BRACELETE),                                               // 20
];

const mirror = () => PARTY2.map((s) => ({ role: s.role, accepts: s.accepts.map((a) => ({ ...a })) }));
const PARTY3 = mirror();
const PARTY4 = mirror();

// ---------------------------------------------------------------------------
// PARTY 5 (Composição solicitada com suporte total a Holy e Nature)
// ---------------------------------------------------------------------------
const PARTY5 = [
  slot("Tank",    [["MONARCA", 1]]),                                                    // 01
  slot("Tank",    [["MARTELO DE BATALHA", 1]]),                                         // 02
  slot("Tank",    [["CAJADO PRIMORDIAL", 1]]),                                          // 03
  slot("Tank",    [["MARTELO DE UMA MÃO", 1]]),                                         // 04
  slot("Melee",   [["QUEBRA REINOS", 1]]),                                              // 05
  slot("Tank",    [["SEGANÍMICA", 1], ["CAMBRIANA", 1], ["MANGUAL", 1]]),               // 06
  slot("Melee",   [["SEGADEIRA", 1], ["PATAS DE URSO", 1]]),                            // 07
  slot("Melee",   [["URSINAS", 1]]),                                                    // 08
  slot("Melee",   [["GALATINAS", 1], ["CRIA REIS", 1], ["PRESA DEMONIACA", 1], ["PATAS DE URSO", 1]]), // 09
  slot("Melee",   [["GALATINAS", 1], ["CRIA REIS", 1], ["PATAS DE URSO", 1]]),          // 10
  slot("Ranged",  [["ARCO LONGO", 1], ["CANÇÃO", 1], ["PRISMA", 1]]),                  // 11
  slot("Ranged",  [["CANÇÃO", 1], ["PRISMA", 1]]),                                     // 12
  slot("Ranged",  [["CANÇÃO", 1], ["PRISMA", 1]]),                                     // 13
  slot("Melee",   [["PRESA DEMONIACA", 1], ["DESSANGRADORA", 1]]),                      // 14
  slot("Support", [["ARVORE", 1]]),                                                     // 15
  slot("Ranged",  [["ASTRAL", 1]]),                                                     // 16
  slot("Healer",  F.HEALER_NATURE),                                                     // 17 Healer Nature (Rampante / Postulento)
  slot("Healer",  F.HEALER_HOLY),                                                       // 18 Healer Holy (QS / Exaltado / Corrompido)
  slot("Healer",  F.HEALER_HOLY),                                                       // 19 Healer Holy (QS / Exaltado / Corrompido)
  slot("Healer",  [["EXALTADO", 1], ["QUEDA SANTA", 2], ["CORROMPIDO", 2]]),           // 20 Exaltado (preferido) ou qualquer Holy
];

// ---------------------------------------------------------------------------
// PARTY 6 (pt6teste — exatamente os 20 slots solicitados)
// ---------------------------------------------------------------------------
const PARTY6_TESTE = [
  { ...slot("Tank", [["GOLEM", 1], ["MAÇA DE UMA MÃO", 1], ["MONARCA", 1]]), locked: true }, // 01 caller
  slot("Tank",    [["MAÇA PÉTREA", 1]]),                                                    // 02
  slot("Tank",    [["MAÇA PESADA", 1]]),                                                    // 03
  slot("Tank",    [["MONARCA", 1]]),                                                        // 04
  slot("Support", [["BRUXO DE UMA MÃO", 1]]),                                               // 05
  slot("Support", [["LOCUS", 1]]),                                                          // 06
  slot("Support", [["JURADOR", 1]]),                                                        // 07
  slot("Support", [["ARVORE", 1]]),                                                         // 08
  slot("Support", [["SHADOW CALLER", 1]]),                                                  // 09
  slot("Melee",   [["QUEBRA REINOS", 1]]),                                                  // 10
  slot("Ranged",  [["GELO ELEVADO", 1]]),                                                   // 11
  slot("Ranged",  [["PRISMA", 1]]),                                                         // 12
  slot("Melee",   [["CRAVADAS", 1]]),                                                       // 13
  slot("Melee",   [["URSINAS", 1]]),                                                        // 14
  slot("Melee",   F.DPS_LIVRE),                                                             // 15 Vaga flex para completar 20 vagas
  slot("Ranged",  [["ARCO LONGO", 1]]),                                                     // 16
  slot("Healer",  [["QUEDA SANTA", 1]]),                                                    // 17
  slot("Healer",  [["QUEDA SANTA", 1]]),                                                    // 18
  slot("Healer",  [["EXALTADO", 1], ["CORROMPIDO", 1]]),                                    // 19
  slot("Healer",  F.BRACELETE),                                                             // 20
];

const PARTIES = [
  { name: "Party 1", slots: PARTY1 },
  { name: "Party 2", slots: PARTY2 },
  { name: "Party 3", slots: PARTY3 },
  { name: "Party 4", slots: PARTY4 },
  { name: "Party 5", slots: PARTY5 },
  { name: "pt6teste", slots: PARTY6_TESTE }, // index 5 -> pt6teste
];

function buildWeaponCatalog() {
  const byRole = {};
  for (const [w, meta] of Object.entries(WEAPONS)) {
    (byRole[meta.role] ||= []).push(w);
  }
  // Permite selecionar Bruxo de Uma Mão também via Support
  if (!byRole["Support"].includes("BRUXO DE UMA MÃO")) {
    byRole["Support"].push("BRUXO DE UMA MÃO");
  }
  return byRole;
}

// ---------------------------------------------------------------------------
// FAMÍLIAS FUNCIONAIS (Healer Holy e Nature isolados)
// ---------------------------------------------------------------------------
const FAMILIES = {
  DEBUFF_RANGED: ["SHADOW CALLER", "PÚTRIDO", "DANAÇÃO", "EXECRADO", "BRUXO DE UMA MÃO"],
  DEBUFF_MELEE:  ["ENTALHADA", "CAÇA ESPÍRITOS"],
  TANKS_MACA: [
    "MAÇA PESADA", "MAÇA PÉTREA", "MARTELO DE BATALHA", "MARTELO DE UMA MÃO",
    "MAÇA DE UMA MÃO", "BRUXO DE UMA MÃO", "GOLEM", "MONARCA",
    "MAÇA PESADA W RUNA GUARDA", "MANGUAL", "CAMBRIANA", "SEGANÍMICA", "CAJADO PRIMORDIAL",
  ],
  SUPORTE:       ["G.A", "ARVORE", "SILENCE", "JURADOR", "LOCUS"],
  HEALER_HOLY:   ["QUEDA SANTA", "EXALTADO", "CORROMPIDO"],
  HEALER_NATURE: ["RAMPANTE", "POSTULENTO"],
  MELEE: [
    "BRAÇADEIRAS", "QUEBRA REINOS", "PRESA DEMONIACA", "GALATINAS",
    "CRIA REIS", "LAMINA DA INFINIDADE", "FÚRIA CONTIDA", "CRAVADAS",
    "URSINAS", "SEGADEIRA", "PATAS DE URSO", "DESSANGRADORA",
  ],
  RANGED:        ["ASTRAL", "CANÇÃO", "PRISMA", "SINCELO", "ARCO PLANGENTE", "ARCO LONGO", "GELO ELEVADO"],
  MONTARIAS:     ["CARROÇA", "BEHEMOT"],
};

const WEAPON_FAMILY = {};
for (const [fam, list] of Object.entries(FAMILIES)) {
  for (const w of list) WEAPON_FAMILY[w] = fam;
}

// ---------------------------------------------------------------------------
// COMPS DO BOMB (Fase B)
// ---------------------------------------------------------------------------
const HEALER_BOMB = [["QUEDA SANTA", 1], ["EXALTADO", 1], ["CORROMPIDO", 2]];

const BOMB_INVI = [
  { ...slot("Tank", [["BRUXO DE UMA MÃO", 1]]), locked: true },
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
  slot("Healer", HEALER_BOMB),
  slot("Support", [["OCULTO", 1]]),
  slot("Tank", [["MAÇA PESADA", 1]]),
];

const BOMB_MELEE = [
  { ...slot("Tank", [["GOLEM", 1]]), locked: true },
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["BRAÇADEIRAS", 1], ["FÚRIA CONTIDA", 1]]),
  slot("Melee", [["QUEBRA REINOS", 1]]),
  slot("Ranged", [["CANÇÃO", 1]]),
  slot("Support", [["SHADOW CALLER", 1]]),
  slot("Healer", HEALER_BOMB),
  slot("Support", [["OCULTO", 1]]),
  slot("Support", [["CAÇA ESPÍRITOS", 1]]),
  slot("Tank", [["MAÇA PESADA", 1], ["JURADOR", 1], ["MAÇA PÉTREA", 1]]),
];

const BOMB_COMPS = {
  invi:  { name: "Bomb Invi",  slots: BOMB_INVI },
  melee: { name: "Bomb Melee", slots: BOMB_MELEE },
};
const KITE_MIN = 13;

module.exports = {
  ROLES, WEAPONS, PARTIES, FAMILIES, WEAPON_FAMILY,
  WEAPON_CATALOG: buildWeaponCatalog(), BOMB_COMPS, KITE_MIN,
};
