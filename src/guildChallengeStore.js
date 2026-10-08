"use strict";

const { extractChallengeSnapshots } = require("./guildChallenge");

async function initSchema(pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS guild_challenge_snapshots (" +
    "id BIGSERIAL PRIMARY KEY, response_event_id TEXT UNIQUE NOT NULL, " +
    "device_id TEXT, observer TEXT, confidence DOUBLE PRECISION NOT NULL, " +
    "captured_at TIMESTAMPTZ NOT NULL, layout JSONB NOT NULL DEFAULT '{}'::jsonb, " +
    "members_complete BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_guild_challenge_snapshot_time ON guild_challenge_snapshots(captured_at DESC)");
  await pool.query("CREATE TABLE IF NOT EXISTS guild_challenge_snapshot_members (" +
    "snapshot_id BIGINT NOT NULL REFERENCES guild_challenge_snapshots(id) ON DELETE CASCADE, " +
    "player_key TEXT NOT NULL, player_name TEXT NOT NULL, points BIGINT NOT NULL, " +
    "PRIMARY KEY(snapshot_id, player_key))");
}

async function materialize(pool, rows) {
  const snapshots = extractChallengeSnapshots(rows);
  if (!snapshots.length) return { candidates: 0, stored: 0 };
  const ids = snapshots.map(s => s.responseEventId).filter(Boolean);
  if (!ids.length) return { candidates: snapshots.length, stored: 0 };
  const completeRows = await pool.query(
    "SELECT response_event_id FROM guild_challenge_snapshots WHERE response_event_id = ANY($1::text[]) AND members_complete=true",
    [ids]
  );
  const complete = new Set(completeRows.rows.map(x => x.response_event_id));
  let stored = 0;
  for (const snap of snapshots) {
    if (!snap.responseEventId || complete.has(snap.responseEventId)) continue;
    const members = snap.members.map(m => ({
      player_key: m.player.toLowerCase(),
      player_name: m.player,
      points: m.points
    }));
    if (!members.length) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO guild_challenge_snapshots(response_event_id,device_id,observer,confidence,captured_at,layout,members_complete) " +
        "VALUES($1,$2,$3,$4,$5,$6::jsonb,false) " +
        "ON CONFLICT(response_event_id) DO UPDATE SET " +
        "confidence=GREATEST(guild_challenge_snapshots.confidence,EXCLUDED.confidence)," +
        "layout=EXCLUDED.layout,members_complete=false RETURNING id",
        [snap.responseEventId,snap.deviceId,snap.observer,snap.confidence,snap.capturedAt,JSON.stringify(snap.layout)]
      );
      const snapshotId = inserted.rows[0].id;
      await client.query("DELETE FROM guild_challenge_snapshot_members WHERE snapshot_id=$1", [snapshotId]);
      await client.query(
        "INSERT INTO guild_challenge_snapshot_members(snapshot_id,player_key,player_name,points) " +
        "SELECT $1::bigint,x.player_key,x.player_name,x.points FROM jsonb_to_recordset($2::jsonb) " +
        "AS x(player_key text,player_name text,points bigint)",
        [snapshotId,JSON.stringify(members)]
      );
      await client.query("UPDATE guild_challenge_snapshots SET members_complete=true WHERE id=$1", [snapshotId]);
      await client.query("COMMIT");
      stored++;
    } catch(e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { candidates: snapshots.length, stored };
}

async function getDashboard(pool, { days = 90 } = {}) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 90));
  const [latest, stats, probes] = await Promise.all([
    pool.query(
      "SELECT id,response_event_id,device_id,observer,confidence,captured_at " +
      "FROM guild_challenge_snapshots WHERE members_complete=true " +
      "AND captured_at >= now() - ($1::text || ' days')::interval " +
      "ORDER BY captured_at DESC,id DESC LIMIT 1", [safeDays]
    ),
    pool.query("SELECT COUNT(*)::int AS n,MAX(captured_at) AS newest FROM guild_challenge_snapshots WHERE members_complete=true"),
    pool.query(
      "SELECT COUNT(*)::int AS total, " +
      "COUNT(*) FILTER (WHERE lower(COALESCE(payload->>'direction','response'))='response')::int AS responses, " +
      "MAX(occurred_at) AS newest " +
      "FROM albion_telemetry_events WHERE type='guild_might_probe' " +
      "AND payload->>'operationName'='GetGuildChallengePoints' AND occurred_at >= now() - interval '3 days'"
    )
  ]);
  const snap = latest.rows[0] || null;
  let members = [];
  if (snap) {
    const result = await pool.query(
      "SELECT player_name,points FROM guild_challenge_snapshot_members WHERE snapshot_id=$1 " +
      "ORDER BY points DESC,player_name", [snap.id]
    );
    members = result.rows.map(r => ({ player: r.player_name, points: Number(r.points) || 0 }));
  }
  return {
    available: !!snap, verified: false,
    source: "GetGuildChallengePoints",
    capturedAt: snap?.captured_at || null,
    observer: snap?.observer || null,
    confidence: snap ? Number(snap.confidence) : null,
    members, totalPoints: members.reduce((a, m) => a + m.points, 0),
    meta: {
      days: safeDays, storedSnapshots: Number(stats.rows[0]?.n) || 0,
      newestStoredAt: stats.rows[0]?.newest || null,
      rawProbes3d: Number(probes.rows[0]?.total) || 0,
      rawResponses3d: Number(probes.rows[0]?.responses) || 0,
      rawNewestAt: probes.rows[0]?.newest || null,
      note: "Extração passiva experimental. Valores de Challenge Points NÃO são Guild Might. Validar nomes e colunas com o painel do jogo antes de uso oficial."
    }
  };
}

module.exports = { initSchema, materialize, getDashboard };
