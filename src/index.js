// ============================================================================
// BOT CTA — IMORTAIS  |  Fase 0
// Fluxo: post no cta-mandatório -> caller escolhe horários -> abre thread
//        "Planilha CTA" -> @Imortal + inscrição 1-clique -> monta "PT pronta".
// ============================================================================
const {
  Client, GatewayIntentBits, Partials, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, MessageFlags,
} = require("discord.js");

const db = require("./db");
const { ROLES, WEAPON_CATALOG } = require("./comps");
const { findOpenSlot, renderRoster } = require("./roster");

// ---- Config via variáveis de ambiente -------------------------------------
const CFG = {
  token: process.env.DISCORD_TOKEN,
  ctaChannelId: process.env.CTA_CHANNEL_ID,       // id do #cta-mandatório
  imortalRoleId: process.env.IMORTAL_ROLE_ID,     // cargo @Imortal (pra mencionar)
  ptProntaChannelId: process.env.PT_PRONTA_CHANNEL_ID || null, // opcional
  presetTimes: (process.env.PRESET_TIMES || "17:20,19:20,21:20").split(","),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // PRECISA estar ligado no Dev Portal
  ],
  partials: [Partials.Channel],
});

// Estado leve em memória: id da mensagem-roster por evento (pra editar ao vivo).
const rosterMessages = new Map(); // eventId -> Message

// ---- 1) Gatilho: post novo no canal cta-mandatório -------------------------
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== CFG.ctaChannelId) return;

    // Canal é trancado (só caller/dono postam), então qualquer post = CTA.
    // Mandamos o painel de horários e travamos pra quem postou.
    const rows = buildTimePicker(new Set(), msg.author.id);
    await msg.reply({
      content: `🗡️ **CTA detectado.** ${msg.author}, escolhe os horários (UTC / horário do jogo):`,
      components: rows,
    });
  } catch (e) {
    console.error("trigger error:", e);
  }
});

// Painel de horários: um botão-toggle por horário + "Confirmar".
// O estado (quais estão marcados) vai codificado no customId, então não
// precisamos guardar nada em memória entre cliques.
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

  // até 5 botões por linha
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
  }
  rows.push(new ActionRowBuilder().addComponents(confirm));
  return rows;
}

// ---- Roteador de interações ------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const [kind] = interaction.customId.split("|");
      if (kind === "time") return onTimeToggle(interaction);
      if (kind === "timeok") return onTimeConfirm(interaction);
      if (kind === "role") return onRolePick(interaction);
      if (kind === "montar") return onMontar(interaction);
      if (kind === "presence") return onPresence(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      const [kind] = interaction.customId.split("|");
      if (kind === "weapon") return onWeaponPick(interaction);
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable() && !interaction.replied) {
      interaction.reply({ content: "Deu ruim aqui, tenta de novo.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// toggle de um horário
async function onTimeToggle(interaction) {
  const [, callerId, time] = interaction.customId.split("|");
  if (interaction.user.id !== callerId) {
    return interaction.reply({ content: "Só quem chamou o CTA configura os horários.", flags: MessageFlags.Ephemeral });
  }
  // lê estado atual dos botões pra saber o que já está marcado
  const selected = new Set();
  for (const row of interaction.message.components) {
    for (const c of row.components) {
      if (c.customId?.startsWith("time|") && c.label?.startsWith("✅")) {
        selected.add(c.customId.split("|")[2]);
      }
    }
  }
  if (selected.has(time)) selected.delete(time);
  else selected.add(time);

  await interaction.update({ components: buildTimePicker(selected, callerId) });
}

// confirmar horários -> cria evento + thread + painel de inscrição
async function onTimeConfirm(interaction) {
  const [, callerId, csv] = interaction.customId.split("|");
  if (interaction.user.id !== callerId) {
    return interaction.reply({ content: "Só quem chamou o CTA confirma.", flags: MessageFlags.Ephemeral });
  }
  const times = csv.split(",").filter(Boolean);
  if (!times.length) {
    return interaction.reply({ content: "Marca pelo menos um horário.", flags: MessageFlags.Ephemeral });
  }

  const event = await db.createEvent({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    callerId,
    times,
  });

  // cria a thread "Planilha CTA"
  const thread = await interaction.channel.threads.create({
    name: `Planilha CTA — ${times.join(" / ")}`,
    type: ChannelType.PublicThread,
    autoArchiveDuration: 1440,
  });
  await db.setThread(event.id, thread.id);

  // aviso pro cargo @Imortal + painel de inscrição
  const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
  await thread.send({
    content:
      `${mention} 🗡️ **CTA HOJE** — ${times.map((t) => `\`${t}\` UTC`).join(" e ")}\n` +
      `Loga e luta. Escolhe tua arma abaixo pra entrar na planilha 👇`,
    components: buildRolePicker(event.id),
  });

  // mensagem-roster ao vivo (vai sendo editada a cada inscrição)
  const rosterMsg = await thread.send({ content: renderRosterContent([]) });
  rosterMessages.set(String(event.id), rosterMsg);

  await interaction.update({
    content: `✅ Planilha aberta: ${thread}`,
    components: [],
  });
}

// botões de papel (Tank/Support/...) — só filtram o menu de armas
function buildRolePicker(eventId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) =>
    new ButtonBuilder()
      .setCustomId(`role|${eventId}|${name}`)
      .setLabel(name)
      .setEmoji(meta.emoji)
      .setStyle(ButtonStyle.Secondary)
  );
  const montar = new ButtonBuilder()
    .setCustomId(`montar|${eventId}`)
    .setLabel("Montar PT (caller)")
    .setStyle(ButtonStyle.Success);

  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  }
  rows.push(new ActionRowBuilder().addComponents(montar));
  return rows;
}

// clicou num papel -> mostra menu (ephemeral) com as armas daquele papel
async function onRolePick(interaction) {
  const [, eventId, role] = interaction.customId.split("|");
  const weapons = WEAPON_CATALOG[role] || [];
  if (!weapons.length) {
    return interaction.reply({ content: "Nenhuma arma nesse papel.", flags: MessageFlags.Ephemeral });
  }
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

// escolheu a arma -> pergunta presença (online agora / entra no horário)
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

// confirmou presença -> atribui vaga e atualiza a planilha ao vivo
async function onPresence(interaction) {
  const [, eventId, presence, weapon] = interaction.customId.split("|");
  const signups = await db.getSignups(eventId);
  // remove a inscrição antiga da pessoa antes de recalcular a vaga
  const others = signups.filter((s) => s.user_id !== interaction.user.id);
  const spot = findOpenSlot(weapon, others);

  await db.upsertSignup({
    eventId,
    userId: interaction.user.id,
    username: interaction.member?.displayName || interaction.user.username,
    weapon,
    presence,
    partyIndex: spot ? spot.partyIndex : null,
    slotIndex: spot ? spot.slotIndex : null,
  });

  const msg = spot
    ? `✅ Fechado! Você entrou na **Party ${spot.partyIndex + 1}**, vaga ${spot.slotIndex + 1} (${weapon}).`
    : `📝 Anotado como **reserva** (${weapon}) — sem vaga exata agora, o caller pode te encaixar.`;
  await interaction.update({ content: msg, components: [] });

  await refreshRoster(eventId);
}

// caller fecha e publica a PT pronta
async function onMontar(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const event = await db.getEvent(eventId);
  if (interaction.user.id !== event.caller_id) {
    return interaction.reply({ content: "Só o caller monta a PT.", flags: MessageFlags.Ephemeral });
  }
  await db.closeEvent(eventId);
  const signups = await db.getSignups(eventId);
  const content = `📋 **PT PRONTA** — CTA ${event.times.join(" / ")} UTC\n\n` + renderRoster(signups).join("\n\n");

  const target = CFG.ptProntaChannelId
    ? await client.channels.fetch(CFG.ptProntaChannelId).catch(() => null)
    : interaction.channel;
  await (target || interaction.channel).send({ content: content.slice(0, 1900) });

  await interaction.reply({ content: "✅ PT publicada.", flags: MessageFlags.Ephemeral });
}

// ---- render helpers --------------------------------------------------------
function renderRosterContent(signups) {
  return "**Planilha ao vivo**\n\n" + renderRoster(signups).join("\n\n");
}
async function refreshRoster(eventId) {
  const msg = rosterMessages.get(String(eventId));
  if (!msg) return;
  const signups = await db.getSignups(eventId);
  const text = renderRosterContent(signups).slice(0, 1900);
  await msg.edit({ content: text }).catch(() => {});
}

// ---- boot ------------------------------------------------------------------
client.once(Events.ClientReady, (c) => console.log(`✅ Online como ${c.user.tag}`));

(async () => {
  await db.init();
  await client.login(CFG.token);
})();
