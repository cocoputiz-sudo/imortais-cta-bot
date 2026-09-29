// Camada de banco (Postgres)
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
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

    CREATE TABLE IF NOT EXISTS cta_navigation_objectives (
      cta_event_id       BIGINT PRIMARY KEY REFERENCES cta_events(id) ON DELETE CASCADE,
      objective_type     TEXT NOT NULL,
      rarity             TEXT,
      target_zone_id     TEXT NOT NULL,
      target_zone_name   TEXT NOT NULL,
      expires_at         TIMESTAMPTZ,
      created_by         TEXT,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_cta_nav_expiry
      ON cta_navigation_objectives(expires_at);

    CREATE TABLE IF NOT EXISTS cta_navigation_waypoints (
      id                 BIGSERIAL PRIMARY KEY,
      cta_event_id       BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE,
      position           INT NOT NULL,
      objective_type     TEXT NOT NULL,
      rarity             TEXT,
      target_zone_id     TEXT NOT NULL,
      target_zone_name   TEXT NOT NULL,
      expires_at         TIMESTAMPTZ,
      created_by         TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      delivery_zone_id   TEXT,
      delivery_zone_name TEXT,
      picked_at          TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (cta_event_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_cta_nav_waypoints_event
      ON cta_navigation_waypoints(cta_event_id, status, position);
    CREATE INDEX IF NOT EXISTS idx_cta_nav_waypoints_expiry
      ON cta_navigation_waypoints(expires_at);

    CREATE TABLE IF NOT EXISTS cta_navigation_sessions (
      cta_event_id       BIGINT PRIMARY KEY REFERENCES cta_events(id) ON DELETE CASCADE,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      seconds_per_map    INT NOT NULL DEFAULT 90,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Navegação global do War Room. Não depende de CTA aberto nem de horário.
    CREATE TABLE IF NOT EXISTS navigation_global_waypoints (
      id                 BIGSERIAL PRIMARY KEY,
      scope_key          TEXT NOT NULL DEFAULT 'global',
      position           INT NOT NULL,
      objective_type     TEXT NOT NULL,
      rarity             TEXT,
      target_zone_id     TEXT NOT NULL,
      target_zone_name   TEXT NOT NULL,
      expires_at         TIMESTAMPTZ,
      created_by         TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      delivery_zone_id   TEXT,
      delivery_zone_name TEXT,
      picked_at          TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (scope_key, position)
    );
    CREATE INDEX IF NOT EXISTS idx_nav_global_scope
      ON navigation_global_waypoints(scope_key, status, position);
    CREATE INDEX IF NOT EXISTS idx_nav_global_expiry
      ON navigation_global_waypoints(expires_at);

    CREATE TABLE IF NOT EXISTS navigation_global_sessions (
      scope_key          TEXT PRIMARY KEY,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      seconds_per_map    INT NOT NULL DEFAULT 90,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS num_parties INT NOT NULL DEFAULT 4;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS party_list TEXT DEFAULT '0';`);
  await pool.query(`ALTER TABLE cta_signups ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS realloc_lock_parties TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS cta_departure TEXT;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS cta_gear_tier TEXT;`);
  await pool.query(`ALTER TABLE cta_events ADD COLUMN IF NOT EXISTS cta_gear_count INT;`);
  await pool.query(`ALTER TABLE cta_navigation_waypoints ADD COLUMN IF NOT EXISTS delivery_zone_id TEXT;`);
  await pool.query(`ALTER TABLE cta_navigation_waypoints ADD COLUMN IF NOT EXISTS delivery_zone_name TEXT;`);
  await pool.query(`ALTER TABLE cta_navigation_waypoints ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ;`);

  // Migração compatível: transforma o objetivo único antigo no primeiro waypoint.
  await pool.query(`
    INSERT INTO cta_navigation_waypoints
      (cta_event_id, position, objective_type, rarity, target_zone_id, target_zone_name,
       expires_at, created_by, created_at, updated_at)
    SELECT o.cta_event_id, 1, o.objective_type, o.rarity, o.target_zone_id, o.target_zone_name,
           o.expires_at, o.created_by, o.created_at, o.updated_at
      FROM cta_navigation_objectives o
     WHERE NOT EXISTS (
       SELECT 1 FROM cta_navigation_waypoints w WHERE w.cta_event_id=o.cta_event_id
     )
    ON CONFLICT (cta_event_id, position) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO cta_navigation_sessions
      (cta_event_id, discord_channel_id, discord_message_id, updated_at)
    SELECT o.cta_event_id, o.discord_channel_id, o.discord_message_id, o.updated_at
      FROM cta_navigation_objectives o
    ON CONFLICT (cta_event_id) DO UPDATE SET
      discord_channel_id=COALESCE(EXCLUDED.discord_channel_id, cta_navigation_sessions.discord_channel_id),
      discord_message_id=COALESCE(EXCLUDED.discord_message_id, cta_navigation_sessions.discord_message_id),
      updated_at=GREATEST(cta_navigation_sessions.updated_at, EXCLUDED.updated_at)
  `);
  // A tabela antiga era de objetivo único. Depois de migrar, esvaziamos para que
  // um "limpar fila" não faça o objetivo legado reaparecer no próximo restart.
  await pool.query(`DELETE FROM cta_navigation_objectives`);

  // Migração única e conservadora para a fila global: se ela ainda estiver vazia,
  // copia objetivos pendentes/carregando do CTA aberto. Depois disso a navegação
  // passa a viver fora do ciclo de vida dos CTAs.
  await pool.query(`
    INSERT INTO navigation_global_waypoints
      (scope_key, position, objective_type, rarity, target_zone_id, target_zone_name,
       expires_at, created_by, status, delivery_zone_id, delivery_zone_name,
       picked_at, completed_at, created_at, updated_at)
    SELECT 'global',
           ROW_NUMBER() OVER (ORDER BY e.created_at, w.position, w.id)::int,
           w.objective_type, w.rarity, w.target_zone_id, w.target_zone_name,
           w.expires_at, w.created_by, w.status, w.delivery_zone_id, w.delivery_zone_name,
           w.picked_at, w.completed_at, w.created_at, w.updated_at
      FROM cta_navigation_waypoints w
      JOIN cta_events e ON e.id=w.cta_event_id
     WHERE e.status='open'
       AND w.status IN ('pending','carrying')
       AND NOT EXISTS (
         SELECT 1 FROM navigation_global_waypoints g WHERE g.scope_key='global'
       )
     ORDER BY e.created_at, w.position, w.id
    ON CONFLICT (scope_key, position) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO navigation_global_sessions(scope_key, updated_at)
    VALUES ('global', now())
    ON CONFLICT (scope_key) DO NOTHING
  `);
}

async function createEvent({ guildId, channelId, callerId, timeLabel, remind30, remind10, brief = {} }) {
  const departure = String(brief.departure || "").trim() || null;
  const gearTier = String(brief.gearTier || "").trim().toUpperCase() || null;
  const gearCount = gearTier ? Math.max(1, Math.min(9, Number(brief.gearCount) || 2)) : null;
  const { rows } = await pool.query(
    `INSERT INTO cta_events
       (guild_id, channel_id, caller_id, time_label, remind_30, remind_10, num_parties,
        cta_departure, cta_gear_tier, cta_gear_count)
     VALUES ($1,$2,$3,$4,$5,$6,4,$7,$8,$9)
     RETURNING *`,
    [guildId, channelId, callerId, timeLabel, remind30 || null, remind10 || null,
      departure, gearTier, gearCount]
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

function parseReallocationLocks(ev) {
  const raw = String(ev?.realloc_lock_parties || "").trim();
  if (!raw) return [];
  return [...new Set(
    raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0)
  )];
}

async function setReallocationLocks(eventId, list) {
  const clean = [...new Set(
    (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0)
  )];
  await pool.query(
    `UPDATE cta_events SET realloc_lock_parties=$1 WHERE id=$2`,
    [clean.join(","), eventId]
  );
}

async function setEventBrief(eventId, brief = {}) {
  const departure = String(brief.departure || "").trim() || null;
  const gearTier = String(brief.gearTier || "").trim().toUpperCase() || null;
  const gearCount = gearTier ? Math.max(1, Math.min(9, Number(brief.gearCount) || 2)) : null;
  const { rows } = await pool.query(
    `UPDATE cta_events
        SET cta_departure=$2, cta_gear_tier=$3, cta_gear_count=$4
      WHERE id=$1
      RETURNING *`,
    [eventId, departure, gearTier, gearCount]
  );
  return rows[0];
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
  const terminal = status === "closed" || status === "cancelled";
  await pool.query(
    `UPDATE cta_events
        SET status=$1,
            closed_at=CASE WHEN $3 THEN COALESCE(closed_at, now()) ELSE closed_at END
      WHERE id=$2`,
    [status, eventId, terminal]
  );
}

async function getRecentClosedEvents(guildId, days = 3) {
  const { rows } = await pool.query(
    `SELECT id, guild_id, time_label, status, created_at,
            COALESCE(closed_at, created_at) AS closed_at
       FROM cta_events
      WHERE guild_id=$1
        AND status='closed'
        AND COALESCE(closed_at, created_at) >= now() - ($2::text || ' days')::interval
      ORDER BY COALESCE(closed_at, created_at) DESC`,
    [guildId, Math.max(1, Number(days) || 3)]
  );
  return rows;
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

// ---- CTA NAVIGATION / WAZE ----
async function addNavigationObjective({
  eventId,
  objectiveType,
  rarity = null,
  targetZoneId,
  targetZoneName,
  expiresAt = null,
  createdBy = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO cta_navigation_waypoints
         (cta_event_id, position, objective_type, rarity, target_zone_id, target_zone_name,
          expires_at, created_by, status, updated_at)
       SELECT $1,
              COALESCE(MAX(position),0)+1,
              $2,$3,$4,$5,$6,$7,'pending',now()
         FROM cta_navigation_waypoints
        WHERE cta_event_id=$1
       RETURNING *`,
      [
        eventId,
        String(objectiveType || "OBJETIVO").trim().slice(0, 80),
        rarity ? String(rarity).trim().slice(0, 40) : null,
        String(targetZoneId || "").trim(),
        String(targetZoneName || "").trim(),
        expiresAt || null,
        createdBy || null,
      ]
    );
    await client.query(
      `INSERT INTO cta_navigation_sessions(cta_event_id, updated_at)
       VALUES ($1,now())
       ON CONFLICT (cta_event_id) DO UPDATE SET updated_at=now()`,
      [eventId]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getNavigationObjectives(eventId, { includeDone = true } = {}) {
  const params = [eventId];
  const statusWhere = includeDone ? "" : "AND status IN ('pending','carrying')";
  const { rows } = await pool.query(
    `SELECT * FROM cta_navigation_waypoints
      WHERE cta_event_id=$1
        ${statusWhere}
      ORDER BY position ASC, id ASC`,
    params
  );
  return rows;
}

async function getNavigationObjective(eventId) {
  const rows = await getNavigationObjectives(eventId, { includeDone: false });
  return rows[0] || null;
}

// Compatibilidade: chamadas antigas de "set" agora acrescentam um objetivo à fila.
async function setNavigationObjective(input) {
  return addNavigationObjective(input);
}

async function removeNavigationObjective(eventId, waypointId) {
  const { rows } = await pool.query(
    `DELETE FROM cta_navigation_waypoints
      WHERE cta_event_id=$1 AND id=$2
      RETURNING *`,
    [eventId, waypointId]
  );
  if (rows[0]) await compactNavigationPositions(eventId);
  return rows[0] || null;
}

async function startNavigationCarry(eventId, waypointId, deliveryZoneId, deliveryZoneName) {
  const { rows } = await pool.query(
    `UPDATE cta_navigation_waypoints
        SET status='carrying',
            delivery_zone_id=$3,
            delivery_zone_name=$4,
            picked_at=COALESCE(picked_at,now()),
            updated_at=now()
      WHERE cta_event_id=$1
        AND id=$2
        AND objective_type IN ('VORTEX','ORBS')
        AND status='pending'
      RETURNING *`,
    [eventId, waypointId, String(deliveryZoneId || "").trim(), String(deliveryZoneName || "").trim()]
  );
  return rows[0] || null;
}

async function completeNavigationObjective(eventId, waypointId) {
  const { rows } = await pool.query(
    `UPDATE cta_navigation_waypoints
        SET status='done', completed_at=now(), updated_at=now()
      WHERE cta_event_id=$1 AND id=$2
      RETURNING *`,
    [eventId, waypointId]
  );
  return rows[0] || null;
}

async function compactNavigationPositions(eventId) {
  await pool.query(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY position,id)::int AS new_pos
         FROM cta_navigation_waypoints
        WHERE cta_event_id=$1
     )
     UPDATE cta_navigation_waypoints w
        SET position=r.new_pos, updated_at=now()
       FROM ranked r
      WHERE w.id=r.id AND w.position<>r.new_pos`,
    [eventId]
  );
}

async function clearNavigationObjectives(eventId) {
  const { rows } = await pool.query(
    `DELETE FROM cta_navigation_waypoints WHERE cta_event_id=$1 RETURNING *`,
    [eventId]
  );
  return rows;
}

async function clearNavigationObjective(eventId) {
  const rows = await clearNavigationObjectives(eventId);
  return rows[0] || null;
}

async function getNavigationSession(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM cta_navigation_sessions WHERE cta_event_id=$1 LIMIT 1`,
    [eventId]
  );
  return rows[0] || null;
}

async function setNavigationObjectiveMessage(eventId, channelId, messageId) {
  const { rows } = await pool.query(
    `INSERT INTO cta_navigation_sessions
       (cta_event_id, discord_channel_id, discord_message_id, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (cta_event_id) DO UPDATE SET
       discord_channel_id=EXCLUDED.discord_channel_id,
       discord_message_id=EXCLUDED.discord_message_id,
       updated_at=now()
     RETURNING *`,
    [eventId, channelId || null, messageId || null]
  );
  return rows[0] || null;
}

async function setNavigationSecondsPerMap(eventId, secondsPerMap) {
  const value = Math.max(20, Math.min(600, Number(secondsPerMap) || 90));
  const { rows } = await pool.query(
    `INSERT INTO cta_navigation_sessions(cta_event_id, seconds_per_map, updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (cta_event_id) DO UPDATE SET
       seconds_per_map=EXCLUDED.seconds_per_map,
       updated_at=now()
     RETURNING *`,
    [eventId, value]
  );
  return rows[0];
}

async function getOpenNavigationObjectives(guildId = null) {
  const params = [];
  let guildWhere = "";
  if (guildId) {
    params.push(guildId);
    guildWhere = `AND e.guild_id=$${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT w.*, e.guild_id, e.channel_id, e.thread_id, e.time_label, e.status AS event_status, e.caller_id
       FROM cta_navigation_waypoints w
       JOIN cta_events e ON e.id=w.cta_event_id
      WHERE e.status='open'
        AND w.status IN ('pending','carrying')
        ${guildWhere}
      ORDER BY w.cta_event_id, w.position`,
    params
  );
  return rows;
}

// ---- NAVEGAÇÃO GLOBAL / WAZE (independente de CTA) ----
async function addGlobalNavigationObjective({
  objectiveType,
  rarity = null,
  targetZoneId,
  targetZoneName,
  expiresAt = null,
  createdBy = null,
  scopeKey = "global",
}) {
  const scope = String(scopeKey || "global").trim() || "global";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializa inclusões na mesma fila para não disputar a posição MAX+1.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["nav:" + scope]);
    const { rows } = await client.query(
      `INSERT INTO navigation_global_waypoints
         (scope_key, position, objective_type, rarity, target_zone_id, target_zone_name,
          expires_at, created_by, status, updated_at)
       SELECT $1,
              COALESCE(MAX(position),0)+1,
              $2,$3,$4,$5,$6,$7,'pending',now()
         FROM navigation_global_waypoints
        WHERE scope_key=$1
       RETURNING *`,
      [
        scope,
        String(objectiveType || "OBJETIVO").trim().slice(0, 80),
        rarity ? String(rarity).trim().slice(0, 40) : null,
        String(targetZoneId || "").trim(),
        String(targetZoneName || "").trim(),
        expiresAt || null,
        createdBy || null,
      ]
    );
    await client.query(
      `INSERT INTO navigation_global_sessions(scope_key, updated_at)
       VALUES ($1,now())
       ON CONFLICT (scope_key) DO UPDATE SET updated_at=now()`,
      [scope]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getGlobalNavigationObjectives({ includeDone = true, scopeKey = "global" } = {}) {
  const scope = String(scopeKey || "global").trim() || "global";
  const statusWhere = includeDone ? "" : "AND status IN ('pending','carrying')";
  const { rows } = await pool.query(
    `SELECT * FROM navigation_global_waypoints
      WHERE scope_key=$1
        ${statusWhere}
      ORDER BY position ASC, id ASC`,
    [scope]
  );
  return rows;
}

async function compactGlobalNavigationPositions(scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  await pool.query(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY position,id)::int AS new_pos
         FROM navigation_global_waypoints
        WHERE scope_key=$1
     )
     UPDATE navigation_global_waypoints w
        SET position=r.new_pos, updated_at=now()
       FROM ranked r
      WHERE w.id=r.id AND w.position<>r.new_pos`,
    [scope]
  );
}

async function removeGlobalNavigationObjective(waypointId, scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  const { rows } = await pool.query(
    `DELETE FROM navigation_global_waypoints
      WHERE scope_key=$1 AND id=$2
      RETURNING *`,
    [scope, waypointId]
  );
  if (rows[0]) await compactGlobalNavigationPositions(scope);
  return rows[0] || null;
}

async function startGlobalNavigationCarry(waypointId, deliveryZoneId, deliveryZoneName, scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  const { rows } = await pool.query(
    `UPDATE navigation_global_waypoints
        SET status='carrying',
            delivery_zone_id=$3,
            delivery_zone_name=$4,
            picked_at=COALESCE(picked_at,now()),
            updated_at=now()
      WHERE scope_key=$1
        AND id=$2
        AND objective_type IN ('VORTEX','ORBS')
        AND status='pending'
      RETURNING *`,
    [scope, waypointId, String(deliveryZoneId || "").trim(), String(deliveryZoneName || "").trim()]
  );
  return rows[0] || null;
}

async function completeGlobalNavigationObjective(waypointId, scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  const { rows } = await pool.query(
    `UPDATE navigation_global_waypoints
        SET status='done', completed_at=now(), updated_at=now()
      WHERE scope_key=$1 AND id=$2
      RETURNING *`,
    [scope, waypointId]
  );
  return rows[0] || null;
}

async function clearGlobalNavigationObjectives(scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  const { rows } = await pool.query(
    `DELETE FROM navigation_global_waypoints WHERE scope_key=$1 RETURNING *`,
    [scope]
  );
  return rows;
}

async function getGlobalNavigationSession(scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  const { rows } = await pool.query(
    `SELECT * FROM navigation_global_sessions WHERE scope_key=$1 LIMIT 1`,
    [scope]
  );
  return rows[0] || null;
}

async function setGlobalNavigationSecondsPerMap(secondsPerMap, scopeKey = "global") {
  const scope = String(scopeKey || "global").trim() || "global";
  const value = Math.max(20, Math.min(600, Number(secondsPerMap) || 90));
  const { rows } = await pool.query(
    `INSERT INTO navigation_global_sessions(scope_key, seconds_per_map, updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (scope_key) DO UPDATE SET
       seconds_per_map=EXCLUDED.seconds_per_map,
       updated_at=now()
     RETURNING *`,
    [scope, value]
  );
  return rows[0];
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
  pool, init, createEvent, setThread, setRosterMsg, setNumParties, setPartyList, parsePartyList, parseReallocationLocks, setReallocationLocks, setEventBrief, getEvent, getEventByThread,
  setBombThread, setBombPingMsg, upsertBombConfirm, getBombConfirms, setBombComp, setBombRoster,
  upsertBombSignup, getBombSignups, deleteBombSignup,
  voiceJoin, voiceLeave, voiceCloseAllOpen, getPresenceInWindow, getEventsInRange, setEventIgnored,
  getCurrentSeason, startSeason, finishSeason,
  getOpenEvents, getOpenEventByTime, getRecentClosedEvents, getSignupAtSlot, clearParty, moveSignupToSlot,
  getSignups, getSignup, upsertSignup, deleteSignup, setStatus, setTimeLabel,
  getDueReminders, markReminderSent,
  addNavigationObjective, setNavigationObjective, getNavigationObjective, getNavigationObjectives,
  removeNavigationObjective, startNavigationCarry, completeNavigationObjective, clearNavigationObjective, clearNavigationObjectives,
  compactNavigationPositions, getNavigationSession, setNavigationObjectiveMessage,
  setNavigationSecondsPerMap, getOpenNavigationObjectives,
  addGlobalNavigationObjective, getGlobalNavigationObjectives, removeGlobalNavigationObjective,
  startGlobalNavigationCarry, completeGlobalNavigationObjective, clearGlobalNavigationObjectives,
  compactGlobalNavigationPositions, getGlobalNavigationSession, setGlobalNavigationSecondsPerMap,
  createRoaming, getRoaming, getRoamingById, getOpenRoamings, setRoamingField,
  upsertRoamingSignup, getRoamingSignups, deleteRoamingSignup,
  roamingVoiceJoin, roamingVoiceLeave, roamingCloseAllOpen, getRoamingPresence,
  createCastelo, getCastelo, getCasteloById, getCasteloByThread, getOpenCastelos, setCasteloField,
  upsertCasteloSignup, getCasteloSignups, deleteCasteloSignup, moveCasteloSignup,
  casteloVoiceJoin, casteloVoiceLeave, casteloCloseAllOpen, getCasteloPresence,
};