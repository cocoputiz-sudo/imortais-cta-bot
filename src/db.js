// Camada de banco (Postgres). Reaproveita o mesmo padrão do albion-attendance.
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway já entrega SSL; ssl abaixo evita erro de cert em alguns setups.
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

// Cria as tabelas se ainda não existirem (roda no boot).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cta_events (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      thread_id   TEXT,
      caller_id   TEXT NOT NULL,
      times       TEXT[] NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'open',      -- open | closed
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
      UNIQUE (event_id, user_id)                     -- 1 inscrição por pessoa
    );
  `);
}

async function createEvent({ guildId, channelId, callerId, times }) {
  const { rows } = await pool.query(
    `INSERT INTO cta_events (guild_id, channel_id, caller_id, times)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [guildId, channelId, callerId, times]
  );
  return rows[0];
}

async function setThread(eventId, threadId) {
  await pool.query(`UPDATE cta_events SET thread_id=$1 WHERE id=$2`, [threadId, eventId]);
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

// Insere ou atualiza a inscrição (a pessoa pode trocar de arma antes de fechar).
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

async function closeEvent(eventId) {
  await pool.query(`UPDATE cta_events SET status='closed' WHERE id=$1`, [eventId]);
}

module.exports = {
  pool, init, createEvent, setThread, getEvent, getSignups, upsertSignup, closeEvent,
};
