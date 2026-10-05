"use strict";

const assert = require("assert/strict");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";

const db = require("../src/db");
const scout = require("../src/scout");
const telemetry = require("../src/telemetry");

const GUILD = process.env.GUILD_ID;
const BASE = Date.parse("2026-10-02T17:20:00Z");

function ok(name) { console.log("✅ " + name); }

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE albion_telemetry_events, player_cta_stats, cta_signups, bomb_confirms, " +
    "voice_presence, seasons, cta_events RESTART IDENTITY CASCADE"
  );
}

async function seedSeason() {
  await db.pool.query(
    "INSERT INTO seasons(guild_id,number,started_at) VALUES($1,34,'2026-09-01T00:00:00Z')",
    [GUILD]
  );
}

async function seedEvent() {
  const { rows } = await db.pool.query(
    "INSERT INTO cta_events(guild_id,channel_id,caller_id,time_label,status,created_at) " +
    "VALUES($1,'chan','caller','17:20','closed','2026-10-02T16:00:00Z') RETURNING *",
    [GUILD]
  );
  return rows[0];
}

async function seedSignup(eventId) {
  await db.pool.query(
    "INSERT INTO cta_signups(event_id,user_id,username,weapon,presence,party_index,slot_index) " +
    "VALUES($1,'u1','Alice','HEAVY MACE','online',0,0)",
    [eventId]
  );
}

function attendanceStub() {
  return {
    processEvent: async () => new Map([
      ["u1", { username: "Alice", level: "INTEGRAL", minutes: 90, pingou: true, bomb: false }]
    ]),
    windowFor: () => ({
      start: new Date("2026-10-02T17:00:00Z"),
      end: new Date("2026-10-02T19:00:00Z")
    })
  };
}

async function insertSnapshot(eventId, idx, device, msOffset, players) {
  const at = new Date(BASE + idx * 15000 + msOffset);
  await db.pool.query(
    "INSERT INTO albion_telemetry_events(event_id,cta_event_id,device_id,type,occurred_at,player_name,payload,received_at) " +
    "VALUES($1,$2,$3,'player_presence_snapshot',$4,$5,$6::jsonb,$4)",
    [
      "presence-" + idx + "-" + device,
      eventId,
      device,
      at,
      device === "dev-a" ? "ObserverA" : "ObserverB",
      JSON.stringify({
        cluster: "Thunderrock Upland",
        players,
        observedCount: players.length,
        snapshotIntervalMs: 15000,
        source: "NewCharacter+Leave"
      })
    ]
  );
}

function alice(guid) {
  return { objectId: 10, playerId: guid, name: "Alice", guild: "IMORTAIS", alliance: "" };
}
const enemy = { objectId: 20, playerId: "enemy-guid", name: "EnemyOne", guild: "ARCH", alliance: "AAA" };
const noLine = { objectId: 30, playerId: "ally-guid", name: "NoLineAlly", guild: "IMORTAIS", alliance: "" };

async function seedSixtyBuckets(eventId) {
  for (let i = 0; i < 60; i++) {
    const seen = i < 40;
    const guidA = i === 39 ? "alice-guid-old" : "alice-guid";
    const guidB = i === 39 ? "alice-guid-latest" : "alice-guid";
    const playersA = [enemy, noLine];
    const playersB = [enemy, noLine];
    if (seen) {
      playersA.push(alice(guidA));
      playersB.push(alice(guidB));
    }
    await insertSnapshot(eventId, i, "dev-a", 1000, playersA);
    await insertSnapshot(eventId, i, "dev-b", 5000, playersB);
  }
}

async function testAreaPersistenceAndNoRegression() {
  await resetDb();
  await seedSeason();
  const ev = await seedEvent();
  await seedSignup(ev.id);
  await seedSixtyBuckets(ev.id);

  await scout.snapshotCta(db, attendanceStub(), telemetry, ev.id, { pass: "first" });

  let rows = (await db.pool.query(
    "SELECT * FROM player_cta_stats WHERE cta_event_id=$1 ORDER BY player_key",
    [ev.id]
  )).rows;

  assert.equal(rows.length, 1, "presença não pode criar linhas novas");
  assert.equal(rows[0].player_key, "alice");
  assert.equal(rows[0].area_observed, true);
  assert.equal(Number(rows[0].area_total_buckets), 60);
  assert.equal(Number(rows[0].area_seen_buckets), 40);
  assert.equal(rows[0].albion_player_id, "alice-guid-latest");
  assert.equal(rows.some(r => r.player_key === "enemyone"), false, "inimigo não pode ser persistido");
  assert.equal(rows.some(r => r.player_key === "nolineally"), false, "aliado sem linha prévia não pode ser criado");

  const ov = await scout.overview(db, GUILD);
  const summary = ov.rows.find(r => r.playerKey === "alice");
  assert.ok(summary);
  assert.equal(summary.area_seen_buckets, 40);
  assert.equal(summary.area_total_buckets, 60);
  assert.equal(summary.area_observed, true);
  assert.equal(summary.albion_player_id, "alice-guid-latest");

  const detail = await scout.playerDetail(db, GUILD, "Alice");
  assert.ok(detail);
  assert.equal(detail.history[0].area_seen_buckets, 40);
  assert.equal(detail.history[0].area_total_buckets, 60);
  assert.equal(detail.history[0].area_observed, true);
  assert.equal(detail.history[0].albion_player_id, "alice-guid-latest");

  await db.pool.query(
    "DELETE FROM albion_telemetry_events WHERE cta_event_id=$1 AND type='player_presence_snapshot'",
    [ev.id]
  );
  await scout.snapshotCta(db, attendanceStub(), telemetry, ev.id);

  rows = (await db.pool.query(
    "SELECT * FROM player_cta_stats WHERE cta_event_id=$1 AND player_key='alice'",
    [ev.id]
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].area_observed, true);
  assert.equal(Number(rows[0].area_total_buckets), 60);
  assert.equal(Number(rows[0].area_seen_buckets), 40);
  assert.equal(rows[0].albion_player_id, "alice-guid-latest");

  ok("área: 2 observers dedup; Alice 40/60; GUID salvo; inimigo/sem-linha ignorados; vazio não regride");
}

async function testAreaBackfillOnceWithoutVersionBump() {
  await resetDb();
  const ev = await seedEvent();

  await db.pool.query(
    "INSERT INTO player_cta_stats(guild_id,cta_event_id,discord_user_id,player_key,player_name,stats_version) " +
    "VALUES($1,$2,'u1','alice','Alice',$3)",
    [GUILD, ev.id, scout.STATS_VERSION]
  );
  await db.pool.query(
    "UPDATE cta_events SET scout_first_pass_at='2026-10-03T00:00:00Z', " +
    "scout_second_pass_at='2026-10-03T18:00:00Z', scout_stats_version=$2 WHERE id=$1",
    [ev.id, scout.STATS_VERSION]
  );
  await insertSnapshot(ev.id, 0, "dev-a", 1000, [alice("alice-backfill-guid")]);
  await insertSnapshot(ev.id, 0, "dev-b", 5000, [alice("alice-backfill-guid")]);

  const now = new Date("2026-10-03T20:00:00Z");
  const first = await scout.consolidateDue(db, attendanceStub(), telemetry, { now, limit: 10 });
  assert.equal(first.areaBackfill.ok, 1);

  const saved = (await db.pool.query(
    "SELECT area_seen_buckets,area_total_buckets,area_observed,albion_player_id,stats_version FROM player_cta_stats WHERE cta_event_id=$1",
    [ev.id]
  )).rows[0];
  assert.equal(saved.area_observed, true);
  assert.equal(Number(saved.area_seen_buckets), 1);
  assert.equal(Number(saved.area_total_buckets), 1);
  assert.equal(saved.albion_player_id, "alice-backfill-guid");
  assert.equal(Number(saved.stats_version), 1);
  assert.equal(scout.STATS_VERSION, 1);

  const state = (await db.pool.query(
    "SELECT scout_area_backfill_at,scout_stats_version FROM cta_events WHERE id=$1",
    [ev.id]
  )).rows[0];
  assert.ok(state.scout_area_backfill_at);
  assert.equal(Number(state.scout_stats_version), 1);

  const second = await scout.consolidateDue(db, attendanceStub(), telemetry, {
    now: new Date(now.getTime() + 60 * 1000),
    limit: 10
  });
  assert.equal(second.areaBackfill.total, 0);

  ok("backfill de área roda uma vez e mantém STATS_VERSION/retention em 1");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await telemetry.initSchema(db.pool);
  await scout.initSchema(db.pool);
  await scout.initSchema(db.pool);
  ok("initSchema roda 2x sem erro");

  await testAreaPersistenceAndNoRegression();
  await testAreaBackfillOnceWithoutVersionBump();

  console.log("\n✅ Scout area presence suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Scout area presence suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
