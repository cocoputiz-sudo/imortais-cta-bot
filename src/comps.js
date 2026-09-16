/**
 * ============================================================================
 * IMORTAIS CTA BOT - comps.js
 * Configuração de Composições, Catálogo de Armas, Roles e Botões de Inscrição
 * ============================================================================
 */

// ============================================================================
// 1. CATÁLOGO DE ARMAS POR ROLE (Utilizado para os botões de inscrição)
// ============================================================================
const ROLE_WEAPONS = {
  TANK: [
    'Golem',
    'Maça de Uma Mão',
    'Maça Pétrea',
    'Maça Pesada',
    'Monarca',
    'G.A',
    'Martelo de Batalha',
    'Sincelo'
  ],
  SUPPORT: [
    'Locus',
    'Jurador',
    'Árvore',
    'Shadow Caller',
    'Bruxo de Uma Mão',
    'Danação',
    'Entalhada',
    'Caça Espíritos',
    'Silence'
  ],
  MELEE: [
    'Quebra-reinos',
    'Cravada',
    'Ursinas',
    'Galatinas',
    'Braçadeiras',
    'Astral',
    'Presa Demo'
  ],
  RANGED: [
    // Armas RANGED adicionadas e verificadas para botões e catálogo
    'Arco Longo',     // [CONFIRMADO]: Adicionado para ativação por botão
    'Gelo Elevado',   // [CONFIRMADO]: Adicionado para ativação por botão
    'Prisma',
    'Canção da Alvorada',
    'Feiticeiro',
    'Bruxo de Uma Mão',
    'Shadow Caller'
  ],
  HEALER: [
    'Queda Santa',
    'Exaltado',
    'Corrompido',
    'Pustulento',
    'Rampante'
  ],
  BATTLEMOUNT: [
    'Carroça',
    'Balista',
    'Behemoth',
    'Águia',
    'Besouro',
    'Lagarto',
    'Ent'
  ]
};

// ============================================================================
// 2. FAMÍLIAS DE ARMAS (Engine de Realocação e Afinidade)
// ============================================================================
const WEAPON_FAMILIES = {
  'Maças': ['Golem', 'Maça de Uma Mão', 'Maça Pétrea', 'Maça Pesada', 'Monarca'],
  'Martelos': ['Martelo de Batalha', 'Sincelo', 'Guarda do Bosque'],
  'Arcanos': ['Locus', '1H Arcane', 'Arcano de Uma Mão', 'Silence'],
  'Sagrado': ['Queda Santa', 'Exaltado', 'Corrompido'],
  'Natureza': ['Árvore', 'Pustulento', 'Rampante', 'Selvagem'],
  'Machados': ['Quebra-reinos', 'Ursinas', 'Patas de Urso'],
  'Luvas': ['Cravada', 'Braçadeiras', 'Punhos de Avalon'],
  'Espadas': ['Galatinas', 'Astral', 'Espada Clarent'],
  'Arcos': ['Arco Longo', 'Arco de Guerra', 'Badon'],
  'Gelo': ['Gelo Elevado', 'Prisma', 'Gelo 1H'],
  'Amaldiçoado': ['Bruxo de Uma Mão', 'Shadow Caller', 'Danação']
};

// ============================================================================
// 3. COMPOSIÇÕES PADRÃO (PT1, PT2, PT3, PT4, PT5)
// ============================================================================
const PT1 = [
  { slot: 1,  role: 'TANK',    title: 'Caller (Golem)',      weapons: ['Golem', 'Maça de Uma Mão', 'Monarca'] },
  { slot: 2,  role: 'TANK',    title: 'Tank (G.A)',          weapons: ['G.A', 'Maça Pesada'] },
  { slot: 3,  role: 'TANK',    title: 'Maça Pesada',         weapons: ['Maça Pesada'] },
  { slot: 4,  role: 'TANK',    title: 'Maça Pesada',         weapons: ['Maça Pesada'] },
  { slot: 5,  role: 'SUPPORT', title: 'Jurador',             weapons: ['Jurador'] },
  { slot: 6,  role: 'SUPPORT', title: 'Jurador',             weapons: ['Jurador'] },
  { slot: 7,  role: 'SUPPORT', title: 'Shadow Caller',       weapons: ['Shadow Caller'] },
  { slot: 8,  role: 'SUPPORT', title: 'Danação',             weapons: ['Danação'] },
  { slot: 9,  role: 'SUPPORT', title: 'Caça Espíritos',      weapons: ['Caça Espíritos'] },
  { slot: 10, role: 'SUPPORT', title: 'Árvore',              weapons: ['Árvore'] },
  { slot: 11, role: 'RANGED',  title: 'Prisma',              weapons: ['Prisma', 'Gelo Elevado'] },
  { slot: 12, role: 'MELEE',   title: 'Braçadeiras',         weapons: ['Braçadeiras', 'Cravada'] },
  { slot: 13, role: 'MELEE',   title: 'Braçadeiras',         weapons: ['Braçadeiras', 'Cravada'] },
  { slot: 14, role: 'MELEE',   title: 'Ursinas',             weapons: ['Ursinas'] },
  { slot: 15, role: 'MELEE',   title: 'Quebra-reinos',       weapons: ['Quebra-reinos'] },
  { slot: 16, role: 'MELEE',   title: 'Quebra-reinos',       weapons: ['Quebra-reinos'] },
  { slot: 17, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 18, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 19, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 20, role: 'HEALER',  title: 'Rampante/Pustulento', weapons: ['Rampante', 'Pustulento'] }
];

const PT2 = [
  { slot: 1,  role: 'TANK',    title: 'Caller/Golem',        weapons: ['Golem', 'Maça Pesada'] },
  { slot: 2,  role: 'TANK',    title: 'Maça Pesada',         weapons: ['Maça Pesada'] },
  { slot: 3,  role: 'TANK',    title: 'Maça Pesada',         weapons: ['Maça Pesada'] },
  { slot: 4,  role: 'TANK',    title: 'Maça Pesada',         weapons: ['Maça Pesada'] },
  { slot: 5,  role: 'SUPPORT', title: 'G.A Support',         weapons: ['G.A'] },
  { slot: 6,  role: 'SUPPORT', title: 'Entalhada',           weapons: ['Entalhada'] },
  { slot: 7,  role: 'SUPPORT', title: 'Shadow Caller',       weapons: ['Shadow Caller'] },
  { slot: 8,  role: 'SUPPORT', title: 'Carroça / Support',   weapons: ['Carroça', 'Danação'] },
  { slot: 9,  role: 'SUPPORT', title: 'Entalhada',           weapons: ['Entalhada'] },
  { slot: 10, role: 'SUPPORT', title: 'Silence',             weapons: ['Silence'] },
  { slot: 11, role: 'RANGED',  title: 'Prisma',              weapons: ['Prisma', 'Gelo Elevado'] },
  { slot: 12, role: 'MELEE',   title: 'Cravadas',            weapons: ['Cravada'] },
  { slot: 13, role: 'RANGED',  title: 'Canção da Alvorada',  weapons: ['Canção da Alvorada', 'Arco Longo'] },
  { slot: 14, role: 'MELEE',   title: 'Braçadeiras',         weapons: ['Braçadeiras'] },
  { slot: 15, role: 'MELEE',   title: 'Braçadeiras',         weapons: ['Braçadeiras'] },
  { slot: 16, role: 'MELEE',   title: 'Galatinas',           weapons: ['Galatinas'] },
  { slot: 17, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 18, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 19, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 20, role: 'HEALER',  title: 'Rampante/Pustulento', weapons: ['Rampante', 'Pustulento'] }
];

// ============================================================================
// 4. NOVA COMPOSIÇÃO PT6: pt6teste (EXATAMENTE OS 20 SLOTS REQUISITADOS)
// ============================================================================
/**
 * Composição da PT6 (pt6teste):
 * Slot 1: Caller [Tank] - Golem / Maça de uma mão / Monarca
 * Slot 2: Maça Pétrea [Tank]
 * Slot 3: Maça Pesada [Tank]
 * Slot 4: Monarca [Tank]
 * Slot 5: Bruxo de uma mão [Support/Cursed]
 * Slot 6: Locus [Support]
 * Slot 7: Jurador [Support]
 * Slot 8: Árvore [Support]
 * Slot 9: Shadow Caller [Support]
 * Slot 10: Quebra-reinos [Melee]
 * Slot 11: Gelo Elevado [Ranged]
 * Slot 12: Prisma [Ranged]
 * Slot 13: Cravada [Melee]
 * Slot 14: Ursinas [Melee]
 * Slot 15: Flex DPS / Braçadeiras (Vaga Reserva para totalizar 20 membros)
 * Slot 16: Arco Longo [Ranged]
 * Slot 17: Queda Santa [Healer]
 * Slot 18: Queda Santa [Healer]
 * Slot 19: Exaltado / Corrompido [Healer]
 * Slot 20: Pustulento / Rampante [Healer]
 */
const pt6teste = [
  { slot: 1,  role: 'TANK',    title: 'Caller',              weapons: ['Golem', 'Maça de Uma Mão', 'Monarca'] },
  { slot: 2,  role: 'TANK',    title: 'Maça Pétrea',         weapons: ['Maça Pétrea'] },
  { slot: 3,  role: 'TANK',    title: 'Maça Pesada',         weapons: ['Maça Pesada'] },
  { slot: 4,  role: 'TANK',    title: 'Monarca',             weapons: ['Monarca'] },
  { slot: 5,  role: 'SUPPORT', title: 'Bruxo de Uma Mão',    weapons: ['Bruxo de Uma Mão'] },
  { slot: 6,  role: 'SUPPORT', title: 'Locus',               weapons: ['Locus'] },
  { slot: 7,  role: 'SUPPORT', title: 'Jurador',             weapons: ['Jurador'] },
  { slot: 8,  role: 'SUPPORT', title: 'Árvore',              weapons: ['Árvore'] },
  { slot: 9,  role: 'SUPPORT', title: 'Shadow Caller',       weapons: ['Shadow Caller'] },
  { slot: 10, role: 'MELEE',   title: 'Quebra-reinos',       weapons: ['Quebra-reinos'] },
  { slot: 11, role: 'RANGED',  title: 'Gelo Elevado',        weapons: ['Gelo Elevado'] },
  { slot: 12, role: 'RANGED',  title: 'Prisma',              weapons: ['Prisma'] },
  { slot: 13, role: 'MELEE',   title: 'Cravada',             weapons: ['Cravada'] },
  { slot: 14, role: 'MELEE',   title: 'Ursinas',             weapons: ['Ursinas'] },
  { slot: 15, role: 'MELEE',   title: 'Flex DPS / Reserva',  weapons: ['Braçadeiras', 'Quebra-reinos', 'Arco Longo', 'Gelo Elevado'] },
  { slot: 16, role: 'RANGED',  title: 'Arco Longo',          weapons: ['Arco Longo'] },
  { slot: 17, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 18, role: 'HEALER',  title: 'Queda Santa',         weapons: ['Queda Santa'] },
  { slot: 19, role: 'HEALER',  title: 'Exaltado / Corromp.', weapons: ['Exaltado', 'Corrompido'] },
  { slot: 20, role: 'HEALER',  title: 'Pustulento / Ramp.',  weapons: ['Pustulento', 'Rampante'] }
];

// ============================================================================
// 5. DICIONÁRIO PRINCIPAL DE COMPOSIÇÕES
// ============================================================================
const COMPS = {
  pt1: {
    id: 'pt1',
    name: 'PT 1 - Principal',
    slots: PT1
  },
  pt2: {
    id: 'pt2',
    name: 'PT 2 - Secundária',
    slots: PT2
  },
  pt6teste: {
    id: 'pt6teste',
    name: 'pt6teste', // Nome exibido no /cta_show exatamente como solicitado
    displayName: 'pt6teste',
    slots: pt6teste
  }
};

// ============================================================================
// 6. ESTRUTURA DOS BOTÕES DO DISCORD
// ============================================================================
const BUTTON_CONFIG = {
  // Roles principais ativadas no painel do CTA
  MAIN_ROLES: [
    { id: 'role_tank',    label: '🛡️ Tank',    style: 'Primary' },
    { id: 'role_support', label: '🔮 Suporte', style: 'Primary' },
    { id: 'role_melee',   label: '⚔️ Melee',   style: 'Primary' },
    { id: 'role_ranged',  label: '🏹 Ranged',  style: 'Primary' },
    { id: 'role_healer',  label: '💚 Healer',  style: 'Primary' }
  ],
  // Botões de armas RANGED (garantindo Arco Longo e Gelo Elevado)
  RANGED_WEAPONS: [
    { id: 'weapon_arcolongo',   label: 'Arco Longo',          style: 'Secondary' },
    { id: 'weapon_geloelevado', label: 'Gelo Elevado',        style: 'Secondary' },
    { id: 'weapon_prisma',      label: 'Prisma',              style: 'Secondary' },
    { id: 'weapon_shadowcaller',label: 'Shadow Caller',       style: 'Secondary' },
    { id: 'weapon_bruxo1h',     label: 'Bruxo 1H',            style: 'Secondary' }
  ]
};

// ============================================================================
// 7. FUNÇÕES AUXILIARES
// ============================================================================
function getComp(compKey) {
  const normalizedKey = (compKey || '').toLowerCase().trim();
  return COMPS[normalizedKey] || null;
}

function getAvailableComps() {
  return Object.keys(COMPS).map(key => ({
    name: COMPS[key].name || COMPS[key].displayName || key,
    value: key
  }));
}

function getWeaponsForRole(role) {
  const normalizedRole = (role || '').toUpperCase().trim();
  return ROLE_WEAPONS[normalizedRole] || [];
}

// ============================================================================
// 8. EXPORTAÇÕES (Compatibilidade CommonJS e ES Modules)
// ============================================================================
module.exports = {
  ROLE_WEAPONS,
  WEAPON_FAMILIES,
  PT1,
  PT2,
  pt6teste,
  COMPS,
  BUTTON_CONFIG,
  getComp,
  getAvailableComps,
  getWeaponsForRole
};
