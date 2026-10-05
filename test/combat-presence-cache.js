"use strict";

const assert = require("assert/strict");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";

const db = require("../src/db");
const telemetry = require("../src/telemetry");

const GUILD = process.env.GUILD_ID;
const DAY = 24 * 60 * 60 * 1000;

function ok(name) { console.log("✅ " + name); }

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE albion_telemetry_events, player_cta_stats, cta_signups, bomb_confirms, " +
    "voice_presence, seasons, cta_events RESTART IDENTITY CASCADE"
  );
  telemetry.__test.resetCombatCache();
}

async function seedEvent(status = "open") {
  const { rows } = await db.pool.query(
    "INSERT INTO cta_events(guild_id,channel_id,caller_id,time_label,status,created_at) " +
    "VALUES($1,'chan','caller','17:20',$2,'2026-10-05T16:00:00Z') RETURNING *",
    [GUILD, status]
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

async function insertPresence(eventId, id, at, device, players) {
  await db.pool.query(
    "INSERT INTO albion_telemetry_events(event_id,cta_event_id,device_id,type,occurred_at,player_name,payload,received_at) " +
    "VALUES($1,$2,$3,'player_presence_snapshot',$4,'Alice',$5::jsonb,$4)",
    [id, eventId, device, at, JSON.stringify({
      cluster: "Thunderrock Upland",
      players,
      observedCount: players.length,
      snapshotIntervalMs: 15000,
      source: "NewCharacter+Leave"
    })]
  );
}

async function insertCombat(eventId) {
  await db.pool.query(
    "INSERT INTO albion_telemetry_events(event_id,cta_event_id,device_id,type,occurred_at,player_name,payload,received_at) " +
    "VALUES('combat-1',$1,'dev-a','combat_delta','2026-10-05T17:20:10Z','Alice',$2::jsonb,'2026-10-05T17:20:10Z')",
    [eventId, JSON.stringify({
      player: "Alice",
      damage: 1000,
      healing: 0,
      cluster: "Thunderrock Upland"
    })]
  );
}

async function testSingleFlightAndTtl() {
  telemetry.__test.resetCombatCache();
  let calls = 0;
  let clock = 100000;
  const fakeDb = { getEvent: async () => ({ id: 1, status: "open" }) };
  const loader = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { ok: true, call: calls };
  };
  const options = { loader, now: () => clock };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => telemetry.__test.getCombatCached(fakeDb, "1", options))
  );
  assert.equal(calls, 1, "10 simultâneas devem compartilhar uma execução");
  assert.deepEqual(results, Array.from({ length: 10 }, () => ({ ok: true, call: 1 })));

  clock += 7999;
  assert.deepEqual(await telemetry.__test.getCombatCached(fakeDb, "1", options), { ok: true, call: 1 });
  assert.equal(calls, 1);

  clock += 2;
  assert.deepEqual(await telemetry.__test.getCombatCached(fakeDb, "1", options), { ok: true, call: 2 });
  assert.equal(calls, 2);
  ok("cache: 10 simultâneas = 1 getCombat; TTL aberto expira e recalcula");
}

async function testClosedTtl() {
  telemetry.__test.resetCombatCache();
  let calls = 0;
  let clock = 200000;
  const fakeDb = { getEvent: async () => ({ id: 2, status: "closed" }) };
  const loader = async () => ({ call: ++calls });
  const options = { loader, now: () => clock };

  assert.deepEqual(await telemetry.__test.getCombatCached(fakeDb, "2", options), { call: 1 });
  clock += 59000;
  assert.deepEqual(await telemetry.__test.getCombatCached(fakeDb, "2", options), { call: 1 });
  clock += 1001;
  assert.deepEqual(await telemetry.__test.getCombatCached(fakeDb, "2", options), { call: 2 });
  assert.equal(calls, 2);
  ok("cache: CTA fechado usa TTL de 60 s");
}

async function testErrorNotCached() {
  telemetry.__test.resetCombatCache();
  let calls = 0;
  const fakeDb = { getEvent: async () => ({ id: 3, status: "open" }) };
  const loader = async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return { recovered: true };
  };

  await assert.rejects(
    telemetry.__test.getCombatCached(fakeDb, "3", { loader, now: () => 300000 }),
    /boom/
  );
  const result = await telemetry.__test.getCombatCached(fakeDb, "3", {
    loader,
    now: () => 300001
  });
  assert.deepEqual(result, { recovered: true });
  assert.equal(calls, 2);
  ok("cache: erro não é guardado");
}

async function testSingleReadDeepEqual() {
  await resetDb();
  const ev = await seedEvent("open");
  await seedSignup(ev.id);
  await insertCombat(ev.id);

  const alice = { objectId: 10, playerId: "alice-guid", name: "Alice", guild: "IMORTAIS", alliance: "" };
  const enemy = { objectId: 20, playerId: "enemy-guid", name: "Enemy", guild: "ARCH", alliance: "AAA" };

  await insertPresence(ev.id, "presence-1", "2026-10-05T17:20:05Z", "dev-a", [alice, enemy]);
  await insertPresence(ev.id, "presence-2", "2026-10-05T17:20:06Z", "dev-b", [alice, enemy]);
  await insertPresence(ev.id, "presence-3", "2026-10-05T17:20:20Z", "dev-a", [alice]);

  // Caminho antigo: getCombat e getPresenceArea fazem suas próprias leituras.
  const oldCombat = await telemetry.getCombat(db, ev.id);
  const oldArea = await telemetry.getPresenceArea(ev.id);

  // Caminho novo do Scout: uma leitura, compartilhada pelos dois cálculos.
  const presenceRows = await telemetry.getPresenceSnapshotRows(ev.id);
  const newCombat = await telemetry.getCombat(db, ev.id, { presenceRows });
  const newArea = await telemetry.getPresenceArea(ev.id, presenceRows);

  assert.deepEqual(newCombat, oldCombat);
  assert.deepEqual(newArea, oldArea);
  assert.equal(newCombat.audit.presenceSnapshots, 3);
  assert.equal(newArea.totalBuckets, 2);
  ok("leitura única: getCombat/getPresenceArea são deepEqual ao caminho de leitura dupla");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await telemetry.initSchema(db.pool);

  await testSingleFlightAndTtl();
  await testClosedTtl();
  await testErrorNotCached();
  await testSingleReadDeepEqual();

  console.log("\n✅ Combat presence cache suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Combat presence cache suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
