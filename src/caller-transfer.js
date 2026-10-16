"use strict";

// Transferência do caller PRINCIPAL, distinta da inscrição em armas/PTs.
// Nunca usa displayName para identificar uma pessoa: somente IDs do Discord.
const CALLER_WEAPONS = Object.freeze(["GOLEM", "MAÇA DE UMA MÃO", "BRUXO DE UMA MÃO", "MONARCA", "HAND OF JUSTICE"]);
const { WEAPONS } = require("./comps");

class CallerTransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CallerTransferError";
    this.code = code;
  }
}

function validateCallerTransfer(ev, signups, { guildId, fromUserId, toUserId }) {
  if (!ev || String(ev.guild_id) !== String(guildId))
    throw new CallerTransferError("not_found", "CTA não encontrado neste servidor.");
  if (ev.status !== "open")
    throw new CallerTransferError("closed", "Esse CTA já está encerrado ou cancelado.");
  if (String(ev.caller_id) !== String(fromUserId))
    throw new CallerTransferError("not_caller", "Somente o caller principal atual pode transferir a liderança.");
  if (!toUserId || String(fromUserId) === String(toUserId))
    throw new CallerTransferError("same_user", "Selecione outra conta do Discord para assumir a liderança.");
  const successor = signups.find(s => String(s.user_id) === String(toUserId));
  if (!successor)
    throw new CallerTransferError("not_signed", "O novo caller precisa estar inscrito neste CTA. Adicione-o com /cta_add antes de transferir.");
  if (!WEAPONS[String(successor.weapon || "").toUpperCase()])
    throw new CallerTransferError("invalid_weapon", "O novo caller precisa ter uma arma válida do catálogo do CTA.");
  const firstParty = String(ev.party_list || "0").split(",").map(Number).find(Number.isInteger);
  if (firstParty == null || firstParty < 0)
    throw new CallerTransferError("missing_party", "PT1 indisponível. Abra a PT1 antes de transferir.");
  return { successor, firstParty };
}

async function transferPrimaryCaller(pool, args) {
  const client = await pool.connect();
  let tx = false;
  try {
    await client.query("BEGIN");
    tx = true;
    // SERIALIZA transferências concorrentes e confere o caller novamente.
    const { rows: events } = await client.query(
      "SELECT * FROM cta_events WHERE id=$1 FOR UPDATE", [args.eventId]
    );
    const { rows: signups } = await client.query(
      "SELECT * FROM cta_signups WHERE event_id=$1 FOR UPDATE", [args.eventId]
    );
    const { successor, firstParty } = validateCallerTransfer(events[0], signups, args);

    // O ocupante anterior fica na reserva, mantendo nome, arma e identidade.
    // Não apagar inscrições do antigo caller nem de suas contas secundárias.
    const { rows: displaced } = await client.query(
      `UPDATE cta_signups
         SET party_index=NULL, slot_index=NULL, manual=false
       WHERE event_id=$1 AND party_index=$2 AND slot_index=0 AND user_id<>$3
       RETURNING user_id, username, weapon`,
      [args.eventId, firstParty, args.toUserId]
    );

    const { rows: placed } = await client.query(
      `UPDATE cta_signups
         SET party_index=$3, slot_index=0, manual=true, second_caller=false
       WHERE event_id=$1 AND user_id=$2
       RETURNING user_id, username, weapon, party_index, slot_index, second_caller`,
      [args.eventId, args.toUserId, firstParty]
    );
    if (!placed[0]) throw new CallerTransferError("not_signed", "O novo caller saiu do CTA durante a operação.");

    const { rows: updated } = await client.query(
      `UPDATE cta_events SET caller_id=$2
       WHERE id=$1 AND caller_id=$3 AND status='open'
       RETURNING id, caller_id, time_label, thread_id`,
      [args.eventId, args.toUserId, args.fromUserId]
    );
    if (!updated[0]) throw new CallerTransferError("concurrent", "A titularidade do CTA mudou. Atualize a planilha e tente novamente.");

    await client.query("COMMIT");
    tx = false;
    return { event: updated[0], successor: placed[0], previousCallerId: args.fromUserId, displaced };
  } catch (e) {
    if (tx) await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * O posto de caller é definido por cta_events.caller_id, NÃO pela arma.
 * A conta do caller principal pode usar qualquer arma cadastrada mantendo
 * PT1 visual, vaga 1 (inclusive MARTELO DE BATALHA).
 * Lock no evento protege contra transferências concorrentes.
 */
async function assignPrimaryCallerWeapon(pool, args) {
  const client = await pool.connect();
  let tx = false;
  try {
    await client.query("BEGIN");
    tx = true;
    const { rows: events } = await client.query(
      "SELECT id, guild_id, caller_id, status, party_list FROM cta_events WHERE id=$1 FOR UPDATE",
      [args.eventId]
    );
    const ev = events[0];
    if (!ev || String(ev.guild_id) !== String(args.guildId))
      throw new CallerTransferError("not_found", "CTA não encontrado neste servidor.");
    if (ev.status !== "open")
      throw new CallerTransferError("closed", "Esse CTA já está encerrado ou cancelado.");
    if (String(ev.caller_id) !== String(args.userId))
      throw new CallerTransferError("not_caller", "Este CTA já tem outro caller principal. Atualize a planilha.");
    const weapon = String(args.weapon || "").toUpperCase();
    if (!WEAPONS[weapon])
      throw new CallerTransferError("invalid_weapon", "A arma selecionada não pertence ao catálogo do CTA.");

    const party = String(ev.party_list || "0").split(",")
      .map(v => Number(v.trim())).find(v => Number.isInteger(v) && v >= 0);
    if (party == null)
      throw new CallerTransferError("missing_party", "PT1 indisponível. Abra a PT1 antes de escolher sua arma.");

    const { rows: displaced } = await client.query(
      `UPDATE cta_signups
          SET party_index=NULL, slot_index=NULL, manual=false
        WHERE event_id=$1 AND party_index=$2 AND slot_index=0 AND user_id<>$3
        RETURNING user_id, username, weapon`,
      [args.eventId, party, args.userId]
    );

    const { rows: placed } = await client.query(
      `INSERT INTO cta_signups
         (event_id, user_id, username, weapon, presence, party_index, slot_index, ip, manual, second_caller)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,true,false)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         weapon=EXCLUDED.weapon,
         presence=EXCLUDED.presence,
         party_index=EXCLUDED.party_index,
         slot_index=EXCLUDED.slot_index,
         ip=COALESCE(EXCLUDED.ip, cta_signups.ip),
         manual=true,
         second_caller=false,
         created_at=now()
       RETURNING *`,
      [args.eventId, args.userId, args.username, weapon, args.presence, party, args.ip ?? null]
    );
    if (!placed[0]) throw new CallerTransferError("not_placed", "Não foi possível colocar o caller na PT1.");

    await client.query("COMMIT");
    tx = false;
    return { signup: placed[0], displaced, partyIndex: party };
  } catch (err) {
    if (tx) await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Recuperação administrativa: não depende da presença nem do consentimento do
// caller anterior. O handler deve autorizar a staff antes de chamar esta função.
function validateCallerRecovery(ev, args) {
  if (!ev || String(ev.guild_id) !== String(args.guildId))
    throw new CallerTransferError("not_found", "CTA não encontrado neste servidor.");
  if (ev.status !== "open")
    throw new CallerTransferError("closed", "Esse CTA já está encerrado ou cancelado.");
  if (!args.fromUserId || String(ev.caller_id) !== String(args.fromUserId))
    throw new CallerTransferError("concurrent", "O caller mudou. Confira o CTA antes de tentar novamente.");
  if (!args.actorId)
    throw new CallerTransferError("missing_actor", "Informe quem está substituindo o caller.");
  if (!args.toUserId || String(args.toUserId) === String(ev.caller_id))
    throw new CallerTransferError("same_user", "Selecione outra conta para substituir o caller atual.");
  const reason = String(args.reason || "").trim();
  if (reason.length < 5 || reason.length > 300)
    throw new CallerTransferError("missing_reason", "Informe um motivo entre 5 e 300 caracteres.");
  const weapon = String(args.weapon || "").trim().toUpperCase();
  if (!WEAPONS[weapon])
    throw new CallerTransferError("invalid_weapon", "Escolha uma arma válida do catálogo do CTA.");
  const firstParty = String(ev.party_list || "0").split(",").filter(v => v.trim())
    .map(Number)[0];
  if (!Number.isInteger(firstParty) || firstParty < 0)
    throw new CallerTransferError("missing_party", "PT1 indisponível neste CTA.");
  return { reason, weapon, firstParty };
}

async function recoverPrimaryCaller(pool, args) {
  const client = await pool.connect();
  let tx = false;
  try {
    await client.query("BEGIN");
    tx = true;
    const { rows: events } = await client.query(
      "SELECT * FROM cta_events WHERE id=$1 FOR UPDATE", [args.eventId]);
    const { reason, weapon, firstParty } = validateCallerRecovery(events[0], args);
    await client.query("SELECT * FROM cta_signups WHERE event_id=$1 FOR UPDATE", [args.eventId]);
    // Reserva o anterior mesmo se sua vaga já tiver sido alterada. Outras contas
    // e inscrições são preservadas, sempre identificadas pelo ID do Discord.
    const { rows: displaced } = await client.query(
      `UPDATE cta_signups SET party_index=NULL, slot_index=NULL, manual=false, second_caller=false
       WHERE event_id=$1 AND user_id<>$3
         AND ((party_index=$2 AND slot_index=0) OR user_id=$4)
       RETURNING user_id, username, weapon`,
      [args.eventId, firstParty, args.toUserId, args.fromUserId]);
    const { rows: placed } = await client.query(
      `INSERT INTO cta_signups
         (event_id,user_id,username,weapon,presence,party_index,slot_index,manual,second_caller)
       VALUES ($1,$2,$3,$4,$5,$6,0,true,false)
       ON CONFLICT (event_id,user_id) DO UPDATE SET
         username=EXCLUDED.username, weapon=EXCLUDED.weapon,
         party_index=EXCLUDED.party_index, slot_index=0, manual=true, second_caller=false
       RETURNING *`,
      [args.eventId,args.toUserId,args.username,weapon,args.presence || "later",firstParty]);
    const { rows: updated } = await client.query(
      `UPDATE cta_events SET caller_id=$2
       WHERE id=$1 AND caller_id=$3 AND status='open'
       RETURNING id,caller_id,time_label,thread_id`,
      [args.eventId,args.toUserId,args.fromUserId]);
    if (!updated[0]) throw new CallerTransferError("concurrent", "O caller mudou durante a substituição.");
    const { rows: audit } = await client.query(
      `INSERT INTO cta_caller_recoveries
         (event_id,guild_id,actor_id,previous_caller_id,new_caller_id,weapon,reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,
      [args.eventId,args.guildId,args.actorId,args.fromUserId,args.toUserId,weapon,reason]);
    await client.query("COMMIT");
    tx = false;
    return { event:updated[0],successor:placed[0],previousCallerId:args.fromUserId,
      displaced,audit:audit[0],reason };
  } catch (err) {
    if (tx) await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

module.exports = { CALLER_WEAPONS, CallerTransferError, validateCallerTransfer, transferPrimaryCaller,
  assignPrimaryCallerWeapon, validateCallerRecovery, recoverPrimaryCaller };
