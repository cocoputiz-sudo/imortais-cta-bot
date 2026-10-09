"use strict";

const assert = require("assert/strict");
const { once } = require("node:events");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";
process.env.TELEMETRY_INGEST_KEY = "ingest-route-test-key";
// Let the OS choose an unused port; PID-derived ports collide in hosted CI.
process.env.PORT = "0";

const db = require("../src/db");
const telemetry = require("../src/telemetry");
const killFame = require("../src/killFame");
const web = require("../src/web");

const GUILD = process.env.GUILD_ID;

function ok(name) {
  console.log("✅ " + name);
}

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE albion_guild_presence, albion_telemetry_events, albion_telemetry_devices, albion_telemetry_agent_tokens, " +
    "cta_signups, bomb_confirms, voice_presence, cta_events RESTART IDENTITY CASCADE"
  );
}

async function postIngest(base, events, deviceId = "ingest-route-device") {
  const response = await fetch(base + "/api/telemetry/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.TELEMETRY_INGEST_KEY,
    },
    body: JSON.stringify({
      device: {
        deviceId,
        playerName: "Alice",
        version: "test",
      },
      events,
    }),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function withPoolQueryObserver(observer, fn) {
  const originalConnect = db.pool.connect;
  db.pool.connect = function (...args) {
    // pool.query() usa connect(callback) internamente; não interceptamos esse caminho.
    // O ingest usa await pool.connect(), que é o caminho que queremos observar.
    if (typeof args[0] === "function") {
      return originalConnect.apply(this, args);
    }
    return originalConnect.apply(this, args).then((client) => {
      const originalQuery = client.query;
      const originalRelease = client.release;

    client.query = function (...queryArgs) {
      const first = queryArgs[0];
      const sql = typeof first === "string" ? first : String(first?.text || "");
      const params = Array.isArray(queryArgs[1]) ? queryArgs[1] : [];
      observer({ sql, params });
      return originalQuery.apply(client, queryArgs);
    };

    client.release = function (...releaseArgs) {
      client.query = originalQuery;
      client.release = originalRelease;
      return originalRelease.apply(client, releaseArgs);
    };

      return client;
    });
  };

  try {
    return await fn();
  } finally {
    db.pool.connect = originalConnect;
  }
}

async function testUnauthorizedGuildProbesBlocked(base) {
  await resetDb();
  const body=JSON.stringify({
    device:{deviceId:"unpaired-guild-probe",playerName:"BadMack",version:"test"},
    events:[{
      eventId:"unauthorized-guild-challenge",
      type:"guild_might_probe",
      occurredAt:new Date().toISOString(),
      playerName:"BadMack",
      payload:{direction:"response",operationName:"GetGuildChallengePoints",
        parameters:{"3":482,"5":["GiganteCarrara","ESTHER9950"],"6":[5905587,5179919]}}
    }]
  });
  for(const token of [null,"imt_no_registered_pairing"]){
    const headers={"Content-Type":"application/json"};
    if(token)headers.Authorization="Bearer "+token;
    const result=await fetch(base+"/api/telemetry/ingest",{method:"POST",headers,body});
    assert.equal(result.status,401,"unpaired Guild Might/Challenge uploads must be rejected");
  }
  const count=await db.pool.query(
    "SELECT count(*)::int AS n FROM albion_telemetry_events WHERE type='guild_might_probe'"
  );
  assert.equal(count.rows[0].n,0,"unauthorized attempts must not write telemetry");
  ok("Guild probe ingest: token ausente ou não pareado => HTTP 401 e zero snapshots");
}

async function testHealthyBatchHasNoPostResponseFailure(base) {
  await resetDb();

  const errors = [];
  const rejections = [];
  let savepointStatements = 0;
  const originalError = console.error;
  const onUnhandled = (reason) => rejections.push(reason);

  console.error = (...args) => {
    errors.push(args.map((x) => x instanceof Error ? (x.stack || x.message) : String(x)).join(" "));
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const result = await withPoolQueryObserver(({ sql }) => {
      if (/\bSAVEPOINT\b/i.test(sql)) savepointStatements++;
    }, () => postIngest(base, [
      {
        eventId: "healthy-heartbeat-1",
        type: "heartbeat",
        occurredAt: new Date().toISOString(),
        playerName: "Alice",
        payload: { source: "ingest-route-test-1" },
      },
      {
        eventId: "healthy-heartbeat-2",
        type: "heartbeat",
        occurredAt: new Date().toISOString(),
        playerName: "Alice",
        payload: { source: "ingest-route-test-2" },
      },
      {
        eventId: "healthy-heartbeat-3",
        type: "heartbeat",
        occurredAt: new Date().toISOString(),
        playerName: "Alice",
        payload: { source: "ingest-route-test-3" },
      },
    ]));

    assert.equal(result.status, 200, "lote saudável precisa responder 200");
    assert.equal(result.json.ok, true);
    assert.equal(result.json.inserted, 3);
    assert.equal(result.json.duplicate, 0);
    assert.equal(result.json.rejected, 0);
    assert.equal(savepointStatements, 0, "lote 100% saudável não pode usar SAVEPOINT por evento");

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(errors, [], "lote saudável não pode gerar console.error após responder");
    assert.deepEqual(rejections, [], "lote saudável não pode gerar unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    console.error = originalError;
  }

  ok("ingest saudável: caminho rápido, HTTP 200, zero SAVEPOINT e zero unhandledRejection");
}

async function testSanitizesNulAndInvalidOccurredAt(base) {
  await resetDb();

  const rejections = [];
  const onUnhandled = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const windowsPath = "C:\\Games\\Albion Online\\game_x64";
  const batch = [
    {
      eventId: "good-a",
      type: "heartbeat",
      occurredAt: "2026-10-06T20:00:00.000Z",
      playerName: "Alice",
      payload: { value: "ok-a" },
    },
    {
      eventId: "good-b",
      type: "zone_change",
      occurredAt: "2026-10-06T20:00:01.000Z",
      playerName: "Alice",
      payload: { cluster: "Thunderrock Upland" },
    },
    {
      eventId: "nul\u0000-event",
      type: "heart\u0000beat",
      occurredAt: "2026-10-06T20:00:02.000Z",
      playerName: "Al\u0000ice",
      payload: {
        text: "ab\u0000cd",
        nested: { value: "x\u0000y", path: windowsPath },
        array: ["left\u0000right", "\\u0000 literal precisa continuar literal"],
      },
    },
    {
      eventId: "invalid-date",
      type: "heartbeat",
      occurredAt: "data-invalida",
      playerName: "Alice",
      payload: { value: "server-time" },
    },
  ];

  try {
    const first = await postIngest(base, batch, "ingest-route-sanitize-device");
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.inserted, 4);
    assert.equal(first.json.duplicate, 0);
    assert.equal(first.json.rejected, 0);

    const { rows } = await db.pool.query(
      "SELECT event_id, type, occurred_at, player_name, payload FROM albion_telemetry_events ORDER BY event_id"
    );
    assert.equal(rows.length, 4, "todos os eventos saneáveis precisam ser gravados");

    const nul = rows.find((row) => row.event_id === "nul-event");
    assert.ok(nul, "NUL no event_id deve ser removido");
    assert.equal(nul.type, "heartbeat");
    assert.equal(nul.player_name, "Alice");
    assert.equal(nul.payload.text, "abcd");
    assert.equal(nul.payload.nested.value, "xy");
    assert.equal(nul.payload.nested.path, windowsPath, "barras invertidas legítimas precisam ser preservadas");
    assert.equal(nul.payload.array[0], "leftright");
    assert.equal(nul.payload.array[1], "\\u0000 literal precisa continuar literal");

    const invalidDate = rows.find((row) => row.event_id === "invalid-date");
    assert.ok(invalidDate);
    const occurredMs = new Date(invalidDate.occurred_at).getTime();
    assert.ok(Number.isFinite(occurredMs), "occurredAt inválido precisa virar data válida do servidor");
    assert.ok(Math.abs(Date.now() - occurredMs) < 30_000, "occurredAt inválido precisa usar horário atual do servidor");

    const second = await postIngest(base, batch, "ingest-route-sanitize-device");
    assert.equal(second.status, 200);
    assert.equal(second.json.inserted, 0);
    assert.equal(second.json.duplicate, 4);
    assert.equal(second.json.rejected, 0);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(rejections, [], "saneamento/reenvio não pode gerar unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }

  ok("ingest saneia NUL/data inválida e o reenvio vira 100% duplicate");
}

async function testFallbackIsolatesBadPresenceProbe(base) {
  await resetDb();

  const warnings = [];
  const rejections = [];
  let savepointStatements = 0;
  const originalWarn = console.warn;
  const onUnhandled = (reason) => rejections.push(reason);
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  process.on("unhandledRejection", onUnhandled);

  try {
    const result = await withPoolQueryObserver(({ sql, params }) => {
      if (/\bSAVEPOINT\b/i.test(sql)) savepointStatements++;
      if (/INSERT INTO albion_guild_presence/i.test(sql) && params[1] === "BadProbe") {
        const error = new Error("synthetic invalid presence probe");
        error.code = "22007";
        throw error;
      }
    }, () => postIngest(base, [
      {
        eventId: "fallback-good-1",
        type: "heartbeat",
        occurredAt: new Date().toISOString(),
        playerName: "Alice",
        payload: { source: "good-1" },
      },
      {
        eventId: "fallback-bad-probe",
        type: "guild_presence_probe",
        occurredAt: new Date().toISOString(),
        playerName: "Alice",
        payload: {
          eventName: "GuildPlayerUpdated",
          parameters: {
            "0": { previewBase64: "player-id" },
            "1": "BadProbe",
            "2": true,
            "3": 638953440000000000,
          },
        },
      },
      {
        eventId: "fallback-good-2",
        type: "heartbeat",
        occurredAt: new Date().toISOString(),
        playerName: "Alice",
        payload: { source: "good-2" },
      },
    ], "ingest-route-fallback-device"));

    assert.equal(result.status, 200, "probe ruim não pode derrubar o lote");
    assert.equal(result.json.ok, true);
    assert.equal(result.json.inserted, 2);
    assert.equal(result.json.duplicate, 0);
    assert.equal(result.json.rejected, 1);
    assert.ok(savepointStatements > 0, "fallback precisa usar SAVEPOINT por evento");

    const { rows } = await db.pool.query(
      "SELECT event_id FROM albion_telemetry_events ORDER BY event_id"
    );
    assert.deepEqual(rows.map((row) => row.event_id), ["fallback-good-1", "fallback-good-2"]);

    assert.equal(warnings.length, 1, "rejeições do lote precisam gerar uma única linha resumida");
    assert.match(warnings[0], /rejected=1/);
    assert.doesNotMatch(warnings[0], /parameters|previewBase64|payload/i, "log não pode imprimir payload");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(rejections, [], "fallback não pode gerar unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    console.warn = originalWarn;
  }

  ok("fallback: probe ruim é rejeitada isoladamente e eventos bons são gravados");
}

async function testLethalDeathQueuesKillFame(base) {
  await resetDb();

  const ev = await db.createEvent({
    guildId: GUILD,
    channelId: "ingest-route-test",
    callerId: "caller",
    timeLabel: "19:20",
    remind30: new Date(Date.now() + 10 * 60 * 1000),
    remind10: new Date(Date.now() + 30 * 60 * 1000),
  });

  await db.upsertSignup({
    eventId: ev.id,
    userId: "u-alice",
    username: "Alice",
    weapon: "ARCO LONGO",
    presence: "online",
    partyIndex: 0,
    slotIndex: 0,
  });

  const calls = [];
  const originalQueue = killFame.queueEnrichment;
  killFame.queueEnrichment = (args) => {
    calls.push(args);
    return Promise.resolve(null);
  };

  try {
    const result = await postIngest(base, [{
      eventId: "lethal-death-1",
      type: "player_death_observed",
      occurredAt: new Date().toISOString(),
      playerName: "Enemy",
      payload: {
        killer: "Alice",
        victim: "Enemy",
        killerGuild: "",
        victimGuild: "ARCH",
        isLethal: true,
        cluster: "Thunderrock Upland",
      },
    }], "ingest-route-kill-device");

    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.rejected, 0);
    assert.equal(String(result.json.ctaEventId), String(ev.id));

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(calls.length, 1, "morte letal elegível precisa chamar killFame.queueEnrichment");
    assert.equal(calls[0].eventId, "lethal-death-1");
    assert.equal(calls[0].payload.killer, "Alice");
    assert.equal(calls[0].payload.victim, "Enemy");
  } finally {
    killFame.queueEnrichment = originalQueue;
  }

  ok("ingest letal: morte elegível do roster entra na fila de Kill Fame");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await telemetry.initSchema(db.pool);

  const server = web.startWebServer(null, {});
  if (!server.listening) await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "servidor de teste deve usar TCP local");
  const base = "http://127.0.0.1:" + addr.port;

  try {
    await testUnauthorizedGuildProbesBlocked(base);
    await testHealthyBatchHasNoPostResponseFailure(base);
    await testSanitizesNulAndInvalidOccurredAt(base);
    await testFallbackIsolatesBadPresenceProbe(base);
    await testLethalDeathQueuesKillFame(base);
    console.log("\n✅ Ingest route suite: TODOS OS TESTES PASSARAM");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Ingest route suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
