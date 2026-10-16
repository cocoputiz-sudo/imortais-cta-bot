"use strict";
const { CallerTransferError } = require("./caller-transfer");

// Ao contrário do fallback legado de isStaff, ausência de cargo configurado
// nunca libera esta operação para qualquer membro ou para o próprio caller.
function canRecoverCaller(interaction, staffRoleIds = []) {
  const userId = interaction.user?.id;
  if (!userId || !interaction.guildId || !interaction.guild) return false;
  if (String(interaction.guild.ownerId) === String(userId)) return true;
  const permissions = interaction.member?.permissions;
  if (permissions?.has?.(8n) || permissions?.has?.(32n)) return true;
  return staffRoleIds.filter(Boolean).some(id => interaction.member?.roles?.cache?.has(id));
}

async function handleCallerRecovery(interaction, ev, { db, staffRoleIds, refreshRoster, logStaff }) {
  if (!canRecoverCaller(interaction, staffRoleIds))
    return interaction.reply({ content:"Somente o dono do servidor, administradores ou Mestre de Guerra podem substituir o caller.", flags:64 });
  if (!ev || String(ev.guild_id) !== String(interaction.guildId))
    return interaction.reply({ content:"CTA não encontrado neste servidor.", flags:64 });
  await interaction.deferReply({ flags:64 });
  const user = interaction.options.getUser("usuario");
  const member = user && await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member || user.bot)
    return interaction.editReply({ content:"O novo caller precisa ser uma pessoa que ainda pertence a este servidor." });
  let result;
  try {
    result = await db.recoverCaller({ eventId:ev.id,guildId:interaction.guildId,
      fromUserId:ev.caller_id,toUserId:user.id,actorId:interaction.user.id,
      username:member.displayName || user.username,
      weapon:interaction.options.getString("arma"),reason:interaction.options.getString("motivo"),
      presence:user.id === interaction.user.id ? "online" : "later" });
  } catch (err) {
    if (err instanceof CallerTransferError) return interaction.editReply({ content:err.message });
    throw err;
  }
  // A liderança já foi confirmada no banco; falhas de notificação não devem
  // aparentar que a operação inteira falhou nem permitir que seja repetida.
  try { await refreshRoster(result.event); } catch (err) { console.error("caller recovery roster:",err.message); }
  try {
    await logStaff(interaction.guild,
      `👑 SUBSTITUIÇÃO DE CALLER · CTA ${result.event.time_label} · <@${result.previousCallerId}> → <@${user.id}>` +
      ` · ${result.successor.weapon} · PT1 vaga 1 · por <@${interaction.user.id}>` +
      ` · Motivo: ${result.reason.replace(/@/g,"＠").replace(/[\r\n]/g," ")}`);
  } catch (err) { console.error("caller recovery log:",err.message); }
  return interaction.editReply({
    content:`👑 Caller substituído: <@${user.id}> · **${result.successor.weapon}** · **PT1 vaga 1**. ` +
      "O anterior ficou na reserva e pode ser retirado com /cta_remove. Liderança e permissões foram transferidas.",
    allowedMentions:{ parse:[] }
  });
}
module.exports = { canRecoverCaller, handleCallerRecovery };
