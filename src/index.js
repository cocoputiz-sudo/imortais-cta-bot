/**
 * IMORTAIS CTA Bot - index.js
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { ctaShowCommand, handleCtaShow, createRangedButtonsRow } = require('./commands');
const { COMPS, getComp, ROLE_WEAPONS } = require('./comps');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Estado do roster ativo em memória
const activeCtaRoster = {
  pt6teste: {}
};

client.once('ready', () => {
  console.log(`✅ [BOT ONLINE] Conectado como ${client.user.tag}`);
});

// Handler de interações (Slash Commands e Botões)
client.on('interactionCreate', async interaction => {
  try {
    // 1. Slash Commands (/cta_show)
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'cta_show') {
        const party = interaction.options.getString('party');
        await handleCtaShow(interaction, activeCtaRoster[party] || {});
      }
    }

    // 2. Interações com Botões de Inscrição
    if (interaction.isButton()) {
      const { customId } = interaction;

      // Clique no botão de RANGED -> Abre opções de armas (Arco Longo, Gelo Elevado, etc.)
      if (customId === 'role_ranged') {
        const row = createRangedButtonsRow();
        return interaction.reply({
          content: '🏹 **Escolha sua arma RANGED:**',
          components: [row],
          ephemeral: true
        });
      }

      // Inscrição com arma específica
      if (customId.startsWith('weapon_choice_')) {
        const weaponId = customId.replace('weapon_choice_', '');
        return interaction.reply({
          content: `✅ Você se inscreveu com sucesso como **${weaponId}**!`,
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error('Erro na interação:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Ocorreu um erro ao processar esta ação.', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
