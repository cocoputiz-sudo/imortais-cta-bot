// ============================================================================
// PERFIL DO JOGADOR — Fase 1 (coleta e mostra; NÃO altera a montagem do CTA)
// Wizard guiado (menus + modal, tudo efêmero) que registra, por pessoa:
//   role principal, 1ª arma, 2ª arma, fill, IP de URSINAS/CRAVADAS, e o par
//   core (a pessoa se declara -> a staff confirma).
// As "roles" do perfil batem com as famílias do comps.js. Nada aqui dá cargo
// no Discord nem muda o encaixe — isso fica pras próximas fases.
// ============================================================================
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require("discord.js");
const { WEAPONS, WEAPON_FAMILY } = require("./comps");

const PROFILE_CHANNEL_ID = process.env.PROFILE_CHANNEL_ID || "1550716945718972467";
const STAFF_LOG_CHANNEL_ID = process.env.STAFF_LOG_CHANNEL_ID || null;
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
  Tank:         { label: "Tank (Def)",   emoji: "🛡️" },
  Support:      { label: "Suporte",      emoji: "🎯" },
  Melee:        { label: "DPS Melee",    emoji: "⚔️" },
  Ranged:       { label: "DPS Ranged",   emoji: "🏹" },
  HealerHoly:   { label: "Healer Holy",  emoji: "💚" },
  HealerNature: { label: "Healer Nature", emoji: "🌿" },
};
const ROLE_ORDER = ["Tank", "Support", "Melee", "Ranged", "HealerHoly", "HealerNature"];

// turnos de jogo (batem com os prime times dos pings)
const TURNO_DEFS = {
  Diurno:  { label: "Diurno (15:20\u201319:20 UTC)",  emoji: "\u2600\ufe0f" },
  Noturno: { label: "Noturno (21:20\u201301:20 UTC)", emoji: "\ud83c\udf19" },
};
const TURNO_ORDER = ["Diurno", "Noturno"];

const U = (w) => (w || "").trim().toUpperCase();
const IP_WEAPONS = ["URSINAS", "CRAVADAS"];

// armas que aparecem no menu de cada função
function weaponsForRole(role) {
  const all = Object.keys(WEAPONS);
  if (role === "HealerHoly")   return all.filter((w) => WEAPON_FAMILY[w] === "HEALER_HOLY");
  if (role === "HealerNature") return all.filter((w) => WEAPON_FAMILY[w] === "HEALER_NATURE");
  const map = { Tank: "Tank", Support: "Support", Melee: "Melee", Ranged: "Ranged" };
  const r = map[role];
  return all.filter((w) => (WEAPONS[w] || {}).role === r);
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
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS turnos TEXT;`);
  console.log("✅ Tabela players pronta");
}

async function getPlayer(guildId, userId) {
  const { rows } = await _pool.query(
    `SELECT * FROM players WHERE guild_id=$1 AND user_id=$2`, [guildId, userId]
  );
  return rows[0] || null;
}

async function upsertPlayer(p) {
  const { rows } = await _pool.query(
    `INSERT INTO players
       (guild_id, user_id, username, main_role, roles, w1, w2, fill, turnos, ip_ursinas, ip_cravadas, core_claimed, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       username=EXCLUDED.username, main_role=EXCLUDED.main_role, roles=EXCLUDED.roles,
       w1=EXCLUDED.w1, w2=EXCLUDED.w2, fill=EXCLUDED.fill, turnos=EXCLUDED.turnos,
       ip_ursinas=COALESCE(EXCLUDED.ip_ursinas, players.ip_ursinas),
       ip_cravadas=COALESCE(EXCLUDED.ip_cravadas, players.ip_cravadas),
       core_claimed=EXCLUDED.core_claimed,
       core_verified = CASE WHEN EXCLUDED.core_claimed THEN players.core_verified ELSE false END,
       updated_at=now()
     RETURNING *`,
    [p.guildId, p.userId, p.username, p.mainRole, (p.roles || []).join(","),
     p.w1 || null, p.w2 || null, (p.fill || []).join(","), (p.turnos || []).join(","),
     p.ipUrsinas ?? null, p.ipCravadas ?? null, !!p.coreClaimed]
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
function draft(i) {
  const k = dkey(i);
  if (!drafts.has(k)) drafts.set(k, { fill: [], turnos: [] });
  return drafts.get(k);
}

// ---------------------------------------------------------------------------
// COMPONENTES DE CADA PASSO
// ---------------------------------------------------------------------------
function roleRow() {
  const menu = new StringSelectMenuBuilder().setCustomId("perfil|role").setPlaceholder("Qual tua função principal?");
  for (const r of ROLE_ORDER)
    menu.addOptions({ label: ROLE_DEFS[r].label, value: r, emoji: ROLE_DEFS[r].emoji });
  return new ActionRowBuilder().addComponents(menu);
}

function weaponRow(role, step, withNone) {
  const menu = new StringSelectMenuBuilder().setCustomId(`perfil|${step}`)
    .setPlaceholder(step === "w1" ? "Tua 1ª arma (main)" : "Tua 2ª arma");
  const ws = weaponsForRole(role).slice(0, withNone ? 24 : 25);
  for (const w of ws) menu.addOptions({ label: w.slice(0, 100), value: w });
  if (withNone) menu.addOptions({ label: "— nenhuma (só a 1ª) —", value: "__none__" });
  return new ActionRowBuilder().addComponents(menu);
}

function fillRow() {
  const menu = new StringSelectMenuBuilder().setCustomId("perfil|fill")
    .setPlaceholder("O que você topa flexar? (pode marcar vários)")
    .setMinValues(1).setMaxValues(ROLE_ORDER.length + 1);
  for (const r of ROLE_ORDER)
    menu.addOptions({ label: ROLE_DEFS[r].label, value: r, emoji: ROLE_DEFS[r].emoji });
  menu.addOptions({ label: "Não faço fill", value: "__none__", emoji: "🚫" });
  return new ActionRowBuilder().addComponents(menu);
}

function turnoRow() {
  const menu = new StringSelectMenuBuilder().setCustomId("perfil|turnos")
    .setPlaceholder("Em quais horários você costuma jogar?")
    .setMinValues(1).setMaxValues(TURNO_ORDER.length);
  for (const t of TURNO_ORDER)
    menu.addOptions({ label: TURNO_DEFS[t].label, value: t, emoji: TURNO_DEFS[t].emoji });
  return new ActionRowBuilder().addComponents(menu);
}

function ipButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("perfil|ipopen").setLabel("Informar IP").setEmoji("🔢").setStyle(ButtonStyle.Primary)
  );
}

function coreRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("perfil|core|sim").setLabel("Sou core").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("perfil|core|nao").setLabel("Não sou core").setStyle(ButtonStyle.Secondary)
  );
}

function needsIP(d) {
  return IP_WEAPONS.includes(U(d.w1)) || IP_WEAPONS.includes(U(d.w2));
}

function summary(d) {
  const arma2 = d.w2 && d.w2 !== "__none__" ? d.w2 : "—";
  const fill = (d.fill || []).length ? d.fill.map((r) => ROLE_DEFS[r]?.label || r).join(", ") : "—";
  const ip = [];
  if (d.ipUrsinas) ip.push(`URSINAS ${d.ipUrsinas}`);
  if (d.ipCravadas) ip.push(`CRAVADAS ${d.ipCravadas}`);
  return [
    `**Função:** ${ROLE_DEFS[d.mainRole]?.label || d.mainRole}`,
    `**1ª arma:** ${d.w1} · **2ª:** ${arma2}`,
    `**Fill:** ${fill}`,
    (d.turnos || []).length ? `**Horários:** ${d.turnos.map((t) => TURNO_DEFS[t]?.label || t).join(", ")}` : null,
    ip.length ? `**IP:** ${ip.join(" · ")}` : null,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// FLUXO
// ---------------------------------------------------------------------------
async function openWizard(interaction) {
  const d = draft(interaction);
  d.fill = [];
  const atual = await getPlayer(interaction.guildId, interaction.user.id);
  const nota = atual
    ? `Você já tem perfil (${ROLE_DEFS[atual.main_role]?.label || atual.main_role || "?"}). Refazer sobrescreve o anterior.\n\n`
    : "";
  return interaction.reply({
    content: `📋 **Montar meu perfil**\n${nota}Escolhe tua função principal 👇`,
    components: [roleRow()],
    flags: MessageFlags.Ephemeral,
  });
}

async function onRole(interaction) {
  const d = draft(interaction);
  d.mainRole = interaction.values[0];
  return interaction.update({
    content: `Função: **${ROLE_DEFS[d.mainRole].label}**.\nAgora tua **1ª arma** (a que você mais joga) 👇`,
    components: [weaponRow(d.mainRole, "w1", false)],
  });
}

async function onW1(interaction) {
  const d = draft(interaction);
  d.w1 = interaction.values[0];
  return interaction.update({
    content: `1ª arma: **${d.w1}**.\nTua **2ª opção** (ou "nenhuma") 👇`,
    components: [weaponRow(d.mainRole, "w2", true)],
  });
}

async function onW2(interaction) {
  const d = draft(interaction);
  d.w2 = interaction.values[0];
  return interaction.update({
    content: `Beleza. Agora o **fill**: o que você topa flexar quando a comp pedir? 👇`,
    components: [fillRow()],
  });
}

async function onFill(interaction) {
  const d = draft(interaction);
  d.fill = interaction.values.filter((v) => v !== "__none__");
  return interaction.update({
    content: `${summary(d)}\n\nEm quais **horários** você costuma jogar? 👇`,
    components: [turnoRow()],
  });
}

async function onTurnos(interaction) {
  const d = draft(interaction);
  d.turnos = interaction.values.slice();
  if (needsIP(d)) {
    return interaction.update({
      content: `${summary(d)}\n\nVocê marcou uma arma de IP (URSINAS/CRAVADAS). Clica pra informar o IP 👇`,
      components: [ipButtonRow()],
    });
  }
  return interaction.update({
    content: `${summary(d)}\n\nÚltima: você se considera **core**? (a staff confirma depois) 👇`,
    components: [coreRow()],
  });
}

async function onIpOpen(interaction) {
  const d = draft(interaction);
  const modal = new ModalBuilder().setCustomId("perfil|ipmodal").setTitle("IP das tuas armas");
  if (IP_WEAPONS.includes(U(d.w1)) || IP_WEAPONS.includes(U(d.w2))) {
    if (U(d.w1) === "URSINAS" || U(d.w2) === "URSINAS")
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("ip_ursinas").setLabel("IP URSINAS (ex: 1450)")
          .setStyle(TextInputStyle.Short).setRequired(false)));
    if (U(d.w1) === "CRAVADAS" || U(d.w2) === "CRAVADAS")
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("ip_cravadas").setLabel("IP CRAVADAS (ex: 1450)")
          .setStyle(TextInputStyle.Short).setRequired(false)));
  }
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
  const payload = {
    content: `${summary(d)}\n\nÚltima: você se considera **core**? (a staff confirma depois) 👇`,
    components: [coreRow()],
  };
  if (interaction.isFromMessage && interaction.isFromMessage()) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function onCore(interaction, claimed) {
  const d = draft(interaction);
  d.coreClaimed = claimed;
  const username = interaction.member?.displayName || interaction.user.username;
  await upsertPlayer({
    guildId: interaction.guildId, userId: interaction.user.id, username,
    mainRole: d.mainRole, roles: [d.mainRole, ...(d.fill || [])].filter((v, i, a) => v && a.indexOf(v) === i),
    w1: d.w1, w2: d.w2 && d.w2 !== "__none__" ? d.w2 : null, fill: d.fill, turnos: d.turnos,
    ipUrsinas: d.ipUrsinas, ipCravadas: d.ipCravadas, coreClaimed: claimed,
  });
  drafts.delete(dkey(interaction));

  const cargo = await applyRoleCargo(interaction, d.mainRole);
  const cargoLine = cargo.ok
    ? `\n🏷️ Cargo **${ROLE_DEFS[d.mainRole].label}** aplicado.`
    : `\n⚠️ Não consegui aplicar o cargo. Confere se o bot tem **Gerenciar Cargos** e se o cargo dele está **acima** dos cargos de função.`;

  let extra = "";
  if (claimed) {
    const ok = await notifyStaffCore(interaction, username);
    extra = ok
      ? "\n\n🕐 Você se declarou **core** — mandei pra staff confirmar."
      : "\n\n🕐 Você se declarou **core** — a staff vai confirmar (não achei o canal de staff, avisa um Mestre de Guerra).";
  }
  return interaction.update({
    content: `✅ **Perfil salvo!**\n\n${summary(d)}${cargoLine}${extra}`,
    components: [],
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
  if (!STAFF_LOG_CHANNEL_ID) return false;
  const ch = await interaction.client.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
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
    content: "📋 **Perfil IMORTAL**\nMonta teu perfil pra guerra: função, armas, fill e IP. É rapidinho e tudo privado (só você vê as perguntas). Clica no botão 👇",
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
    if (step === "role") return onRole(interaction);
    if (step === "w1")   return onW1(interaction);
    if (step === "w2")   return onW2(interaction);
    if (step === "fill") return onFill(interaction);
    if (step === "turnos") return onTurnos(interaction);
  }
  if (interaction.isModalSubmit() && step === "ipmodal") return onIpModal(interaction);
}

module.exports = {
  initSchema, openWizard, postPanelCmd, handleComponent,
  getPlayer, upsertPlayer, setVerified, weaponsForRole, ROLE_DEFS,
};
