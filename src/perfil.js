// ============================================================================
// PERFIL DO JOGADOR — Fase 1 (coleta e mostra; NÃO altera a montagem do CTA)
// Wizard guiado (menus + modal, tudo efêmero). Três blocos de função, cada um
// com role + até 2 armas:
//   • Principal  (obrigatório)
//   • 2ª função  (opcional)
//   • Fill       (opcional)
// Mais: horários (diurno/noturno), IP de URSINAS/CRAVADAS e o par core
// (a pessoa se declara -> a staff confirma). As "roles" batem com as famílias
// do comps.js. Nada aqui dá cargo por família nem muda o encaixe do CTA.
// ============================================================================
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require("discord.js");
const { WEAPONS, WEAPON_FAMILY } = require("./comps");
const locale = require("./locale");

const PROFILE_CHANNEL_ID = process.env.PROFILE_CHANNEL_ID || "1550716945718972467";
const STAFF_LOG_CHANNEL_ID = process.env.STAFF_LOG_CHANNEL_ID || null;
const CORE_CHANNEL_ID = process.env.CORE_CHANNEL_ID || "1498805797411622973";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;

// função do perfil -> id do cargo no Discord (override por env se mudar)
const ROLE_TO_CARGO = {
  Tank:         process.env.ROLE_TANK_ID          || "1306706210061553664",
  Support:      process.env.ROLE_SUPPORT_ID       || "1314345337766281216",
  Melee:        process.env.ROLE_MELEE_ID         || "1314348560006774874",
  Ranged:       process.env.ROLE_RANGED_ID        || "1550719720246747136",
  HealerHoly:   process.env.ROLE_HEALER_HOLY_ID   || "1282398769316630568",
  HealerNature: process.env.ROLE_HEALER_NATURE_ID || "1550716206347067464",
};

// ---- funções do perfil (batem com as famílias do motor) ----
const ROLE_DEFS = {
  Tank:         { label: "Tank (Def)",    emoji: "🛡️" },
  Support:      { label: "Suporte",       emoji: "🎯" },
  Melee:        { label: "DPS Melee",     emoji: "⚔️" },
  Ranged:       { label: "DPS Ranged",    emoji: "🏹" },
  HealerHoly:   { label: "Healer Holy",   emoji: "💚" },
  HealerNature: { label: "Healer Nature", emoji: "🌿" },
};
const ROLE_ORDER = ["Tank", "Support", "Melee", "Ranged", "HealerHoly", "HealerNature"];

// turnos de jogo (batem com os prime times dos pings)
const TURNO_DEFS = {
  Diurno:  { label: "Diurno (15:20–19:20 UTC)",  emoji: "☀️" },
  Noturno: { label: "Noturno (21:20–01:20 UTC)", emoji: "🌙" },
};
const TURNO_ORDER = ["Diurno", "Noturno"];

// os três blocos de função
const SLOTS = ["main", "second", "fill"];
const SLOT_LABEL = { main: "Principal", second: "2ª função", fill: "Fill" };
const SLOT_LABEL_ES = { main: "Principal", second: "2ª función", fill: "Fill" };

function isSpanish(interaction) {
  return locale.isSpanishMember(interaction?.member);
}
function roleDisplay(role, es = false) {
  return es ? locale.roleLabel(role, true) : (ROLE_DEFS[role]?.label || role);
}
function weaponDisplay(weapon, es = false) {
  return locale.weaponLabel(weapon, es);
}

const U = (w) => (w || "").trim().toUpperCase();
const IP_WEAPONS = ["URSINAS", "CRAVADAS"];

function weaponsForRole(role) {
  const all = Object.keys(WEAPONS);
  if (role === "HealerHoly")   return all.filter((w) => WEAPON_FAMILY[w] === "HEALER_HOLY");
  if (role === "HealerNature") return all.filter((w) => WEAPON_FAMILY[w] === "HEALER_NATURE");
  const map = { Tank: "Tank", Support: "Support", Melee: "Melee", Ranged: "Ranged" };
  return all.filter((w) => (WEAPONS[w] || {}).role === map[role]);
}

// ---------------------------------------------------------------------------
// BANCO
// ---------------------------------------------------------------------------
let _pool = null;

async function initSchema(pool) {
  _pool = pool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      username      TEXT,
      main_role     TEXT,
      roles         TEXT,
      w1            TEXT,
      w2            TEXT,
      fill          TEXT,
      ip_ursinas    INT,
      ip_cravadas   INT,
      core_claimed  BOOLEAN NOT NULL DEFAULT false,
      core_verified BOOLEAN NOT NULL DEFAULT false,
      verified_by   TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  // migrações (a tabela pode já existir de deploys anteriores)
  for (const col of [
    "turnos TEXT", "role2 TEXT", "r2w1 TEXT", "r2w2 TEXT",
    "fill_role TEXT", "fw1 TEXT", "fw2 TEXT",
  ]) {
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ${col};`);
  }
  console.log("✅ Tabela players pronta");
}

async function getPlayer(guildId, userId) {
  const { rows } = await _pool.query(
    `SELECT * FROM players WHERE guild_id=$1 AND user_id=$2`, [guildId, userId]
  );
  return rows[0] || null;
}

async function upsertPlayer(p) {
  const roles = [p.mainRole, p.role2, p.fillRole].filter((v, i, a) => v && a.indexOf(v) === i);
  const { rows } = await _pool.query(
    `INSERT INTO players
       (guild_id, user_id, username, main_role, roles, w1, w2,
        role2, r2w1, r2w2, fill_role, fw1, fw2, turnos,
        ip_ursinas, ip_cravadas, core_claimed, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       username=EXCLUDED.username, main_role=EXCLUDED.main_role, roles=EXCLUDED.roles,
       w1=EXCLUDED.w1, w2=EXCLUDED.w2,
       role2=EXCLUDED.role2, r2w1=EXCLUDED.r2w1, r2w2=EXCLUDED.r2w2,
       fill_role=EXCLUDED.fill_role, fw1=EXCLUDED.fw1, fw2=EXCLUDED.fw2,
       turnos=EXCLUDED.turnos,
       ip_ursinas=COALESCE(EXCLUDED.ip_ursinas, players.ip_ursinas),
       ip_cravadas=COALESCE(EXCLUDED.ip_cravadas, players.ip_cravadas),
       core_claimed=EXCLUDED.core_claimed,
       core_verified = CASE WHEN EXCLUDED.core_claimed THEN players.core_verified ELSE false END,
       updated_at=now()
     RETURNING *`,
    [p.guildId, p.userId, p.username, p.mainRole, roles.join(","), p.w1 || null, p.w2 || null,
     p.role2 || null, p.r2w1 || null, p.r2w2 || null, p.fillRole || null, p.fw1 || null, p.fw2 || null,
     (p.turnos || []).join(","), p.ipUrsinas ?? null, p.ipCravadas ?? null, !!p.coreClaimed]
  );
  return rows[0];
}

async function setVerified(guildId, userId, verified, byId) {
  await _pool.query(
    `UPDATE players SET core_verified=$3, verified_by=$4, updated_at=now()
     WHERE guild_id=$1 AND user_id=$2`,
    [guildId, userId, verified, byId]
  );
}

// ---------------------------------------------------------------------------
// RASCUNHO EM MEMÓRIA (some se o bot reiniciar no meio; a pessoa refaz)
// ---------------------------------------------------------------------------
const drafts = new Map();
const dkey = (i) => `${i.guildId}:${i.user.id}`;
function freshDraft() {
  return { slots: { main: {}, second: {}, fill: {} }, turnos: [] };
}
function draft(i) {
  const k = dkey(i);
  if (!drafts.has(k)) drafts.set(k, freshDraft());
  return drafts.get(k);
}

// ---------------------------------------------------------------------------
// HELPERS DE ESTADO
// ---------------------------------------------------------------------------
function allWeapons(d) {
  const out = [];
  for (const s of SLOTS) { const sl = d.slots[s]; if (sl.w1) out.push(sl.w1); if (sl.w2) out.push(sl.w2); }
  return out;
}
function needsIP(d) { return allWeapons(d).some((w) => IP_WEAPONS.includes(U(w))); }
function rolesChosen(d) { return SLOTS.map((s) => d.slots[s].role).filter(Boolean); }

function summary(d, es = false) {
  const line = (slot) => {
    const sl = d.slots[slot];
    if (!sl.role) return null;
    const ws = [sl.w1, sl.w2].filter(Boolean).map(w => weaponDisplay(w, es)).join(" / ") || "—";
    const slotLabel = es ? SLOT_LABEL_ES[slot] : SLOT_LABEL[slot];
    return `**${slotLabel}:** ${roleDisplay(sl.role, es)} — ${ws}`;
  };
  const ip = [];
  if (d.ipUrsinas) ip.push(`${weaponDisplay("URSINAS", es)} ${d.ipUrsinas}`);
  if (d.ipCravadas) ip.push(`${weaponDisplay("CRAVADAS", es)} ${d.ipCravadas}`);
  return SLOTS.map(line).filter(Boolean)
    .concat((d.turnos || []).length ? [`**${es ? "Horarios" : "Horários"}:** ${d.turnos.map((t) => TURNO_DEFS[t]?.label || t).join(", ")}`] : [])
    .concat(ip.length ? [`**IP:** ${ip.join(" · ")}`] : [])
    .join("\n") || (es ? "_(todavía no has completado nada)_" : "_(nada preenchido ainda)_");
}

// ---------------------------------------------------------------------------
// COMPONENTES
// ---------------------------------------------------------------------------
function roleRow(slot, exclude = [], skipLabel = null, es = false) {
  const ph = es
    ? (slot === "main" ? "Tu rol principal" : slot === "second" ? "Tu 2º rol" : "Rol de fill")
    : (slot === "main" ? "Tua função principal" : slot === "second" ? "Tua 2ª função" : "Função de fill");
  const menu = new StringSelectMenuBuilder().setCustomId(`perfil|role|${slot}`).setPlaceholder(ph);
  for (const r of ROLE_ORDER) {
    if (exclude.includes(r)) continue;
    menu.addOptions({ label: roleDisplay(r, es), value: r, emoji: ROLE_DEFS[r].emoji });
  }
  if (skipLabel) menu.addOptions({ label: skipLabel, value: "__skip__", emoji: "🚫" });
  return new ActionRowBuilder().addComponents(menu);
}

function weaponRow(role, slot, which, withNone, es = false) {
  const menu = new StringSelectMenuBuilder().setCustomId(`perfil|${which}|${slot}`)
    .setPlaceholder(which === "w1" ? (es ? "1ª arma" : "1ª arma") : (es ? "2ª arma (opcional)" : "2ª arma (opcional)"));
  const ws = weaponsForRole(role).slice(0, withNone ? 24 : 25);
  for (const w of ws) menu.addOptions({ label: weaponDisplay(w, es).slice(0, 100), value: w });
  if (withNone) menu.addOptions({ label: es ? "— ninguna —" : "— nenhuma —", value: "__none__" });
  return new ActionRowBuilder().addComponents(menu);
}

function turnoRow(es = false) {
  const menu = new StringSelectMenuBuilder().setCustomId("perfil|turnos")
    .setPlaceholder(es ? "¿En qué horarios sueles jugar?" : "Em quais horários você costuma jogar?")
    .setMinValues(1).setMaxValues(TURNO_ORDER.length);
  for (const t of TURNO_ORDER) menu.addOptions({ label: TURNO_DEFS[t].label, value: t, emoji: TURNO_DEFS[t].emoji });
  return new ActionRowBuilder().addComponents(menu);
}

function ipButtonRow(es = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("perfil|ipopen").setLabel(es ? "Informar IP" : "Informar IP").setEmoji("🔢").setStyle(ButtonStyle.Primary)
  );
}

function coreRow(es = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("perfil|core|sim").setLabel(es ? "Soy core" : "Sou core").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("perfil|core|nao").setLabel(es ? "No soy core" : "Não sou core").setStyle(ButtonStyle.Secondary)
  );
}

// ---------------------------------------------------------------------------
// FLUXO
// ---------------------------------------------------------------------------
async function openWizard(interaction) {
  const es = isSpanish(interaction);
  drafts.set(dkey(interaction), freshDraft());
  const atual = await getPlayer(interaction.guildId, interaction.user.id);
  const nota = atual
    ? (es ? `Ya tienes un perfil. Si lo rehaces, sustituirá al anterior.\n\n` : `Você já tem perfil. Refazer sobrescreve o anterior.\n\n`)
    : "";
  return interaction.reply({
    content: es
      ? `📋 **Crear mi perfil**\n${nota}Elige tu **rol principal** 👇`
      : `📋 **Montar meu perfil**\n${nota}Escolhe tua **função principal** 👇`,
    components: [roleRow("main", [], null, es)],
    flags: MessageFlags.Ephemeral,
  });
}

async function askSecond(interaction) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  return interaction.update({
    content: es
      ? `${summary(d, es)}\n\n¿Juegas un **2º rol**? 👇`
      : `${summary(d, es)}\n\nVocê joga uma **2ª função**? 👇`,
    components: [roleRow("second", rolesChosen(d), es ? "No tengo 2º rol" : "Não tenho 2ª função", es)],
  });
}
async function askFill(interaction) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  return interaction.update({
    content: es
      ? `${summary(d, es)}\n\n¿Tienes un **rol de fill** para cubrir huecos? 👇`
      : `${summary(d, es)}\n\nTem uma **função de fill** (que você pega pra tapar buraco)? 👇`,
    components: [roleRow("fill", rolesChosen(d), es ? "No tengo fill" : "Não tenho fill", es)],
  });
}
async function askTurnos(interaction) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  return interaction.update({
    content: es
      ? `${summary(d, es)}\n\n¿En qué **horarios** sueles jugar? 👇`
      : `${summary(d, es)}\n\nEm quais **horários** você costuma jogar? 👇`,
    components: [turnoRow(es)],
  });
}
async function advanceAfterSlot(interaction, slot) {
  if (slot === "main") return askSecond(interaction);
  if (slot === "second") return askFill(interaction);
  return askTurnos(interaction); // fill
}

async function onRolePick(interaction, slot) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  const v = interaction.values[0];
  if (v === "__skip__") return advanceAfterSlot(interaction, slot);
  d.slots[slot] = { role: v };
  const slotLabel = es ? SLOT_LABEL_ES[slot] : SLOT_LABEL[slot];
  return interaction.update({
    content: es
      ? `${slotLabel}: **${roleDisplay(v, es)}**.\nElige tu **1ª arma** para este rol 👇`
      : `${slotLabel}: **${roleDisplay(v, es)}**.\nTua **1ª arma** nessa função 👇`,
    components: [weaponRow(v, slot, "w1", false, es)],
  });
}
async function onW1(interaction, slot) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  d.slots[slot].w1 = interaction.values[0];
  return interaction.update({
    content: es
      ? `1ª arma: **${weaponDisplay(d.slots[slot].w1, es)}**.\nElige tu **2ª arma** para este rol (o ninguna) 👇`
      : `1ª arma: **${weaponDisplay(d.slots[slot].w1, es)}**.\n**2ª arma** nessa função (ou nenhuma) 👇`,
    components: [weaponRow(d.slots[slot].role, slot, "w2", true, es)],
  });
}
async function onW2(interaction, slot) {
  const d = draft(interaction);
  const v = interaction.values[0];
  d.slots[slot].w2 = v === "__none__" ? null : v;
  return advanceAfterSlot(interaction, slot);
}

async function onTurnos(interaction) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  d.turnos = interaction.values.slice();
  if (needsIP(d)) {
    return interaction.update({
      content: es
        ? `${summary(d, es)}\n\nMarcaste un arma que necesita IP (${weaponDisplay("URSINAS", es)}/${weaponDisplay("CRAVADAS", es)}). Pulsa para informar el IP 👇`
        : `${summary(d, es)}\n\nVocê marcou uma arma de IP (URSINAS/CRAVADAS). Clica pra informar o IP 👇`,
      components: [ipButtonRow(es)],
    });
  }
  return interaction.update({
    content: es
      ? `${summary(d, es)}\n\nÚltima pregunta: ¿te consideras **core**? (la staff lo confirma después) 👇`
      : `${summary(d, es)}\n\nÚltima: você se considera **core**? (a staff confirma depois) 👇`,
    components: [coreRow(es)],
  });
}

async function onIpOpen(interaction) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  const ws = allWeapons(d).map(U);
  const modal = new ModalBuilder().setCustomId("perfil|ipmodal").setTitle(es ? "IP de tus armas" : "IP das tuas armas");
  if (ws.includes("URSINAS"))
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("ip_ursinas").setLabel(`IP ${weaponDisplay("URSINAS", es)} (${es ? "ej" : "ex"}: 1450)`.slice(0, 45))
        .setStyle(TextInputStyle.Short).setRequired(false)));
  if (ws.includes("CRAVADAS"))
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("ip_cravadas").setLabel(`IP ${weaponDisplay("CRAVADAS", es)} (${es ? "ej" : "ex"}: 1450)`.slice(0, 45))
        .setStyle(TextInputStyle.Short).setRequired(false)));
  return interaction.showModal(modal);
}

async function onIpModal(interaction) {
  const d = draft(interaction);
  const parse = (id) => {
    let f = "";
    try { f = interaction.fields.getTextInputValue(id); } catch { return null; }
    const n = parseInt((f || "").replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  d.ipUrsinas = parse("ip_ursinas") ?? d.ipUrsinas ?? null;
  d.ipCravadas = parse("ip_cravadas") ?? d.ipCravadas ?? null;
  const es = isSpanish(interaction);
  const payload = {
    content: es
      ? `${summary(d, es)}\n\nÚltima pregunta: ¿te consideras **core**? (la staff lo confirma después) 👇`
      : `${summary(d, es)}\n\nÚltima: você se considera **core**? (a staff confirma depois) 👇`,
    components: [coreRow(es)],
  };
  if (interaction.isFromMessage && interaction.isFromMessage()) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function onCore(interaction, claimed) {
  const d = draft(interaction);
  const es = isSpanish(interaction);
  const username = interaction.member?.displayName || interaction.user.username;
  await upsertPlayer({
    guildId: interaction.guildId, userId: interaction.user.id, username,
    mainRole: d.slots.main.role, w1: d.slots.main.w1, w2: d.slots.main.w2,
    role2: d.slots.second.role, r2w1: d.slots.second.w1, r2w2: d.slots.second.w2,
    fillRole: d.slots.fill.role, fw1: d.slots.fill.w1, fw2: d.slots.fill.w2,
    turnos: d.turnos, ipUrsinas: d.ipUrsinas, ipCravadas: d.ipCravadas, coreClaimed: claimed,
  });
  drafts.delete(dkey(interaction));

  const cargo = await applyRoleCargo(interaction, d.slots.main.role);
  const cargoLine = cargo.ok
    ? (es
      ? `\n🏷️ Rol **${roleDisplay(d.slots.main.role, es)}** aplicado.`
      : `\n🏷️ Cargo **${roleDisplay(d.slots.main.role, es)}** aplicado.`)
    : (es
      ? `\n⚠️ No pude aplicar el rol. Comprueba que el bot tenga **Gestionar roles** y esté por encima de los roles de función.`
      : `\n⚠️ Não consegui aplicar o cargo. Confere se o bot tem **Gerenciar Cargos** e se o cargo dele está **acima** dos cargos de função.`);

  let extra = "";
  if (claimed) {
    const ok = await notifyStaffCore(interaction, username);
    extra = es
      ? (ok
        ? "\n\n🕐 Te declaraste **core**; envié la solicitud a la staff."
        : "\n\n🕐 Te declaraste **core**; la staff lo confirmará después.")
      : (ok
        ? "\n\n🕐 Você se declarou **core** — mandei pra staff confirmar."
        : "\n\n🕐 Você se declarou **core** — a staff vai confirmar (não achei o canal de staff, avisa um Mestre de Guerra).");
  }
  return interaction.update({
    content: es
      ? `✅ **¡Perfil guardado!**\n\n${summary(d, es)}${cargoLine}${extra}`
      : `✅ **Perfil salvo!**\n\n${summary(d, es)}${cargoLine}${extra}`,
    components: []
  });
}

// Dá o cargo da função principal e tira os outros cargos de função (troca).
// Só mexe nos 6 cargos do mapa; não encosta em nenhum outro cargo da pessoa.
async function applyRoleCargo(interaction, mainRole) {
  const target = ROLE_TO_CARGO[mainRole];
  if (!target) return { ok: false, err: "sem cargo pra essa função" };
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const managed = Object.values(ROLE_TO_CARGO);
    const toRemove = managed.filter((id) => id !== target && member.roles.cache.has(id));
    if (toRemove.length) await member.roles.remove(toRemove, "Perfil IMORTAL: troca de função");
    if (!member.roles.cache.has(target)) await member.roles.add(target, "Perfil IMORTAL: função principal");
    return { ok: true };
  } catch (e) {
    console.error("applyRoleCargo:", e?.message || e);
    return { ok: false, err: e?.message || String(e) };
  }
}

async function notifyStaffCore(interaction, username) {
  if (!CORE_CHANNEL_ID) return false;
  const ch = await interaction.client.channels.fetch(CORE_CHANNEL_ID).catch(() => null);
  if (!ch) return false;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`perfil|verify|${interaction.user.id}|ok`).setLabel("Confirmar core").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`perfil|verify|${interaction.user.id}|no`).setLabel("Não é core").setStyle(ButtonStyle.Danger)
  );
  const ping = STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}> ` : "";
  await ch.send({
    content: `${ping}🧾 **${username}** se declarou **CORE**. Confirma?`,
    components: [row],
    allowedMentions: { roles: STAFF_ROLE_ID ? [STAFF_ROLE_ID] : [] },
  }).catch(() => {});
  return true;
}

async function onVerify(interaction, targetId, decision) {
  if (STAFF_ROLE_ID && !interaction.member?.roles?.cache?.has(STAFF_ROLE_ID))
    return interaction.reply({ content: "Só Mestre de Guerra confirma core.", flags: MessageFlags.Ephemeral });
  const verified = decision === "ok";
  await setVerified(interaction.guildId, targetId, verified, interaction.user.id);
  return interaction.update({
    content: `${verified ? "✅" : "❌"} Core de <@${targetId}> ${verified ? "**confirmado**" : "**negado**"} por ${interaction.user}.`,
    components: [],
  });
}

// ---------------------------------------------------------------------------
// PAINEL FIXO NO CANAL DE PERFIL
// ---------------------------------------------------------------------------
async function postPanelCmd(interaction) {
  if (STAFF_ROLE_ID && !interaction.member?.roles?.cache?.has(STAFF_ROLE_ID))
    return interaction.reply({ content: "Só Mestre de Guerra posta o painel.", flags: MessageFlags.Ephemeral });
  const ch = await interaction.client.channels.fetch(PROFILE_CHANNEL_ID).catch(() => null);
  if (!ch) return interaction.reply({ content: "Não achei o canal de perfil (confere o PROFILE_CHANNEL_ID).", flags: MessageFlags.Ephemeral });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("perfil|start").setLabel("Montar meu perfil").setEmoji("📋").setStyle(ButtonStyle.Primary)
  );
  await ch.send({
    content: "📋 **Perfil IMORTAL**\nMonta teu perfil pra guerra: função principal, 2ª função, fill, horários e IP. É rapidinho e privado (só você vê as perguntas). Clica no botão 👇",
    components: [row],
  });
  return interaction.reply({ content: `✅ Painel postado em <#${PROFILE_CHANNEL_ID}>.`, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// DISPATCHER (chamado pelo index.js pra qualquer customId "perfil...")
// ---------------------------------------------------------------------------
async function handleComponent(interaction) {
  const parts = interaction.customId.split("|");
  const step = parts[1];
  if (interaction.isButton()) {
    if (step === "start")  return openWizard(interaction);
    if (step === "ipopen") return onIpOpen(interaction);
    if (step === "core")   return onCore(interaction, parts[2] === "sim");
    if (step === "verify") return onVerify(interaction, parts[2], parts[3]);
  }
  if (interaction.isStringSelectMenu()) {
    if (step === "role")   return onRolePick(interaction, parts[2]);
    if (step === "w1")     return onW1(interaction, parts[2]);
    if (step === "w2")     return onW2(interaction, parts[2]);
    if (step === "turnos") return onTurnos(interaction);
  }
  if (interaction.isModalSubmit() && step === "ipmodal") return onIpModal(interaction);
}

// ---------------------------------------------------------------------------
// CONSULTA (ver o próprio, ver de alguém, listar)
// ---------------------------------------------------------------------------
function coreStatus(p) {
  return p.core_verified ? "✅ confirmado" : p.core_claimed ? "🕐 declarado (aguardando staff)" : "—";
}
function fmtSlot(role, w1, w2) {
  if (!role) return null;
  const ws = [w1, w2].filter(Boolean).join(" / ") || "—";
  return `${ROLE_DEFS[role]?.label || role} — ${ws}`;
}
function turnosOf(p) {
  return (p.turnos || "").split(",").filter(Boolean);
}
function formatFull(p) {
  const lines = [`👤 **${p.username || p.user_id}**`];
  const main = fmtSlot(p.main_role, p.w1, p.w2); if (main) lines.push(`**Principal:** ${main}`);
  const s2 = fmtSlot(p.role2, p.r2w1, p.r2w2);   if (s2)   lines.push(`**2ª função:** ${s2}`);
  const sf = fmtSlot(p.fill_role, p.fw1, p.fw2);  if (sf)   lines.push(`**Fill:** ${sf}`);
  const t = turnosOf(p).map((x) => TURNO_DEFS[x]?.label || x);
  if (t.length) lines.push(`**Horários:** ${t.join(", ")}`);
  const ip = [];
  if (p.ip_ursinas) ip.push(`URSINAS ${p.ip_ursinas}`);
  if (p.ip_cravadas) ip.push(`CRAVADAS ${p.ip_cravadas}`);
  if (ip.length) lines.push(`**IP:** ${ip.join(" · ")}`);
  lines.push(`**Core:** ${coreStatus(p)}`);
  return lines.join("\n");
}
function formatShort(p) {
  let head = ROLE_DEFS[p.main_role]?.label || p.main_role || "?";
  if (p.w1) head += ` (${p.w1})`;
  const parts = [head];
  if (p.role2) parts.push(`2ª ${ROLE_DEFS[p.role2]?.label || p.role2}`);
  if (p.fill_role) parts.push(`fill ${ROLE_DEFS[p.fill_role]?.label || p.fill_role}`);
  const t = turnosOf(p).map((x) => x[0]).join("");
  const flag = p.core_verified ? " ⭐" : p.core_claimed ? " 🕐" : "";
  return `**${p.username || p.user_id}** — ${parts.join(" · ")}${t ? ` · [${t}]` : ""}${flag}`;
}

async function allPlayers(guildId) {
  const { rows } = await _pool.query(
    `SELECT * FROM players WHERE guild_id=$1 ORDER BY main_role, lower(username)`, [guildId]
  );
  return rows;
}

async function viewOwn(interaction) {
  const p = await getPlayer(interaction.guildId, interaction.user.id);
  if (!p) return interaction.reply({ content: "Você ainda não montou perfil. Usa **/perfil** ou o botão no canal de perfil.", flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: formatFull(p), flags: MessageFlags.Ephemeral });
}

async function viewOf(interaction) {
  const user = interaction.options.getUser("usuario");
  const p = await getPlayer(interaction.guildId, user.id);
  if (!p) return interaction.reply({ content: `**${user.username}** ainda não tem perfil.`, flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: formatFull(p), flags: MessageFlags.Ephemeral });
}

async function listCmd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const funcao = interaction.options.getString("funcao");
  const turno = interaction.options.getString("turno");
  const core = interaction.options.getString("core");
  let rows = await allPlayers(interaction.guildId);
  if (funcao) rows = rows.filter((p) => [p.main_role, p.role2, p.fill_role].includes(funcao));
  if (turno)  rows = rows.filter((p) => turnosOf(p).includes(turno));
  if (core === "sim") rows = rows.filter((p) => p.core_verified);
  else if (core === "nao") rows = rows.filter((p) => !p.core_verified);

  const filtros = [funcao && ROLE_DEFS[funcao]?.label, turno && TURNO_DEFS[turno]?.label,
    core === "sim" && "core", core === "nao" && "sem core"].filter(Boolean).join(" · ");
  const header = `📇 **Perfis** (${rows.length})${filtros ? ` — ${filtros}` : ""}`;
  if (!rows.length) return interaction.editReply({ content: header + "\n\n_(ninguém com esse filtro)_" });

  const linhas = rows.map((p, i) => `${String(i + 1).padStart(3)}. ${formatShort(p)}`);
  const msg = { content: `${header}\n\n${linhas.slice(0, 25).join("\n")}` };
  if (linhas.length > 25) {
    const plain = linhas.map((l) => l.replace(/\*/g, "")).join("\n");
    const buf = Buffer.from(`${header.replace(/\*/g, "")}\n\n${plain}\n`, "utf-8");
    msg.content += `\n\n_Mostrando 25 de ${rows.length}. Lista completa no anexo 👇_`;
    msg.files = [{ attachment: buf, name: "perfis.txt" }];
  }
  return interaction.editReply(msg);
}

async function corePending(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { rows } = await _pool.query(
    `SELECT * FROM players WHERE guild_id=$1 AND core_claimed=true AND core_verified=false
     ORDER BY updated_at DESC`,
    [interaction.guildId]
  );
  if (!rows.length) return interaction.editReply({ content: "✅ Ninguém com core pendente de confirmação." });

  const cap = rows.slice(0, 20);
  await interaction.editReply({
    content: `🧾 **Core pendente** — ${rows.length} pessoa(s)${rows.length > 20 ? " (mostrando as 20 mais recentes)" : ""}. Confirma cada uma abaixo:`,
  });
  for (const p of cap) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`perfil|verify|${p.user_id}|ok`).setLabel("Confirmar core").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perfil|verify|${p.user_id}|no`).setLabel("Não é core").setStyle(ButtonStyle.Danger)
    );
    await interaction.followUp({
      content: `**${p.username || p.user_id}** — ${ROLE_DEFS[p.main_role]?.label || p.main_role || "?"}${p.w1 ? ` (${p.w1})` : ""}`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

module.exports = {
  initSchema, openWizard, postPanelCmd, handleComponent,
  viewOwn, viewOf, listCmd, corePending,
  getPlayer, upsertPlayer, setVerified, weaponsForRole, ROLE_DEFS,
};
