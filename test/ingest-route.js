"use strict";

const assert = require("assert/strict");
const { once } = require("node:events");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";
process.env.TELEMETRY_INGEST_KEY = "ingest-route-test-key";
process.env.PORT = String(40000 + (process.pid % 1000));

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
    "TRUNCATE TABLE albion_telemetry_events, albion_telemetry_devices, albion_telemetry_agent_tokens, " +
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

async function testHealthyBatchHasNoPostResponseFailure(base) {
  await resetDb();

  const errors = [];
  const rejections = [];
  const originalError = console.error;
  const onUnhandled = (reason) => rejections.push(reason);

  console.error = (...args) => {
    errors.push(args.map((x) => x instanceof Error ? (x.stack || x.message) : String(x)).join(" "));
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const result = await postIngest(base, [{
      eventId: "healthy-heartbeat-1",
      type: "heartbeat",
      occurredAt: new Date().toISOString(),
      playerName: "Alice",
      payload: { source: "ingest-route-test" },
    }]);

    assert.equal(result.status, 200, "lote saudável precisa responder 200");
    assert.equal(result.json.ok, true);
    assert.equal(result.json.inserted, 1);

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(errors, [], "lote saudável não pode gerar console.error após responder");
    assert.deepEqual(rejections, [], "lote saudável não pode gerar unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    console.error = originalError;
  }

  ok("ingest saudável: HTTP 200, zero console.error e zero unhandledRejection");
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
    await testHealthyBatchHasNoPostResponseFailure(base);
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
