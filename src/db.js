// Camada de banco (Postgres)
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cta_events (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      thread_id   TEXT,
      caller_id   TEXT NOT NULL,
      time_label  TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'open',
      num_parties INT NOT NULL DEFAULT 4,
      roster_msg  TEXT,
      remind_30   TIMESTAMPTZ,
      remind_10   TIMESTAMPTZ,
      sent_30     BOOLEAN NOT NULL DEFAULT false,
      sent_10     BOOLEAN NOT NULL DEFAULT false,
      bomb_thread TEXT,
      bomb_comp   TEXT,
      bomb_roster TEXT,
      bomb_ping_msg TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      number      INT NOT NULL,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at    TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS voice_presence (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      channel_kind TEXT NOT NULL,
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      left_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_voice_open ON voice_presence(user_id, channel_id) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_voice_time ON voice_presence(joined_at);

    CREATE TABLE IF NOT EXISTS bomb_confirms (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      coming      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS bomb_signups (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      weapon      TEXT NOT NULL,
      slot_index  INT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS castelos (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      time_label  TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      voice_id    TEXT,
      thread_id   TEXT,
      roster_msg  TEXT,
      status      TEXT NOT NULL DEFAULT 'aberto',    -- aberto | contando | fechado | pago
      valor       BIGINT,
      started_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS castelo_signups (
      id          BIGSERIAL PRIMARY KEY,
      castelo_id  BIGINT NOT NULL REFERENCES castelos(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      weapon      TEXT NOT NULL,
      presence    TEXT NOT NULL DEFAULT 'online',
      party_index INT,
      slot_index  INT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (castelo_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS castelo_presence (
      id          BIGSERIAL PRIMARY KEY,
      castelo_id  BIGINT NOT NULL REFERENCES castelos(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      left_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS roamings (
      id          BIGSERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      nome        TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      vagas       INT NOT NULL,
      voice_id    TEXT,
      thread_id   TEXT,
      roster_msg  TEXT,
      status      TEXT NOT NULL DEFAULT 'aberto',
      valor       BIGINT,
      started_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS roaming_signups (
      id          BIGSERIAL PRIMARY KEY,
      roaming_id  BIGINT NOT NULL REFERENCES roamings(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      funcao      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (roaming_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS roaming_presence (
      id          BIGSERIAL PRIMARY KEY,
      roaming_id  BIGINT NOT NULL REFERENCES roamings(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      left_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cta_signups (
      id          BIGSERIAL PRIMARY KEY,
      event_id    BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      weapon      TEXT NOT NULL,
      presence    TEXT NOT NULL,
      party_index INT,
      slot_index  INT,
      ip          INT,
      manual      BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, user_id)
    );
  `);

  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS num_parties INT NOT NULL DEFAULT 4;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS party_list TEXT DEFAULT '0';`);
  await pool.query(`ALTER TABLE cta_signups ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT false;`);
}

async function createEvent({ guildId, channelId, callerId, timeLabel, remind30, remind10 }) {
  const { rows } = await pool.query(
    `INSERT INTO cta_events (guild_id, channel_id, caller_id, time_label, remind_30, remind_10, num_parties)
     VALUES ($1,$2,$3,$4,$5,$6, 4) RETURNING *`,
    [guildId, channelId, callerId, timeLabel, remind30 || null, remind10 || null]
  );
  return rows[0];
}

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

async function setNumParties(eventId, numParties) {
  await pool.query(`UPDATE cta_events SET num_parties=$1 WHERE id=$2`, [numParties, eventId]);
}
// lista ordenada de índices de PT a exibir (ex "0,4,1"). Default "0" (só PT1).
async function setPartyList(eventId, list) {
  await pool.query(`UPDATE cta_events SET party_list=$1 WHERE id=$2`, [list.join(","), eventId]);
}
function parsePartyList(ev) {
  const raw = (ev.party_list || "0").trim();
  return raw.split(",").map(Number).filter((n) => !isNaN(n));
}

async function getEvent(eventId) {
  const { rows } = await pool.query(`SELECT * FROM cta_events WHERE id=$1`, [eventId]);
  return rows[0];
}

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
       (event_id, user_id, username, weapon, presence, party_index, slot_index, ip, manual)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, false))
     ON CONFLICT (event_id, user_id) DO UPDATE SET
       weapon=EXCLUDED.weapon, presence=EXCLUDED.presence,
       party_index=EXCLUDED.party_index, slot_index=EXCLUDED.slot_index,
       ip=COALESCE(EXCLUDED.ip, cta_signups.ip),
       manual=COALESCE($9, cta_signups.manual, false),
       created_at=now()
     RETURNING *`,
    [row.eventId, row.userId, row.username, row.weapon, row.presence, row.partyIndex, row.slotIndex, row.ip ?? null, row.manual ?? null]
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

async function getOpenEvents(guildId) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events WHERE guild_id=$1 AND status='open' ORDER BY created_at DESC`,
    [guildId]
  );
  return rows;
}

async function getOpenEventByTime(guildId, timeLabel) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events WHERE guild_id=$1 AND status='open' AND time_label=$2
     ORDER BY created_at DESC LIMIT 1`,
    [guildId, timeLabel]
  );
  return rows[0];
}

async function getSignupAtSlot(eventId, partyIndex, slotIndex) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_signups WHERE event_id=$1 AND party_index=$2 AND slot_index=$3`,
    [eventId, partyIndex, slotIndex]
  );
  return rows[0];
}

async function clearParty(eventId, partyIndex) {
  const { rowCount } = await pool.query(
    `DELETE FROM cta_signups WHERE event_id=$1 AND party_index=$2`,
    [eventId, partyIndex]
  );
  return rowCount;
}

async function moveSignupToSlot(eventId, userId, partyIndex, slotIndex) {
  await pool.query(
    `UPDATE cta_signups SET party_index=$3, slot_index=$4 WHERE event_id=$1 AND user_id=$2`,
    [eventId, userId, partyIndex, slotIndex]
  );
}

// ---- BOMB ----
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

// ---- PRESENÇA EM CALL ----
async function voiceJoin(guildId, userId, username, channelId, channelKind) {
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
async function voiceLeave(userId, channelId) {
  await pool.query(
    `UPDATE voice_presence SET left_at=now() WHERE user_id=$1 AND channel_id=$2 AND left_at IS NULL`,
    [userId, channelId]
  );
}
async function voiceCloseAllOpen(channelId) {
  await pool.query(
    `UPDATE voice_presence SET left_at=now() WHERE channel_id=$1 AND left_at IS NULL`, [channelId]
  );
}
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

async function setEventIgnored(eventId, ignored) {
  await pool.query(`UPDATE cta_events SET ignored=$2 WHERE id=$1`, [eventId, !!ignored]);
}

async function getEventsInRange(guildId, startUTC, endUTC) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_events
     WHERE guild_id=$1 AND created_at >= $2 AND created_at <= $3 AND NOT ignored
     ORDER BY created_at ASC`,
    [guildId, startUTC, endUTC]
  );
  return rows;
}

// ---- TEMPORADAS ----
async function getCurrentSeason(guildId) {
  const { rows } = await pool.query(
    `SELECT * FROM seasons WHERE guild_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [guildId]
  );
  return rows[0];
}
async function startSeason(guildId, number) {
  await pool.query(`UPDATE seasons SET ended_at=now() WHERE guild_id=$1 AND ended_at IS NULL`, [guildId]);
  const { rows } = await pool.query(
    `INSERT INTO seasons (guild_id, number) VALUES ($1,$2) RETURNING *`, [guildId, number]
  );
  return rows[0];
}
async function finishSeason(guildId) {
  const { rows } = await pool.query(
    `UPDATE seasons SET ended_at=now() WHERE guild_id=$1 AND ended_at IS NULL RETURNING *`, [guildId]
  );
  return rows[0];
}

// ---- CASTELO ----
async function createCastelo({ guildId, timeLabel, ownerId }) {
  const { rows } = await pool.query(`INSERT INTO castelos (guild_id, time_label, owner_id) VALUES ($1,$2,$3) RETURNING *`, [guildId, timeLabel, ownerId]);
  return rows[0];
}
async function getCastelo(guildId, timeLabel) {
  const { rows } = await pool.query(`SELECT * FROM castelos WHERE guild_id=$1 AND time_label=$2 AND status!='pago' ORDER BY created_at DESC LIMIT 1`, [guildId, timeLabel]);
  return rows[0];
}
async function getCasteloById(id) {
  const { rows } = await pool.query(`SELECT * FROM castelos WHERE id=$1`, [id]);
  return rows[0];
}
async function getCasteloByThread(threadId) {
  const { rows } = await pool.query(`SELECT * FROM castelos WHERE thread_id=$1 AND status NOT IN ('pago','fechado') LIMIT 1`, [threadId]);
  return rows[0];
}
async function getOpenCastelos(guildId) {
  const { rows } = await pool.query(`SELECT * FROM castelos WHERE guild_id=$1 AND status!='pago' ORDER BY created_at DESC`, [guildId]);
  return rows;
}
async function setCasteloField(id, field, value) {
  const allowed = ["voice_id","thread_id","roster_msg","status","valor","started_at"];
  if (!allowed.includes(field)) return;
  await pool.query(`UPDATE castelos SET ${field}=$1 WHERE id=$2`, [value, id]);
}
async function upsertCasteloSignup(row) {
  await pool.query(
    `INSERT INTO castelo_signups (castelo_id, user_id, username, weapon, presence, party_index, slot_index)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (castelo_id, user_id) DO UPDATE SET weapon=EXCLUDED.weapon, presence=EXCLUDED.presence, party_index=EXCLUDED.party_index, slot_index=EXCLUDED.slot_index`,
    [row.casteloId, row.userId, row.username, row.weapon, row.presence, row.partyIndex, row.slotIndex]
  );
}
async function getCasteloSignups(casteloId) {
  const { rows } = await pool.query(`SELECT * FROM castelo_signups WHERE castelo_id=$1 ORDER BY created_at ASC`, [casteloId]);
  return rows;
}
async function deleteCasteloSignup(casteloId, userId) {
  const { rows } = await pool.query(`DELETE FROM castelo_signups WHERE castelo_id=$1 AND user_id=$2 RETURNING *`, [casteloId, userId]);
  return rows[0];
}
async function moveCasteloSignup(casteloId, userId, partyIndex, slotIndex) {
  await pool.query(`UPDATE castelo_signups SET party_index=$3, slot_index=$4 WHERE castelo_id=$1 AND user_id=$2`, [casteloId, userId, partyIndex, slotIndex]);
}
async function casteloVoiceJoin(casteloId, userId, username) {
  await pool.query(`UPDATE castelo_presence SET left_at=now() WHERE castelo_id=$1 AND user_id=$2 AND left_at IS NULL`, [casteloId, userId]);
  await pool.query(`INSERT INTO castelo_presence (castelo_id, user_id, username) VALUES ($1,$2,$3)`, [casteloId, userId, username]);
}
async function casteloVoiceLeave(casteloId, userId) {
  await pool.query(`UPDATE castelo_presence SET left_at=now() WHERE castelo_id=$1 AND user_id=$2 AND left_at IS NULL`, [casteloId, userId]);
}
async function casteloCloseAllOpen(casteloId) {
  await pool.query(`UPDATE castelo_presence SET left_at=now() WHERE castelo_id=$1 AND left_at IS NULL`, [casteloId]);
}
async function getCasteloPresence(casteloId) {
  const { rows } = await pool.query(`SELECT * FROM castelo_presence WHERE castelo_id=$1 ORDER BY user_id, joined_at`, [casteloId]);
  return rows;
}

// ---- ROAMING ----
async function createRoaming({ guildId, nome, ownerId, vagas }) {
  const { rows } = await pool.query(
    `INSERT INTO roamings (guild_id, nome, owner_id, vagas) VALUES ($1,$2,$3,$4) RETURNING *`,
    [guildId, nome, ownerId, vagas]
  );
  return rows[0];
}
async function getRoaming(guildId, nome) {
  const { rows } = await pool.query(
    `SELECT * FROM roamings WHERE guild_id=$1 AND nome=$2 AND status != 'pago' ORDER BY created_at DESC LIMIT 1`,
    [guildId, nome]
  );
  return rows[0];
}
async function getRoamingById(id) {
  const { rows } = await pool.query(`SELECT * FROM roamings WHERE id=$1`, [id]);
  return rows[0];
}
async function getOpenRoamings(guildId) {
  const { rows } = await pool.query(
    `SELECT * FROM roamings WHERE guild_id=$1 AND status != 'pago' ORDER BY created_at DESC`, [guildId]
  );
  return rows;
}
async function setRoamingField(id, field, value) {
  const allowed = ["voice_id", "thread_id", "roster_msg", "status", "valor", "started_at"];
  if (!allowed.includes(field)) return;
  await pool.query(`UPDATE roamings SET ${field}=$1 WHERE id=$2`, [value, id]);
}
async function upsertRoamingSignup(roamingId, userId, username, funcao) {
  await pool.query(
    `INSERT INTO roaming_signups (roaming_id, user_id, username, funcao) VALUES ($1,$2,$3,$4)
     ON CONFLICT (roaming_id, user_id) DO UPDATE SET funcao=EXCLUDED.funcao`,
    [roamingId, userId, username, funcao]
  );
}
async function getRoamingSignups(roamingId) {
  const { rows } = await pool.query(`SELECT * FROM roaming_signups WHERE roaming_id=$1 ORDER BY created_at ASC`, [roamingId]);
  return rows;
}
async function deleteRoamingSignup(roamingId, userId) {
  const { rows } = await pool.query(`DELETE FROM roaming_signups WHERE roaming_id=$1 AND user_id=$2 RETURNING *`, [roamingId, userId]);
  return rows[0];
}
async function roamingVoiceJoin(roamingId, userId, username) {
  await pool.query(`UPDATE roaming_presence SET left_at=now() WHERE roaming_id=$1 AND user_id=$2 AND left_at IS NULL`, [roamingId, userId]);
  await pool.query(`INSERT INTO roaming_presence (roaming_id, user_id, username) VALUES ($1,$2,$3)`, [roamingId, userId, username]);
}
async function roamingVoiceLeave(roamingId, userId) {
  await pool.query(`UPDATE roaming_presence SET left_at=now() WHERE roaming_id=$1 AND user_id=$2 AND left_at IS NULL`, [roamingId, userId]);
}
async function roamingCloseAllOpen(roamingId) {
  await pool.query(`UPDATE roaming_presence SET left_at=now() WHERE roaming_id=$1 AND left_at IS NULL`, [roamingId]);
}
async function getRoamingPresence(roamingId) {
  const { rows } = await pool.query(`SELECT * FROM roaming_presence WHERE roaming_id=$1 ORDER BY user_id, joined_at`, [roamingId]);
  return rows;
}

module.exports = {
  pool, init, createEvent, setThread, setRosterMsg, setNumParties, setPartyList, parsePartyList, getEvent, getEventByThread,
  setBombThread, setBombPingMsg, upsertBombConfirm, getBombConfirms, setBombComp, setBombRoster,
  upsertBombSignup, getBombSignups, deleteBombSignup,
  voiceJoin, voiceLeave, voiceCloseAllOpen, getPresenceInWindow, getEventsInRange, setEventIgnored,
  getCurrentSeason, startSeason, finishSeason,
  getOpenEvents, getOpenEventByTime, getSignupAtSlot, clearParty, moveSignupToSlot,
  getSignups, getSignup, upsertSignup, deleteSignup, setStatus, setTimeLabel,
  getDueReminders, markReminderSent,
  createRoaming, getRoaming, getRoamingById, getOpenRoamings, setRoamingField,
  upsertRoamingSignup, getRoamingSignups, deleteRoamingSignup,
  roamingVoiceJoin, roamingVoiceLeave, roamingCloseAllOpen, getRoamingPresence,
  createCastelo, getCastelo, getCasteloById, getCasteloByThread, getOpenCastelos, setCasteloField,
  upsertCasteloSignup, getCasteloSignups, deleteCasteloSignup, moveCasteloSignup,
  casteloVoiceJoin, casteloVoiceLeave, casteloCloseAllOpen, getCasteloPresence,
};