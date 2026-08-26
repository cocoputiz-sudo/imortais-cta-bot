// Camada de banco (Postgres). Reaproveita o mesmo padrão do albion-attendance.
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

// Cria/atualiza as tabelas se ainda não existirem (roda no boot).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cta_events (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      thread_id   TEXT,
      caller_id   TEXT NOT NULL,
      time_label  TEXT NOT NULL DEFAULT '',        -- AGORA: 1 horario por evento
      status      TEXT NOT NULL DEFAULT 'open',      -- open | closed | cancelled
      roster_msg  TEXT,                              -- id da msg de planilha ao vivo
      remind_30   TIMESTAMPTZ,                       -- quando mandar aviso 30min
      remind_10   TIMESTAMPTZ,                       -- quando mandar aviso 10min
      sent_30     BOOLEAN NOT NULL DEFAULT false,
      sent_10     BOOLEAN NOT NULL DEFAULT false,
      bomb_thread TEXT,                             -- thread de contagem do bomb
      bomb_comp   TEXT,                             -- 'invi'|'melee'|'kite' (fase B)
      bomb_roster TEXT,                             -- ids das msgs da planilha do bomb
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bomb_confirms (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      coming      BOOLEAN NOT NULL DEFAULT true,   -- true = vai, false = nao vai
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS cta_signups (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      weapon      TEXT NOT NULL,
      presence    TEXT NOT NULL,                     -- online | later
      party_index INT,                               -- null = reserva
      slot_index  INT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, user_id)                     -- 1 inscricao por pessoa por CTA
    );
  `);
  // migracao leve: se veio da Fase 0 com coluna "times", ignora — as novas
  // colunas acima cobrem o novo modelo.
}

async function createEvent({ guildId, channelId, callerId, timeLabel, remind30, remind10 }) {
  const { rows } = await pool.query(
    `INSERT INTO cta_events (guild_id, channel_id, caller_id, time_label, remind_30, remind_10)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [guildId, channelId, callerId, timeLabel, remind30 || null, remind10 || null]
  );
  return rows[0];
}

// lembretes vencidos ainda nao enviados (pro verificador periodico)
async function getDueReminders(now) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events
     WHERE status='open' AND (
       (sent_30=false AND remind_30 IS NOT NULL AND remind_30 <= $1) OR
       (sent_10=false AND remind_10 IS NOT NULL AND remind_10 <= $1)
     )`, [now]
  );
  return rows;
}

async function markReminderSent(eventId, which) {
  const col = which === 30 ? "sent_30" : "sent_10";
  await pool.query(`UPDATE cta_events SET ${col}=true WHERE id=$1`, [eventId]);
}

async function setThread(eventId, threadId) {
  await pool.query(`UPDATE cta_events SET thread_id=$1 WHERE id=$2`, [threadId, eventId]);
}

async function setRosterMsg(eventId, msgId) {
  await pool.query(`UPDATE cta_events SET roster_msg=$1 WHERE id=$2`, [msgId, eventId]);
}

async function getEvent(eventId) {
  const { rows } = await pool.query(`SELECT * FROM cta_events WHERE id=$1`, [eventId]);
  return rows[0];
}

async function getSignups(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_signups WHERE event_id=$1 ORDER BY created_at ASC`,
    [eventId]
  );
  return rows;
}

async function getSignup(eventId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_signups WHERE event_id=$1 AND user_id=$2`,
    [eventId, userId]
  );
  return rows[0];
}

async function upsertSignup(row) {
  const { rows } = await pool.query(
    `INSERT INTO cta_signups
       (event_id, user_id, username, weapon, presence, party_index, slot_index)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (event_id, user_id) DO UPDATE SET
       weapon=EXCLUDED.weapon, presence=EXCLUDED.presence,
       party_index=EXCLUDED.party_index, slot_index=EXCLUDED.slot_index,
       created_at=now()
     RETURNING *`,
    [row.eventId, row.userId, row.username, row.weapon, row.presence, row.partyIndex, row.slotIndex]
  );
  return rows[0];
}

async function deleteSignup(eventId, userId) {
  const { rows } = await pool.query(
    `DELETE FROM cta_signups WHERE event_id=$1 AND user_id=$2 RETURNING *`,
    [eventId, userId]
  );
  return rows[0];
}

async function setStatus(eventId, status) {
  await pool.query(`UPDATE cta_events SET status=$1 WHERE id=$2`, [status, eventId]);
}


// CTAs abertos (pro autocomplete do slash command)
async function getOpenEvents(guildId) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events WHERE guild_id=$1 AND status='open' ORDER BY created_at DESC`,
    [guildId]
  );
  return rows;
}

// acha evento aberto por rótulo de horário (ex "17:20")
async function getOpenEventByTime(guildId, timeLabel) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events WHERE guild_id=$1 AND status='open' AND time_label=$2
     ORDER BY created_at DESC LIMIT 1`,
    [guildId, timeLabel]
  );
  return rows[0];
}

// quem está numa vaga específica (ou null)
async function getSignupAtSlot(eventId, partyIndex, slotIndex) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_signups WHERE event_id=$1 AND party_index=$2 AND slot_index=$3`,
    [eventId, partyIndex, slotIndex]
  );
  return rows[0];
}

// remove todos os signups de uma PT (cta_clean) -> retorna quantos saíram
async function clearParty(eventId, partyIndex) {
  const { rowCount } = await pool.query(
    `DELETE FROM cta_signups WHERE event_id=$1 AND party_index=$2`,
    [eventId, partyIndex]
  );
  return rowCount;
}

// move um signup pra uma vaga (usado por cta_move/add); mantém arma/presença
async function moveSignupToSlot(eventId, userId, partyIndex, slotIndex) {
  await pool.query(
    `UPDATE cta_signups SET party_index=$3, slot_index=$4 WHERE event_id=$1 AND user_id=$2`,
    [eventId, userId, partyIndex, slotIndex]
  );
}


// ---- BOMB (fase A: contagem) ----
async function setBombThread(eventId, threadId) {
  await pool.query(`UPDATE cta_events SET bomb_thread=$1 WHERE id=$2`, [threadId, eventId]);
}
async function upsertBombConfirm(eventId, userId, username, coming) {
  await pool.query(
    `INSERT INTO bomb_confirms (event_id, user_id, username, coming)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (event_id, user_id) DO UPDATE SET coming=EXCLUDED.coming, created_at=now()`,
    [eventId, userId, username, coming]
  );
}
async function getBombConfirms(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM bomb_confirms WHERE event_id=$1 ORDER BY created_at ASC`, [eventId]
  );
  return rows;
}
async function setBombComp(eventId, comp) {
  await pool.query(`UPDATE cta_events SET bomb_comp=$1 WHERE id=$2`, [comp, eventId]);
}
async function setBombRoster(eventId, ids) {
  await pool.query(`UPDATE cta_events SET bomb_roster=$1 WHERE id=$2`, [ids, eventId]);
}

module.exports = {
  pool, init, createEvent, setThread, setRosterMsg, getEvent,
  setBombThread, upsertBombConfirm, getBombConfirms, setBombComp, setBombRoster,
  getOpenEvents, getOpenEventByTime, getSignupAtSlot, clearParty, moveSignupToSlot,
  getSignups, getSignup, upsertSignup, deleteSignup, setStatus,
  getDueReminders, markReminderSent,
};
