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
const { ROLES, WEAPON_CATALOG, BOMB_COMPS, KITE_MIN } = require("./comps");
const { findBestSlot, suggestUpgrade, renderRoster, reallocate } = require("./roster");
const cmds = require("./commands");

const CFG = {
  token: process.env.DISCORD_TOKEN,
  ctaChannelId: process.env.CTA_CHANNEL_ID,
  imortalRoleId: process.env.IMORTAL_ROLE_ID,
  staffLogChannelId: process.env.STAFF_LOG_CHANNEL_ID || null,
  bombPingChannelId: process.env.BOMB_PING_CHANNEL_ID || null,
  bombRoleId: process.env.BOMB_ROLE_ID || null,
  bombLeaderRoleId: process.env.BOMB_LEADER_ROLE_ID || null,
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
    if (interaction.isAutocomplete()) return cmds.handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return onSlash(interaction);
    if (interaction.isButton()) {
      const [bk] = interaction.customId.split("|");
      if (bk === "occ") return onOccupantChoice(interaction); // pergunta interativa
      if (bk === "bombyes") return onBombConfirm(interaction, true);
      if (bk === "bombno")  return onBombConfirm(interaction, false);
      if (bk === "bombcomp") return onBombCompChoice(interaction);
      if (bk === "bombrole") return onBombRolePick(interaction);
      if (bk === "bombleave") return onBombLeave(interaction);
      if (bk === "cleanyes") return onCleanConfirm(interaction);
      if (bk === "cleanno")  return interaction.update({ content: "Cancelado.", components: [] });
    }
    if (interaction.isButton()) {
      const [k] = interaction.customId.split("|");
      if (k === "time")     return onTimeToggle(interaction);
      if (k === "timeok")   return onTimeConfirm(interaction);
      if (k === "role")     return onRolePick(interaction);
      if (k === "calleryes") return onCallerYes(interaction);
      if (k === "callerno")  return onCallerNo(interaction);
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
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("bombweapon|"))
      return onBombWeaponPick(interaction);
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
    const chunks = rosterChunks([]);
    const ids = [];
    for (const c of chunks) { const m = await thread.send({ content: c }); ids.push(m.id); }
    await db.setRosterMsg(ev.id, ids.join(","));
    created.push(`• **${time}** → ${thread}`);
    await logStaff(interaction.guild, `🆕 CTA **${time} UTC** criado por <@${callerId}>.`);
    await postBombPing(interaction.guild, ev, time); // aviso no bomb-ping
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
  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(leave, montar));
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
  const username = interaction.member?.displayName || interaction.user.username;

  // grava a inscrição (sem vaga) e realoca TODO MUNDO de forma ótima
  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon, presence,
    partyIndex: null, slotIndex: null,
  });
  const myLoc = await applyReallocation(ev, interaction.guild, interaction.user.id);

  // se escolheu arma de caller E é quem criou o CTA -> pergunta se é o caller
  const CALLER_WEAPONS = ["GOLEM", "MAÇA DE UMA MÃO", "BRUXO DE UMA MÃO"];
  if (CALLER_WEAPONS.includes(weapon.toUpperCase()) && interaction.user.id === ev.caller_id) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`calleryes|${eventId}|${encodeURIComponent(weapon)}`)
        .setLabel("👑 Sim, sou o caller").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`callerno|${eventId}`)
        .setLabel("Não, sou jogador normal").setStyle(ButtonStyle.Secondary),
    );
    return interaction.editReply({
      content: `Você escolheu **${weapon}**. Você é o **caller** deste CTA?`,
      components: [row],
    });
  }

  const dest = myLoc ? `Party ${myLoc.partyIndex + 1} (vaga ${myLoc.slotIndex + 1})` : "RESERVA";
  const pres = presence === "online" ? "🟢 já ON" : "🕐 entra no horário";
  await logStaff(interaction.guild, `➕ **${username}** entrou de **${weapon}** → ${dest} · ${pres} · CTA ${ev.time_label}`);

  const msg = myLoc
    ? `✅ Fechado! **Party ${myLoc.partyIndex + 1}**, vaga ${myLoc.slotIndex + 1} (${weapon}).`
    : `📝 Anotado como **reserva** (${weapon}) — sem vaga nem por afinidade.`;
  await interaction.editReply({ content: msg, components: [] });
}

// ==========================================================================
// REALOCAÇÃO: roda o solver em todos, persiste mudanças, notifica quem moveu.
// Retorna a posição do usuário `focusUserId` (pra mensagem de confirmação dele).
// Notificação com DEBOUNCE POR PESSOA (não spamma no pico).
// ==========================================================================
const notifyTimers = new Map();   // eventId:userId -> timeout
const notifyPending = new Map();  // eventId:userId -> {guild, threadId, text}

async function applyReallocation(ev, guild, focusUserId) {
  const signups = await db.getSignups(ev.id);
  const result = reallocate(signups); // [{user_id, partyIndex, slotIndex, moved, ...}]

  // persiste só quem mudou de vaga
  let focusLoc = null;
  for (const r of result) {
    if (r.user_id === focusUserId)
      focusLoc = r.partyIndex != null ? { partyIndex: r.partyIndex, slotIndex: r.slotIndex } : null;
    if (r.moved) {
      await db.moveSignupToSlot(ev.id, r.user_id, r.partyIndex, r.slotIndex);
      // notifica quem foi movido (menos quem acabou de entrar — esse recebe a confirmação normal)
      if (r.user_id !== focusUserId) {
        const to = r.partyIndex != null
          ? `**Party ${r.partyIndex + 1}**, vaga ${r.slotIndex + 1} (${r.weapon})`
          : `**reserva**`;
        scheduleNotify(ev, guild, r.user_id, `🔄 <@${r.user_id}> você foi remanejado para ${to}.`);
      }
    }
  }
  refreshRoster(ev); // atualiza a planilha (já tem debounce próprio)
  return focusLoc;
}

// agenda uma notificação de remanejamento com debounce por pessoa (3s).
// se a pessoa for movida de novo antes de 3s, a msg é substituída pela mais recente.
function scheduleNotify(ev, guild, userId, text) {
  const key = `${ev.id}:${userId}`;
  notifyPending.set(key, { threadId: ev.thread_id, text });
  if (notifyTimers.has(key)) return;
  const t = setTimeout(async () => {
    notifyTimers.delete(key);
    const pend = notifyPending.get(key);
    notifyPending.delete(key);
    if (!pend || !pend.threadId) return;
    const thread = await client.channels.fetch(pend.threadId).catch(() => null);
    if (thread) await thread.send({ content: pend.text }).catch(() => {});
  }, 3000);
  notifyTimers.set(key, t);
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
  await applyReallocation(ev, interaction.guild, null); // realoca: reserva pode subir pra vaga livre
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




// respondeu "sim, sou o caller" -> move pra v1 da pt1
async function onCallerYes(interaction) {
  const [, eventId, wEnc] = interaction.customId.split("|");
  const weapon = decodeURIComponent(wEnc);
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.update({ content: "CTA não está aberto.", components: [] });
  if (interaction.user.id !== ev.caller_id)
    return interaction.update({ content: "Só quem criou o CTA é o caller.", components: [] });
  await interaction.deferUpdate();
  const username = interaction.member?.displayName || interaction.user.username;
  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon, presence: "online",
    partyIndex: 0, slotIndex: 0,
  });
  await interaction.editReply({ content: `👑 Você é o caller — **${weapon}** na PT1 vaga 1.`, components: [] });
  await applyReallocation(ev, interaction.guild, null); // realoca o resto após o caller assumir
  await logStaff(interaction.guild, `👑 **${username}** assumiu caller (${weapon}) · CTA ${ev.time_label}`);
}

// respondeu "não sou caller" -> mantém o encaixe normal que já foi feito
async function onCallerNo(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  const su = ev ? await db.getSignup(eventId, interaction.user.id) : null;
  const dest = su && su.party_index != null
    ? `Party ${su.party_index + 1} (vaga ${su.slot_index + 1})`
    : "RESERVA";
  await interaction.update({ content: `👍 Beleza. Você está em ${dest}.`, components: [] });
}


// ==================  SLASH COMMANDS  ======================================
async function onSlash(interaction) {
  if (!cmds.isStaff(interaction))
    return interaction.reply({ content: "Só Mestre de Guerra usa esses comandos.", flags: MessageFlags.Ephemeral });

  const name = interaction.commandName;
  const timeLabel = interaction.options.getString("cta");
  const ev = await db.getOpenEventByTime(interaction.guildId, timeLabel);
  if (!ev) return interaction.reply({ content: `Não achei um CTA aberto às ${timeLabel}.`, flags: MessageFlags.Ephemeral });

  if (name === "cta_remove") return slashRemove(interaction, ev);
  if (name === "cta_clean")  return slashClean(interaction, ev);
  if (name === "cta_move")   return slashMoveOrAdd(interaction, ev, false);
  if (name === "cta_add")    return slashMoveOrAdd(interaction, ev, true);
}

async function slashRemove(interaction, ev) {
  const user = interaction.options.getUser("usuario");
  const removed = await db.deleteSignup(ev.id, user.id);
  if (!removed) return interaction.reply({ content: `${user} não estava no CTA.`, flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: `🗑️ ${user} removido do CTA ${ev.time_label}.` });
  refreshRoster(ev);
  await logStaff(interaction.guild, `🗑️ ${interaction.user} removeu ${user} · CTA ${ev.time_label}`);
}

async function slashClean(interaction, ev) {
  const pt = interaction.options.getInteger("pt");
  const signups = await db.getSignups(ev.id);
  const naPt = signups.filter((s) => s.party_index === pt - 1).length;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cleanyes|${ev.id}|${pt}`).setLabel(`Sim, limpar PT${pt}`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cleanno|${ev.id}`).setLabel("Não").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ content: `⚠️ Limpar a **PT${pt}** do CTA ${ev.time_label}? Vai tirar **${naPt}** pessoa(s).`, components: [row], flags: MessageFlags.Ephemeral });
}

async function onCleanConfirm(interaction) {
  const [, eventId, pt] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.update({ content: "CTA não encontrado.", components: [] });
  const n = await db.clearParty(eventId, parseInt(pt, 10) - 1);
  await interaction.update({ content: `🧹 PT${pt} limpa — ${n} pessoa(s) removida(s).`, components: [] });
  refreshRoster(ev);
  await logStaff(interaction.guild, `🧹 ${interaction.user} limpou a PT${pt} (${n} pessoas) · CTA ${ev.time_label}`);
}

// move (add=false) ou adiciona (add=true) alguém numa vaga
async function slashMoveOrAdd(interaction, ev, isAdd) {
  const user = interaction.options.getUser("usuario");
  const pt = interaction.options.getInteger("pt");
  const vaga = interaction.options.getInteger("vaga");
  const arma = interaction.options.getString("arma");

  const signups = await db.getSignups(ev.id);
  const existing = signups.find((s) => s.user_id === user.id);

  if (!isAdd && !existing)
    return interaction.reply({ content: `${user} não está inscrito. Use /cta_add pra adicionar.`, flags: MessageFlags.Ephemeral });
  if (isAdd && existing)
    return interaction.reply({ content: `${user} já está no CTA. Use /cta_move pra mover.`, flags: MessageFlags.Ephemeral });
  if (isAdd && !arma)
    return interaction.reply({ content: "Pra adicionar, informe a **arma**.", flags: MessageFlags.Ephemeral });

  const others = signups.filter((s) => s.user_id !== user.id);
  const target = cmds.resolveTargetSlot(pt - 1, vaga, arma, others);
  if (!target) return interaction.reply({ content: `A PT${pt} está cheia.`, flags: MessageFlags.Ephemeral });

  // vaga ocupada? pergunta interativa
  const occupant = await db.getSignupAtSlot(ev.id, target.partyIndex, target.slotIndex);
  const weaponToUse = arma || (existing ? existing.weapon : null);

  if (occupant && occupant.user_id !== user.id) {
    // guarda a operação no customId pra resolver após a escolha
    const payload = `${ev.id}|${user.id}|${target.partyIndex}|${target.slotIndex}|${encodeURIComponent(weaponToUse || "")}|${isAdd ? 1 : 0}|${existing ? existing.party_index : ""}|${existing ? existing.slot_index : ""}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`occ|reserva|${payload}`).setLabel(`${occupant.username} → reserva`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`occ|swap|${payload}`).setLabel(`Trocar de lugar`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`occ|cancel|${payload}`).setLabel("Cancelar").setStyle(ButtonStyle.Danger),
    );
    return interaction.reply({
      content: `⚠️ PT${target.partyIndex + 1} v${target.slotIndex + 1} está com **${occupant.username}**. O que fazer com ${occupant.username}?`,
      components: [row], flags: MessageFlags.Ephemeral,
    });
  }

  // vaga livre: executa direto
  await placeUser(ev.id, user.id, interaction, weaponToUse, target, isAdd);
  await interaction.reply({ content: `✅ ${user} → PT${target.partyIndex + 1} v${target.slotIndex + 1}${weaponToUse ? ` (${weaponToUse})` : ""}.` });
  refreshRoster(ev);
  await logStaff(interaction.guild, `🔧 ${interaction.user} ${isAdd ? "adicionou" : "moveu"} ${user} → PT${target.partyIndex + 1} v${target.slotIndex + 1} · CTA ${ev.time_label}`);
}

// coloca o usuário na vaga (add cria signup; move atualiza)
async function placeUser(eventId, userId, interaction, weapon, target, isAdd) {
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const username = member?.displayName || "jogador";
  await db.upsertSignup({
    eventId, userId, username, weapon: weapon || "?", presence: "online",
    partyIndex: target.partyIndex, slotIndex: target.slotIndex,
  });
}

// resolve a pergunta interativa do ocupante
async function onOccupantChoice(interaction) {
  const parts = interaction.customId.split("|");
  const choice = parts[1];
  const [eventId, userId, tp, ts, wEnc, addFlag, oldP, oldS] = parts.slice(2);
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.update({ content: "CTA não encontrado.", components: [] });
  if (choice === "cancel") return interaction.update({ content: "Operação cancelada.", components: [] });

  const target = { partyIndex: parseInt(tp, 10), slotIndex: parseInt(ts, 10) };
  const weapon = decodeURIComponent(wEnc) || "?";
  const occupant = await db.getSignupAtSlot(eventId, target.partyIndex, target.slotIndex);

  if (choice === "reserva" && occupant) {
    // ocupante vai pra reserva (party/slot null)
    await db.upsertSignup({ eventId, userId: occupant.user_id, username: occupant.username, weapon: occupant.weapon, presence: occupant.presence, partyIndex: null, slotIndex: null });
  }
  if (choice === "swap" && occupant) {
    // ocupante vai pra vaga de onde o movido veio (se veio de alguma)
    const toP = oldP === "" ? null : parseInt(oldP, 10);
    const toS = oldS === "" ? null : parseInt(oldS, 10);
    await db.upsertSignup({ eventId, userId: occupant.user_id, username: occupant.username, weapon: occupant.weapon, presence: occupant.presence, partyIndex: toP, slotIndex: toS });
  }
  // coloca o movido/adicionado na vaga alvo
  await placeUser(eventId, userId, interaction, weapon, target, addFlag === "1");
  await interaction.update({ content: `✅ Feito. Vaga PT${target.partyIndex + 1} v${target.slotIndex + 1} atualizada.`, components: [] });
  refreshRoster(ev);
  await logStaff(interaction.guild, `🔧 ${interaction.user} resolveu troca (${choice}) · CTA ${ev.time_label}`);
}


// ==================  BOMB — FASE A (contagem)  ============================
async function postBombPing(guild, ev, time) {
  if (!CFG.bombPingChannelId) return;
  const ch = await client.channels.fetch(CFG.bombPingChannelId).catch(() => null);
  if (!ch) return;
  const roleMention = CFG.bombRoleId ? `<@&${CFG.bombRoleId}>` : "@Bomb";
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bombyes|${ev.id}`).setLabel("Sim, vou").setEmoji("💣").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`bombno|${ev.id}`).setLabel("Não vou").setStyle(ButtonStyle.Secondary),
  );
  const msg = await ch.send({
    content: `${roleMention} 💣 **BOMB** — Vai no CTA das **${time} UTC** hoje?`,
    components: [row],
  });
  // thread de contagem pro líder do bomb
  const thread = await msg.startThread({ name: `Bomb ${time} — contagem`, autoArchiveDuration: 1440 }).catch(() => null);
  if (thread) {
    await db.setBombThread(ev.id, thread.id);
    const leader = CFG.bombLeaderRoleId ? `<@&${CFG.bombLeaderRoleId}>` : "Líder do Bomb";
    await thread.send({ content: `${leader} contagem do bomb pro CTA ${time}:` });
    const c = await thread.send({ content: bombCountText([]) });
    await db.setBombRoster(ev.id, c.id); // guarda id da msg de contagem no banco
    // botões pro Líder do Bomb escolher a comp (Fase B)
    const compRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bombcomp|${ev.id}|invi`).setLabel("Montar Invi").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bombcomp|${ev.id}|melee`).setLabel("Montar Melee").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bombcomp|${ev.id}|kite`).setLabel("Kite (só lista)").setStyle(ButtonStyle.Secondary),
    );
    await thread.send({ content: "👑 **Líder do Bomb**, escolhe a composição:", components: [compRow] });
  }
}

function bombCountText(confirms) {
  const vem = confirms.filter((c) => c.coming);
  const nao = confirms.filter((c) => !c.coming);
  let t = `💣 **Confirmados: ${vem.length}**\n`;
  if (vem.length) t += vem.map((c) => `• ${c.username}`).join("\n");
  if (nao.length) t += `\n\n❌ Não vêm: ${nao.map((c) => c.username).join(", ")}`;
  return t.slice(0, 1900);
}

async function onBombConfirm(interaction, coming) {
  const [, eventId] = interaction.customId.split("|");
  // só cargo Bomb responde
  if (CFG.bombRoleId && !interaction.member?.roles?.cache?.has(CFG.bombRoleId))
    return interaction.reply({ content: "Só quem tem o cargo Bomb responde aqui.", flags: MessageFlags.Ephemeral });
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open")
    return interaction.reply({ content: "Esse CTA não está mais aberto.", flags: MessageFlags.Ephemeral });

  const username = interaction.member?.displayName || interaction.user.username;
  await db.upsertBombConfirm(eventId, interaction.user.id, username, coming);
  await interaction.reply({ content: coming ? "💣 Confirmado! Você vai." : "Ok, anotado que não vai.", flags: MessageFlags.Ephemeral });

  // atualiza a contagem na thread (id da msg vem do banco -> sobrevive a restart)
  const confirms = await db.getBombConfirms(eventId);
  const fresh = await db.getEvent(eventId);
  if (fresh.bomb_thread && fresh.bomb_roster) {
    const countMsgId = String(fresh.bomb_roster).split(",")[0]; // 1º id = contagem
    const thread = await client.channels.fetch(fresh.bomb_thread).catch(() => null);
    if (thread) {
      const m = await thread.messages.fetch(countMsgId).catch(() => null);
      if (m) await m.edit({ content: bombCountText(confirms) }).catch(() => {});
    }
  }
}

// ==================  BOMB — FASE B (montagem)  ============================
// Líder do Bomb escolhe a comp. Kite só lista; Invi/Melee montam planilha.
async function onBombCompChoice(interaction) {
  const [, eventId, comp] = interaction.customId.split("|");
  // só o Líder do Bomb
  if (CFG.bombLeaderRoleId && !interaction.member?.roles?.cache?.has(CFG.bombLeaderRoleId))
    return interaction.reply({ content: "Só o Líder do Bomb escolhe a composição.", flags: MessageFlags.Ephemeral });
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });

  const confirms = (await db.getBombConfirms(eventId)).filter((c) => c.coming);

  if (comp === "kite") {
    if (confirms.length < KITE_MIN)
      return interaction.reply({ content: `Kite precisa de pelo menos ${KITE_MIN} confirmados (tem ${confirms.length}).`, flags: MessageFlags.Ephemeral });
    await db.setBombComp(eventId, "kite");
    const nomes = confirms.map((c) => `• ${c.username}`).join("\n") || "(ninguém)";
    return interaction.reply({ content: `🪁 **KITE COMP** — ${confirms.length} confirmados. O caller organiza na mão:\n${nomes}`.slice(0, 1900) });
  }

  // invi ou melee: monta a planilha do bomb
  await db.setBombComp(eventId, comp);
  await interaction.reply({ content: `💣 Montando **${BOMB_COMPS[comp].name}**...`, flags: MessageFlags.Ephemeral });
  const thread = await client.channels.fetch(ev.bomb_thread).catch(() => null);
  if (!thread) return;

  const roleMention = CFG.bombRoleId ? `<@&${CFG.bombRoleId}>` : "@Bomb";
  await thread.send({
    content: `${roleMention} 💣 **${BOMB_COMPS[comp].name}** — escolhe tua arma pra entrar:`,
    components: buildBombRolePicker(eventId),
  });
  const msg = await thread.send({ content: bombRosterText(eventId, comp, []) });
  await db.setBombRoster(eventId, `${ev.bomb_roster},${msg.id}`); // guarda: contagem,planilha
}

// botões de papel pra inscrição no bomb (reusa os papéis)
function buildBombRolePicker(eventId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) =>
    new ButtonBuilder().setCustomId(`bombrole|${eventId}|${name}`).setLabel(name).setEmoji(meta.emoji).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`bombleave|${eventId}`).setLabel("Sair").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(leave));
  return rows;
}

// renderiza a planilha do bomb
function bombRosterText(eventId, comp, signups) {
  const slots = BOMB_COMPS[comp].slots;
  const bySlot = new Map();
  const reserves = [];
  for (const su of signups) {
    if (su.slot_index != null) bySlot.set(su.slot_index, su);
    else reserves.push(su);
  }
  let filled = 0;
  const lines = slots.map((slot, i) => {
    const su = bySlot.get(i);
    const n = String(i + 1).padStart(2, "0");
    if (su) { filled++; return `\`${n}\` ${su.weapon} — **${su.username}**`; }
    const label = slot.locked ? "👑 CALLER" : slot.accepts.map((a) => a.weapon).join(" / ");
    return `\`${n}\` ${label} — *vazio*`;
  });
  let t = `💣 **${BOMB_COMPS[comp].name}** (${filled}/${slots.length})\n` + lines.join("\n");
  if (reserves.length) t += `\n\n**Reserva:** ` + reserves.map((r) => `${r.username}(${r.weapon})`).join(", ");
  return t.slice(0, 1990);
}

// arma do bomb: papel -> menu de armas (só as que existem na comp escolhida)
async function onBombRolePick(interaction) {
  const [, eventId, role] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || !ev.bomb_comp) return interaction.reply({ content: "Bomb não está montado.", flags: MessageFlags.Ephemeral });
  // armas daquele papel que aparecem na comp do bomb
  const slots = BOMB_COMPS[ev.bomb_comp].slots;
  const armas = [...new Set(slots.flatMap((s) => s.accepts).filter((a) => (WEAPON_CATALOG[role] || []).includes(a.weapon)).map((a) => a.weapon))];
  if (!armas.length) return interaction.reply({ content: "Nenhuma arma desse papel nessa comp.", flags: MessageFlags.Ephemeral });
  const menu = new StringSelectMenuBuilder().setCustomId(`bombweapon|${eventId}`)
    .setPlaceholder(`Tua arma de ${role}`).addOptions(armas.slice(0, 25).map((w) => ({ label: w, value: w })));
  await interaction.reply({ content: `Escolhe tua arma (${role}):`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}

async function onBombWeaponPick(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const weapon = interaction.values[0];
  const ev = await db.getEvent(eventId);
  if (!ev || !ev.bomb_comp) return interaction.update({ content: "Bomb não está montado.", components: [] });
  await interaction.deferUpdate();
  const username = interaction.member?.displayName || interaction.user.username;

  // acha vaga livre pra essa arma na comp do bomb
  const signups = await db.getBombSignups(eventId);
  const others = signups.filter((s) => s.user_id !== interaction.user.id);
  const taken = new Set(others.filter((s) => s.slot_index != null).map((s) => s.slot_index));
  const slots = BOMB_COMPS[ev.bomb_comp].slots;
  let slotIndex = null;
  for (let i = 0; i < slots.length; i++) {
    if (taken.has(i) || slots[i].locked) continue;
    if (slots[i].accepts.some((a) => a.weapon.toUpperCase() === weapon.toUpperCase())) { slotIndex = i; break; }
  }
  await db.upsertBombSignup(eventId, interaction.user.id, username, weapon, slotIndex);
  await refreshBombRoster(ev);
  const msg = slotIndex != null ? `✅ Você entrou como **${weapon}** (vaga ${slotIndex + 1}).` : `📝 Reserva (${weapon}) — sem vaga.`;
  await interaction.editReply({ content: msg, components: [] });
}

async function onBombLeave(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  const removed = await db.deleteBombSignup(eventId, interaction.user.id);
  if (!removed) return interaction.reply({ content: "Você não estava na comp do bomb.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "🚪 Saiu da comp do bomb.", flags: MessageFlags.Ephemeral });
  await refreshBombRoster(ev);
}

// atualiza a planilha do bomb (a msg é a 2ª guardada em bomb_roster: "contagem,planilha")
async function refreshBombRoster(ev) {
  const fresh = await db.getEvent(ev.id);
  if (!fresh.bomb_thread || !fresh.bomb_roster || !fresh.bomb_comp) return;
  const ids = String(fresh.bomb_roster).split(",");
  const planilhaId = ids[1]; // segundo id = planilha de montagem
  if (!planilhaId) return;
  const thread = await client.channels.fetch(fresh.bomb_thread).catch(() => null);
  if (!thread) return;
  const m = await thread.messages.fetch(planilhaId).catch(() => null);
  if (!m) return;
  const signups = await db.getBombSignups(ev.id);
  await m.edit({ content: bombRosterText(ev.id, fresh.bomb_comp, signups) }).catch(() => {});
}

// ======================  HELPERS  ==========================================
// 1 mensagem por PT (4 mensagens) pra nunca estourar 2000, mesmo com nomes longos.
// A reserva (se houver) vai junto na ultima mensagem.
function rosterChunks(signups) {
  const blocks = renderRoster(signups); // [PT1, PT2, PT3, PT4, (Reserva?)]
  const NUM_PT = 4;
  const chunks = [];
  for (let i = 0; i < NUM_PT; i++) {
    let txt = blocks[i] || "";
    // reserva (bloco extra) gruda na ultima PT
    if (i === NUM_PT - 1 && blocks.length > NUM_PT) {
      txt += "\n\n" + blocks.slice(NUM_PT).join("\n\n");
    }
    chunks.push(txt.slice(0, 1990));
  }
  return chunks; // 4 strings
}

// ---- DEBOUNCE da planilha ao vivo ----
// Em vez de editar a cada inscrição, agrupa as mudanças e edita no maximo
// 1x a cada 3s por evento. Protege contra rate limit no pico de inscricoes.
const REFRESH_DELAY = 3000;
const refreshTimers = new Map();   // eventId -> timeout
const refreshPending = new Map();  // eventId -> ev (mais recente)

function refreshRoster(ev) {
  // guarda o ev mais recente e agenda (ou reusa o timer existente)
  refreshPending.set(String(ev.id), ev);
  if (refreshTimers.has(String(ev.id))) return; // ja tem edicao agendada
  const t = setTimeout(async () => {
    refreshTimers.delete(String(ev.id));
    const target = refreshPending.get(String(ev.id));
    refreshPending.delete(String(ev.id));
    if (target) await doRefreshRoster(target).catch((e) => console.error("refresh:", e));
  }, REFRESH_DELAY);
  refreshTimers.set(String(ev.id), t);
}

// edição real das mensagens (chamada pelo debounce)
async function doRefreshRoster(ev) {
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
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Online como ${c.user.tag}`);
  setInterval(checkReminders, 60 * 1000); // a cada minuto
  // registra slash commands em cada servidor onde o bot está
  for (const [gid] of c.guilds.cache) {
    try { await cmds.registerCommands(c.user.id, gid); }
    catch (e) { console.error("registerCommands:", e); }
  }
});

(async () => { await db.init(); await client.login(CFG.token); })();
