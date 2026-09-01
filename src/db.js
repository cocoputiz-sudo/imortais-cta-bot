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
      bomb_ping_msg TEXT,                           -- id da msg "Vai no CTA?" no bomb-ping
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      number      INT NOT NULL,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at    TIMESTAMPTZ,                        -- null = temporada aberta
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS voice_presence (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      channel_kind TEXT NOT NULL,                    -- 'prep' | 'bomb'
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      left_at     TIMESTAMPTZ,                        -- null = ainda na call
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_open ON voice_presence(user_id, channel_id) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_voice_time ON voice_presence(joined_at);

    CREATE TABLE IF NOT EXISTS bomb_confirms (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      coming      BOOLEAN NOT NULL DEFAULT true,   -- true = vai, false = nao vai
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS bomb_signups (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      weapon      TEXT NOT NULL,
      slot_index  INT,                               -- vaga na comp do bomb (null=reserva)
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
      ip          INT,                                -- IP (só p/ Ursinas/Cravadas, desempate vaga única)
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

// acha o CTA pela thread da planilha (pro reconhecimento de texto)
async function getEventByThread(threadId) {
  const { rows } = await pool.query(`SELECT * FROM cta_events WHERE thread_id=$1 LIMIT 1`, [threadId]);
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
       (event_id, user_id, username, weapon, presence, party_index, slot_index, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_id, user_id) DO UPDATE SET
       weapon=EXCLUDED.weapon, presence=EXCLUDED.presence,
       party_index=EXCLUDED.party_index, slot_index=EXCLUDED.slot_index,
       ip=COALESCE(EXCLUDED.ip, cta_signups.ip),
       created_at=now()
     RETURNING *`,
    [row.eventId, row.userId, row.username, row.weapon, row.presence, row.partyIndex, row.slotIndex, row.ip ?? null]
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

async function setTimeLabel(eventId, timeLabel) {
  await pool.query(`UPDATE cta_events SET time_label=$1 WHERE id=$2`, [timeLabel, eventId]);
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
async function setBombPingMsg(eventId, msgId) {
  await pool.query(`UPDATE cta_events SET bomb_ping_msg=$1 WHERE id=$2`, [msgId, eventId]);
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
async function upsertBombSignup(eventId, userId, username, weapon, slotIndex) {
  await pool.query(
    `INSERT INTO bomb_signups (event_id, user_id, username, weapon, slot_index)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id, user_id) DO UPDATE SET weapon=EXCLUDED.weapon, slot_index=EXCLUDED.slot_index, created_at=now()`,
    [eventId, userId, username, weapon, slotIndex]
  );
}
async function getBombSignups(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM bomb_signups WHERE event_id=$1 ORDER BY created_at ASC`, [eventId]
  );
  return rows;
}
async function deleteBombSignup(eventId, userId) {
  const { rows } = await pool.query(
    `DELETE FROM bomb_signups WHERE event_id=$1 AND user_id=$2 RETURNING *`, [eventId, userId]
  );
  return rows[0];
}

// ---- PRESENÇA EM CALL (attendance camada 1) ----
// abre um registro de presença (entrou na call)
async function voiceJoin(guildId, userId, username, channelId, channelKind) {
  // fecha qualquer registro aberto dessa pessoa nesse canal (segurança contra duplicata)
  await pool.query(
    `UPDATE voice_presence SET left_at=now() WHERE user_id=$1 AND channel_id=$2 AND left_at IS NULL`,
    [userId, channelId]
  );
  await pool.query(
    `INSERT INTO voice_presence (guild_id, user_id, username, channel_id, channel_kind)
     VALUES ($1,$2,$3,$4,$5)`,
    [guildId, userId, username, channelId, channelKind]
  );
}
// fecha o registro aberto (saiu da call)
async function voiceLeave(userId, channelId) {
  await pool.query(
    `UPDATE voice_presence SET left_at=now() WHERE user_id=$1 AND channel_id=$2 AND left_at IS NULL`,
    [userId, channelId]
  );
}
// fecha TODOS os registros abertos (usado no boot, pra não deixar sessão órfã de antes do restart)
async function voiceCloseAllOpen(channelId) {
  await pool.query(
    `UPDATE voice_presence SET left_at=now() WHERE channel_id=$1 AND left_at IS NULL`, [channelId]
  );
}
// presença dentro de uma janela de tempo (pro relatório futuro)
async function getPresenceInWindow(guildId, channelKind, startUTC, endUTC) {
  const { rows } = await pool.query(
    `SELECT * FROM voice_presence
     WHERE guild_id=$1 AND channel_kind=$2
       AND joined_at < $4 AND (left_at IS NULL OR left_at > $3)
     ORDER BY user_id, joined_at`,
    [guildId, channelKind, startUTC, endUTC]
  );
  return rows;
}

// todos os CTAs (eventos) criados num período — pro relatório de attendance
async function getEventsInRange(guildId, startUTC, endUTC) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events
     WHERE guild_id=$1 AND created_at >= $2 AND created_at <= $3
     ORDER BY created_at ASC`,
    [guildId, startUTC, endUTC]
  );
  return rows;
}

// ---- TEMPORADAS ----
// temporada atual (aberta) do servidor, ou null se em off-season/nenhuma
async function getCurrentSeason(guildId) {
  const { rows } = await pool.query(
    `SELECT * FROM seasons WHERE guild_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [guildId]
  );
  return rows[0];
}
// inicia uma temporada: fecha a atual (se houver) e cria a nova
async function startSeason(guildId, number) {
  await pool.query(`UPDATE seasons SET ended_at=now() WHERE guild_id=$1 AND ended_at IS NULL`, [guildId]);
  const { rows } = await pool.query(
    `INSERT INTO seasons (guild_id, number) VALUES ($1,$2) RETURNING *`, [guildId, number]
  );
  return rows[0];
}
// fecha a temporada atual
async function finishSeason(guildId) {
  const { rows } = await pool.query(
    `UPDATE seasons SET ended_at=now() WHERE guild_id=$1 AND ended_at IS NULL RETURNING *`, [guildId]
  );
  return rows[0];
}

module.exports = {
  pool, init, createEvent, setThread, setRosterMsg, getEvent, getEventByThread,
  setBombThread, setBombPingMsg, upsertBombConfirm, getBombConfirms, setBombComp, setBombRoster,
  upsertBombSignup, getBombSignups, deleteBombSignup,
  voiceJoin, voiceLeave, voiceCloseAllOpen, getPresenceInWindow, getEventsInRange,
  getCurrentSeason, startSeason, finishSeason,
  getOpenEvents, getOpenEventByTime, getSignupAtSlot, clearParty, moveSignupToSlot,
  getSignups, getSignup, upsertSignup, deleteSignup, setStatus, setTimeLabel,
  getDueReminders, markReminderSent,
};
