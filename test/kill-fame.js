"use strict";

const assert = require("assert/strict");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";
process.env.ALBION_API_CONCURRENCY = "2";

const db = require("../src/db");
const telemetry = require("../src/telemetry");
const scout = require("../src/scout");
const killFame = require("../src/killFame");

const GUILD = process.env.GUILD_ID;
const BASE = Date.parse("2026-10-05T17:20:00Z");

function ok(name) {
  console.log("✅ " + name);
}

function fakeResponse(status, body, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return normalized.get(String(name).toLowerCase()) || null; } },
    async json() { return body; }
  };
}

function officialEvent(id, seconds, killer, victim, fame, killerGuild = "IMORTAIS", victimGuild = "ARCH") {
  return {
    EventId: id,
    BattleId: "battle-" + id,
    TimeStamp: new Date(BASE + seconds * 1000).toISOString(),
    TotalVictimKillFame: fame,
    Killer: { Name: killer, GuildName: killerGuild, AllianceName: "" },
    Victim: { Name: victim, GuildName: victimGuild, AllianceName: "AAA" },
    Location: "Thunderrock Upland"
  };
}

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE albion_telemetry_events, player_cta_stats, cta_signups, bomb_confirms, " +
    "voice_presence, seasons, cta_events RESTART IDENTITY CASCADE"
  );
}

async function seedEvent() {
  await db.pool.query(
    "INSERT INTO seasons(guild_id,number,started_at) VALUES($1,34,'2026-09-01T00:00:00Z')",
    [GUILD]
  );
  const { rows } = await db.pool.query(
    "INSERT INTO cta_events(guild_id,channel_id,caller_id,time_label,status,created_at) " +
    "VALUES($1,'chan','caller','17:20','closed','2026-10-05T16:00:00Z') RETURNING *",
    [GUILD]
  );
  await db.pool.query(
    "INSERT INTO cta_signups(event_id,user_id,username,weapon,presence,party_index,slot_index) " +
    "VALUES($1,'u1','Alice','MAÇA PESADA','online',0,0)",
    [rows[0].id]
  );
  return rows[0];
}

async function insertDeath(eventId, rawId, seconds, payload) {
  const at = new Date(BASE + seconds * 1000).toISOString();
  await db.pool.query(
    "INSERT INTO albion_telemetry_events(event_id,cta_event_id,device_id,type,occurred_at,player_name,payload,received_at) " +
    "VALUES($1,$2,'dev-a','player_death_observed',$3,'Alice',$4::jsonb,$3)",
    [rawId, eventId, at, JSON.stringify(payload)]
  );
}

async function testSingleFlightAnd429() {
  killFame.__test.resetForTests();
  killFame.__test.setSleep(async () => {});
  killFame.__test.setRetryMs([0, 0, 0, 0]);

  let searchCalls = 0;
  killFame.__test.setFetch(async (url) => {
    if (String(url).includes("/search?q=Alice")) {
      searchCalls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return fakeResponse(200, { players: [{ Name: "Alice", Id: "alice-id" }] });
    }
    throw new Error("URL inesperada: " + url);
  });

  const ids = await Promise.all(
    Array.from({ length: 10 }, () => killFame.__test.resolvePlayerId("Alice"))
  );
  assert.deepEqual(ids, Array(10).fill("alice-id"));
  assert.equal(searchCalls, 1, "10 chamadas simultâneas devem compartilhar a busca");

  killFame.__test.resetForTests();
  const sleeps = [];
  killFame.__test.setSleep(async (ms) => { sleeps.push(ms); });
  killFame.__test.setRetryMs([0, 0, 0, 0]);

  let attempts = 0;
  killFame.__test.setFetch(async () => {
    attempts++;
    return attempts === 1
      ? fakeResponse(429, {}, { "Retry-After": "2" })
      : fakeResponse(200, { ok: true });
  });

  assert.deepEqual(await killFame.__test.albionJson("/429-test"), { ok: true });
  assert.equal(attempts, 2);
  assert.ok(sleeps.some(ms => ms >= 2000), "Retry-After de 2 s deve prevalecer sobre backoff menor");
  ok("GameInfo: 10 chamadas = 1 request; HTTP 429 respeita Retry-After/backoff");
}

async function testConcurrencyLimit() {
  killFame.__test.resetForTests();
  killFame.__test.setSleep(async () => {});

  let active = 0;
  let maxActive = 0;
  killFame.__test.setFetch(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return fakeResponse(200, []);
  });

  await Promise.all([
    killFame.__test.albionJson("/a"),
    killFame.__test.albionJson("/b"),
    killFame.__test.albionJson("/c"),
    killFame.__test.albionJson("/d")
  ]);

  assert.ok(maxActive <= 2, "máximo esperado 2, observado " + maxActive);
  ok("GameInfo: limite de concorrência respeitado (máx. " + maxActive + ")");
}

function testConservativeMatch() {
  const expected = {
    killer: "Alice",
    victim: "Enemy",
    killerGuild: "IMORTAIS",
    victimGuild: "ARCH",
    occurredAt: new Date(BASE + 30_000).toISOString()
  };

  const one = officialEvent("1", 30, "Alice", "Enemy", 12345);
  assert.equal(
    killFame.__test.matchOfficialEvent([one, { ...one }], expected)?.EventId,
    "1",
    "mesmo EventId vindo de kills/deaths deve deduplicar"
  );

  const secondPlausible = officialEvent("2", 45, "Alice", "Enemy", 22222);
  assert.equal(
    killFame.__test.matchOfficialEvent([one, secondPlausible], expected),
    null,
    "dois kills plausíveis devem ser tratados como ambíguos"
  );

  const wrongGuild = officialEvent("3", 30, "Alice", "Enemy", 33333, "OTHER", "ARCH");
  assert.equal(killFame.__test.matchOfficialEvent([wrongGuild], expected), null);
  ok("casamento oficial: ambiguidade ou guild divergente não preenche fame");
}

async function testPersistenceAndNoRegression() {
  await resetDb();
  await telemetry.initSchema(db.pool);
  await scout.initSchema(db.pool);
  await scout.initSchema(db.pool);
  const ev = await seedEvent();

  const ourKill = {
    killer: "Alice",
    victim: "Enemy",
    killerGuild: "IMORTAIS",
    victimGuild: "ARCH",
    isLethal: true,
    cluster: "Thunderrock Upland",
    killerObjectId: 100,
    victimObjectId: 200
  };
  await insertDeath(ev.id, "observed-kill", 30, ourKill);

  const ourDeath = {
    killer: "EnemyTwo",
    victim: "Alice",
    killerGuild: "ARCH",
    victimGuild: "IMORTAIS",
    isLethal: true,
    cluster: "Thunderrock Upland",
    killerObjectId: 300,
    victimObjectId: 100,
    killFame: 54321,
    totalVictimKillFame: 54321,
    killFameSource: "albion-gameinfo",
    albionEventId: "official-loss"
  };
  await insertDeath(ev.id, "observed-loss", 80, ourDeath);

  killFame.__test.resetForTests();
  killFame.__test.setSleep(async () => {});
  killFame.__test.setRetryMs([0, 0, 0, 0]);

  const official = officialEvent("official-kill", 30, "Alice", "Enemy", 12345);
  killFame.__test.setFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search?q=Alice")) {
      return fakeResponse(200, { players: [{ Name: "Alice", Id: "alice-id" }] });
    }
    if (u.includes("/search?q=Enemy")) {
      return fakeResponse(200, { players: [{ Name: "Enemy", Id: "enemy-id" }] });
    }
    if (u.includes("/players/alice-id/kills")) return fakeResponse(200, [official]);
    if (u.includes("/players/enemy-id/deaths")) return fakeResponse(200, [official]);
    throw new Error("URL inesperada: " + u);
  });

  const enriched = await killFame.enrichOnce({
    pool: db.pool,
    eventId: "observed-kill",
    payload: ourKill,
    occurredAt: new Date(BASE + 30_000).toISOString()
  });
  assert.equal(enriched.patch.killFame, 12345);

  const combat = await telemetry.getCombat(db, ev.id);
  const alice = combat.players.find(p => p.n === "Alice");
  assert.ok(alice);
  assert.equal(alice.killFame, 12345);
  assert.equal(alice.deathFame, 54321);
  assert.equal(combat.resumo.killFame, 12345);
  assert.equal(combat.resumo.deathFame, 54321);

  const attendance = {
    processEvent: async () => new Map([
      ["u1", { username: "Alice", level: "INTEGRAL", minutes: 90, pingou: true, bomb: false }]
    ]),
    windowFor: () => ({
      start: new Date(BASE),
      end: new Date(BASE + 100 * 60 * 1000)
    })
  };

  await scout.snapshotCta(db, attendance, telemetry, ev.id, { pass: "first" });

  let saved = (await db.pool.query(
    "SELECT kill_fame,death_fame,combat_observed FROM player_cta_stats " +
    "WHERE cta_event_id=$1 AND player_key='alice'",
    [ev.id]
  )).rows[0];

  assert.equal(Number(saved.kill_fame), 12345);
  assert.equal(Number(saved.death_fame), 54321);
  assert.equal(saved.combat_observed, true);

  const ov = await scout.overview(db, GUILD);
  const summary = ov.rows.find(r => r.playerKey === "alice");
  assert.equal(summary.kill_fame, 12345);
  assert.equal(summary.death_fame, 54321);

  const detail = await scout.playerDetail(db, GUILD, "Alice");
  assert.equal(detail.history[0].kill_fame, 12345);
  assert.equal(detail.history[0].death_fame, 54321);

  await db.pool.query("DELETE FROM albion_telemetry_events WHERE cta_event_id=$1", [ev.id]);
  await scout.snapshotCta(db, attendance, telemetry, ev.id);

  saved = (await db.pool.query(
    "SELECT kill_fame,death_fame FROM player_cta_stats " +
    "WHERE cta_event_id=$1 AND player_key='alice'",
    [ev.id]
  )).rows[0];

  assert.equal(Number(saved.kill_fame), 12345);
  assert.equal(Number(saved.death_fame), 54321);
  ok("Combate expõe fame; Scout persiste e não regride após apagar telemetria bruta");
}

function testSemanticDedupMapExpires() {
  killFame.__test.resetForTests();

  let now = 1_000_000;
  killFame.__test.setNow(() => now);
  const windowMs = killFame.__test.config().semanticDedupMs;
  const resolved = Promise.resolve(null);

  for (let i = 0; i < 1000; i++) {
    killFame.__test.rememberSemanticEnrichment(
      "killer-" + i + "|victim-" + i,
      BASE + i,
      resolved
    );
  }

  assert.equal(killFame.__test.semanticEnrichmentSize(), 1000);

  now += windowMs + 1;
  killFame.__test.rememberSemanticEnrichment("fresh|pair", BASE + 2000, resolved);

  assert.equal(
    killFame.__test.semanticEnrichmentSize(),
    1,
    "após a janela, 1.000 pares antigos devem ser varridos antes da nova inserção"
  );

  killFame.__test.resetForTests();
  ok("dedup semântico: mapa não cresce após expirar 1.000 pares distintos");
}

async function testEnemyFilteringDedupAndCoalesce() {
  killFame.__test.resetForTests();
  killFame.__test.setSleep(async () => {});
  killFame.__test.setRetryMs([]);
  killFame.__test.setResolvedCoalesceMs(5);

  const roster = new Set(["alice"]);
  const at = new Date(BASE + 30_000).toISOString();
  const observed = [];

  for (let i = 0; i < 270; i++) {
    observed.push({
      eventId: "enemy-" + i,
      occurredAt: new Date(BASE + i * 1000).toISOString(),
      payload: {
        killer: "EnemyK" + i,
        victim: "EnemyV" + i,
        killerGuild: "ARCH",
        victimGuild: "POE",
        isLethal: true
      }
    });
  }
  for (let i = 0; i < 30; i++) {
    observed.push({
      eventId: "ours-observer-" + i,
      occurredAt: new Date(BASE + 30_000 + (i % 3) * 250).toISOString(),
      payload: {
        killer: "Alice",
        victim: "EnemyBoss",
        killerGuild: "IMORTAIS",
        victimGuild: "ARCH",
        isLethal: true
      }
    });
  }

  const eligible = observed.filter(x => telemetry.__test.shouldEnrichKillFame(x.payload, roster));
  assert.equal(eligible.length, 30, "270 mortes entre inimigos não devem entrar na fila");

  let requests = 0;
  const official = officialEvent("official-one", 30, "Alice", "EnemyBoss", 77777);
  killFame.__test.setFetch(async (url) => {
    requests++;
    const s = String(url);
    if (s.includes("/search?q=Alice")) {
      return fakeResponse(200, { players: [{ Name: "Alice", Id: "alice-id" }] });
    }
    if (s.includes("/search?q=EnemyBoss")) {
      return fakeResponse(200, { players: [{ Name: "EnemyBoss", Id: "enemy-id" }] });
    }
    if (s.includes("/players/alice-id/kills")) return fakeResponse(200, [official]);
    if (s.includes("/players/enemy-id/deaths")) return fakeResponse(200, [official]);
    throw new Error("URL inesperada: " + s);
  });

  let invalidations = 0;
  const fakePool = {
    async query() { return { rows: [{ cta_event_id: "cta-1" }] }; }
  };

  await Promise.all(eligible.map(item => killFame.queueEnrichment({
    pool: fakePool,
    eventId: item.eventId,
    payload: item.payload,
    occurredAt: item.occurredAt,
    onResolved: () => { invalidations++; }
  })));

  await new Promise(resolve => setTimeout(resolve, 20));

  assert.ok(requests <= 4, "30 observações do mesmo kill devem gerar no máximo 4 requests; observado " + requests);
  assert.equal(invalidations, 1, "resoluções do mesmo CTA devem coalescer em uma invalidação por janela");
  ok("300 mortes: 270 inimigas filtradas, kill multi-observer deduplicado e 1 invalidação coalescida");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await testSingleFlightAnd429();
  await testConcurrencyLimit();
  testConservativeMatch();
  testSemanticDedupMapExpires();
  await testEnemyFilteringDedupAndCoalesce();
  await testPersistenceAndNoRegression();

  console.log("\n✅ Kill Fame suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async err => {
    console.error("\n❌ Kill Fame suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
