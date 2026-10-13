"use strict";

// Transferência do caller PRINCIPAL, distinta da inscrição em armas/PTs.
// Nunca usa displayName para identificar uma pessoa: somente IDs do Discord.
const CALLER_WEAPONS = Object.freeze(["GOLEM", "MAÇA DE UMA MÃO", "BRUXO DE UMA MÃO", "MONARCA", "HAND OF JUSTICE"]);

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
  if (!CALLER_WEAPONS.includes(String(successor.weapon || "").toUpperCase()))
    throw new CallerTransferError("invalid_weapon", "O novo caller deve ter uma arma de caller (Golem, Monarca, Maça ou Bruxo de uma mão).");
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

module.exports = { CALLER_WEAPONS, CallerTransferError, validateCallerTransfer, transferPrimaryCaller };
