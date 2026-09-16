const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COMPS, getComp, getAvailableComps, BUTTON_CONFIG, ROLE_WEAPONS } = require('./comps');

// Definição do comando /cta_show com a nova opção pt6teste
const ctaShowCommand = new SlashCommandBuilder()
  .setName('cta_show')
  .setDescription('Abre ou exibe uma composição específica no CTA ativo')
  .addStringOption(option => {
    option.setName('party')
      .setDescription('Selecione a PT a exibir')
      .setRequired(true);
    
    // Adiciona as opções disponíveis, garantindo pt6teste
    option.addChoices(
      { name: 'PT 1', value: 'pt1' },
      { name: 'PT 2', value: 'pt2' },
      { name: 'pt6teste', value: 'pt6teste' }
    );
    return option;
  });

// Manipulador do comando /cta_show
async function handleCtaShow(interaction, activeRoster = {}) {
  const partyChoice = interaction.options.getString('party');
  const comp = getComp(partyChoice);

  if (!comp) {
    return interaction.reply({
      content: `❌ Composição "${partyChoice}" não encontrada.`,
      ephemeral: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ CTA IMORTAIS - ${comp.name}`)
    .setColor('#1E88E5')
    .setDescription(`Composição oficial carregada com **${comp.slots.length} vagas**.`)
    .setFooter({ text: 'IMORTAIS • Albion Online ZvZ CTA Bot' })
    .setTimestamp();

  // Divide a exibição dos 20 slots de forma limpa
  let slotsText = '';
  comp.slots.forEach(slot => {
    const assignedPlayer = activeRoster[slot.slot] ? `<@${activeRoster[slot.slot].userId}>` : '*Vaga Vazia*';
    const weaponsList = slot.weapons.join(' / ');
    slotsText += `**${slot.slot}.** [${slot.role}] **${slot.title}** (${weaponsList}): ${assignedPlayer}\n`;
  });

  embed.addFields({ name: '📋 Relação de Vagas', value: slotsText });

  return interaction.reply({ embeds: [embed] });
}

// Cria os botões da role RANGED
function createRangedButtonsRow() {
  const row = new ActionRowBuilder();
  BUTTON_CONFIG.RANGED_WEAPONS.forEach(w => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`weapon_choice_${w.id}`)
        .setLabel(w.label)
        .setStyle(ButtonStyle[w.style] || ButtonStyle.Secondary)
    );
  });
  return row;
}

module.exports = {
  ctaShowCommand,
  handleCtaShow,
  createRangedButtonsRow
};
