// ============================================================================
// LOCALIZAÇÃO POR CARGO DO DISCORD
// Valores internos continuam canônicos (PT/EN) para não quebrar banco/comps.
// Apenas os rótulos mostrados ao jogador mudam.
// ============================================================================
const { WEAPONS } = require("./comps");

const SPANISH_ROLE_ID = String(process.env.SPANISH_ROLE_ID || "").trim();
const SPANISH_ROLE_NAMES = new Set(
  String(process.env.SPANISH_ROLE_NAMES || "Espanhol,Español,Spanish")
    .split(",")
    .map(norm)
    .filter(Boolean)
);

const ROLE_ES = Object.freeze({
  Tank: "Tanque",
  Support: "Soporte",
  Melee: "DPS cuerpo a cuerpo",
  Ranged: "DPS a distancia",
  Healer: "Sanador",
  HealerHoly: "Sanador sagrado",
  HealerNature: "Sanador de naturaleza",
  Caller: "Caller",
  DPS: "DPS",
  Looter: "Saqueador",
});

const WEAPON_ES = Object.freeze({
  "GOLEM": "GÓLEM",
  "MAÇA PESADA": "MAZA PESADA",
  "MAÇA PÉTREA": "MAZA PÉTREA",
  "MARTELO DE BATALHA": "MARTILLO DE BATALLA",
  "MAÇA DE UMA MÃO": "MAZA DE UNA MANO",
  "MARTELO DE UMA MÃO": "MARTILLO DE UNA MANO",
  "MAÇA PESADA W RUNA GUARDA": "MAZA PESADA CON RUNA DE GUARDIA",
  "BRUXO DE UMA MÃO": "BÁCULO DE BRUJERÍA (WITCHWORK)",
  "MONARCA": "MONARCA",
  "MANGUAL": "MAYAL",
  "CAMBRIANA": "CAMLANN",
  "SEGANÍMICA": "MAZA ÍNCUBO",
  "CAJADO PRIMITIVO": "BÁCULO PRIMITIVO",
  "HAND OF JUSTICE": "MANO DE JUSTICIA",

  "ARVORE": "BÁCULO ENRAIZADO",
  "JURADOR": "JURADORES",
  "G.A": "GRAN ARCANO",
  "LOCUS": "LOCUS",
  "SILENCE": "SILENCIO",
  "CARROÇA": "CARRO DE GUERRA",
  "BEHEMOT": "BEHEMOTH",
  "SHADOW CALLER": "LLAMADOR SOMBRÍO",
  "DANAÇÃO": "CONDENACIÓN",
  "PÚTRIDO": "PÚTRIDO",
  "CAÇA ESPÍRITOS": "CAZADOR DE ESPÍRITUS",
  "ENTALHADA": "ESPADA TALLADA",
  "EXECRADO": "EXECRADO",
  "OCULTO": "OCULTO",

  "QUEBRA REINOS": "ROMPERREINOS",
  "BRAÇADEIRAS": "BRAZALES DE BATALLA",
  "URSINAS": "GUANTELETES URSINOS",
  "CRAVADAS": "GUANTELETES CON PÚAS",
  "GALATINAS": "GALATINAS",
  "PRESA DEMONIACA": "COLMILLO DEMONÍACO",
  "CRIA REIS": "HACEDOR DE REYES",
  "LAMINA DA INFINIDADE": "HOJA DEL INFINITO",
  "FÚRIA CONTIDA": "FURIA CONTENIDA",
  "SEGADEIRA": "GUADAÑA",
  "PATAS DE URSO": "PATAS DE OSO",
  "DESSANGRADORA": "SANGUINARIA",

  "PRISMA": "PRISMA",
  "CANÇÃO": "CANCIÓN DEL ALBA",
  "ASTRAL": "ASTRAL",
  "SINCELO": "CARÁMBANO",
  "ARCO PLANGENTE": "ARCO LAMENTOSO",
  "ARCO LONGO": "ARCO LARGO",
  "GELO ELEVADO": "HIELO ELEVADO",

  "QUEDA SANTA": "CAÍDA SANTA",
  "EXALTADO": "EXALTADO",
  "CORROMPIDO": "CORROMPIDO",
  "RAMPANTE": "RAMPANTE",
  "POSTULENTO": "POSTULENTO",
});

const ROLE_WORDS_ES = Object.freeze({
  tanque: "Tank",
  tank: "Tank",
  soporte: "Support",
  support: "Support",
  sup: "Support",
  melee: "Melee",
  melé: "Melee",
  cuerpo: "Melee",
  ranged: "Ranged",
  range: "Ranged",
  distancia: "Ranged",
  heal: "Healer",
  healer: "Healer",
  sanador: "Healer",
  cura: "Healer",
  saqueador: "Looter",
  looter: "Looter",
});

const EXTRA_WEAPON_ALIASES_ES = Object.freeze({
  "witchwork": "BRUXO DE UMA MÃO",
  "báculo witchwork": "BRUXO DE UMA MÃO",
  "maza incubus": "SEGANÍMICA",
  "maza íncubo": "SEGANÍMICA",
  "incubus": "SEGANÍMICA",
  "juradores": "JURADOR",
  "oathkeepers": "JURADOR",
  "gran arcano": "G.A",
  "great arcane": "G.A",
  "shadow caller": "SHADOW CALLER",
  "llamador sombrío": "SHADOW CALLER",
  "cazador de espíritus": "CAÇA ESPÍRITOS",
  "spirit hunter": "CAÇA ESPÍRITOS",
  "espada tallada": "ENTALHADA",
  "carving": "ENTALHADA",
  "realmbreaker": "QUEBRA REINOS",
  "romperreinos": "QUEBRA REINOS",
  "brazales de batalla": "BRAÇADEIRAS",
  "battle bracers": "BRAÇADEIRAS",
  "guanteletes ursinos": "URSINAS",
  "ursine": "URSINAS",
  "guanteletes con púas": "CRAVADAS",
  "spiked gauntlets": "CRAVADAS",
  "colmillo demoníaco": "PRESA DEMONIACA",
  "demonfang": "PRESA DEMONIACA",
  "hacedor de reyes": "CRIA REIS",
  "kingmaker": "CRIA REIS",
  "hoja del infinito": "LAMINA DA INFINIDADE",
  "infinity blade": "LAMINA DA INFINIDADE",
  "patas de oso": "PATAS DE URSO",
  "bear paws": "PATAS DE URSO",
  "sanguinaria": "DESSANGRADORA",
  "bloodletter": "DESSANGRADORA",
  "canción del alba": "CANÇÃO",
  "dawnsong": "CANÇÃO",
  "arco largo": "ARCO LONGO",
  "longbow": "ARCO LONGO",
  "caída santa": "QUEDA SANTA",
  "hallowfall": "QUEDA SANTA",
  "cajado primitivo": "CAJADO PRIMITIVO",
  "cajado primordial": "CAJADO PRIMITIVO",
  "báculo primitivo": "CAJADO PRIMITIVO",
  "báculo primordial": "CAJADO PRIMITIVO",
  "mano de justicia": "HAND OF JUSTICE",
  "hand of justice": "HAND OF JUSTICE",
  "hoj": "HAND OF JUSTICE",
});

function norm(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSpanishMember(member) {
  const cache = member?.roles?.cache;
  if (!cache) return false;
  if (SPANISH_ROLE_ID && cache.has(SPANISH_ROLE_ID)) return true;
  return cache.some((role) => SPANISH_ROLE_NAMES.has(norm(role?.name)));
}

function isSpanishInteraction(interaction) {
  return isSpanishMember(interaction?.member);
}

function roleLabel(role, spanish = false) {
  return spanish ? (ROLE_ES[role] || role) : role;
}

function weaponLabel(weapon, spanish = false) {
  const key = String(weapon || "").trim().toUpperCase();
  return spanish ? (WEAPON_ES[key] || weapon) : weapon;
}

function weaponOption(weapon, spanish = false) {
  return {
    label: String(weaponLabel(weapon, spanish)).slice(0, 100),
    value: weapon,
  };
}

function roleFromWord(word) {
  return ROLE_WORDS_ES[norm(word)] || null;
}

function canonicalWeapon(input) {
  const q = norm(input);
  if (!q) return null;

  // Chaves canônicas em português: mantém exatamente a regra histórica.
  for (const weapon of Object.keys(WEAPONS)) {
    if (norm(weapon) === q || q.includes(norm(weapon))) return weapon;
  }

  // Espanhol: nomes maiores vencem nomes menores. Um rótulo/apelido de UMA
  // palavra só exige igualdade exata para evitar falsos positivos em frases
  // comuns ("silencio en la call" não pode cadastrar SILENCE).
  const spanishCandidates = [
    ...Object.entries(WEAPON_ES).map(([weapon, label], order) => ({
      needle: norm(label), weapon, order
    })),
    ...Object.entries(EXTRA_WEAPON_ALIASES_ES).map(([alias, weapon], order) => ({
      needle: norm(alias), weapon, order: Object.keys(WEAPON_ES).length + order
    })),
  ]
    .filter((x) => x.needle)
    .sort((a, b) => b.needle.length - a.needle.length || a.order - b.order);

  for (const candidate of spanishCandidates) {
    const words = candidate.needle.split(" ").filter(Boolean);
    const matches = words.length === 1
      ? q === candidate.needle
      : (q === candidate.needle || q.includes(candidate.needle));
    if (matches) return candidate.weapon;
  }

  return null;
}

module.exports = {
  ROLE_ES,
  WEAPON_ES,
  isSpanishMember,
  isSpanishInteraction,
  roleLabel,
  weaponLabel,
  weaponOption,
  roleFromWord,
  canonicalWeapon,
};
