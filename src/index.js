// ============================================================================
// BOT CTA — IMORTAIS  |  Fase 1
// ============================================================================
const {
  Client, GatewayIntentBits, Partials, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");

const db = require("./db");
const { ROLES, WEAPONS, WEAPON_CATALOG, BOMB_COMPS, KITE_MIN } = require("./comps");
const { findBestSlot, suggestUpgrade, renderRoster, reallocate, consolidate } = require("./roster");
const cmds = require("./commands");
const attendance = require("./attendance");
const roaming = require("./roaming");
const castelo = require("./castelo");
const CALLER_TAG_ID = process.env.CALLER_TAG_ID || "1088448632023437362";
const ROAMING_CATEGORY_ID = process.env.ROAMING_CATEGORY_ID || "1055337071067275284";

const CFG = {
  token: process.env.DISCORD_TOKEN,
  ctaChannelId: process.env.CTA_CHANNEL_ID,
  imortalRoleId: process.env.IMORTAL_ROLE_ID,
  staffLogChannelId: process.env.STAFF_LOG_CHANNEL_ID || null,
  bombPingChannelId: process.env.BOMB_PING_CHANNEL_ID || null,
  bombRoleId: process.env.BOMB_ROLE_ID || null,
  bombLeaderRoleId: process.env.BOMB_LEADER_ROLE_ID || null,
  prepVoiceId: process.env.PREP_VOICE_ID || null,
  contentPingChannelId: process.env.CONTENT_PING_CHANNEL_ID || "1045114655128944640",
  bombVoiceId: process.env.BOMB_VOICE_ID || null,
  presetTimes: (process.env.PRESET_TIMES || "15:20,17:20,19:20,21:20,00:00,01:20").split(","),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

function catalog(role) { return WEAPON_CATALOG[role] || []; }

function timeToTodayUTC(label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    parseInt(m[1], 10), parseInt(m[2], 10), 0, 0));
}

// ======================  1) GATILHO  =======================================
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId === CFG.ctaChannelId) {
      await msg.reply({
        content: `🗡️ **CTA detectado.** ${msg.author}, escolhe os horários (UTC / horário do jogo):`,
        components: buildTimePicker(new Set(), msg.author.id),
      });
      return;
    }
    if (msg.channel?.isThread?.()) await onThreadText(msg);
  } catch (e) { console.error("trigger:", e); }
});

const ROLE_WORDS = {
  tank: "Tank",
  sup: "Support", suporte: "Support", support: "Support",
  dps: "Melee", melee: "Melee",
  range: "Ranged", ranged: "Ranged",
  heal: "Healer", healer: "Healer", cura: "Healer",
  loot: "Looter", looter: "Looter",
};

function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

async function onThreadText(msg) {
  const text = norm(msg.content);
  if (!text || text.length > 40) return;
  const words = text.split(/\s+/);
  if (words.length > 4) return;

  const ev = await db.getEventByThread(msg.channelId);
  if (ev && ev.status === "open") {
    const weapons = Object.keys(WEAPONS);
    let matchedWeapon = null;
    for (const w of weapons) {
      if (norm(w) === text || text.includes(norm(w))) { matchedWeapon = w; break; }
    }
    if (matchedWeapon) { await msg.delete().catch(() => {}); return startSignupFromText(msg, ev, null, matchedWeapon); }
    for (const word of words) {
      if (ROLE_WORDS[word]) { await msg.delete().catch(() => {}); return startSignupFromText(msg, ev, ROLE_WORDS[word], null); }
    }
    if (/^\d{1,2}$/.test(text)) {
      const vaga = parseInt(text, 10);
      if (vaga >= 1 && vaga <= 20) { await msg.delete().catch(() => {}); return startSignupFromSlotNumber(msg, ev, vaga); }
    }
    return;
  }

  // não é CTA — tenta CASTELO
  const cast = await db.getCasteloByThread(msg.channelId);
  if (cast && cast.status !== "pago" && cast.status !== "fechado") {
    return onCasteloText(msg, cast, text, words);
  }
}

// reconhecimento de texto no castelo: arma, papel, ou número de vaga
async function onCasteloText(msg, cast, text, words) {
  const weapons = Object.keys(WEAPONS);
  // 1) nome de arma
  let matchedWeapon = null;
  for (const w of weapons) {
    if (norm(w) === text || text.includes(norm(w))) { matchedWeapon = w; break; }
  }
  if (matchedWeapon) { await msg.delete().catch(() => {}); return casteloSignupWeapon(msg, cast, matchedWeapon); }
  // 2) papel
  for (const word of words) {
    if (ROLE_WORDS[word]) { await msg.delete().catch(() => {}); return casteloSignupRole(msg, cast, ROLE_WORDS[word]); }
  }
  // 3) número de vaga (1-20): junta armas cabíveis naquela posição nas 3 PTs do castelo
  if (/^\d{1,2}$/.test(text)) {
    const vaga = parseInt(text, 10);
    if (vaga >= 1 && vaga <= 20) { await msg.delete().catch(() => {}); return casteloSignupSlotNumber(msg, cast, vaga); }
  }
}

// encaixa direto uma arma no castelo (via engine)
async function casteloSignupWeapon(msg, cast, weapon) {
  const username = msg.member?.displayName || msg.author.username;
  await db.upsertCasteloSignup({ casteloId: cast.id, userId: msg.author.id, username, weapon, presence: "online", partyIndex: null, slotIndex: null });
  const loc = await applyCasteloReallocation(cast, msg.author.id);
  const txt = loc
    ? `✅ ${msg.author}, você entrou de **${weapon}** no castelo (Party ${castelo.CASTELO_PT_INDEX.indexOf(loc.partyIndex)+1}, vaga ${loc.slotIndex+1}).`
    : `📝 ${msg.author}, **${weapon}** anotado como reserva no castelo.`;
  await msg.channel.send({ content: txt }).catch(() => {});
}
// abre menu de armas do papel no castelo
async function casteloSignupRole(msg, cast, role) {
  const armas = WEAPON_CATALOG[role] || [];
  if (!armas.length) return;
  const menu = new StringSelectMenuBuilder().setCustomId(`cweapon|${cast.id}|${msg.author.id}`)
    .setPlaceholder(`Tua arma de ${role}`).addOptions(armas.slice(0, 25).map((w) => ({ label: w, value: w })));
  await msg.channel.send({ content: `${msg.author}, escolhe tua arma (${role}):`, components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
}
// número de vaga no castelo: lista armas cabíveis naquela posição nas 3 PTs
async function casteloSignupSlotNumber(msg, cast, vaga) {
  const idx = vaga - 1;
  const armasSet = new Set();
  for (const p of castelo.CASTELO_PT_INDEX) {
    const slot = castelo.casteloSlot(castelo.CASTELO_PT_INDEX.indexOf(p), idx);
    if (!slot || slot.locked) continue;
    for (const a of slot.accepts) armasSet.add(a.weapon);
  }
  const armas = [...armasSet];
  if (!armas.length) { await msg.channel.send({ content: `${msg.author}, a vaga ${vaga} não tem armas pra escolher.` }).catch(() => {}); return; }
  const menu = new StringSelectMenuBuilder().setCustomId(`cweapon|${cast.id}|${msg.author.id}`)
    .setPlaceholder(`Arma da vaga ${vaga}`).addOptions(armas.slice(0, 25).map((w) => ({ label: w, value: w })));
  await msg.channel.send({ content: `${msg.author}, a vaga **${vaga}** aceita estas armas — escolhe a tua:`, components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
}

async function startSignupFromText(msg, ev, role, weapon) {
  if (role === "Looter") {
    const username = msg.member?.displayName || msg.author.username;
    await db.upsertSignup({ eventId: ev.id, userId: msg.author.id, username, weapon: "LOOTER", presence: "online", partyIndex: null, slotIndex: null, ip: null });
    await applyReallocationMsg(ev, msg.guild);
    await msg.channel.send({ content: `💰 ${msg.author}, você entrou como **Looter**.` }).catch(() => {});
    return;
  }
  if (weapon) {
    const role2 = WEAPONS[weapon]?.role;
    const IP_WEAPONS = ["URSINAS", "CRAVADAS"];
    if (IP_WEAPONS.includes(weapon.toUpperCase())) {
      await msg.channel.send({ content: `${msg.author}, **${weapon}** precisa do IP. Clica no botão **${role2}** na planilha acima pra escolher e informar o IP.` }).catch(() => {});
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`presence|${ev.id}|online|${weapon}|0|${msg.author.id}`).setLabel("Já estou ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`presence|${ev.id}|later|${weapon}|0|${msg.author.id}`).setLabel("Entro no horário").setEmoji("🕐").setStyle(ButtonStyle.Secondary),
    );
    await msg.channel.send({ content: `${msg.author}, **${weapon}** — e aí, presença?`, components: [row] }).catch(() => {});
    return;
  }
  const armas = WEAPON_CATALOG[role] || [];
  if (!armas.length) return;
  const menu = new StringSelectMenuBuilder().setCustomId(`weapon|${ev.id}|${msg.author.id}`)
    .setPlaceholder(`Tua arma de ${role}`).addOptions(armas.slice(0, 25).map((w) => ({ label: w, value: w })));
  await msg.channel.send({ content: `${msg.author}, escolhe tua arma (${role}):`, components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
}

async function startSignupFromSlotNumber(msg, ev, vaga) {
  const idx = vaga - 1;
  const { PARTIES } = require("./comps");
  const armasSet = new Set();
  for (let p = 0; p < PARTIES.length; p++) {
    const slot = PARTIES[p].slots[idx];
    if (!slot || slot.locked) continue;
    for (const a of slot.accepts) armasSet.add(a.weapon);
  }
  const armas = [...armasSet];
  if (!armas.length) {
    await msg.channel.send({ content: `${msg.author}, a vaga ${vaga} não tem armas pra escolher (ou é a vaga do caller).` }).catch(() => {});
    return;
  }
  const menu = new StringSelectMenuBuilder().setCustomId(`weapon|${ev.id}|${msg.author.id}`)
    .setPlaceholder(`Arma da vaga ${vaga}`).addOptions(armas.slice(0, 25).map((w) => ({ label: w, value: w })));
  await msg.channel.send({ content: `${msg.author}, a vaga **${vaga}** aceita estas armas — escolhe a tua:`, components: [new ActionRowBuilder().addComponents(menu)] }).catch(() => {});
}

async function applyReallocationMsg(ev, guild) {
  const fresh = (await db.getEvent(ev.id)) || ev;
  const numParties = fresh.num_parties || 4;
  const signups = await db.getSignups(fresh.id);
  const result = reallocate(signups, numParties);
  for (const r of result) {
    if (r.moved) await db.moveSignupToSlot(fresh.id, r.user_id, r.partyIndex, r.slotIndex);
  }
  refreshRoster(fresh);
}

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

// ======================  PRESENÇA EM CALL ==================================
function voiceKind(channelId) {
  if (channelId && channelId === CFG.prepVoiceId) return "prep";
  if (channelId && channelId === CFG.bombVoiceId) return "bomb";
  return null;
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const oldCh = oldState.channelId;
    const newCh = newState.channelId;
    if (oldCh === newCh) return;

    const member = newState.member || oldState.member;
    const username = member?.displayName || member?.user?.username || "?";
    const guildId = (newState.guild || oldState.guild).id;

    const oldKind = voiceKind(oldCh);
    if (oldKind) await db.voiceLeave(member.id, oldCh);

    const newKind = voiceKind(newCh);
    if (newKind) await db.voiceJoin(guildId, member.id, username, newCh, newKind);

    const roamings = await db.getOpenRoamings(guildId).catch(() => []);
    for (const r of roamings) {
      if (r.status !== "contando" || !r.voice_id) continue;
      if (oldCh === r.voice_id) await db.roamingVoiceLeave(r.id, member.id);
      if (newCh === r.voice_id) await db.roamingVoiceJoin(r.id, member.id, username);
    }
    const castelos = await db.getOpenCastelos(guildId).catch(() => []);
    for (const c of castelos) {
      if (c.status !== "contando" || !c.voice_id) continue;
      if (oldCh === c.voice_id) await db.casteloVoiceLeave(c.id, member.id);
      if (newCh === c.voice_id) await db.casteloVoiceJoin(c.id, member.id, username);
    }
  } catch (e) { console.error("voiceState:", e); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return cmds.handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return onSlash(interaction);
    if (interaction.isButton()) {
      const [bk] = interaction.customId.split("|");
      if (bk === "occ") return onOccupantChoice(interaction);
      if (bk === "bombyes") return onBombConfirm(interaction, true);
      if (bk === "bombno")  return onBombConfirm(interaction, false);
      if (bk === "bombcomp") return onBombCompChoice(interaction);
      if (bk === "bombrole") return onBombRolePick(interaction);
      if (bk === "bombleave") return onBombLeave(interaction);
      if (bk === "rmf") return onRoamingRolePick(interaction);
      if (bk === "rmleave") return onRoamingLeave(interaction);
      if (bk === "cleave") return onCasteloLeave(interaction);
      if (bk === "cleanyes") return onCleanConfirm(interaction);
      if (bk === "cleanno")  return interaction.update({ content: "Cancelado.", components: [] });
    }
    if (interaction.isButton()) {
      const [k] = interaction.customId.split("|");
      if (k === "time")     return onTimeToggle(interaction);
      if (k === "timeok")   return onTimeConfirm(interaction);
      if (k === "role") {
        const parts = interaction.customId.split("|");
        if (parts[1] && parts[1].startsWith("c") && /^c\d+$/.test(parts[1])) return onCasteloRolePick(interaction);
        return onRolePick(interaction);
      }
      if (k === "calleryes") return onCallerYes(interaction);
      if (k === "callerno")  return onCallerNo(interaction);
      if (k === "presence") return onPresence(interaction);
      if (k === "looter") return onLooter(interaction);
      if (k === "swapyes")  return onSwapYes(interaction);
      if (k === "swapno")   return onSwapNo(interaction);
      if (k === "leave")    return onLeave(interaction);
      if (k === "cancel")   return onCancel(interaction);
      if (k === "montar")   return onMontar(interaction);
      if (k === "fechar")   return onFechar(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("weapon|"))
      return onWeaponPick(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("ipmodal|"))
      return onIpModal(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("bombweapon|"))
      return onBombWeaponPick(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("cweapon|"))
      return onCasteloWeaponPick(interaction);
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

  times.sort((a, b) => {
    const [ha, ma] = a.split(":").map(Number);
    const [hb, mb] = b.split(":").map(Number);
    return (ha * 60 + ma) - (hb * 60 + mb);
  });

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
    const chunks = rosterChunks([], 4);
    const ids = [];
    for (const c of chunks) { const m = await thread.send({ content: c }); ids.push(m.id); }
    await db.setRosterMsg(ev.id, ids.join(","));
    created.push(`• **${time}** → ${thread}`);
    await logStaff(interaction.guild, `🆕 CTA **${time} UTC** criado por <@${callerId}>.`);
    if (CFG.contentPingChannelId) {
      const cch = await client.channels.fetch(CFG.contentPingChannelId).catch(() => null);
      if (cch) {
        const link = `https://discord.com/channels/${interaction.guildId}/${thread.id}`;
        const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
        await cch.send({ content: `${mention} 🗡️ **Saiu CTA — ${time} UTC!** Loga e pinga tua função.\n👉 ${link}`, ...allow }).catch(() => {});
      }
    }
    await postBombPing(interaction.guild, ev, time);
    await new Promise((r) => setTimeout(r, 1200));
  }
  await interaction.editReply({ content: `✅ Planilha(s):\n${created.join("\n")}`, components: [] });
}

function buildRolePicker(eventId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) => new ButtonBuilder()
    .setCustomId(`role|${eventId}|${name}`).setLabel(name).setEmoji(meta.emoji).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`leave|${eventId}`).setLabel("Sair da função").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const looter = new ButtonBuilder().setCustomId(`looter|${eventId}`).setLabel("Sou Looter").setEmoji("💰").setStyle(ButtonStyle.Secondary);
  const montar = new ButtonBuilder().setCustomId(`montar|${eventId}`).setLabel("Montar PT (caller)").setStyle(ButtonStyle.Success);
  const cancel = new ButtonBuilder().setCustomId(`cancel|${eventId}`).setLabel("Cancelar (caller)").setStyle(ButtonStyle.Danger);
  const fechar = new ButtonBuilder().setCustomId(`fechar|${eventId}`).setLabel("Fechar CTA (caller)").setStyle(ButtonStyle.Secondary);
  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(looter, leave, montar));
  rows.push(new ActionRowBuilder().addComponents(fechar, cancel));
  return rows;
}

async function onRolePick(interaction) {
  const [, eventId, role] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev)
    return interaction.reply({ content: "⚠️ Não achei esse CTA no sistema. Avisa o caller.", flags: MessageFlags.Ephemeral });
  if (ev.status !== "open")
    return interaction.reply({ content: `Esse CTA está **${ev.status === "cancelled" ? "cancelado" : "fechado"}**.`, flags: MessageFlags.Ephemeral });
  const weapons = catalog(role);
  if (!weapons.length) return interaction.reply({ content: "Sem armas nesse papel.", flags: MessageFlags.Ephemeral });
  const menu = new StringSelectMenuBuilder().setCustomId(`weapon|${eventId}`)
    .setPlaceholder(`Tua arma de ${role}`).addOptions(weapons.slice(0, 25).map((w) => ({ label: w, value: w })));
  await interaction.reply({ content: `Escolhe tua arma (${role}):`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}

async function onWeaponPick(interaction) {
  const [, eventId, ownerId] = interaction.customId.split("|");
  if (ownerId && interaction.user.id !== ownerId)
    return interaction.reply({ content: "Esse menu é de outra pessoa. Escreve tua função na thread pra pingar a tua.", flags: MessageFlags.Ephemeral });
  const weapon = interaction.values[0];
  const IP_WEAPONS = ["URSINAS", "CRAVADAS"];
  if (IP_WEAPONS.includes(weapon.toUpperCase())) {
    const modal = new ModalBuilder().setCustomId(`ipmodal|${eventId}|${encodeURIComponent(weapon)}`)
      .setTitle(`IP da tua ${weapon}`);
    const input = new TextInputBuilder().setCustomId("ip").setLabel("Qual teu IP? (ex: 1450)")
      .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(5);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`presence|${eventId}|online|${weapon}|0|${ownerId || ""}`).setLabel("Já estou ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`presence|${eventId}|later|${weapon}|0|${ownerId || ""}`).setLabel("Entro no horário").setEmoji("🕐").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ content: `**${weapon}** selecionada. E aí:`, components: [row] });
}

async function onIpModal(interaction) {
  const [, eventId, wEnc] = interaction.customId.split("|");
  const weapon = decodeURIComponent(wEnc);
  const raw = interaction.fields.getTextInputValue("ip").replace(/\D/g, "");
  const ip = parseInt(raw, 10);
  if (!ip || ip < 100 || ip > 2000)
    return interaction.reply({ content: "IP inválido. Digita só o número, ex: 1450.", flags: MessageFlags.Ephemeral });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`presence|${eventId}|online|${weapon}|${ip}`).setLabel("Já estou ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`presence|${eventId}|later|${weapon}|${ip}`).setLabel("Entro no horário").setEmoji("🕐").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ content: `**${weapon}** (IP ${ip}) selecionada. E aí:`, components: [row], flags: MessageFlags.Ephemeral });
}

// calcula o que falta nas PT1-4 (ignora PT5 press comp), por função,
// listando as armas cabíveis (preferíveis primeiro = peso menor).
// retorna { faltam: [{funcao, qtd, armas:[...]}], texto: "..." }
function faltasCTA(signups) {
  const { PARTIES } = require("./comps");
  const N = 4; // só PT1-4
  // conta vagas vazias por função nas 4 PTs
  const taken = new Set(signups.filter(s => s.party_index != null && s.party_index < N).map(s => `${s.party_index}:${s.slot_index}`));
  const porFuncao = {}; // funcao -> { qtd, armasSet(weight) }
  for (let p = 0; p < N; p++) {
    for (let i = 0; i < PARTIES[p].slots.length; i++) {
      const slot = PARTIES[p].slots[i];
      if (slot.locked) continue;
      if (taken.has(`${p}:${i}`)) continue; // vaga ocupada
      const role = slot.role;
      if (!porFuncao[role]) porFuncao[role] = { qtd: 0, armas: {} };
      porFuncao[role].qtd++;
      for (const a of slot.accepts) {
        // guarda o menor peso visto pra cada arma (preferível)
        if (porFuncao[role].armas[a.weapon] == null || a.weight < porFuncao[role].armas[a.weapon])
          porFuncao[role].armas[a.weapon] = a.weight;
      }
    }
  }
  const faltam = [];
  for (const [funcao, info] of Object.entries(porFuncao)) {
    if (info.qtd <= 0) continue;
    // ordena armas por peso (preferíveis primeiro)
    const armas = Object.entries(info.armas).sort((a,b)=>a[1]-b[1]).map(([w])=>w);
    faltam.push({ funcao, qtd: info.qtd, armas });
  }
  return faltam;
}
function faltasTexto(faltam) {
  if (!faltam.length) return "";
  return faltam.map(f => `**${f.qtd} ${f.funcao}** (${f.armas.slice(0,6).join(", ")}${f.armas.length>6?"...":""})`).join(" · ");
}

async function onPresence(interaction) {
  const [, eventId, presence, weapon, ipStr, ownerId] = interaction.customId.split("|");
  const ip = ipStr && ipStr !== "0" ? parseInt(ipStr, 10) : null;
  if (ownerId && interaction.user.id !== ownerId)
    return interaction.reply({ content: "Esse botão é de outra pessoa. Escreve tua função na thread pra pingar a tua.", flags: MessageFlags.Ephemeral });
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.update({ content: "CTA não está aberto.", components: [] });

  await interaction.deferUpdate();
  const username = interaction.member?.displayName || interaction.user.username;

  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon, presence,
    partyIndex: null, slotIndex: null, ip,
  });
  const myLoc = await applyReallocation(ev, interaction.guild, interaction.user.id);

  const CALLER_WEAPONS = ["GOLEM", "MAÇA DE UMA MÃO", "BRUXO DE UMA MÃO", "MONARCA"];
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

  // calcula o que falta nas PT1-4 (pra DM e nudge)
  const signupsNow = await db.getSignups(ev.id);
  const faltam = faltasCTA(signupsNow);
  const faltamTxt = faltasTexto(faltam);

  // NUDGE: se a pessoa foi pra RESERVA (função cheia) e tem função faltando -> oferece trocar
  if (!myLoc && faltam.length) {
    const btns = faltam.slice(0, 5).map(f =>
      new ButtonBuilder().setCustomId(`role|${eventId}|${f.funcao}`).setLabel(f.funcao).setStyle(ButtonStyle.Primary));
    const row = new ActionRowBuilder().addComponents(btns);
    return interaction.editReply({
      content: `📝 As vagas de **${weapon}** estão cheias. Mas falta: ${faltamTxt}\nQuer ir de uma dessas pra garantir vaga?`,
      components: [row],
    });
  }

  const msg = myLoc
    ? `✅ Fechado! **Party ${myLoc.partyIndex + 1}**, vaga ${myLoc.slotIndex + 1} (${weapon}).`
    : `📝 Anotado como **reserva** (${weapon}) — sem vaga nem por afinidade.`;
  await interaction.editReply({ content: msg, components: [] });

  // DM informativa (Leitura C): confirma + avisa o que falta se pingou função abundante
  try {
    const minhaRole = (require("./comps").WEAPONS[weapon.toUpperCase()] || {}).role;
    const faltaMinhaRole = faltam.some(f => f.funcao === minhaRole);
    let dm = myLoc
      ? `✅ Você entrou de **${weapon}** na **Party ${myLoc.partyIndex + 1}** do CTA ${ev.time_label} UTC. Tá tudo certo!`
      : `📝 Você ficou na **reserva** do CTA ${ev.time_label} UTC (${weapon}).`;
    // se a função da pessoa é abundante (ainda falta dela = não; se NÃO falta dela mas falta outra = abundante)
    if (faltamTxt && !faltaMinhaRole) {
      dm += `\n\n💡 Se quiser ajudar mais, ainda falta: ${faltamTxt}. É só pingar de novo a função na thread.`;
    }
    await interaction.user.send({ content: dm }).catch(()=>{}); // se DM bloqueada, ignora
  } catch (e) { /* DM é best-effort */ }
}

async function onLooter(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open") return interaction.reply({ content: "CTA não está aberto.", flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const username = interaction.member?.displayName || interaction.user.username;
  await db.upsertSignup({
    eventId, userId: interaction.user.id, username, weapon: "LOOTER", presence: "online",
    partyIndex: null, slotIndex: null,
  });
  const myLoc = await applyReallocation(ev, interaction.guild, interaction.user.id);
  const dest = myLoc ? `Party ${myLoc.partyIndex + 1} (vaga ${myLoc.slotIndex + 1})` : "RESERVA";
  await logStaff(interaction.guild, `💰 **${username}** entrou como **Looter** → ${dest} · CTA ${ev.time_label}`);
  await interaction.editReply({
    content: myLoc ? `💰 Você entrou como **Looter** em ${dest}. Cede a vaga se uma arma titular pingar.` : `💰 Anotado como **Looter** na reserva (sem buraco livre agora).`,
  });
}

const notifyTimers = new Map();
const ctaFrozen = new Set();
const notifyPending = new Map();

async function applyReallocation(ev, guild, focusUserId) {
  const fresh = (await db.getEvent(ev.id)) || ev;
  const numParties = fresh.num_parties || 4;
  const signups = await db.getSignups(fresh.id);

  if (ctaFrozen.has(String(fresh.id))) {
    const taken = new Set(signups.filter((s) => s.party_index != null && s.user_id !== focusUserId).map((s) => `${s.party_index}:${s.slot_index}`));
    const me = signups.find((s) => s.user_id === focusUserId);
    let myLoc = me && me.party_index != null ? { partyIndex: me.party_index, slotIndex: me.slot_index } : null;
    if (me && myLoc == null) {
      const { PARTIES } = require("./comps");
      outer: for (let p = 0; p < numParties; p++) {
        for (let i = 0; i < PARTIES[p].slots.length; i++) {
          if (taken.has(`${p}:${i}`) || PARTIES[p].slots[i].locked) continue;
          if (PARTIES[p].slots[i].accepts.some((a) => a.weapon.toUpperCase() === (me.weapon || "").toUpperCase())) {
            await db.moveSignupToSlot(fresh.id, focusUserId, p, i);
            myLoc = { partyIndex: p, slotIndex: i };
            break outer;
          }
        }
      }
    }
    refreshRoster(fresh);
    return myLoc;
  }

  const result = reallocate(signups, numParties);

  let focusLoc = null;
  for (const r of result) {
    if (r.user_id === focusUserId)
      focusLoc = r.partyIndex != null ? { partyIndex: r.partyIndex, slotIndex: r.slotIndex } : null;
    if (r.moved) {
      await db.moveSignupToSlot(fresh.id, r.user_id, r.partyIndex, r.slotIndex);
      if (r.user_id !== focusUserId) {
        const isUnique = ["URSINAS", "CRAVADAS"].includes((r.weapon || "").toUpperCase());
        if (r.partyIndex == null && isUnique) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`role|${fresh.id}|Melee`).setLabel("Trocar pra outra Melee").setStyle(ButtonStyle.Primary),
          );
          const thread = fresh.thread_id ? await client.channels.fetch(fresh.thread_id).catch(() => null) : null;
          if (thread) await thread.send({
            content: `⚠️ <@${r.user_id}> só existe(m) vaga(s) limitada(s) de **${r.weapon}** e alguém com IP maior assumiu. Quer entrar de outra melee?`,
            components: [row],
          }).catch(() => {});
        } else {
          const to = r.partyIndex != null
            ? `**Party ${r.partyIndex + 1}**, vaga ${r.slotIndex + 1} (${r.weapon})`
            : `**reserva**`;
          scheduleNotify(fresh, guild, r.user_id, `🔄 <@${r.user_id}> você foi remanejado para ${to}.`);
        }
      }
    }
  }
  refreshRoster(fresh);
  return focusLoc;
}

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
    presence: (signups.find((s) => s.user_id === interaction.user.id)?.presence) || "online",
    partyIndex: parseInt(p, 10), slotIndex: parseInt(i, 10),
  });
  await interaction.editReply({ content: `🔄 Trocado! Agora você é **${weapon}** na Party ${parseInt(p, 10) + 1}.`, components: [] });
  await refreshRoster(ev);
  await logStaff(interaction.guild, `🔄 **${username}** trocou para **${weapon}** → Party ${parseInt(p, 10) + 1} · CTA ${ev.time_label}`);
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
  await applyReallocation(ev, interaction.guild, null);
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
  if (thread) { await thread.setLocked(true).catch(() => {}); await thread.setArchived(true).catch(() => {}); }
}

async function onMontar(interaction) {
  const [, eventId] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev) return interaction.reply({ content: "CTA não encontrado.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== ev.caller_id)
    return interaction.reply({ content: "Só o caller monta.", flags: MessageFlags.Ephemeral });
  const fresh = (await db.getEvent(eventId)) || ev;
  const numParties = fresh.num_parties || 4;
  const signups = await db.getSignups(eventId);
  const blocks = renderRoster(signups, numParties);
  const half = Math.ceil(blocks.length / 2);
  const p1 = `📋 **PT — CTA ${fresh.time_label} UTC (1/2)**\n\n` + blocks.slice(0, half).join("\n\n");
  const p2 = `📋 **PT — CTA ${fresh.time_label} UTC (2/2)**\n\n` + blocks.slice(half).join("\n\n");
  await interaction.reply({ content: p1.slice(0, 1990) });
  await interaction.followUp({ content: p2.slice(0, 1990) });
  await logStaff(interaction.guild, `📋 PT publicada · CTA **${fresh.time_label} UTC** (${signups.length} inscritos). (CTA segue aberto)`);
}

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
  await applyReallocation(ev, interaction.guild, null);
  await logStaff(interaction.guild, `👑 **${username}** assumiu caller (${weapon}) · CTA ${ev.time_label}`);
}

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
  const name = interaction.commandName;

  if (name === "cta_rank")    return slashRank(interaction, false);
  if (name === "cta_meurank") return slashRank(interaction, true);

  if (name.startsWith("roaming")) return onRoamingCommand(interaction);

  if (name.startsWith("castelo")) return onCasteloCommand(interaction);

  if (!cmds.isStaff(interaction))
    return interaction.reply({ content: "Só Mestre de Guerra usa esses comandos.", flags: MessageFlags.Ephemeral });

  if (name === "cta_start_temporada")  return slashStartSeason(interaction);
  if (name === "cta_finish_temporada") return slashFinishSeason(interaction);

  if (name === "attendance_daily")   return slashAttendance(interaction, 1, "hoje");
  if (name === "attendance_week")    return slashAttendance(interaction, 7, "últimos 7 dias");
  if (name === "attendance_monthly") return slashAttendance(interaction, 30, "últimos 30 dias");

  const timeLabel = interaction.options.getString("cta");
  const ev = await db.getOpenEventByTime(interaction.guildId, timeLabel);
  if (!ev) return interaction.reply({ content: `Não achei um CTA aberto às ${timeLabel}.`, flags: MessageFlags.Ephemeral });

  if (name === "cta_press_pt") return slashPressPt(interaction, ev);
  if (name === "cta_remove") return slashRemove(interaction, ev);
  if (name === "cta_clean")  return slashClean(interaction, ev);
  if (name === "cta_move")   return slashMoveOrAdd(interaction, ev, false);
  if (name === "cta_add")    return slashMoveOrAdd(interaction, ev, true);
  if (name === "cta_change_time") return slashChangeTime(interaction, ev);
  if (name === "cta_finish") return slashFinish(interaction, ev);
  if (name === "cta_consolidar") return slashConsolidar(interaction, ev);
}

async function slashPressPt(interaction, ev) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const fresh = (await db.getEvent(ev.id)) || ev;
  const currentNum = fresh.num_parties || 4;
  if (currentNum >= 5) {
    return interaction.editReply({ content: `⚠️ A **Party 5** já foi criada para o CTA ${fresh.time_label} UTC.` });
  }
  if (!fresh.thread_id) {
    return interaction.editReply({ content: "⚠️ Thread deste CTA não encontrada." });
  }
  const thread = await client.channels.fetch(fresh.thread_id).catch(() => null);
  if (!thread) {
    return interaction.editReply({ content: "⚠️ Não foi possível acessar a thread do CTA no Discord." });
  }

  await db.setNumParties(fresh.id, 5);
  fresh.num_parties = 5;

  const signups = await db.getSignups(fresh.id);
  const blocks = renderRoster(signups, 5);
  const msg5 = await thread.send({
    content: (blocks[4] || "__**Party 5** (0/20)__\n*vazio*").slice(0, 1990),
  });

  const currentIds = fresh.roster_msg ? String(fresh.roster_msg).split(",").filter(Boolean) : [];
  currentIds.push(msg5.id);
  const newRosterMsg = currentIds.join(",");
  await db.setRosterMsg(fresh.id, newRosterMsg);
  fresh.roster_msg = newRosterMsg;

  const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
  const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
  await thread.send({
    content: `${mention} 🛡️⚔️ **PARTY 5 LIBERADA!** (CTA ${fresh.time_label} UTC)\nMais 20 vagas abertas. Escolha sua função abaixo para entrar 👇`,
    components: buildRolePicker(fresh.id),
    ...allow,
  });

  await applyReallocation(fresh, interaction.guild, null);
  await logStaff(interaction.guild, `🚀 ${interaction.user} liberou a **Party 5** no CTA **${fresh.time_label} UTC**! (+20 vagas)`);
  await interaction.editReply({
    content: `✅ **Party 5 criada com sucesso** para o CTA **${fresh.time_label} UTC**!\nA mensagem da PT5 e os botões de inscrição foram enviados na thread ${thread}.`,
  });
}

async function applyConsolidation(ev, guild) {
  const fresh = (await db.getEvent(ev.id)) || ev;
  const numParties = fresh.num_parties || 4;
  const signups = await db.getSignups(fresh.id);
  const result = consolidate(signups, numParties);
  for (const r of result) {
    if (r.moved) await db.moveSignupToSlot(fresh.id, r.user_id, r.partyIndex, r.slotIndex);
  }
  refreshRoster(fresh);
  return result;
}

async function slashConsolidar(interaction, ev) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await applyConsolidation(ev, interaction.guild);
  await interaction.editReply({ content: `🧲 Participantes amontoados nas PTs da frente (CTA ${ev.time_label}).` });
  await logStaff(interaction.guild, `🧲 ${interaction.user} disparou o amontoamento · CTA ${ev.time_label}`);
  ctaFrozen.add(String(ev.id));
}

// ==================  ROAMING  =============================================
function isCaller(interaction) {
  return interaction.member?.roles?.cache?.has(CALLER_TAG_ID);
}
function isGM(interaction) {
  return process.env.STAFF_ROLE_ID && interaction.member?.roles?.cache?.has(process.env.STAFF_ROLE_ID);
}
function canManageRoaming(interaction, r) {
  return isGM(interaction) || (isCaller(interaction) && r.owner_id === interaction.user.id);
}

async function onRoamingCommand(interaction) {
  const name = interaction.commandName;
  if (name === "roaming") return roamingCreate(interaction);
  if (name === "roaming_meu_saldo") return roamingMeuSaldo(interaction);
  if (name === "roaming_saldo") return roamingSaldo(interaction);

  const nome = interaction.options.getString("nome");
  const r = await db.getRoaming(interaction.guildId, nome);
  if (!r) return interaction.reply({ content: `Roaming "${nome}" não encontrado.`, flags: MessageFlags.Ephemeral });
  if (!canManageRoaming(interaction, r))
    return interaction.reply({ content: "Só o caller que criou este roaming (ou o GM) pode gerenciá-lo.", flags: MessageFlags.Ephemeral });

  if (name === "roaming_start")  return roamingStart(interaction, r);
  if (name === "roaming_value")  return roamingValue(interaction, r);
  if (name === "roaming_finish") return roamingFinish(interaction, r);
  if (name === "roaming_remove") return roamingRemove(interaction, r);
  if (name === "roaming_fill")   return roamingFill(interaction, r);
  if (name === "roaming_pago")   return roamingPago(interaction, r);
}

async function roamingCreate(interaction) {
  if (!isCaller(interaction) && !isGM(interaction))
    return interaction.reply({ content: "Só quem tem a tag de caller cria roaming.", flags: MessageFlags.Ephemeral });
  const nome = interaction.options.getString("nome").toLowerCase();
  const vagas = interaction.options.getInteger("vagas");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const r = await db.createRoaming({ guildId: interaction.guildId, nome, ownerId: interaction.user.id, vagas });

  let voice = null;
  try {
    voice = await interaction.guild.channels.create({
      name: `roaming ${nome}`, type: ChannelType.GuildVoice,
      parent: ROAMING_CATEGORY_ID || undefined, userLimit: vagas,
    });
    await db.setRoamingField(r.id, "voice_id", voice.id);
  } catch (e) { console.error("criar sala roaming:", e); }

  let thread = null;
  if (CFG.contentPingChannelId) {
    const ch = await client.channels.fetch(CFG.contentPingChannelId).catch(() => null);
    if (ch) {
      const roleMention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
      const fs = require("fs"); const path = require("path");
      const imgPath = path.join(__dirname, "..", "assets", "roaming.png");
      const files = fs.existsSync(imgPath) ? [{ attachment: imgPath, name: "roaming.png" }] : [];
      const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
      const msg = await ch.send({
        content: roamingPostText(r, [], roleMention),
        components: buildRoamingRolePicker(r.id),
        files,
        ...allow,
      }).catch((e) => { console.error("post roaming:", e); return null; });
      if (msg) {
        await db.setRoamingField(r.id, "roster_msg", msg.id);
        thread = await msg.startThread({ name: `Roaming ${nome}`, autoArchiveDuration: 1440 }).catch(() => null);
        if (thread) await db.setRoamingField(r.id, "thread_id", thread.id);
      }
    }
  }
  await interaction.editReply({ content: `✅ Roaming **${nome}** criado (${vagas} vagas)${voice ? `, sala <#${voice.id}> criada` : ""}. Use **/roaming_start ${nome}** quando começar.` });
}

function buildRoamingRolePicker(roamingId) {
  const funcs = [["Tank", "🛡️"], ["Support", "🎺"], ["DPS", "⚔️"], ["Healer", "💚"], ["Caller", "👑"]];
  const btns = funcs.map(([f, e]) => new ButtonBuilder().setCustomId(`rmf|${roamingId}|${f}`).setLabel(f).setEmoji(e).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`rmleave|${roamingId}`).setLabel("Sair").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(leave));
  return rows;
}

function roamingRosterText(r, signups) {
  const comp = roaming.ROAMING_COMPS[r.vagas];
  const porFunc = {}; for (const s of signups) (porFunc[s.funcao] ||= []).push(s.username);
  let t = `🧭 **Roaming ${r.nome}** (${signups.length}/${r.vagas})\n`;
  for (const [funcao, qtd] of Object.entries(comp)) {
    const gente = porFunc[funcao] || [];
    const cheio = gente.length >= qtd ? " ✅" : "";
    t += `\n**${funcao}** (${gente.length}/${qtd})${cheio}: ${gente.join(", ") || "*vazio*"}`;
  }
  return t.slice(0, 1900);
}

function roamingPostText(r, signups, roleMention) {
  const men = roleMention || (CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal");
  const falta = funcoesFaltando(r, signups);
  const header = `${men} 🧭 **ROAMING "${r.nome}"** (${r.vagas} vagas) — conteúdo novo! Pinga tua função 👇`;
  const faltaLinha = falta ? `\n⚠️ **Falta:** ${falta}` : `\n✅ **PT completa!**`;
  return (header + faltaLinha + "\n" + roamingRosterText(r, signups)).slice(0, 1990);
}

async function refreshRoamingRoster(r) {
  const fresh = await db.getRoamingById(r.id);
  if (!fresh.roster_msg || !CFG.contentPingChannelId) return;
  const ch = await client.channels.fetch(CFG.contentPingChannelId).catch(() => null);
  if (!ch) return;
  const m = await ch.messages.fetch(fresh.roster_msg).catch(() => null);
  if (!m) return;
  const signups = await db.getRoamingSignups(r.id);
  const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
  await m.edit({ content: roamingPostText(fresh, signups), ...allow }).catch(() => {});
}

async function onRoamingRolePick(interaction) {
  const [, roamingId, funcao] = interaction.customId.split("|");
  const r = await db.getRoamingById(roamingId);
  if (!r || r.status === "pago" || r.status === "fechado")
    return interaction.reply({ content: "Esse roaming não está aberto.", flags: MessageFlags.Ephemeral });
  const username = interaction.member?.displayName || interaction.user.username;

  const comp = roaming.ROAMING_COMPS[r.vagas];
  const teto = comp[funcao] || 0;
  const signups = await db.getRoamingSignups(roamingId);
  const naFuncao = signups.filter((s) => s.funcao === funcao && s.user_id !== interaction.user.id).length;
  if (naFuncao >= teto) {
    const faltam = funcoesFaltando(r, signups);
    return interaction.reply({ content: `⚠️ **${funcao}** já está cheio (${teto}/${teto}) no roaming ${r.nome}.${faltam ? ` Ainda falta: ${faltam}.` : ""}`, flags: MessageFlags.Ephemeral });
  }

  await db.upsertRoamingSignup(roamingId, interaction.user.id, username, funcao);
  await refreshRoamingRoster(r);
  await interaction.reply({ content: `🧭 Você pingou **${funcao}** no roaming ${r.nome}. Entra na sala de voz!`, flags: MessageFlags.Ephemeral });
}

function funcoesFaltando(r, signups) {
  const comp = roaming.ROAMING_COMPS[r.vagas];
  const cont = {}; for (const s of signups) cont[s.funcao] = (cont[s.funcao] || 0) + 1;
  const faltas = [];
  for (const [f, qtd] of Object.entries(comp)) {
    const tem = cont[f] || 0;
    if (tem < qtd) faltas.push(`${qtd - tem} ${f}`);
  }
  return faltas.join(", ");
}

async function onRoamingLeave(interaction) {
  const [, roamingId] = interaction.customId.split("|");
  const r = await db.getRoamingById(roamingId);
  await db.deleteRoamingSignup(roamingId, interaction.user.id);
  if (r) await refreshRoamingRoster(r);
  await interaction.reply({ content: "🚪 Saiu do roaming.", flags: MessageFlags.Ephemeral });
}

async function roamingStart(interaction, r) {
  await db.setRoamingField(r.id, "status", "contando");
  await db.setRoamingField(r.id, "started_at", new Date());
  if (r.voice_id) {
    const vc = await client.channels.fetch(r.voice_id).catch(() => null);
    if (vc && vc.members) for (const [, mb] of vc.members)
      await db.roamingVoiceJoin(r.id, mb.id, mb.displayName || mb.user.username);
  }
  await interaction.reply({ content: `▶️ Roaming **${r.nome}** — contagem de presença iniciada!` });
}

async function roamingValue(interaction, r) {
  const valor = interaction.options.getInteger("valor");
  await db.setRoamingField(r.id, "valor", valor);
  await interaction.reply({ content: `💰 Roaming **${r.nome}** — valor registrado: **${valor.toLocaleString("pt-BR")}** prata.` });
}

async function roamingFinish(interaction, r) {
  await interaction.deferReply();
  await db.setRoamingField(r.id, "status", "fechado");
  if (r.voice_id) await db.roamingCloseAllOpen(r.id);
  const linhas = await calcRoamingDivisao(r);
  const elegiveis = linhas.filter((l) => l.elegivel);
  const top = elegiveis.slice(0, 15).map((l, i) => `\`${String(i + 1).padStart(2)}\` ${l.username} — ${l.valor.toLocaleString("pt-BR")} (${l.minutos}min)`).join("\n");
  await interaction.editReply({ content: `🏁 **Roaming ${r.nome} encerrado.**\nValor: ${(r.valor || 0).toLocaleString("pt-BR")} prata · ${elegiveis.length} elegíveis\n\n${top || "(ninguém elegível)"}\n\nUse **/roaming_saldo ${r.nome}** pra ver todos.` });
  await deleteRoamingVoice(r);
}

async function calcRoamingDivisao(r) {
  const fresh = await db.getRoamingById(r.id);
  const signups = await db.getRoamingSignups(r.id);
  const presence = await db.getRoamingPresence(r.id);
  const start = fresh.started_at ? new Date(fresh.started_at) : new Date(fresh.created_at);
  const end = new Date();
  const presMin = roaming.presenceMinutes(presence, start, end);
  return roaming.dividir(fresh.valor || 0, signups, presMin, 10);
}

async function roamingSaldo(interaction) {
  const nome = interaction.options.getString("nome");
  const r = await db.getRoaming(interaction.guildId, nome);
  if (!r) return interaction.reply({ content: `Roaming "${nome}" não encontrado.`, flags: MessageFlags.Ephemeral });
  await interaction.deferReply();
  const linhas = await calcRoamingDivisao(r);
  const eleg = linhas.filter((l) => l.elegivel);
  const txt = eleg.map((l, i) => `\`${String(i + 1).padStart(2)}\` ${l.username} — ${l.valor.toLocaleString("pt-BR")} (${l.minutos}min)`).join("\n");
  await interaction.editReply({ content: `💰 **Saldo do roaming ${r.nome}** (${(r.valor || 0).toLocaleString("pt-BR")} prata)\n${txt || "(ninguém elegível ainda)"}` });
}

async function roamingMeuSaldo(interaction) {
  const nome = interaction.options.getString("nome");
  const r = await db.getRoaming(interaction.guildId, nome);
  if (!r) return interaction.reply({ content: `Roaming "${nome}" não encontrado.`, flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const linhas = await calcRoamingDivisao(r);
  const meu = linhas.find((l) => l.user_id === interaction.user.id);
  if (!meu) return interaction.editReply({ content: `Você não está no roaming ${r.nome}.` });
  if (!meu.elegivel) return interaction.editReply({ content: `Roaming ${r.nome}: você não está elegível (${meu.motivo}).` });
  await interaction.editReply({ content: `💰 **Teu saldo no roaming ${r.nome}:** ${meu.valor.toLocaleString("pt-BR")} prata (${meu.minutos}min de presença).` });
}

async function roamingRemove(interaction, r) {
  const user = interaction.options.getUser("usuario");
  await db.deleteRoamingSignup(r.id, user.id);
  await refreshRoamingRoster(r);
  await interaction.reply({ content: `🗑️ ${user} removido do roaming ${r.nome}.` });
}

async function roamingFill(interaction, r) {
  const user = interaction.options.getUser("usuario");
  const funcao = roaming.normFunc(interaction.options.getString("funcao")) || interaction.options.getString("funcao");
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const username = member?.displayName || user.username;
  await db.upsertRoamingSignup(r.id, user.id, username, funcao);
  await refreshRoamingRoster(r);
  await interaction.reply({ content: `➕ ${user} adicionado como **${funcao}** no roaming ${r.nome}.` });
}

async function roamingPago(interaction, r) {
  await db.setRoamingField(r.id, "status", "pago");
  const del = await deleteRoamingVoice(r);
  await interaction.reply({ content: `✅ Roaming **${r.nome}** marcado como PAGO.${del}` });
}

// ==================  CASTELO  ============================================
// 3 PTs (press comp + PT1 + PT2 do CTA), sala de voz, presença por tempo, divisão de prata.
function canManageCastelo(interaction, c) {
  return isGM(interaction) || (isCaller(interaction) && c.owner_id === interaction.user.id);
}
async function onCasteloCommand(interaction) {
  const name = interaction.commandName;
  if (name === "castelo") return casteloCreate(interaction);
  if (name === "castelo_meu_saldo") return casteloMeuSaldo(interaction);
  if (name === "castelo_saldo") return casteloSaldo(interaction);

  const horario = interaction.options.getString("horario");
  const c = await db.getCastelo(interaction.guildId, horario);
  if (!c) return interaction.reply({ content: `Castelo "${horario}" não encontrado.`, flags: MessageFlags.Ephemeral });
  if (!canManageCastelo(interaction, c))
    return interaction.reply({ content: "Só o caller que criou este castelo (ou o GM) pode gerenciá-lo.", flags: MessageFlags.Ephemeral });

  if (name === "castelo_start")  return casteloStart(interaction, c);
  if (name === "castelo_value")  return casteloValue(interaction, c);
  if (name === "castelo_finish") return casteloFinish(interaction, c);
  if (name === "castelo_pago")   return casteloPago(interaction, c);
  if (name === "castelo_remove") return casteloRemove(interaction, c);
  if (name === "castelo_cancel") return casteloCancel(interaction, c);
}

async function casteloCancel(interaction, c) {
  await db.setCasteloField(c.id, "status", "pago"); // marca como encerrado (sai da lista de abertos)
  // apaga a sala de voz
  if (c.voice_id) { const vc = await client.channels.fetch(c.voice_id).catch(()=>null); if (vc) await vc.delete().catch(()=>{}); await db.setCasteloField(c.id,"voice_id",null); }
  // arquiva a thread
  if (c.thread_id) { const th = await client.channels.fetch(c.thread_id).catch(()=>null); if (th) await th.setArchived(true).catch(()=>{}); }
  await interaction.reply({ content: `❌ **Castelo ${c.time_label} CANCELADO.** Sala apagada.` });
}

async function casteloCreate(interaction) {
  if (!isCaller(interaction) && !isGM(interaction))
    return interaction.reply({ content: "Só quem tem a tag de caller cria castelo.", flags: MessageFlags.Ephemeral });
  const horario = interaction.options.getString("horario").trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const c = await db.createCastelo({ guildId: interaction.guildId, timeLabel: horario, ownerId: interaction.user.id });

  // sala de voz na categoria conteúdos e eventos
  let voice = null;
  try {
    voice = await interaction.guild.channels.create({
      name: `castelo ${horario}`, type: ChannelType.GuildVoice,
      parent: ROAMING_CATEGORY_ID || undefined,
    });
    await db.setCasteloField(c.id, "voice_id", voice.id);
  } catch (e) { console.error("criar sala castelo:", e); }

  // posta no ping-de-conteúdo
  if (CFG.contentPingChannelId) {
    const ch = await client.channels.fetch(CFG.contentPingChannelId).catch(()=>null);
    if (ch) {
      const roleMention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
      const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
      const fs = require("fs"); const path = require("path");
      const imgPath = path.join(__dirname, "..", "assets", "castelo.png");
      const files = fs.existsSync(imgPath) ? [{ attachment: imgPath, name: "castelo.png" }] : [];
      // POST: só imagem + aviso (SEM botões — eles vão na thread, igual o CTA)
      const msg = await ch.send({
        content: `${roleMention} 🏰 **CASTELO ${horario} UTC** — conteúdo de guerra! Entra na thread pra pingar tua função 👇`,
        files,
        ...allow,
      }).catch(()=>null);
      if (msg) {
        const thread = await msg.startThread({ name: `Castelo ${horario}`, autoArchiveDuration: 1440 }).catch(()=>null);
        if (thread) {
          await db.setCasteloField(c.id, "thread_id", thread.id);
          // botões de função DENTRO da thread (igual o CTA)
          await thread.send({
            content: `🏰 **Castelo ${horario} UTC** — escolhe tua função abaixo 👇`,
            components: buildCasteloRolePicker(c.id),
          }).catch(()=>{});
          const blocks = renderRoster([], 3, castelo.CASTELO_PT_INDEX);
          const ids = [];
          for (const b of blocks) { const m = await thread.send({ content: b.slice(0,1990) }); ids.push(m.id); }
          await db.setCasteloField(c.id, "roster_msg", ids.join(","));
        }
      }
    }
  }
  await interaction.editReply({ content: `✅ Castelo **${horario}** criado${voice?`, sala <#${voice.id}>`:""}. Use **/castelo_start ${horario}** quando começar.` });
}

// botões de função do castelo (funções + sair) — SEM fechar/cancelar do CTA.
// gestão do castelo é via comandos (/castelo_finish, /castelo_pago).
function buildCasteloRolePicker(casteloId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) =>
    new ButtonBuilder().setCustomId(`role|c${casteloId}|${name}`).setLabel(name).setEmoji(meta.emoji).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`cleave|${casteloId}`).setLabel("Sair da função").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(leave));
  return rows;
}

async function refreshCasteloRoster(c) {
  const fresh = await db.getCasteloById(c.id);
  if (!fresh.thread_id || !fresh.roster_msg) return;
  const th = await client.channels.fetch(fresh.thread_id).catch(()=>null);
  if (!th) return;
  const ids = String(fresh.roster_msg).split(",");
  const signups = await db.getCasteloSignups(c.id);
  const blocks = renderRoster(signups, 3, castelo.CASTELO_PT_INDEX);
  await Promise.all(ids.map(async (id, i) => {
    const m = await th.messages.fetch(id).catch(()=>null);
    if (m && blocks[i]) await m.edit({ content: blocks[i].slice(0,1990) }).catch(()=>{});
  }));
}

// realoca no castelo (usa a engine do CTA com a lista de PTs do castelo)
async function applyCasteloReallocation(c, focusUserId) {
  const signups = await db.getCasteloSignups(c.id);
  const result = reallocate(signups, 3, castelo.CASTELO_PT_INDEX);
  let focusLoc = null;
  for (const r of result) {
    if (r.user_id === focusUserId) focusLoc = r.partyIndex != null ? { partyIndex: r.partyIndex, slotIndex: r.slotIndex } : null;
    if (r.moved) await db.moveCasteloSignup(c.id, r.user_id, r.partyIndex, r.slotIndex);
  }
  await refreshCasteloRoster(c);
  return focusLoc;
}

// pingar função no castelo (botões reusam o picker com prefixo c<id>)
async function onCasteloRolePick(interaction) {
  const [, cid, role] = interaction.customId.split("|");
  const c = await db.getCasteloById(cid.replace(/^c/, ""));
  if (!c || c.status === "pago" || c.status === "fechado")
    return interaction.reply({ content: "Castelo não está aberto.", flags: MessageFlags.Ephemeral });
  // menu de armas do papel (reusa WEAPON_CATALOG)
  const armas = WEAPON_CATALOG[role] || [];
  if (!armas.length) return interaction.reply({ content: "Sem armas nesse papel.", flags: MessageFlags.Ephemeral });
  const menu = new StringSelectMenuBuilder().setCustomId(`cweapon|${c.id}|${interaction.user.id}`)
    .setPlaceholder(`Tua arma de ${role}`).addOptions(armas.slice(0,25).map(w=>({label:w,value:w})));
  await interaction.reply({ content: `Escolhe tua arma (${role}):`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
}
async function onCasteloWeaponPick(interaction) {
  const [, cid, ownerId] = interaction.customId.split("|");
  if (ownerId && interaction.user.id !== ownerId)
    return interaction.reply({ content: "Esse menu é de outra pessoa.", flags: MessageFlags.Ephemeral });
  const weapon = interaction.values[0];
  const c = await db.getCasteloById(cid);
  if (!c) return interaction.update({ content: "Castelo não encontrado.", components: [] });
  await interaction.deferUpdate();
  const username = interaction.member?.displayName || interaction.user.username;
  await db.upsertCasteloSignup({ casteloId: c.id, userId: interaction.user.id, username, weapon, presence: "online", partyIndex: null, slotIndex: null });
  const loc = await applyCasteloReallocation(c, interaction.user.id);
  await interaction.editReply({ content: loc ? `✅ Você entrou de **${weapon}** no castelo (Party ${castelo.CASTELO_PT_INDEX.indexOf(loc.partyIndex)+1}, vaga ${loc.slotIndex+1}).` : `📝 Reserva (${weapon}).`, components: [] });
}

async function casteloStart(interaction, c) {
  await db.setCasteloField(c.id, "status", "contando");
  await db.setCasteloField(c.id, "started_at", new Date());
  if (c.voice_id) {
    const vc = await client.channels.fetch(c.voice_id).catch(()=>null);
    if (vc && vc.members) for (const [, mb] of vc.members) await db.casteloVoiceJoin(c.id, mb.id, mb.displayName || mb.user.username);
  }
  await interaction.reply({ content: `▶️ Castelo **${c.time_label}** — contagem de presença iniciada!` });
}
async function casteloValue(interaction, c) {
  const valor = interaction.options.getInteger("valor");
  await db.setCasteloField(c.id, "valor", valor);
  await interaction.reply({ content: `💰 Castelo **${c.time_label}** — valor: **${valor.toLocaleString("pt-BR")}** prata.` });
}
async function calcCasteloDivisao(c) {
  const fresh = await db.getCasteloById(c.id);
  const signups = await db.getCasteloSignups(c.id);
  const presence = await db.getCasteloPresence(c.id);
  const start = fresh.started_at ? new Date(fresh.started_at) : new Date(fresh.created_at);
  const presMin = castelo.presenceMinutes(presence, start, new Date());
  return castelo.dividir(fresh.valor || 0, signups, presMin, 10);
}
async function casteloFinish(interaction, c) {
  await interaction.deferReply();
  await db.setCasteloField(c.id, "status", "fechado");
  await db.casteloCloseAllOpen(c.id);
  const linhas = await calcCasteloDivisao(c);
  const eleg = linhas.filter(l=>l.elegivel);
  const top = eleg.slice(0,15).map((l,i)=>`\`${String(i+1).padStart(2)}\` ${l.username} — ${l.valor.toLocaleString("pt-BR")} (${l.minutos}min)`).join("\n");
  await interaction.editReply({ content: `🏰 **Castelo ${c.time_label} encerrado.**\nValor: ${(c.valor||0).toLocaleString("pt-BR")} prata · ${eleg.length} elegíveis\n\n${top||"(ninguém elegível)"}\n\nUse **/castelo_saldo ${c.time_label}** pra ver todos.` });
  // apaga sala se vazia
  if (c.voice_id) { const vc = await client.channels.fetch(c.voice_id).catch(()=>null); if (vc && vc.members && vc.members.size===0) { await vc.delete().catch(()=>{}); await db.setCasteloField(c.id,"voice_id",null); } }
}
async function casteloSaldo(interaction) {
  const horario = interaction.options.getString("horario");
  const c = await db.getCastelo(interaction.guildId, horario);
  if (!c) return interaction.reply({ content: `Castelo "${horario}" não encontrado.`, flags: MessageFlags.Ephemeral });
  await interaction.deferReply();
  const eleg = (await calcCasteloDivisao(c)).filter(l=>l.elegivel);
  const txt = eleg.map((l,i)=>`\`${String(i+1).padStart(2)}\` ${l.username} — ${l.valor.toLocaleString("pt-BR")} (${l.minutos}min)`).join("\n");
  await interaction.editReply({ content: `💰 **Saldo do castelo ${c.time_label}** (${(c.valor||0).toLocaleString("pt-BR")} prata)\n${txt||"(ninguém elegível)"}` });
}
async function casteloMeuSaldo(interaction) {
  const horario = interaction.options.getString("horario");
  const c = await db.getCastelo(interaction.guildId, horario);
  if (!c) return interaction.reply({ content: `Castelo "${horario}" não encontrado.`, flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const meu = (await calcCasteloDivisao(c)).find(l=>l.user_id===interaction.user.id);
  if (!meu) return interaction.editReply({ content: `Você não está no castelo ${c.time_label}.` });
  if (!meu.elegivel) return interaction.editReply({ content: `Castelo ${c.time_label}: não elegível (${meu.motivo}).` });
  await interaction.editReply({ content: `💰 **Teu saldo no castelo ${c.time_label}:** ${meu.valor.toLocaleString("pt-BR")} prata (${meu.minutos}min).` });
}
async function casteloPago(interaction, c) {
  await db.setCasteloField(c.id, "status", "pago");
  await interaction.reply({ content: `✅ Castelo **${c.time_label}** marcado como PAGO.` });
}
async function onCasteloLeave(interaction) {
  const [, casteloId] = interaction.customId.split("|");
  const c = await db.getCasteloById(casteloId);
  await db.deleteCasteloSignup(casteloId, interaction.user.id);
  if (c) await applyCasteloReallocation(c, null);
  await interaction.reply({ content: "🚪 Saiu do castelo.", flags: MessageFlags.Ephemeral });
}
async function casteloRemove(interaction, c) {
  const user = interaction.options.getUser("usuario");
  if (!user) return interaction.reply({ content: "Informe o @usuário.", flags: MessageFlags.Ephemeral });
  await db.deleteCasteloSignup(c.id, user.id);
  await applyCasteloReallocation(c, null);
  await interaction.reply({ content: `🗑️ ${user} removido do castelo ${c.time_label}.` });
}

async function deleteRoamingVoice(r) {
  if (!r.voice_id) return "";
  const vc = await client.channels.fetch(r.voice_id).catch(() => null);
  if (!vc) return "";
  if (vc.members && vc.members.size > 0) return ` (a sala ainda tem gente — apague manualmente ou espere esvaziar)`;
  await vc.delete().catch((e) => console.error("del sala roaming:", e));
  await db.setRoamingField(r.id, "voice_id", null);
  return ` Sala de voz apagada.`;
}

async function slashChangeTime(interaction, ev) {
  const novo = interaction.options.getString("novo").trim();
  if (!/^\d{1,2}:\d{2}$/.test(novo))
    return interaction.reply({ content: "Formato inválido. Use HH:MM, ex 23:00.", flags: MessageFlags.Ephemeral });
  const antigo = ev.time_label;
  await db.setTimeLabel(ev.id, novo);
  if (ev.thread_id) {
    const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
    if (thread) await thread.setName(`Planilha CTA ${novo}`).catch(() => {});
  }
  if (ev.bomb_ping_msg && CFG.bombPingChannelId) {
    const ch = await client.channels.fetch(CFG.bombPingChannelId).catch(() => null);
    if (ch) {
      const pingMsg = await ch.messages.fetch(ev.bomb_ping_msg).catch(() => null);
      if (pingMsg) {
        const roleMention = CFG.bombRoleId ? `<@&${CFG.bombRoleId}>` : "@Bomb";
        await pingMsg.edit({ content: `${roleMention} 💣 **BOMB** — Vai no CTA das **${novo} UTC** hoje?` }).catch(() => {});
      }
    }
  }
  if (ev.bomb_thread) {
    const bt = await client.channels.fetch(ev.bomb_thread).catch(() => null);
    if (bt) await bt.setName(`Bomb ${novo} — contagem`).catch(() => {});
  }
  await interaction.reply({ content: `🕐 CTA **${antigo} → ${novo}**. Planilha, bomb, lembretes e janela atualizados.` });
  await logStaff(interaction.guild, `🕐 ${interaction.user} mudou horário do CTA **${antigo} → ${novo}**`);
}

async function slashFinish(interaction, ev) {
  if (ev.status !== "open")
    return interaction.reply({ content: `CTA ${ev.time_label} já está encerrado.`, flags: MessageFlags.Ephemeral });
  await db.setStatus(ev.id, "closed");
  await interaction.reply({ content: `🏁 **CTA ${ev.time_label} ENCERRADO** por staff — inscrições travadas.` });
  await logStaff(interaction.guild, `🏁 ${interaction.user} encerrou o CTA **${ev.time_label} UTC** (via /cta_finish)`);
}

async function slashAttendance(interaction, dias, rotulo) {
  await interaction.deferReply();
  const end = new Date();
  const start = new Date(end.getTime() - dias * 24 * 60 * 60000);
  const report = await attendance.buildReport(interaction.guildId, start, end);

  if (!report.ctaCount)
    return interaction.editReply({ content: `Nenhum CTA encontrado (${rotulo}).` });

  const html = renderAttendanceHTML(report, rotulo, start, end);
  const buf = Buffer.from(html, "utf-8");
  const file = { attachment: buf, name: `attendance-${rotulo.replace(/\s+/g, "-")}.html` };

  const top = report.rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.username} — ${r.integral} integral, score ${r.score} (${r.cat})`).join("\n");
  await interaction.editReply({
    content: `📊 **Attendance — ${rotulo}** (${report.ctaCount} CTAs)\n\n**Top 5:**\n${top || "(sem dados)"}\n\nRelatório completo no anexo 👇`,
    files: [file],
  });
}

async function slashStartSeason(interaction) {
  const numero = interaction.options.getInteger("numero");
  await db.startSeason(interaction.guildId, numero);
  await interaction.reply({ content: `🏁 **Temporada ${numero} iniciada!** A contagem de presença começa agora. Boa sorte, IMORTAIS! ⚔️` });
  await logStaff(interaction.guild, `🏁 ${interaction.user} iniciou a **Temporada ${numero}**`);
}

async function slashFinishSeason(interaction) {
  const s = await db.finishSeason(interaction.guildId);
  if (!s) return interaction.reply({ content: "Não há temporada aberta pra encerrar.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: `🔒 **Temporada ${s.number} encerrada.** O placar final está congelado — rode /cta_rank pra ver o resultado.` });
  await logStaff(interaction.guild, `🔒 ${interaction.user} encerrou a **Temporada ${s.number}**`);
}

async function slashRank(interaction, meu) {
  await interaction.deferReply({ flags: meu ? MessageFlags.Ephemeral : undefined });
  const season = await db.getCurrentSeason(interaction.guildId);
  if (!season)
    return interaction.editReply({ content: "Nenhuma temporada ativa ainda. Peça a um Mestre de Guerra pra iniciar com **/cta_start_temporada**." });

  const start = new Date(season.started_at);
  const end = new Date();
  const report = await attendance.buildReport(interaction.guildId, start, end);
  const rows = report.rows.filter((r) => r.integral + r.parcial + r.rapida > 0 || r.fantasma > 0);

  if (meu) {
    const idx = rows.findIndex((r) => r.user_id === interaction.user.id);
    if (idx === -1)
      return interaction.editReply({ content: `📊 **Teu rank — Temporada ${season.number}**\n\nVocê ainda não tem presença registrada nesta temporada. Aparece nos CTAs! ⚔️` });
    const r = rows[idx];
    const nextCat = r.cat === "Regular" ? "Pilar" : r.cat === "Intermitente" ? "Regular" : null;
    let dica = "";
    if (nextCat === "Pilar") { const falta = Math.ceil(report.ctaCount * 0.7) - (r.integral + r.parcial); if (falta > 0) dica = `\n\nFaltam **${falta}** presença(s) pra virar **Pilar** 💪`; }
    else if (nextCat === "Regular") { const falta = Math.ceil(report.ctaCount * 0.4) - (r.integral + r.parcial); if (falta > 0) dica = `\n\nFaltam **${falta}** presença(s) pra virar **Regular** 💪`; }
    await interaction.editReply({
      content: `📊 **Teu rank — Temporada ${season.number}**\n\n` +
        `**Posição:** ${idx + 1}º de ${rows.length}\n` +
        `**Score:** ${r.score} pts\n` +
        `**Presença:** ${r.integral + r.parcial}/${report.ctaCount} CTAs\n` +
        `   • ${r.integral} integrais, ${r.parcial} parciais${r.rapida ? `, ${r.rapida} rápidas` : ""}\n` +
        `${r.fantasma ? `   • ⚠️ ${r.fantasma} fantasma(s) (pingou e não veio)\n` : ""}` +
        `**Categoria:** ${r.cat}${dica}`,
    });
    return;
  }

  const linhas = rows.map((r, i) => `\`${String(i + 1).padStart(2)}\` **${r.username}** · ${r.score} pts · ${r.integral + r.parcial}/${report.ctaCount}`);
  const header = `🏆 **Placar — Temporada ${season.number}** (${report.ctaCount} CTAs)\n`;
  const chunks = [];
  for (let i = 0; i < linhas.length; i += 25) chunks.push(linhas.slice(i, i + 25).join("\n"));
  if (!chunks.length) return interaction.editReply({ content: header + "\n_(ninguém pontuou ainda nesta temporada)_" });
  await interaction.editReply({ content: header + "\n" + chunks[0] });
  for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i] });
}

function renderAttendanceHTML(report, rotulo, start, end) {
  const catColor = { "Pilar": "#c9a227", "Regular": "#3f7a4d", "Intermitente": "#6ba7c4", "Fantasma": "#7a2222", "Ausente": "#555" };
  const levelLabel = { INTEGRAL: "Integral", PARCIAL: "Parcial", RAPIDA: "Rápida", FANTASMA: "Fantasma" };
  const levelColor = { INTEGRAL: "#c9a227", PARCIAL: "#6ba7c4", RAPIDA: "#9aa0ab", FANTASMA: "#e0a0a0" };

  const detailHtml = (r) => {
    const dates = Object.keys(r.detail || {}).sort();
    if (!dates.length) return `<div class="empty">Sem presença registrada no período.</div>`;
    return dates.map((d) => {
      const ctas = r.detail[d];
      const ctaBlocks = ctas.map((c) => {
        const prep = c.prepMin ? `Preparação: ${c.prepIn}–${c.prepOut} (${c.prepMin} min)` : "Preparação: —";
        const bomb = c.bombMin ? `Bomb Squad: ${c.bombIn}–${c.bombOut} (${c.bombMin} min)` : "";
        const pingSeal = c.pingou ? ` · 🎯 pingou` : " · não pingou";
        const lvl = `<span class="lvl" style="color:${levelColor[c.level] || "#9aa0ab"}">${levelLabel[c.level] || c.level}</span>`;
        return `<div class="ctarow">
          <button class="ctabtn" onclick="tog(this)">🕐 CTA ${c.cta} — ${lvl}${pingSeal}</button>
          <div class="ctadetail">
            <div>${prep}</div>${bomb ? `<div>${bomb}</div>` : ""}
          </div>
        </div>`;
      }).join("");
      return `<div class="daterow">
        <button class="datebtn" onclick="tog(this)">📅 ${d}</button>
        <div class="datedetail">${ctaBlocks}</div>
      </div>`;
    }).join("");
  };

  const rowsHtml = report.rows.map((r, i) => `
    <tr class="prow" onclick="togRow(this)">
      <td class="rank">${i + 1}</td>
      <td class="name">▸ ${escapeHtml(r.username)}</td>
      <td><span class="cat" style="background:${catColor[r.cat] || "#555"}">${r.cat}</span></td>
      <td class="num gold">${r.integral}</td>
      <td class="num">${r.parcial}</td>
      <td class="num dim">${r.rapida}</td>
      <td class="num red">${r.fantasma}</td>
      <td class="num ice">${r.pingou}</td>
      <td class="num score">${r.score}</td>
    </tr>
    <tr class="drow"><td colspan="9"><div class="drill">${detailHtml(r)}</div></td></tr>`).join("");

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Attendance IMORTAIS</title>
<style>
:root{--void:#0a0c10;--steel:#12161d;--line:#242c38;--gold:#c9a227;--ink:#e6e3da;--ink-dim:#9aa0ab;--ice:#6ba7c4}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(1200px 500px at 50% -10%,rgba(201,162,39,.06),transparent 60%),var(--void);color:var(--ink);font-family:"Iowan Old Style",Palatino,Georgia,serif;padding:44px 20px 70px}
.wrap{max-width:1080px;margin:0 auto}
.eyebrow{font-family:"DIN Condensed","Arial Narrow",sans-serif;letter-spacing:.4em;text-transform:uppercase;font-size:12px;color:var(--gold);text-align:center;margin-bottom:12px}
h1{font-size:clamp(32px,6vw,54px);font-weight:800;text-transform:uppercase;text-align:center;line-height:1;background:linear-gradient(180deg,#f3ead0,#c9a227 60%,#8a7220);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{text-align:center;color:var(--ink-dim);font-style:italic;margin:12px 0 8px}
.meta{text-align:center;color:var(--ink-dim);font-size:13px;margin-bottom:30px}
table{width:100%;border-collapse:collapse;background:var(--steel);border:1px solid var(--line);border-radius:4px;overflow:hidden}
th{font-family:"DIN Condensed","Arial Narrow",sans-serif;text-transform:uppercase;letter-spacing:.1em;font-size:12px;color:var(--gold);text-align:center;padding:12px 8px;border-bottom:2px solid var(--line);background:rgba(0,0,0,.3)}
th.l,td.name{text-align:left}
td{padding:9px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,.04);font-size:14px}
.rank{color:var(--ink-dim);font-family:"DIN Condensed",sans-serif;width:40px}
.name{font-weight:600;padding-left:14px}
.prow{cursor:pointer;transition:background .15s}
.prow:hover{background:rgba(201,162,39,.06)}
.cat{font-family:"DIN Condensed","Arial Narrow",sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#0a0c10;padding:2px 9px;border-radius:2px;font-weight:700}
.num{font-family:"DIN Condensed",sans-serif;font-size:16px}
.gold{color:var(--gold)}.ice{color:var(--ice)}.red{color:#e0a0a0}.dim{color:var(--ink-dim)}
.score{color:#fff;font-weight:700}
.drow{display:none}
.drow.open{display:table-row}
.drow td{padding:0;background:rgba(0,0,0,.25)}
.drill{padding:8px 8px 8px 40px}
.daterow,.ctarow{margin:4px 0}
.datebtn,.ctabtn{background:none;border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:14px;padding:6px 12px;border-radius:3px;cursor:pointer;text-align:left}
.datebtn:hover,.ctabtn:hover{border-color:var(--gold)}
.datedetail,.ctadetail{display:none;padding:6px 0 6px 24px}
.datedetail.open,.ctadetail.open{display:block}
.ctabtn{font-size:13px;color:var(--ink-dim)}
.ctadetail{font-size:13px;color:var(--ink-dim);line-height:1.6}
.lvl{font-weight:700}
.empty{color:var(--ink-dim);font-style:italic;padding:8px 0}
.legend{margin-top:24px;color:var(--ink-dim);font-size:13px;line-height:1.7}
.legend b{color:var(--ink)}
.hint{text-align:center;color:var(--ice);font-size:13px;margin-bottom:18px;font-style:italic}
footer{text-align:center;margin-top:36px;color:var(--ink-dim);font-size:12px;font-style:italic}
</style></head><body><div class="wrap">
<div class="eyebrow">Imortais · Call to Arms</div>
<h1>Attendance</h1>
<p class="sub">Presença medida pelo tempo na call (Preparação)</p>
<p class="meta">${start.toISOString().slice(0, 10)} — ${end.toISOString().slice(0, 10)} · ${rotulo} · <b style="color:var(--gold)">${report.ctaCount} CTAs no período</b></p>
<p class="hint">👆 Clica num nome pra ver os dias · clica no dia pra ver os CTAs · clica no CTA pra ver horário e tempo</p>
<table>
<thead><tr>
<th>#</th><th class="l">Jogador</th><th>Categoria</th><th>Integral</th><th>Parcial</th><th>Rápida</th><th>Fantasma</th><th>Pingou</th><th>Score</th>
</tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<div class="legend">
<b>Integral:</b> esteve na call desde o começo até o fim · <b>Parcial:</b> ficou ≥30 min mas não o CTA todo · <b>Rápida:</b> passou menos de 30 min · <b>Fantasma:</b> pingou mas não apareceu na call · <b>Pingou:</b> quantas vezes usou o ping no cta-mandatório (informativo).<br>
<b>Score:</b> Integral×3 + Parcial×1 + Rápida×0.5 − Fantasma×1. <b>Categorias</b> (sobre ${report.ctaCount} CTAs): Pilar (≥70% presente) · Regular (≥40%) · Intermitente · Fantasma · Ausente.
</div>
<footer>Gerado pelo bot · Imortais CTA</footer>
</div>
<script>
function togRow(tr){ var d=tr.nextElementSibling; if(d&&d.classList.contains("drow")) d.classList.toggle("open"); }
function tog(btn){ var d=btn.nextElementSibling; if(d) d.classList.toggle("open"); event.stopPropagation(); }
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function slashRemove(interaction, ev) {
  const user = interaction.options.getUser("usuario");
  const pt = interaction.options.getInteger("pt");
  const vaga = interaction.options.getInteger("vaga");

  // modo 1: por @ (pessoa ainda no servidor)
  if (user) {
    const removed = await db.deleteSignup(ev.id, user.id);
    if (!removed) return interaction.reply({ content: `${user} não estava no CTA.`, flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: `🗑️ ${user} removido do CTA ${ev.time_label}.` });
    await applyReallocation(ev, interaction.guild, null);
    await logStaff(interaction.guild, `🗑️ ${interaction.user} removeu ${user} · CTA ${ev.time_label}`);
    return;
  }
  // modo 2: por PT+vaga (pessoa saiu do servidor e não aparece mais no @)
  if (pt && vaga) {
    const su = await db.getSignupAtSlot(ev.id, pt - 1, vaga - 1);
    if (!su) return interaction.reply({ content: `Não há ninguém na PT${pt} vaga ${vaga}.`, flags: MessageFlags.Ephemeral });
    await db.deleteSignup(ev.id, su.user_id);
    await interaction.reply({ content: `🗑️ **${su.username}** removido da PT${pt} vaga ${vaga} (CTA ${ev.time_label}).` });
    await applyReallocation(ev, interaction.guild, null);
    await logStaff(interaction.guild, `🗑️ ${interaction.user} removeu ${su.username} (PT${pt} v${vaga}) · CTA ${ev.time_label}`);
    return;
  }
  return interaction.reply({ content: "Informe **@usuário** (se está no servidor) ou **pt + vaga** (se a pessoa saiu do servidor).", flags: MessageFlags.Ephemeral });
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
  if (!target) return interaction.reply({ content: `Não há vaga livre de **${arma || (existing && existing.weapon) || "essa arma"}** na PT${pt}. Use o campo **vaga** pra forçar numa posição específica, ou tente outra PT.`, flags: MessageFlags.Ephemeral });

  const occupant = await db.getSignupAtSlot(ev.id, target.partyIndex, target.slotIndex);
  const weaponToUse = arma || (existing ? existing.weapon : null);

  if (occupant && occupant.user_id !== user.id) {
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

  await placeUser(ev.id, user.id, interaction, weaponToUse, target, isAdd);
  await interaction.reply({ content: `✅ ${user} → PT${target.partyIndex + 1} v${target.slotIndex + 1}${weaponToUse ? ` (${weaponToUse})` : ""}.` });
  refreshRoster(ev);
  await logStaff(interaction.guild, `🔧 ${interaction.user} ${isAdd ? "adicionou" : "moveu"} ${user} → PT${target.partyIndex + 1} v${target.slotIndex + 1} · CTA ${ev.time_label}`);
}

async function placeUser(eventId, userId, interaction, weapon, target, isAdd) {
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const username = member?.displayName || "jogador";
  await db.upsertSignup({
    eventId, userId, username, weapon: weapon || "?", presence: "online",
    partyIndex: target.partyIndex, slotIndex: target.slotIndex,
  });
}

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
    await db.upsertSignup({ eventId, userId: occupant.user_id, username: occupant.username, weapon: occupant.weapon, presence: occupant.presence, partyIndex: null, slotIndex: null });
  }
  if (choice === "swap" && occupant) {
    const toP = oldP === "" ? null : parseInt(oldP, 10);
    const toS = oldS === "" ? null : parseInt(oldS, 10);
    await db.upsertSignup({ eventId, userId: occupant.user_id, username: occupant.username, weapon: occupant.weapon, presence: occupant.presence, partyIndex: toP, slotIndex: toS });
  }
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
  await db.setBombPingMsg(ev.id, msg.id);
  const thread = await msg.startThread({ name: `Bomb ${time} — contagem`, autoArchiveDuration: 1440 }).catch(() => null);
  if (thread) {
    await db.setBombThread(ev.id, thread.id);
    const leader = CFG.bombLeaderRoleId ? `<@&${CFG.bombLeaderRoleId}>` : "Líder do Bomb";
    await thread.send({ content: `${leader} contagem do bomb pro CTA ${time}:` });
    const c = await thread.send({ content: bombCountText([]) });
    await db.setBombRoster(ev.id, c.id);
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
  if (CFG.bombRoleId && !interaction.member?.roles?.cache?.has(CFG.bombRoleId))
    return interaction.reply({ content: "Só quem tem o cargo Bomb responde aqui.", flags: MessageFlags.Ephemeral });
  const ev = await db.getEvent(eventId);
  if (!ev || ev.status !== "open")
    return interaction.reply({ content: "Esse CTA não está mais aberto.", flags: MessageFlags.Ephemeral });

  const username = interaction.member?.displayName || interaction.user.username;
  await db.upsertBombConfirm(eventId, interaction.user.id, username, coming);
  await interaction.reply({ content: coming ? "💣 Confirmado! Você vai." : "Ok, anotado que não vai.", flags: MessageFlags.Ephemeral });

  const confirms = await db.getBombConfirms(eventId);
  const fresh = await db.getEvent(eventId);
  if (fresh.bomb_thread && fresh.bomb_roster) {
    const countMsgId = String(fresh.bomb_roster).split(",")[0];
    const thread = await client.channels.fetch(fresh.bomb_thread).catch(() => null);
    if (thread) {
      const m = await thread.messages.fetch(countMsgId).catch(() => null);
      if (m) await m.edit({ content: bombCountText(confirms) }).catch(() => {});
    }
  }
}

// ==================  BOMB — FASE B (montagem)  ============================
async function onBombCompChoice(interaction) {
  const [, eventId, comp] = interaction.customId.split("|");
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
  await db.setBombRoster(eventId, `${ev.bomb_roster},${msg.id}`);
}

function buildBombRolePicker(eventId) {
  const roleBtns = Object.entries(ROLES).map(([name, meta]) =>
    new ButtonBuilder().setCustomId(`bombrole|${eventId}|${name}`).setLabel(name).setEmoji(meta.emoji).setStyle(ButtonStyle.Secondary));
  const leave = new ButtonBuilder().setCustomId(`bombleave|${eventId}`).setLabel("Sair").setEmoji("🚪").setStyle(ButtonStyle.Danger);
  const rows = [];
  for (let i = 0; i < roleBtns.length; i += 5) rows.push(new ActionRowBuilder().addComponents(roleBtns.slice(i, i + 5)));
  rows.push(new ActionRowBuilder().addComponents(leave));
  return rows;
}

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

async function onBombRolePick(interaction) {
  const [, eventId, role] = interaction.customId.split("|");
  const ev = await db.getEvent(eventId);
  if (!ev || !ev.bomb_comp) return interaction.reply({ content: "Bomb não está montado.", flags: MessageFlags.Ephemeral });
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

  const signups = await db.getBombSignups(eventId);
  const others = signups.filter((s) => s.user_id !== interaction.user.id);
  const taken = new Set(others.filter((s) => s.slot_index != null).map((s) => s.slot_index));
  const slots = BOMB_COMPS[ev.bomb_comp].slots;

  const isLeader = CFG.bombLeaderRoleId && interaction.member?.roles?.cache?.has(CFG.bombLeaderRoleId);
  let slotIndex = null;
  if (isLeader && slots[0].locked && !taken.has(0) &&
      slots[0].accepts.some((a) => a.weapon.toUpperCase() === weapon.toUpperCase())) {
    slotIndex = 0;
  } else {
    for (let i = 0; i < slots.length; i++) {
      if (taken.has(i) || slots[i].locked) continue;
      if (slots[i].accepts.some((a) => a.weapon.toUpperCase() === weapon.toUpperCase())) { slotIndex = i; break; }
    }
  }
  await db.upsertBombSignup(eventId, interaction.user.id, username, weapon, slotIndex);
  await refreshBombRoster(ev);
  const msg = slotIndex === 0 ? `👑 Você é o **caller do bomb** — **${weapon}** (vaga 1).`
    : slotIndex != null ? `✅ Você entrou como **${weapon}** (vaga ${slotIndex + 1}).`
    : `📝 Reserva (${weapon}) — sem vaga.`;
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

async function refreshBombRoster(ev) {
  const fresh = await db.getEvent(ev.id);
  if (!fresh.bomb_thread || !fresh.bomb_roster || !fresh.bomb_comp) return;
  const ids = String(fresh.bomb_roster).split(",");
  const planilhaId = ids[1];
  if (!planilhaId) return;
  const thread = await client.channels.fetch(fresh.bomb_thread).catch(() => null);
  if (!thread) return;
  const m = await thread.messages.fetch(planilhaId).catch(() => null);
  if (!m) return;
  const signups = await db.getBombSignups(ev.id);
  await m.edit({ content: bombRosterText(ev.id, fresh.bomb_comp, signups) }).catch(() => {});
}

// ======================  HELPERS  ==========================================
function rosterChunks(signups, numParties = 4) {
  const blocks = renderRoster(signups, numParties);
  const chunks = [];
  for (let i = 0; i < numParties; i++) {
    let txt = blocks[i] || "";
    if (i === numParties - 1 && blocks.length > numParties) {
      txt += "\n\n" + blocks.slice(numParties).join("\n\n");
    }
    chunks.push(txt.slice(0, 1990));
  }
  return chunks;
}

const REFRESH_DELAY = 3000;
const refreshTimers = new Map();
const refreshPending = new Map();

function refreshRoster(ev) {
  refreshPending.set(String(ev.id), ev);
  if (refreshTimers.has(String(ev.id))) return;
  const t = setTimeout(async () => {
    refreshTimers.delete(String(ev.id));
    const target = refreshPending.get(String(ev.id));
    refreshPending.delete(String(ev.id));
    if (target) await doRefreshRoster(target).catch((e) => console.error("refresh:", e));
  }, REFRESH_DELAY);
  refreshTimers.set(String(ev.id), t);
}

async function doRefreshRoster(ev) {
  if (!ev.thread_id || !ev.roster_msg) return;
  const fresh = (await db.getEvent(ev.id)) || ev;
  const thread = await client.channels.fetch(fresh.thread_id).catch(() => null);
  if (!thread) return;

  const ids = String(fresh.roster_msg).split(",").filter(Boolean);
  const numParties = fresh.num_parties || ids.length || 4;
  const signups = await db.getSignups(fresh.id);
  const chunks = rosterChunks(signups, numParties);

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

async function pingMainChannel(ev, text) {
  if (!ev.channel_id) return;
  const ch = await client.channels.fetch(ev.channel_id).catch(() => null);
  if (!ch) return;
  const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
  await ch.send({ content: text, ...allow }).catch(() => {});
}

async function pingContentChannel(ev, text) {
  if (!CFG.contentPingChannelId || !ev.thread_id || !ev.guild_id) return;
  const ch = await client.channels.fetch(CFG.contentPingChannelId).catch(() => null);
  if (!ch) return;
  const link = `https://discord.com/channels/${ev.guild_id}/${ev.thread_id}`;
  const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
  await ch.send({ content: `${text}\n👉 ${link}`, ...allow }).catch(() => {});
}

async function checkReminders() {
  try {
    const due = await db.getDueReminders(new Date());
    for (const ev of due) {
      const thread = await client.channels.fetch(ev.thread_id).catch(() => null);
      if (!thread) continue;
      const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
      const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
      const now = Date.now();
      if (!ev.sent_30 && ev.remind_30 && new Date(ev.remind_30).getTime() <= now) {
        await thread.send({ content: `${mention} ⏰ **CTA ${ev.time_label} UTC em 30 minutos!** Prepara o set e loga.`, ...allow }).catch(() => {});
        await pingMainChannel(ev, `${mention} ⏰ **CTA ${ev.time_label} UTC em 30 min!** Loga e entra na thread pra pingar tua função.`);
        await pingContentChannel(ev, `${mention} ⏰ **CTA ${ev.time_label} UTC em 30 min!** Bora pro conteúdo.`);
        await db.markReminderSent(ev.id, 30);
      }
      if (!ev.sent_10 && ev.remind_10 && new Date(ev.remind_10).getTime() <= now) {
        await thread.send({ content: `${mention} 🚨 **CTA ${ev.time_label} UTC em 10 minutos!** Entra na call AGORA.`, ...allow }).catch(() => {});
        await pingMainChannel(ev, `${mention} 🚨 **CTA ${ev.time_label} UTC em 10 min!** Entra na call AGORA.`);
        await pingContentChannel(ev, `${mention} 🚨 **CTA ${ev.time_label} UTC em 10 min!** Entra na call AGORA.`);
        await db.markReminderSent(ev.id, 10);
      }
    }
  } catch (e) { console.error("reminders:", e); }
}

const consolidWarned = new Map();
async function checkConsolidation() {
  try {
    const guilds = client.guilds.cache;
    for (const [gid] of guilds) {
      const abertos = await db.getOpenEvents(gid);
      for (const ev of abertos) {
        const m = /^(\d{1,2}):(\d{2})$/.exec((ev.time_label || "").trim());
        if (!m) continue;
        const base = new Date(ev.created_at);
        const ping = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), +m[1], +m[2], 0, 0));
        const saida = new Date(ping.getTime() + 40 * 60000);
        const minAteSaida = Math.round((saida.getTime() - Date.now()) / 60000);
        const done = consolidWarned.get(String(ev.id)) || new Set();

        const mention = CFG.imortalRoleId ? `<@&${CFG.imortalRoleId}>` : "@Imortal";
        const avisar = async (txt) => {
          const th = ev.thread_id ? await client.channels.fetch(ev.thread_id).catch(() => null) : null;
          const allow = CFG.imortalRoleId ? { allowedMentions: { roles: [CFG.imortalRoleId] } } : {};
          if (th) await th.send({ content: txt, ...allow }).catch(() => {});
          await pingMainChannel(ev, txt);
        };

        if (minAteSaida <= 25 && minAteSaida > 20 && !done.has(25)) {
          await avisar(`${mention} ⚠️ **CTA ${ev.time_label}** — precisamos ajustar as vagas faltantes!`);
          done.add(25);
        }
        if (minAteSaida <= 20 && minAteSaida > 15 && !done.has(20)) {
          await avisar(`${mention} ⚠️ **CTA ${ev.time_label}** — ajustem o quanto antes pra não haver lacunas na sua equipe!`);
          done.add(20);
        }
        if (minAteSaida <= 15 && minAteSaida > 10 && !done.has(15)) {
          await avisar(`${mention} 🧲 **CTA ${ev.time_label}** — amontoamento de participantes disparado.`);
          done.add(15);
        }
        if (minAteSaida <= 10 && minAteSaida > -5 && !done.has(10)) {
          await applyConsolidation(ev, client.guilds.cache.get(gid));
          ctaFrozen.add(String(ev.id));
          await avisar(`${mention} 🔒 **CTA ${ev.time_label}** — formação consolidada e travada. Entrem nas suas vagas!`);
          done.add(10);
        }
        consolidWarned.set(String(ev.id), done);
      }
    }
  } catch (e) { console.error("consolidation:", e); }
}

// ======================  BOOT  =============================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Online como ${c.user.tag}`);
  setInterval(checkReminders, 60 * 1000);
  setInterval(checkConsolidation, 60 * 1000);
  for (const [gid] of c.guilds.cache) {
    try { await cmds.registerCommands(c.user.id, gid); }
    catch (e) { console.error("registerCommands:", e); }
  }
  await reconcileVoice(c);
});

async function reconcileVoice(client) {
  try {
    for (const chId of [CFG.prepVoiceId, CFG.bombVoiceId]) {
      if (!chId) continue;
      await db.voiceCloseAllOpen(chId);
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch || !ch.members) continue;
      const kind = voiceKind(chId);
      for (const [, member] of ch.members) {
        const username = member.displayName || member.user.username;
        await db.voiceJoin(ch.guild.id, member.id, username, chId, kind);
      }
      console.log(`✅ Presença reconciliada em ${kind}: ${ch.members.size} na call`);
    }
  } catch (e) { console.error("reconcileVoice:", e); }
}

(async () => { await db.init(); await client.login(CFG.token); })();