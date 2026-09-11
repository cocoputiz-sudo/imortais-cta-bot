// ============================================================================
// SLASH COMMANDS de gestão do CTA
// ============================================================================
const {
  REST, Routes, SlashCommandBuilder,
} = require("discord.js");
const db = require("./db");
const { PARTIES, WEAPONS } = require("./comps");

const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;

function commandDefs() {
  const ctaOpt = (o) => o.setName("cta").setDescription("Qual CTA (horário)").setRequired(true).setAutocomplete(true);
  const userOpt = (o) => o.setName("usuario").setDescription("Jogador").setRequired(true);
  const ptOpt = (o) => o.setName("pt").setDescription("Número da PT (1-5)").setRequired(true).setMinValue(1).setMaxValue(5);
  const vagaOpt = (o) => o.setName("vaga").setDescription("Número da vaga (1-20)").setMinValue(1).setMaxValue(20);
  const armaOpt = (o) => o.setName("arma").setDescription("Arma").setAutocomplete(true);

  return [
    new SlashCommandBuilder().setName("cta_press_pt").setDescription("Adiciona a Party 5 (PT5) ao CTA")
      .addStringOption(ctaOpt),
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
    new SlashCommandBuilder().setName("cta_change_time").setDescription("Muda o horário de um CTA já criado")
      .addStringOption(ctaOpt)
      .addStringOption((o) => o.setName("novo").setDescription("Novo horário, ex 23:00").setRequired(true)),
    new SlashCommandBuilder().setName("cta_finish").setDescription("Encerra um CTA (qualquer staff, qualquer caller)")
      .addStringOption(ctaOpt),
    new SlashCommandBuilder().setName("cta_consolidar").setDescription("Amontoa os participantes nas PTs da frente (perto da hora)")
      .addStringOption(ctaOpt),
    new SlashCommandBuilder().setName("attendance_daily").setDescription("Relatório de presença — hoje"),
    new SlashCommandBuilder().setName("attendance_week").setDescription("Relatório de presença — últimos 7 dias"),
    new SlashCommandBuilder().setName("attendance_monthly").setDescription("Relatório de presença — últimos 30 dias"),
    new SlashCommandBuilder().setName("cta_start_temporada").setDescription("Inicia uma temporada (Mestre de Guerra)")
      .addIntegerOption((o) => o.setName("numero").setDescription("Número da temporada, ex: 34").setRequired(true).setMinValue(1).setMaxValue(999)),
    new SlashCommandBuilder().setName("cta_finish_temporada").setDescription("Encerra a temporada atual (Mestre de Guerra)"),
    new SlashCommandBuilder().setName("cta_rank").setDescription("Placar de presença da temporada atual"),
    new SlashCommandBuilder().setName("cta_meurank").setDescription("Tua pontuação de presença na temporada atual"),
    // ---- ROAMING ----
    new SlashCommandBuilder().setName("roaming").setDescription("Cria um roaming (caller)")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming, ex: badmack").setRequired(true))
      .addIntegerOption((o) => o.setName("vagas").setDescription("12, 16 ou 20").setRequired(true).addChoices({ name: "12", value: 12 }, { name: "16", value: 16 }, { name: "20", value: 20 })),
    new SlashCommandBuilder().setName("roaming_start").setDescription("Começa a contar presença do roaming")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName("roaming_value").setDescription("Informa a prata arrecadada")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName("valor").setDescription("Prata total, ex: 42000000").setRequired(true)),
    new SlashCommandBuilder().setName("roaming_finish").setDescription("Encerra e calcula a divisão")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName("roaming_saldo").setDescription("Mostra a divisão do roaming")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName("roaming_meu_saldo").setDescription("Teu saldo no roaming")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName("roaming_remove").setDescription("Remove alguém do roaming")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true))
      .addUserOption((o) => o.setName("usuario").setDescription("Quem remover").setRequired(true)),
    new SlashCommandBuilder().setName("roaming_fill").setDescription("Adiciona alguém no roaming")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true))
      .addUserOption((o) => o.setName("usuario").setDescription("Quem adicionar").setRequired(true))
      .addStringOption((o) => o.setName("funcao").setDescription("Função (tank/dps/healer/sup/caller)").setRequired(true)),
    new SlashCommandBuilder().setName("roaming_pago").setDescription("Marca o roaming como pago")
      .addStringOption((o) => o.setName("nome").setDescription("Nome do roaming").setRequired(true).setAutocomplete(true)),
  ].map((c) => c.toJSON());
}

async function registerCommands(clientId, guildId) {
  if (!process.env.DISCORD_TOKEN) return;
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandDefs() });
  console.log("✅ Slash commands registrados no servidor", guildId);
}

function isStaff(interaction) {
  if (!STAFF_ROLE_ID) return true;
  return interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);
}

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
  if (focused.name === "nome") {
    const rs = await db.getOpenRoamings(interaction.guildId);
    return interaction.respond(rs.slice(0, 25).map((r) => ({ name: `${r.nome} (${r.vagas}v)`, value: r.nome })));
  }
  return interaction.respond([]);
}

function resolveTargetSlot(partyIndex, vaga, arma, signups) {
  const taken = new Set(signups.filter((s) => s.party_index != null).map((s) => `${s.party_index}:${s.slot_index}`));
  if (vaga != null) return { partyIndex, slotIndex: vaga - 1 };
  const slots = PARTIES[partyIndex]?.slots || [];
  for (let i = 0; i < slots.length; i++) {
    if (taken.has(`${partyIndex}:${i}`)) continue;
    if (slots[i].accepts.some((a) => a.weapon.toUpperCase() === (arma || "").toUpperCase())) {
      return { partyIndex, slotIndex: i };
    }
  }
  return null;
}

module.exports = {
  registerCommands, isStaff, handleAutocomplete, resolveTargetSlot, commandDefs,
};