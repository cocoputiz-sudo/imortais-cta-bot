// ============================================================================
// BOT CTA — IMORTAIS  |  Fase 0.5
// - Post no #cta-mandatorio -> caller escolhe horarios
// - UMA THREAD POR HORARIO (ex: confirma 17:20 e 19:20 => 2 threads)
// - Inscricao 1-clique (papel -> arma -> presenca), encaixe pt1->2->3
// - Botao "Sair da funcao" pra pessoa se remover
// - Botao "Cancelar CTA" (so caller): posta aviso, trava e arquiva a thread
// - Log ao vivo de cada inscricao no #cta-log-staff
// ============================================================================
const {
  Client, GatewayIntentBits, Partials, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, MessageFlags,
} = require("discord.js");

const db = require("./db");
const { ROLES, WEAPON_CATALOG } = require("./comps");
const { findOpenSlot, renderRoster } = require("./roster");

// ---- Config via variaveis de ambiente -------------------------------------
const CFG = {
  token: process.env.DISCORD_TOKEN,
  ctaChannelId: process.env.CTA_CHANNEL_ID,
  imortalRoleId: process.env.IMORTAL_ROLE_ID,
  staffLogChannelId: process.env.STAFF_LOG_CHANNEL_ID || null, // #cta-log-staff
  presetTimes: (process.env.PRESET_TIMES || "17:20,19:20,21:20").split(","),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// =====================  1) GATILHO  =========================================
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== CFG.ctaChannelId) return;
    const rows = buildTimePicker(new Set(), msg.author.id);
    await msg.reply({
      content: `🗡️ **CTA detectado.** ${msg.author}, escolhe os horários (UTC / horário do jogo):`,
      components: rows,
    });
  } catch (e) { console.error("trigger error:", e); }
});

// painel de horarios (toggle + confirmar). Estado vive no proprio botao.
function buildTimePicker(selected, callerId) {
  const btns = CFG.presetTimes.map((t) => {
    const on = selected.has(t);
    return new ButtonBuilder()
      .setCustomId(`time|${callerId}|${t}`)
      .setLabel(`${on ? "✅ " : ""}${t}`)
      .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  });
  const confirm = new ButtonBuilder()
    .setCustomId(`timeok|${callerId}|${[...selected].join(",")}`)
    .setLabel("Confirmar")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(selected.size === 0);
  const rows = [];
  for (let i = 0; i < btns.length; i += 5)
    rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(confirm));
  return rows;
}

// =====================  ROTEADOR DE INTERACOES  =============================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const [kind] = interaction.customId.split("|");
      if (kind === "time")     return onTimeToggle(interaction);
      if (kind === "timeok")   return onTimeConfirm(interaction);
      if (kind === "role")     return onRolePick(interaction);
      if (kind === "leave")    return onLeave(interaction);
      if (kind === "cancel")   return onCancel(interaction);
      if (kind === "montar")   return onMontar(interaction);
      if (kind === "presence") return onPresence(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      const [kind] = interaction.customId.split("|");
      if (kind === "weapon")   return onWeaponPick(interaction);
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: "Deu ruim aqui, tenta de novo.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function onTimeToggle(interaction) {
  const [, callerId, time] = interaction.customId.split("|");
  if (interaction.user.id !== callerId)
    return interaction.reply({ content: "Só quem chamou o CTA configura os horários.", flags: MessageFlags.Ephemeral });
  const selected = new Set();
  for (const row of interaction.message.components)
    for (const c of row.components)
      if (c.customId?.startsWith("time|") && c.label?.startsWith("✅"))
        selected.add(c.customId.split("|")[2]);
  selected.has(time) ? selected.delete(time) : selected.add(time);
  await interaction.update({ components: buildTimePicker(selected, callerId) });
}

// confirmar -> cria UM EVENTO E UMA THREAD POR HORARIO
async function onTimeConfirm(interaction) {
  const [, callerId, csv] = interaction.customId.split("|");
  if (interaction.user.id !== callerId)
    return interaction.reply({ content: "Só quem chamou o CTA confirma.", flags: MessageFlags.Ephemeral });
  const times = csv.split(",").filter(Boolean);
  if (!times.length)
    return interaction.reply({ content: "Marca pelo menos um horário.", flags: MessageFlags.Ephemeral });

  await interaction.update({ content: `⏳ Criando ${times.length} planilha(s)...`, components: [] });

  const created = [];
  for (const time of times) {
    const event = await db.createEvent({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      callerId,
      timeLabel: time,
    });
    const thread = await interaction.channel.threads.create({
      name: `Planilha CTA ${time}`,
      type: ChannelType.PublicThread,
      autoArchiveDuration: 1440,
    });
    await db.setThread(event.id, thread.id);

    const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
    await thread.send({
      content:
        `${mention} 🗡️ **CTA ${time} UTC** — loga e luta.\n` +
        `Escolhe tua arma abaixo pra entrar na planilha 👇`,
      components: buildRolePicker(event.id),
    });
    const rosterMsg = await thread.send({ content: renderRosterContent([]) });
    await db.setRosterMsg(event.id, rosterMsg.id);

    created.push(`• **${time}** → ${thread}`);
    await logStaff(interaction.guild, `🆕 CTA **${time} UTC** criado por <@${callerId}>.`);
  }

  await interaction.editReply({
    content: `✅ Planilha(s) aberta(s):\n${created.join("\n")}`,
    components: [],
  });
}

// papeis (filtram o menu de armas) + Sair da funcao + Cancelar (caller)
function buildRolePicker(eventId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) =>
    new ButtonBuilder().setCustomId(`role|${eventId}|${name}`)
      .setLabel(name).setEmoji(meta.emoji).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`leave|${eventId}`)
    .setLabel("Sair da função").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const montar = new ButtonBuilder().setCustomId(`montar|${eventId}`)
    .setLabel("Montar PT (caller)").setStyle(ButtonStyle.Success);
  const cancel = new ButtonBuilder().setCustomId(`cancel|${eventId}`)
    .setLabel("Cancelar CTA (caller)").setStyle(ButtonStyle.Danger);

  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5)
    rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(leave, montar, cancel));
  return rows;
}

async function onRolePick(interaction) {
  const [, eventId, role] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open")
    return interaction.reply({ content: "Esse CTA não está mais aberto.", flags: MessageFlags.Ephemeral });
  const weapons = WEAPON_CATALOG[role] || [];
  if (!weapons.length)
    return interaction.reply({ content: "Nenhuma arma nesse papel.", flags: MessageFlags.Ephemeral });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`weapon|${eventId}`)
    .setPlaceholder(`Tua arma de ${role}`)
    .addOptions(weapons.slice(0, 25).map((w) => ({ label: w, value: w })));
  await interaction.reply({
    content: `Escolhe tua arma (${role}):`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function onWeaponPick(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const weapon = interaction.values[0];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`presence|${eventId}|online|${weapon}`)
      .setLabel("Já estou ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`presence|${eventId}|later|${weapon}`)
      .setLabel("Entro no horário").setEmoji("🕐").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ content: `**${weapon}** selecionada. E aí:`, components: [row] });
}

async function onPresence(interaction) {
  const [, eventId, presence, weapon] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open")
    return interaction.update({ content: "Esse CTA não está mais aberto.", components: [] });

  const signups = await db.getSignups(eventId);
  const others = signups.filter((s) => s.user_id !== interaction.user.id);
  const spot = findOpenSlot(weapon, others);
  const username = interaction.member?.displayName || interaction.user.username;

  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon, presence,
    partyIndex: spot ? spot.partyIndex : null,
    slotIndex: spot ? spot.slotIndex : null,
  });

  const msg = spot
    ? `✅ Fechado! Você entrou na **Party ${spot.partyIndex + 1}**, vaga ${spot.slotIndex + 1} (${weapon}).`
    : `📝 Anotado como **reserva** (${weapon}) — sem vaga exata agora.`;
  await interaction.update({ content: msg, components: [] });

  await refreshRoster(interaction.guild, ev);

  // log ao vivo pra staff
  const dest = spot ? `Party ${spot.partyIndex + 1} (vaga ${spot.slotIndex + 1})` : "RESERVA";
  const pres = presence === "online" ? "🟢 já ON" : "🕐 entra no horário";
  await logStaff(interaction.guild,
    `➕ **${username}** entrou de **${weapon}** → ${dest} · ${pres} · CTA ${ev.time_label}`);
}

// sair da funcao
async function onLeave(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open")
    return interaction.reply({ content: "Esse CTA não está mais aberto.", flags: MessageFlags.Ephemeral });
  const removed = await db.deleteSignup(eventId, interaction.user.id);
  if (!removed)
    return interaction.reply({ content: "Você não estava inscrito nesse CTA.", flags: MessageFlags.Ephemeral });

  await interaction.reply({ content: "🚪 Você saiu da função. Vaga liberada.", flags: MessageFlags.Ephemeral });
  await refreshRoster(interaction.guild, ev);

  const username = interaction.member?.displayName || interaction.user.username;
  await logStaff(interaction.guild,
    `➖ **${username}** saiu (era **${removed.weapon}**) · CTA ${ev.time_label}`);
}

// cancelar (so caller): avisa + trava + arquiva
async function onCancel(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só o caller pode cancelar o CTA.", flags: MessageFlags.Ephemeral });
  if (ev.status !== "open")
    return interaction.reply({ content: "Esse CTA já foi encerrado.", flags: MessageFlags.Ephemeral });

  await db.setStatus(eventId, "cancelled");
  await interaction.reply({ content: `❌ **CTA ${ev.time_label} CANCELADO** — inscrições travadas.` });

  await logStaff(interaction.guild, `❌ CTA **${ev.time_label} UTC** cancelado por <@${ev.caller_id}>.`);

  // arquiva a thread
  const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
  if (thread) {
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
}

// montar PT (so caller): publica a lista final e trava
async function onMontar(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só o caller monta a PT.", flags: MessageFlags.Ephemeral });

  await db.setStatus(eventId, "closed");
  const signups = await db.getSignups(eventId);
  const content = `📋 **PT PRONTA — CTA ${ev.time_label} UTC**\n\n` + renderRoster(signups).join("\n\n");
  await interaction.reply({ content: content.slice(0, 1900) });
  await logStaff(interaction.guild, `📋 PT montada pro CTA **${ev.time_label} UTC** (${signups.length} inscritos).`);
}

// =====================  HELPERS  ===========================================
function renderRosterContent(signups) {
  return "**Planilha ao vivo**\n\n" + renderRoster(signups).join("\n\n");
}

async function refreshRoster(guild, ev) {
  if (!ev.thread_id || !ev.roster_msg) return;
  const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
  if (!thread) return;
  const msg = await thread.messages.fetch(ev.roster_msg).catch(() => null);
  if (!msg) return;
  const signups = await db.getSignups(ev.id);
  await msg.edit({ content: renderRosterContent(signups).slice(0, 1900) }).catch(() => {});
}

async function logStaff(guild, text) {
  if (!CFG.staffLogChannelId) return;
  const ch = await client.channels.fetch(CFG.staffLogChannelId).catch(() => null);
  if (ch) await ch.send({ content: text }).catch(() => {});
}

// =====================  BOOT  ==============================================
client.once(Events.ClientReady, (c) => console.log(`✅ Online como ${c.user.tag}`));

(async () => {
  await db.init();
  await client.login(CFG.token);
})();
