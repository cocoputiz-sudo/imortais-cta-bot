// ============================================================================
// COMPS DA IMORTAIS — Fase 1 (famílias de armas + pesos)
// ============================================================================
// COMO LER:
//  - Cada vaga é uma lista de armas aceitas, cada uma com um PESO.
//  - PESO 1 = preferida. PESO 2 = ok. PESO 3 = aceitável (último caso).
//    O bot preenche preferindo peso menor.
//  - Peso omitido = 1 (quando você disse "tanto faz", deixei todas peso 1).
//  - "unica: true"     = máximo 1 na comp inteira (Cravadas, Ursinas:
//                        a skill de uma anula a duplicata).
//  - "tetoPorPt: true" = teto = nº de PTs ativas (3 PTs -> máx 2 cópias,
//                        4 PTs -> máx 3). Hoje só Entalhada e Caça Espíritos.
//
// >>> REVISE ESTE ARQUIVO. Onde eu errei ou faltou, corrija. <<<
// Marquei com  // ??? CONFERIR  os pontos que estou em dúvida.
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
// unica:true  = só pode existir 1 na comp inteira (skill anula duplicata)
// role        = usado só pra organizar o menu de inscrição
// ---------------------------------------------------------------------------
const WEAPONS = {
  // Tanks
  "GOLEM":                 { role: "Tank" },
  "MAÇA PESADA":           { role: "Tank" },
  "MAÇA PÉTREA":           { role: "Tank" },
  "MARTELO DE BATALHA":    { role: "Tank" },
  "MAÇA DE UMA MÃO":       { role: "Tank" },
  "MARTELO DE UMA MÃO":    { role: "Tank" },
  "MAÇA PESADA W RUNA GUARDA": { role: "Tank" }, // maça pesada com W de runa guarda
  "BRUXO DE UMA MÃO":      { role: "Tank" },
  "MONARCA":               { role: "Tank" },
  "PERMA":                 { role: "Tank" },
  "ARVORE":                { role: "Support" },
  // Supports
  "JURADOR":               { role: "Support" },
  "G.A":                   { role: "Support" }, // Great Arcane
  "LOCUS":                 { role: "Support" },
  "SILENCE":               { role: "Support" },
  "CARROÇA":               { role: "Support" },
  "BEHEMOT":               { role: "Support" },
  "SHADOW CALLER":         { role: "Support" }, // = Chama Sombra
  "DANAÇÃO":               { role: "Support" },
  "PÚTRIDO":               { role: "Support" },
  // Entalhada e Caça Espíritos: teto = nº de PTs (3 PTs->máx 2, 4 PTs->máx 3)
  "CAÇA ESPÍRITOS":        { role: "Support", tetoPorPt: true },
  "ENTALHADA":             { role: "Support", tetoPorPt: true },
  // Melee / DPS
  "QUEBRA REINOS":         { role: "Melee" }, // corrigido: é Melee
  "BRAÇADEIRAS":           { role: "Melee" },
  "URSINAS":               { role: "Melee", unica: true },
  "CRAVADAS":              { role: "Melee", unica: true },
  "PRISMA":                { role: "Melee" },
  "CANÇÃO":                { role: "Melee" },
  "GALATINAS":             { role: "Melee" },
  "PRESA DEMONIACA":       { role: "Melee" }, // = Presa Demmo?  ??? CONFERIR
  "ASTRAL":                { role: "Melee" },
  "SINCELO":               { role: "Melee" },
  "CRIA REIS":             { role: "Melee" },
  "LAMINA DA INFINIDADE":  { role: "Melee" },
  "FÚRIA CONTIDA":         { role: "Melee" },
  // Healers
  "QUEDA SANTA":           { role: "Healer" },
  "EXALTADO":              { role: "Healer" },
  "CORROMPIDO":            { role: "Healer" },
  "RAMPANTE":              { role: "Healer" },
  "POSTULENTO":            { role: "Healer" },
};

// ---------------------------------------------------------------------------
// FAMÍLIAS reutilizáveis (grupos de armas que preenchem a mesma função)
// Facilita repetir a mesma regra em várias vagas.
// formato: [ [arma, peso], ... ]
// ---------------------------------------------------------------------------
const F = {
  // healer padrão: onde houver Queda Santa, aceita Exaltado(1) e Corrompido(2)
  HEALER_QS: [["QUEDA SANTA", 1], ["EXALTADO", 1], ["CORROMPIDO", 2]],
  // vaga de bracelete flex (final da party)
  BRACELETE: [["RAMPANTE", 1], ["POSTULENTO", 1]],
  // tanks pesados padrão
  TANK_MACA: [["MAÇA PESADA", 1], ["MARTELO DE BATALHA", 1], ["MAÇA DE UMA MÃO", 1]],
  // dps melee "livre" da pt2 (pos 11-14)
  DPS_LIVRE: [
    ["BRAÇADEIRAS", 1], ["QUEBRA REINOS", 1], ["CANÇÃO", 1],
    ["PRESA DEMONIACA", 2], ["GALATINAS", 2], ["ASTRAL", 2], ["PRISMA", 2],
    ["SINCELO", 2], ["CRIA REIS", 2], ["LAMINA DA INFINIDADE", 2],
  ],
};

// helper: vaga a partir de lista [arma,peso] ou família
const slot = (role, accepts) => ({ role, accepts: accepts.map(a => Array.isArray(a) ? { weapon: a[0], weight: a[1] } : { weapon: a, weight: 1 }) });

// ---------------------------------------------------------------------------
// PARTY 1 — a mais engessada
// ---------------------------------------------------------------------------
const PARTY1 = [
  { ...slot("Tank", [["GOLEM",1],["MAÇA DE UMA MÃO",1],["BRUXO DE UMA MÃO",1]]), locked: true }, // 01 caller (travada)
  slot("Tank",    [["MAÇA PESADA",1]]),                                        // 02
  slot("Tank",    [["MAÇA PESADA",1],["MAÇA PÉTREA",1],["MARTELO DE BATALHA",1]]), // 03
  slot("Tank",    [["MAÇA PESADA",1],["MAÇA PÉTREA",1],["MARTELO DE BATALHA",1]]), // 04
  slot("Support", [["G.A",1],["ARVORE",1]]),                                   // 05
  slot("Support", [["JURADOR",1]]),                                            // 06
  slot("Support", [["SHADOW CALLER",1]]),                                      // 07
  slot("Support", [["SHADOW CALLER",1],["PÚTRIDO",2],["DANAÇÃO",3]]),          // 08 (nudge)
  slot("Support", [["CAÇA ESPÍRITOS",1],["ENTALHADA",1]]),                     // 09
  slot("Support", [["SILENCE",1]]),                                            // 10
  slot("Melee",   [["QUEBRA REINOS",1]]),                                      // 11
  slot("Melee",   [["PRISMA",1]]),                                             // 12
  slot("Melee",   [["CANÇÃO",1]]),                                             // 13
  slot("Melee",   [["BRAÇADEIRAS",1],["CANÇÃO",1]]),                           // 14
  slot("Melee",   [["URSINAS",1]]),                                            // 15
  slot("Melee",   [["CRAVADAS",1]]),                                           // 16
  slot("Healer",  [["QUEDA SANTA",1]]),                                       // 17 só QS
  slot("Healer",  F.HEALER_QS),                                               // 18 QS/Exaltado/Corrompido
  slot("Healer",  [["QUEDA SANTA",1],["CORROMPIDO",1]]),                      // 19 QS ou Corrompido
  slot("Healer",  F.BRACELETE),                                               // 20
];

// ---------------------------------------------------------------------------
// PARTY 2
// ---------------------------------------------------------------------------
const PARTY2 = [
  slot("Tank",    [["MAÇA PESADA",2],["MARTELO DE BATALHA",2],["MAÇA DE UMA MÃO",2],
                   ["BRUXO DE UMA MÃO",1],["GOLEM",1],["MONARCA",1]]),          // 01
  slot("Tank",    [["MAÇA PESADA",1],["MARTELO DE BATALHA",1],["MAÇA DE UMA MÃO",1]]), // 02
  slot("Tank",    [["MAÇA PESADA",1],["MARTELO DE BATALHA",1],["MAÇA DE UMA MÃO",1]]), // 03
  slot("Tank",    [["ARVORE",1],["MAÇA PESADA",1],["MARTELO DE BATALHA",1],
                   ["MAÇA DE UMA MÃO",1],["MONARCA",1],["SILENCE",1],["G.A",1]]), // 04
  slot("Support", [["JURADOR",1],["MAÇA PESADA W RUNA GUARDA",2],
                   ["MARTELO DE BATALHA",2],["MAÇA DE UMA MÃO",2]]),             // 05
  slot("Support", [["JURADOR",1],["LOCUS",1],["MAÇA PESADA W RUNA GUARDA",2],
                   ["MARTELO DE BATALHA",2],["MAÇA DE UMA MÃO",2]]),             // 06
  slot("Support", [["G.A",1]]),                                                 // 07
  slot("Support", [["CAÇA ESPÍRITOS",1],["ENTALHADA",1],["SHADOW CALLER",1],
                   ["DANAÇÃO",1],["PÚTRIDO",2]]),                               // 08
  slot("Support", [["G.A",1],["SILENCE",1],["CARROÇA",1],["BEHEMOT",1]]),       // 09
  slot("Support", [["G.A",1],["SILENCE",1],["CARROÇA",1],["BEHEMOT",1]]),       // 10
  slot("Melee",   [["BRAÇADEIRAS",1],["QUEBRA REINOS",1],["CANÇÃO",1],          // 11 (peso1 nos 3)
                   ["PRESA DEMONIACA",2],["GALATINAS",2],["ASTRAL",2],["PRISMA",2],
                   ["SINCELO",2],["CRIA REIS",2],["LAMINA DA INFINIDADE",2]]),
  slot("Melee",   [["BRAÇADEIRAS",1],["QUEBRA REINOS",1],["CANÇÃO",1],          // 12
                   ["PRESA DEMONIACA",2],["GALATINAS",2],["ASTRAL",2],["PRISMA",2],
                   ["SINCELO",2],["CRIA REIS",2],["LAMINA DA INFINIDADE",2]]),
  slot("Melee",   F.DPS_LIVRE),                                                // 13
  slot("Melee",   F.DPS_LIVRE),                                                // 14
  slot("Melee",   [["CANÇÃO",1]]),                                             // 15 (original)
  slot("Melee",   [["GALATINAS",1]]),                                          // 16 (original)
  slot("Healer",  F.HEALER_QS),                                               // 17
  slot("Healer",  F.HEALER_QS),                                               // 18 (era Corrompido)
  slot("Healer",  F.HEALER_QS),                                               // 19
  slot("Healer",  F.BRACELETE),                                               // 20
];

// PARTY 3 e PARTY 4 = espelhos da PARTY 2
const mirror = () => PARTY2.map(s => ({ role: s.role, accepts: s.accepts.map(a => ({...a})) }));
const PARTY3 = mirror();
const PARTY4 = mirror();

const PARTIES = [
  { name: "Party 1", slots: PARTY1 },
  { name: "Party 2", slots: PARTY2 },
  { name: "Party 3", slots: PARTY3 },
  { name: "Party 4", slots: PARTY4 },
];

// catálogo por papel pro menu de inscrição
function buildWeaponCatalog() {
  const byRole = {};
  for (const [w, meta] of Object.entries(WEAPONS))
    (byRole[meta.role] ||= []).push(w);
  return byRole;
}


// ---------------------------------------------------------------------------
// FAMÍLIAS FUNCIONAIS (pro nudge de troca: só sugere entre armas irmãs)
// ---------------------------------------------------------------------------
const FAMILIES = {
  DEBUFF_RANGED: ["SHADOW CALLER", "PÚTRIDO", "DANAÇÃO"],
  DEBUFF_MELEE:  ["ENTALHADA", "CAÇA ESPÍRITOS"],
  TANKS_MACA:    ["MAÇA PESADA", "MAÇA PÉTREA", "MARTELO DE BATALHA", "MAÇA DE UMA MÃO", "GOLEM", "MONARCA", "MAÇA PESADA W RUNA GUARDA"],
  SUPORTE:       ["G.A", "ARVORE", "SILENCE", "JURADOR", "LOCUS"],
  HEALERS:       ["RAMPANTE", "POSTULENTO", "QUEDA SANTA", "CORROMPIDO", "EXALTADO"],
  MELEE:         ["BRAÇADEIRAS", "QUEBRA REINOS", "PRESA DEMONIACA", "GALATINAS", "CRIA REIS", "LAMINA DA INFINIDADE", "FÚRIA CONTIDA", "CRAVADAS", "URSINAS"],
  RANGED:        ["ASTRAL", "CANÇÃO", "PRISMA", "SINCELO"],
  MONTARIAS:     ["CARROÇA", "BEHEMOT"],
};
// index reverso: arma -> nome da família
const WEAPON_FAMILY = {};
for (const [fam, list] of Object.entries(FAMILIES))
  for (const w of list) WEAPON_FAMILY[w] = fam;

module.exports = { ROLES, WEAPONS, PARTIES, FAMILIES, WEAPON_FAMILY, WEAPON_CATALOG: buildWeaponCatalog() };
