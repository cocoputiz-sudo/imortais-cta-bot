// ============================================================================
// BOT CTA — IMORTAIS  |  Fase 1
// - post no #cta-mandatorio -> caller escolhe horarios -> 1 thread por horario
// - inscricao (papel -> arma -> presenca) com engine de PESO + tetos
// - NUDGE de troca (Sim/Nao) quando ha vaga melhor da mesma familia
// - "Sair da funcao", "Cancelar CTA", log ao vivo no #cta-log-staff
// - LEMBRETES 30 e 10 min antes (robustos: verificador le do banco)
// ============================================================================
const {
  Client, GatewayIntentBits, Partials, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, MessageFlags,
} = require("discord.js");

const db = require("./db");
const { ROLES, WEAPON_CATALOG } = require("./comps");
const { findBestSlot, suggestUpgrade, renderRoster } = require("./roster");

const CFG = {
  token: process.env.DISCORD_TOKEN,
  ctaChannelId: process.env.CTA_CHANNEL_ID,
  imortalRoleId: process.env.IMORTAL_ROLE_ID,
  staffLogChannelId: process.env.STAFF_LOG_CHANNEL_ID || null,
  presetTimes: (process.env.PRESET_TIMES || "17:20,19:20,21:20").split(","),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// menu do papel pra armas do catalogo
function catalog(role) { return WEAPON_CATALOG[role] || []; }

// ======= util de horario: "17:20" -> Date de HOJE em UTC ===================
function timeToTodayUTC(label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    parseInt(m[1], 10), parseInt(m[2], 10), 0, 0));
  return d;
}

// ======================  1) GATILHO  =======================================
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== CFG.ctaChannelId) return;
    await msg.reply({
      content: `🗡️ **CTA detectado.** ${msg.author}, escolhe os horários (UTC / horário do jogo):`,
      components: buildTimePicker(new Set(), msg.author.id),
    });
  } catch (e) { console.error("trigger:", e); }
});

function buildTimePicker(selected, callerId) {
  const btns = CFG.presetTimes.map((t) => new ButtonBuilder()
    .setCustomId(`time|${callerId}|${t}`)
    .setLabel(`${selected.has(t) ? "✅ " : ""}${t}`)
    .setStyle(selected.has(t) ? ButtonStyle.Success : ButtonStyle.Secondary));
  const confirm = new ButtonBuilder().setCustomId(`timeok|${callerId}|${[...selected].join(",")}`)
    .setLabel("Confirmar").setStyle(ButtonStyle.Primary).setDisabled(selected.size === 0);
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(confirm));
  return rows;
}

// ======================  ROTEADOR  =========================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const [k] = interaction.customId.split("|");
      if (k === "time")     return onTimeToggle(interaction);
      if (k === "timeok")   return onTimeConfirm(interaction);
      if (k === "role")     return onRolePick(interaction);
      if (k === "callerpick") return onCallerPick(interaction);
      if (k === "callerset")  return onCallerSet(interaction);
      if (k === "presence") return onPresence(interaction);
      if (k === "swapyes")  return onSwapYes(interaction);
      if (k === "swapno")   return onSwapNo(interaction);
      if (k === "leave")    return onLeave(interaction);
      if (k === "cancel")   return onCancel(interaction);
      if (k === "montar")   return onMontar(interaction);
      if (k === "fechar")   return onFechar(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("weapon|"))
      return onWeaponPick(interaction);
  } catch (e) {
    console.error("interaction:", e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
      interaction.reply({ content: "Deu ruim, tenta de novo.", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function onTimeToggle(interaction) {
  const [, callerId, time] = interaction.customId.split("|");
  if (interaction.user.id !== callerId)
    return interaction.reply({ content: "Só quem chamou o CTA configura.", flags: MessageFlags.Ephemeral });
  const sel = new Set();
  for (const row of interaction.message.components)
    for (const c of row.components)
      if (c.customId?.startsWith("time|") && c.label?.startsWith("✅")) sel.add(c.customId.split("|")[2]);
  sel.has(time) ? sel.delete(time) : sel.add(time);
  await interaction.update({ components: buildTimePicker(sel, callerId) });
}

async function onTimeConfirm(interaction) {
  const [, callerId, csv] = interaction.customId.split("|");
  if (interaction.user.id !== callerId)
    return interaction.reply({ content: "Só quem chamou confirma.", flags: MessageFlags.Ephemeral });
  const times = csv.split(",").filter(Boolean);
  if (!times.length) return interaction.reply({ content: "Marca um horário.", flags: MessageFlags.Ephemeral });

  await interaction.update({ content: `⏳ Criando ${times.length} planilha(s)...`, components: [] });

  const created = [];
  for (const time of times) {
    const target = timeToTodayUTC(time);
    let r30 = null, r10 = null;
    if (target) {
      r30 = new Date(target.getTime() - 30 * 60000);
      r10 = new Date(target.getTime() - 10 * 60000);
    }
    const ev = await db.createEvent({
      guildId: interaction.guildId, channelId: interaction.channelId,
      callerId, timeLabel: time, remind30: r30, remind10: r10,
    });
    const thread = await interaction.channel.threads.create({
      name: `Planilha CTA ${time}`, type: ChannelType.PublicThread, autoArchiveDuration: 1440,
    });
    await db.setThread(ev.id, thread.id);

    const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
    await thread.send({
      content: `${mention} 🗡️ **CTA ${time} UTC** — loga e luta.\nEscolhe tua arma abaixo 👇`,
      components: buildRolePicker(ev.id),
    });
    const [c1, c2] = rosterChunks([]);
    const r1 = await thread.send({ content: c1 });
    const r2 = await thread.send({ content: c2 });
    await db.setRosterMsg(ev.id, `${r1.id},${r2.id}`);
    created.push(`• **${time}** → ${thread}`);
    await logStaff(interaction.guild, `🆕 CTA **${time} UTC** criado por <@${callerId}>.`);
    await new Promise((r) => setTimeout(r, 1200)); // respiro anti rate-limit
  }
  await interaction.editReply({ content: `✅ Planilha(s):\n${created.join("\n")}`, components: [] });
}

function buildRolePicker(eventId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) => new ButtonBuilder()
    .setCustomId(`role|${eventId}|${name}`).setLabel(name).setEmoji(meta.emoji).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`leave|${eventId}`).setLabel("Sair da função").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const montar = new ButtonBuilder().setCustomId(`montar|${eventId}`).setLabel("Montar PT (caller)").setStyle(ButtonStyle.Success);
  const cancel = new ButtonBuilder().setCustomId(`cancel|${eventId}`).setLabel("Cancelar (caller)").setStyle(ButtonStyle.Danger);
  const fechar = new ButtonBuilder().setCustomId(`fechar|${eventId}`).setLabel("Fechar CTA (caller)").setStyle(ButtonStyle.Secondary);
  const caller = new ButtonBuilder().setCustomId(`callerpick|${eventId}`).setLabel("Sou o caller").setEmoji("👑").setStyle(ButtonStyle.Primary);
  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(caller, leave, montar));
  rows.push(new ActionRowBuilder().addComponents(fechar, cancel));
  return rows;
}

async function onRolePick(interaction) {
  const [, eventId, role] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev)
    return interaction.reply({ content: "⚠️ Não achei esse CTA no sistema (evento perdido). Avisa o caller.", flags: MessageFlags.Ephemeral });
  if (ev.status !== "open")
    return interaction.reply({ content: `Esse CTA está **${ev.status === "cancelled" ? "cancelado" : "fechado"}**.`, flags: MessageFlags.Ephemeral });
  const weapons = catalog(role);
  if (!weapons.length) return interaction.reply({ content: "Sem armas nesse papel.", flags: MessageFlags.Ephemeral });
  const menu = new StringSelectMenuBuilder().setCustomId(`weapon|${eventId}`)
    .setPlaceholder(`Tua arma de ${role}`).addOptions(weapons.slice(0, 25).map((w) => ({ label: w, value: w })));
  await interaction.reply({ content: `Escolhe tua arma (${role}):`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}

async function onWeaponPick(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const weapon = interaction.values[0];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`presence|${eventId}|online|${weapon}`).setLabel("Já estou ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`presence|${eventId}|later|${weapon}`).setLabel("Entro no horário").setEmoji("🕐").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ content: `**${weapon}** selecionada. E aí:`, components: [row] });
}

async function onPresence(interaction) {
  const [, eventId, presence, weapon] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.update({ content: "CTA não está aberto.", components: [] });

  await interaction.deferUpdate(); // responde ao Discord em <3s; trabalho pesado a seguir
  const signups = await db.getSignups(eventId);
  const others = signups.filter((s) => s.user_id !== interaction.user.id);
  const spot = findBestSlot(weapon, others);
  const username = interaction.member?.displayName || interaction.user.username;

  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon, presence,
    partyIndex: spot ? spot.partyIndex : null, slotIndex: spot ? spot.slotIndex : null,
  });
  await refreshRoster(ev);

  const dest = spot ? `Party ${spot.partyIndex + 1} (vaga ${spot.slotIndex + 1})` : "RESERVA";
  const pres = presence === "online" ? "🟢 já ON" : "🕐 entra no horário";
  await logStaff(interaction.guild, `➕ **${username}** entrou de **${weapon}** → ${dest} · ${pres} · CTA ${ev.time_label}`);

  // NUDGE: existe vaga melhor da mesma familia?
  const up = suggestUpgrade(weapon, spot, others);
  if (up) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`swapyes|${eventId}|${up.partyIndex}|${up.slotIndex}|${encodeURIComponent(up.weapon)}`)
        .setLabel(`Sim, troco pra ${up.weapon}`.slice(0, 80)).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`swapno|${eventId}|${encodeURIComponent(weapon)}`)
        .setLabel(`Não, fico com ${weapon}`.slice(0, 80)).setStyle(ButtonStyle.Secondary),
    );
    return interaction.editReply({
      content: `✅ Entrou como **${weapon}** (${dest}).\n\n💡 Tem vaga de **${up.weapon}** (Party ${up.partyIndex + 1}), melhor pra comp. Quer trocar?`,
      components: [row],
    });
  }
  const msg = spot
    ? `✅ Fechado! **Party ${spot.partyIndex + 1}**, vaga ${spot.slotIndex + 1} (${weapon}).`
    : `📝 Anotado como **reserva** (${weapon}).`;
  await interaction.editReply({ content: msg, components: [] });
}

async function onSwapYes(interaction) {
  const [, eventId, p, i, wEnc] = interaction.customId.split("|");
  const weapon = decodeURIComponent(wEnc);
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.update({ content: "CTA não está aberto.", components: [] });

  await interaction.deferUpdate();
  // re-checa se a vaga sugerida ainda esta livre
  const signups = await db.getSignups(eventId);
  const others = signups.filter((s) => s.user_id !== interaction.user.id);
  const occupied = others.some((s) => String(s.party_index) === p && String(s.slot_index) === i);
  const username = interaction.member?.displayName || interaction.user.username;
  if (occupied) {
    await interaction.editReply({ content: `⚠️ A vaga de ${weapon} já foi preenchida. Você continua na anterior.`, components: [] });
    return;
  }
  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon,
    presence: (signups.find(s => s.user_id === interaction.user.id)?.presence) || "online",
    partyIndex: parseInt(p, 10), slotIndex: parseInt(i, 10),
  });
  await interaction.editReply({ content: `🔄 Trocado! Agora você é **${weapon}** na Party ${parseInt(p,10)+1}.`, components: [] });
  await refreshRoster(ev);
  await logStaff(interaction.guild, `🔄 **${username}** trocou para **${weapon}** → Party ${parseInt(p,10)+1} · CTA ${ev.time_label}`);
}

async function onSwapNo(interaction) {
  const [, , wEnc] = interaction.customId.split("|");
  const weapon = decodeURIComponent(wEnc);
  await interaction.update({ content: `👍 Beleza, você fica de **${weapon}**.`, components: [] });
}

async function onLeave(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.reply({ content: "CTA não está aberto.", flags: MessageFlags.Ephemeral });
  const removed = await db.deleteSignup(eventId, interaction.user.id);
  if (!removed) return interaction.reply({ content: "Você não estava inscrito.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "🚪 Saiu da função. Vaga liberada.", flags: MessageFlags.Ephemeral });
  await refreshRoster(ev);
  const username = interaction.member?.displayName || interaction.user.username;
  await logStaff(interaction.guild, `➖ **${username}** saiu (era **${removed.weapon}**) · CTA ${ev.time_label}`);
}

async function onCancel(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só o caller cancela.", flags: MessageFlags.Ephemeral });
  if (ev.status !== "open") return interaction.reply({ content: "CTA já encerrado.", flags: MessageFlags.Ephemeral });
  await db.setStatus(eventId, "cancelled");
  await interaction.reply({ content: `❌ **CTA ${ev.time_label} CANCELADO** — inscrições travadas.` });
  await logStaff(interaction.guild, `❌ CTA **${ev.time_label} UTC** cancelado por <@${ev.caller_id}>.`);
  const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
  if (thread) { await thread.setLocked(true).catch(()=>{}); await thread.setArchived(true).catch(()=>{}); }
}

async function onMontar(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só o caller monta.", flags: MessageFlags.Ephemeral });
  // NAO fecha o CTA — só publica a lista atual. Inscrições continuam abertas.
  const signups = await db.getSignups(eventId);
  const blocks = renderRoster(signups);
  const half = Math.ceil(blocks.length / 2);
  const p1 = `📋 **PT — CTA ${ev.time_label} UTC (1/2)**\n\n` + blocks.slice(0, half).join("\n\n");
  const p2 = `📋 **PT — CTA ${ev.time_label} UTC (2/2)**\n\n` + blocks.slice(half).join("\n\n");
  await interaction.reply({ content: p1.slice(0, 1990) });
  await interaction.followUp({ content: p2.slice(0, 1990) });
  await logStaff(interaction.guild, `📋 PT publicada · CTA **${ev.time_label} UTC** (${signups.length} inscritos). (CTA segue aberto)`);
}

// fechar de vez (trava inscrições) — botão separado do Montar
async function onFechar(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só o caller fecha.", flags: MessageFlags.Ephemeral });
  if (ev.status !== "open") return interaction.reply({ content: "CTA já encerrado.", flags: MessageFlags.Ephemeral });
  await db.setStatus(eventId, "closed");
  await interaction.reply({ content: `🔒 **CTA ${ev.time_label} FECHADO** — inscrições travadas.` });
  await logStaff(interaction.guild, `🔒 CTA **${ev.time_label} UTC** fechado por <@${ev.caller_id}>.`);
}


// caller assume a vaga 1 da pt1 (escolhe entre Golem/Maça de Uma Mão/Bruxo)
async function onCallerPick(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open")
    return interaction.reply({ content: "CTA não está aberto.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só quem chamou o CTA usa isso.", flags: MessageFlags.Ephemeral });
  const opts = ["GOLEM", "MAÇA DE UMA MÃO", "BRUXO DE UMA MÃO"];
  const menu = new StringSelectMenuBuilder().setCustomId(`callerset|${eventId}`)
    .setPlaceholder("Tua arma de caller")
    .addOptions(opts.map((w) => ({ label: w, value: w })));
  await interaction.reply({ content: "👑 Escolhe tua arma de caller (vaga 1 da PT1):", components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}

async function onCallerSet(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.update({ content: "CTA não está aberto.", components: [] });
  if (interaction.user.id !== ev.caller_id)
    return interaction.update({ content: "Só o caller usa isso.", components: [] });
  const weapon = interaction.values[0];
  const username = interaction.member?.displayName || interaction.user.username;
  await interaction.deferUpdate();
  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon, presence: "online",
    partyIndex: 0, slotIndex: 0,
  });
  await interaction.editReply({ content: `👑 Você é o caller — **${weapon}** na PT1 vaga 1.`, components: [] });
  await refreshRoster(ev);
  await logStaff(interaction.guild, `👑 **${username}** assumiu caller (${weapon}) · CTA ${ev.time_label}`);
}

// ======================  HELPERS  ==========================================
// divide os 4 blocos de PT em 2 mensagens (PT1+2 e PT3+4) pra nunca estourar 2000
function rosterChunks(signups) {
  const blocks = renderRoster(signups);
  const half = Math.ceil(blocks.length / 2);
  const a = ["**Planilha ao vivo (1/2)**", ...blocks.slice(0, half)].join("\n\n");
  const b = ["**Planilha ao vivo (2/2)**", ...blocks.slice(half)].join("\n\n");
  return [a.slice(0, 1990), b.slice(0, 1990)];
}

async function refreshRoster(ev) {
  if (!ev.thread_id || !ev.roster_msg) return;
  const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
  if (!thread) return;
  const ids = String(ev.roster_msg).split(",");
  const signups = await db.getSignups(ev.id);
  const chunks = rosterChunks(signups);
  await Promise.all(ids.map(async (id, i) => {
    const m = await thread.messages.fetch(id).catch(() => null);
    if (m && chunks[i]) await m.edit({ content: chunks[i] }).catch(() => {});
  }));
}

async function logStaff(guild, text) {
  if (!CFG.staffLogChannelId) return;
  const ch = await client.channels.fetch(CFG.staffLogChannelId).catch(() => null);
  if (ch) await ch.send({ content: text }).catch(() => {});
}

// ======================  LEMBRETES (verificador a cada minuto)  =============
async function checkReminders() {
  try {
    const due = await db.getDueReminders(new Date());
    for (const ev of due) {
      const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
      if (!thread) continue;
      const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
      const now = Date.now();
      if (!ev.sent_30 && ev.remind_30 && new Date(ev.remind_30).getTime() <= now) {
        await thread.send({ content: `${mention} ⏰ **CTA ${ev.time_label} UTC em 30 minutos!** Prepara o set e loga.` }).catch(()=>{});
        await db.markReminderSent(ev.id, 30);
      }
      if (!ev.sent_10 && ev.remind_10 && new Date(ev.remind_10).getTime() <= now) {
        await thread.send({ content: `${mention} 🚨 **CTA ${ev.time_label} UTC em 10 minutos!** Entra na call AGORA.` }).catch(()=>{});
        await db.markReminderSent(ev.id, 10);
      }
    }
  } catch (e) { console.error("reminders:", e); }
}

// ======================  BOOT  =============================================
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Online como ${c.user.tag}`);
  setInterval(checkReminders, 60 * 1000); // a cada minuto
});

(async () => { await db.init(); await client.login(CFG.token); })();
