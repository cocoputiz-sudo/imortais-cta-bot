// ============================================================================
// SLASH COMMANDS de gestão do CTA (Onda 1)
//   /cta_move   - move alguém já inscrito pra outra vaga (PT+arma ou PT+vaga)
//   /cta_remove - tira a pessoa do CTA (igual "sair da função")
//   /cta_add    - adiciona alguém (mesmo sem ter pingado) numa vaga
//   /cta_clean  - esvazia uma PT inteira (com confirmação)
// Todos: só cargo Mestre de Guerra, usados no cta-log-staff, cta via autocomplete.
// ============================================================================
const {
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require("discord.js");
const db = require("./db");
const { PARTIES, WEAPONS } = require("./comps");

const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null; // Mestre de Guerra

// -------- definição dos comandos --------
function commandDefs() {
  const ctaOpt = (o) => o.setName("cta").setDescription("Qual CTA (horário)").setRequired(true).setAutocomplete(true);
  const userOpt = (o) => o.setName("usuario").setDescription("Jogador").setRequired(true);
  const ptOpt = (o) => o.setName("pt").setDescription("Número da PT (1-4)").setRequired(true).setMinValue(1).setMaxValue(4);
  const vagaOpt = (o) => o.setName("vaga").setDescription("Número da vaga (1-20)").setMinValue(1).setMaxValue(20);
  const armaOpt = (o) => o.setName("arma").setDescription("Arma").setAutocomplete(true);

  return [
    new SlashCommandBuilder().setName("cta_move").setDescription("Move um jogador já inscrito pra outra vaga")
      .addUserOption(userOpt).addStringOption(ctaOpt).addIntegerOption(ptOpt)
      .addIntegerOption(vagaOpt).addStringOption(armaOpt),
    new SlashCommandBuilder().setName("cta_remove").setDescription("Remove o jogador do CTA (igual sair da função)")
      .addUserOption(userOpt).addStringOption(ctaOpt),
    new SlashCommandBuilder().setName("cta_add").setDescription("Adiciona um jogador numa vaga (mesmo sem ter pingado)")
      .addUserOption(userOpt).addStringOption(ctaOpt).addIntegerOption(ptOpt)
      .addIntegerOption(vagaOpt).addStringOption(armaOpt),
    new SlashCommandBuilder().setName("cta_clean").setDescription("Esvazia uma PT inteira")
      .addStringOption(ctaOpt).addIntegerOption(ptOpt),
  ].map((c) => c.toJSON());
}

// -------- registro no servidor (instantâneo, por guild) --------
async function registerCommands(clientId, guildId) {
  if (!process.env.DISCORD_TOKEN) return;
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandDefs() });
  console.log("✅ Slash commands registrados no servidor", guildId);
}

// -------- checagem de permissão (Mestre de Guerra) --------
function isStaff(interaction) {
  if (!STAFF_ROLE_ID) return true; // se não configurado, não bloqueia (mas avisa no log)
  return interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);
}

// -------- autocomplete (cta e arma) --------
async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "cta") {
    const events = await db.getOpenEvents(interaction.guildId);
    const choices = events.map((e) => ({ name: `CTA ${e.time_label}`, value: e.time_label }));
    return interaction.respond(choices.slice(0, 25));
  }
  if (focused.name === "arma") {
    const q = (focused.value || "").toUpperCase();
    const all = Object.keys(WEAPONS).filter((w) => w.includes(q));
    return interaction.respond(all.slice(0, 25).map((w) => ({ name: w, value: w })));
  }
  return interaction.respond([]);
}

// helper: acha vaga alvo (por vaga exata, ou primeira livre da arma na PT)
function resolveTargetSlot(partyIndex, vaga, arma, signups) {
  const taken = new Set(signups.filter(s => s.party_index != null).map(s => `${s.party_index}:${s.slot_index}`));
  if (vaga != null) return { partyIndex, slotIndex: vaga - 1 }; // vaga exata (força)
  // por arma: primeira vaga livre da PT que aceite a arma
  const slots = PARTIES[partyIndex].slots;
  for (let i = 0; i < slots.length; i++) {
    if (taken.has(`${partyIndex}:${i}`)) continue;
    if (slots[i].accepts.some(a => a.weapon.toUpperCase() === (arma || "").toUpperCase()))
      return { partyIndex, slotIndex: i };
  }
  // se não achou vaga da arma, primeira livre da PT (forçar)
  for (let i = 0; i < slots.length; i++)
    if (!taken.has(`${partyIndex}:${i}`)) return { partyIndex, slotIndex: i };
  return null; // PT cheia
}

module.exports = {
  registerCommands, isStaff, handleAutocomplete, resolveTargetSlot, commandDefs,
};
