/**
 * ============================================================================
 * IMORTAIS CTA Bot - src/index.js
 * ============================================================================
 */

// Tratamento seguro de dotenv: Não trava caso o módulo não esteja instalado,
// pois o Railway injeta as variáveis de ambiente diretamente no sistema!
try {
  require('dotenv').config();
} catch (err) {
  // Ignora se dotenv não estiver instalado (Railway usa variáveis nativas)
}

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
  pt1: {},
  pt6teste: {}
};

client.once('ready', async () => {
  console.log(`✅ [BOT ONLINE] Conectado como ${client.user.tag}`);

  // Registro do slash command /cta_show
  try {
    if (client.application) {
      await client.application.commands.set([ctaShowCommand]);
      console.log('✅ [COMANDOS REGISTRADOS] /cta_show disponível com pt6teste.');
    }
  } catch (e) {
    console.error('Aviso ao registrar comandos:', e.message);
  }
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

      // Clique no botão de RANGED -> Abre opções com Arco Longo, Gelo Elevado, etc.
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
          content: `✅ Você se inscreveu com sucesso na vaga de **${weaponId}**!`,
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
