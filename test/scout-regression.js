"use strict";

const assert = require("assert/strict");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";
process.env.PORT = "0";
process.env.SESSION_SECRET = "scout-regression-secret-fixed-for-ci";

const db = require("../src/db");
const scout = require("../src/scout");
const telemetryReal = require("../src/telemetry");
const attendanceReal = require("../src/attendance");
const web = require("../src/web");

const GUILD = process.env.GUILD_ID;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ok(name) { console.log("✅ " + name); }

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE albion_telemetry_events, player_cta_stats, cta_signups, bomb_confirms, " +
    "voice_presence, seasons, cta_events RESTART IDENTITY CASCADE"
  );
}

async function seedSeason(startedAt = "2026-09-01T00:00:00Z") {
  await db.pool.query(
    "INSERT INTO seasons(guild_id,number,started_at) VALUES($1,34,$2)",
    [GUILD, startedAt]
  );
}

async function seedEvent({
  createdAt = "2026-10-01T16:00:00Z",
  time = "17:20",
  status = "open",
  ignored = false
} = {}) {
  const { rows } = await db.pool.query(
    "INSERT INTO cta_events(guild_id,channel_id,caller_id,time_label,status,ignored,created_at) " +
    "VALUES($1,'chan','caller',$2,$3,$4,$5) RETURNING *",
    [GUILD, time, status, ignored, createdAt]
  );
  return rows[0];
}

async function seedSignup(eventId, userId = "u1", username = "Alice") {
  await db.pool.query(
    "INSERT INTO cta_signups(event_id,user_id,username,weapon,presence,party_index,slot_index) " +
    "VALUES($1,$2,$3,'HEAVY MACE','online',0,0)",
    [eventId, userId, username]
  );
}

function attendanceStub({ minutes = 90, level = "INTEGRAL", username = "Alice", userId = "u1" } = {}) {
  return {
    windowFor: attendanceReal.windowFor,
    processEvent: async () => new Map([
      [userId, { username, level, minutes, pingou: true, bomb: false }]
    ])
  };
}

function combatTelemetry({
  player = "Alice",
  damage = 1000,
  healing = 200,
  kills = 2,
  deaths = 1,
  total = 10,
  equipment = true
} = {}) {
  return {
    getCombat: async () => ({
      players: [{ n: player, damage, healing, kills, deaths }],
      maps: [],
      deaths: [],
      audit: { devices: [{ deviceId: "dev1" }] },
      meta: { totalEventos: total, zergDeathObserver: false }
    }),
    getConfirm: async () => equipment ? ({
      pts: [{ linhas: [{
        n: player,
        actualParty: 1,
        itemPower: 1500,
        equipment: { mainHand: "T8_MAIN_MACE", head: "T8_HEAD_PLATE_SET1" },
        equipmentObservedAt: "2026-10-01T18:30:00Z"
      }] }],
      discordNoPing: [],
      gameNoSignup: [],
      meta: { partySnapshots: 1 }
    }) : null
  };
}

function emptyTelemetry() {
  return {
    getCombat: async () => ({
      players: [], maps: [], deaths: [],
      audit: { devices: [] },
      meta: { totalEventos: 0, zergDeathObserver: false }
    }),
    getConfirm: async () => null
  };
}

async function testInitSchemaTwice() {
  await scout.initSchema(db.pool);
  await scout.initSchema(db.pool);
  ok("initSchema roda 2x sem erro");
}

async function testForgottenOpenConsolidatesAndReads() {
  await resetDb();
  await seedSeason();
  const ev = await seedEvent({ status: "open" });
  await seedSignup(ev.id);
  const att = attendanceStub();
  const win = attendanceReal.windowFor(ev);
  const now = new Date(win.end.getTime() + 2 * HOUR + 5 * 60 * 1000);

  const r = await scout.consolidateDue(db, att, combatTelemetry(), { now, limit: 10 });
  assert.equal(r.ok, 1);
  assert.equal(r.done[0].pass, "first");

  const saved = await db.pool.query("SELECT * FROM player_cta_stats WHERE cta_event_id=$1", [ev.id]);
  assert.equal(saved.rows.length, 1);

  const ov = await scout.overview(db, GUILD);
  assert.equal(ov.ctaCount, 1);
  assert.equal(ov.rows.some(x => x.playerKey === "alice"), true);
  ok("(a) CTA open esquecido consolida e aparece na leitura");
}

async function testSecondPassExactlyOnce() {
  await resetDb();
  await seedSeason();
  const ev = await seedEvent({ status: "open" });
  await seedSignup(ev.id);
  const att = attendanceStub();
  const win = attendanceReal.windowFor(ev);

  const firstNow = new Date(win.end.getTime() + 2 * HOUR + 5 * 60 * 1000);
  const secondNow = new Date(win.end.getTime() + 24 * HOUR + 5 * 60 * 1000);

  assert.equal((await scout.consolidateDue(db, att, combatTelemetry(), { now: firstNow, limit: 10 })).ok, 1);
  const second = await scout.consolidateDue(db, att, combatTelemetry({ damage: 1200 }), { now: secondNow, limit: 10 });
  assert.equal(second.ok, 1);
  assert.equal(second.done[0].pass, "second");

  const third = await scout.consolidateDue(db, att, combatTelemetry({ damage: 1300 }), { now: new Date(secondNow.getTime() + HOUR), limit: 10 });
  assert.equal(third.total, 0);

  const state = await db.pool.query(
    "SELECT scout_first_pass_at,scout_second_pass_at,scout_stats_version FROM cta_events WHERE id=$1",
    [ev.id]
  );
  assert.ok(state.rows[0].scout_first_pass_at);
  assert.ok(state.rows[0].scout_second_pass_at);
  assert.equal(Number(state.rows[0].scout_stats_version), scout.STATS_VERSION);
  ok("(b) 2ª passada ocorre uma vez e não repete");
}

async function testSnapshotNeverRegressesCombat() {
  await resetDb();
  await seedSeason();
  const ev = await seedEvent({ status: "closed" });
  await seedSignup(ev.id);

  await scout.snapshotCta(db, attendanceStub({ minutes: 80 }), combatTelemetry(), ev.id, { pass: "first" });
  const before = (await db.pool.query("SELECT * FROM player_cta_stats WHERE cta_event_id=$1 AND player_key='alice'", [ev.id])).rows[0];
  assert.equal(before.combat_observed, true);
  assert.equal(Number(before.damage), 1000);
  assert.equal(Number(before.item_power), 1500);
  assert.ok(before.equipment);

  await scout.snapshotCta(db, attendanceStub({ minutes: 95 }), emptyTelemetry(), ev.id);
  const after = (await db.pool.query("SELECT * FROM player_cta_stats WHERE cta_event_id=$1 AND player_key='alice'", [ev.id])).rows[0];
  assert.equal(after.combat_observed, true);
  assert.equal(Number(after.damage), 1000);
  assert.equal(Number(after.healing), 200);
  assert.equal(Number(after.kills), 2);
  assert.equal(Number(after.deaths), 1);
  assert.equal(Number(after.item_power), 1500);
  assert.deepEqual(after.equipment, before.equipment);
  assert.equal(Number(after.voice_minutes), 95);
  ok("(c) snapshot vazio não zera combate/equipamento existente");
}

async function testIgnoredStoredButHidden() {
  await resetDb();
  await seedSeason();
  const ev = await seedEvent({ status: "open", ignored: true });
  await seedSignup(ev.id);
  const win = attendanceReal.windowFor(ev);

  await scout.consolidateDue(
    db, attendanceStub(), combatTelemetry(),
    { now: new Date(win.end.getTime() + 2 * HOUR + 5 * 60 * 1000), limit: 10 }
  );

  const saved = await db.pool.query("SELECT count(*)::int AS n FROM player_cta_stats WHERE cta_event_id=$1", [ev.id]);
  assert.equal(saved.rows[0].n, 1);

  let ov = await scout.overview(db, GUILD);
  assert.equal(ov.ctaCount, 0);
  assert.equal(await scout.playerDetail(db, GUILD, "Alice"), null);

  await db.setEventIgnored(ev.id, false);
  ov = await scout.overview(db, GUILD);
  assert.equal(ov.ctaCount, 1);
  assert.ok(await scout.playerDetail(db, GUILD, "Alice"));
  ok("(d) ignored consolida, some da leitura e volta ao desfazer ignore");
}

async function insertTelemetry(eventId, receivedAt, id) {
  await db.pool.query(
    "INSERT INTO albion_telemetry_events(event_id,cta_event_id,device_id,type,occurred_at,player_name,payload,received_at) " +
    "VALUES($1,$2,'dev-test','combat_delta',$3,'Alice','{}'::jsonb,$3)",
    [id, eventId, receivedAt]
  );
}

async function testCleanupProtectedUntilSecondPass() {
  await resetDb();
  const ev = await seedEvent({ status: "open", createdAt: "2026-09-29T16:00:00Z" });
  const now = new Date("2026-10-04T00:00:00Z");
  await insertTelemetry(ev.id, new Date(now.getTime() - 4 * DAY), "tel-protected");

  let r = await scout.cleanupTelemetry(db.pool, { now });
  assert.equal(r.deleted, 0);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM albion_telemetry_events")).rows[0].n, 1);

  await db.pool.query(
    "UPDATE cta_events SET scout_second_pass_at=$2,scout_stats_version=$3 WHERE id=$1",
    [ev.id, now, scout.STATS_VERSION]
  );
  r = await scout.cleanupTelemetry(db.pool, { now });
  assert.equal(r.deleted, 1);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM albion_telemetry_events")).rows[0].n, 0);
  ok("(e) limpeza protege CTA sem 2ª passada e apaga depois");
}

async function testSevenDayHardCapWarns() {
  await resetDb();
  const ev = await seedEvent({ status: "open", createdAt: "2026-09-20T16:00:00Z" });
  const now = new Date("2026-10-04T00:00:00Z");
  await insertTelemetry(ev.id, new Date(now.getTime() - 8 * DAY), "tel-hardcap");

  const warns = [];
  const oldWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  let r;
  try {
    r = await scout.cleanupTelemetry(db.pool, { now });
  } finally {
    console.warn = oldWarn;
  }

  assert.equal(r.deleted, 1);
  assert.ok(r.forcedCtas.includes(String(ev.id)));
  assert.ok(warns.some(x => x.includes(String(ev.id)) && x.includes("7 dias")));
  ok("(f) teto de 7 dias apaga e gera console.warn");
}

function cookieFor(payload) {
  const sid = web.__test.signSession({
    id: payload.id,
    name: payload.name || payload.id,
    canEdit: !!payload.canEdit,
    canManageDevices: false,
    canManageBomb: false,
    canManageCastleRoaming: false,
    isSiteAdmin: false,
    isMember: true,
    exp: Date.now() + HOUR
  });
  return "sid=" + sid;
}

async function testAccessHttp() {
  await resetDb();
  const ev = await seedEvent({ status: "open" });
  await db.pool.query(
    "INSERT INTO player_cta_stats(guild_id,cta_event_id,discord_user_id,player_key,player_name,stats_version) " +
    "VALUES($1,$2,'member-own','alice','Alice',$3),($1,$2,'someone-else','bob','Bob',$3)",
    [GUILD, ev.id, scout.STATS_VERSION]
  );

  const sensitive = player => ({
    summary: { playerName: player, coreVerified: true, radar: { impact: 99 } },
    profile: { core_verified: true },
    history: [{ secret: "history" }],
    current: { itemPower: 1550, equipment: { mainHand: "T8_MAIN_MACE" } }
  });
  const actions = {
    scoutOverview: async () => ({ rows: [{ playerName: "Alice" }], highlights: { secret: true } }),
    scoutPlayer: async (_guild, player, _event) => sensitive(player),
    scoutPlayerCurrent: async (_guild, _player, event) => event ? ({
      eventId: String(event),
      itemPower: 1550,
      equipment: { mainHand: "T8_MAIN_MACE" },
      equipmentObservedAt: "2026-10-03T20:00:00Z",
      equipmentInspected: true
    }) : null
  };
  const fakeClient = {
    guilds: { cache: new Map() },
    isReady: () => true
  };

  const server = web.startWebServer(fakeClient, actions);
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  const memberCookie = cookieFor({ id: "member-own", canEdit: false });
  const staffCookie = cookieFor({ id: "staff-user", canEdit: true });

  try {
    let r = await fetch(base + "/api/scout", { headers: { cookie: memberCookie } });
    assert.equal(r.status, 403);

    r = await fetch(base + "/api/scout/player?player=Bob&event=" + ev.id, { headers: { cookie: memberCookie } });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.limited, true);
    assert.ok(body.current);
    assert.deepEqual(Object.keys(body).sort(), ["current", "limited"]);
    assert.equal("summary" in body, false);
    assert.equal("history" in body, false);
    assert.equal("profile" in body, false);

    r = await fetch(base + "/api/scout/player?player=Alice&event=" + ev.id, { headers: { cookie: memberCookie } });
    assert.equal(r.status, 200);
    body = await r.json();
    assert.equal(body.summary.playerName, "Alice");
    assert.ok(body.history);
    assert.equal(body.summary.coreVerified, true);

    r = await fetch(base + "/api/scout/player?player=Bob&event=" + ev.id, { headers: { cookie: staffCookie } });
    assert.equal(r.status, 200);
    body = await r.json();
    assert.equal(body.summary.playerName, "Bob");
    assert.ok(body.history);

    r = await fetch(base + "/api/scout", { headers: { cookie: staffCookie } });
    assert.equal(r.status, 200);

    r = await fetch(base + "/api/scout/me", { headers: { cookie: memberCookie } });
    assert.equal(r.status, 200);
    body = await r.json();
    assert.equal(body.summary.playerName, "Alice");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  ok("acesso: ranking 403 para membro; outro=current; próprio/staff=perfil completo");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await telemetryReal.initSchema(db.pool);
  await testInitSchemaTwice();

  await testForgottenOpenConsolidatesAndReads();
  await testSecondPassExactlyOnce();
  await testSnapshotNeverRegressesCombat();
  await testIgnoredStoredButHidden();
  await testCleanupProtectedUntilSecondPass();
  await testSevenDayHardCapWarns();
  await testAccessHttp();

  console.log("\n✅ Scout regression suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Scout regression suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
