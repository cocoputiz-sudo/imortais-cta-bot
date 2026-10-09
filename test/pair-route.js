"use strict";

const assert = require("assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";
process.env.TELEMETRY_INGEST_KEY = "pair-route-test-master";
// Each mutation test starts its own server: let the OS allocate a free port.
// A PID-derived fixed port can collide with another live worker on GitHub Actions.
process.env.PORT = "0";

const db = require("../src/db");
const telemetry = require("../src/telemetry");
const web = require("../src/web");

function ok(name) {
  console.log("✅ " + name);
}

function hashPairCode(code) {
  return crypto.createHash("sha256").update("pair:" + code, "utf8").digest("hex");
}

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE albion_guild_presence, albion_telemetry_events, albion_telemetry_devices, " +
    "albion_telemetry_agent_tokens, albion_telemetry_pairing_codes, cta_signups, bomb_confirms, " +
    "voice_presence, cta_events RESTART IDENTITY CASCADE"
  );
}

async function createPairCode(code, { playerName = null, label = null } = {}) {
  await db.pool.query(
    `INSERT INTO albion_telemetry_pairing_codes(code_hash, label, player_name, created_by, expires_at)
     VALUES($1,$2,$3,'test-staff',now() + interval '10 minutes')`,
    [hashPairCode(code), label, playerName]
  );
}

async function postJson(base, path, body, { ip, authorization } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["X-Forwarded-For"] = ip;
  if (authorization) headers.Authorization = "Bearer " + authorization;

  const response = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return {
    status: response.status,
    json,
    retryAfter: response.headers.get("retry-after"),
  };
}

async function postPair(base, body, ip) {
  return postJson(base, "/api/telemetry/pair", body, { ip });
}

async function testAtomicSingleUse(base) {
  await resetDb();
  const code = "111111";
  await createPairCode(code);

  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      postPair(base, {
        code,
        deviceId: "parallel-device-" + index,
        playerName: "ParallelPlayer",
      }, "203.0.113.10")
    )
  );

  const successes = responses.filter((r) => r.status === 200);
  assert.equal(successes.length, 1, "8 requisições simultâneas precisam emitir exatamente 1 token");
  assert.equal(
    responses.filter((r) => r.status === 401 || r.status === 429).length,
    7,
    "as outras 7 requisições devem falhar sem emitir token"
  );
  assert.equal(responses.filter((r) => r.status >= 500).length, 0);

  const { rows: tokenRows } = await db.pool.query(
    "SELECT token_hash, device_id, player_name FROM albion_telemetry_agent_tokens"
  );
  assert.equal(tokenRows.length, 1, "banco precisa conter exatamente 1 token");

  const { rows: codeRows } = await db.pool.query(
    "SELECT used_at FROM albion_telemetry_pairing_codes WHERE code_hash=$1",
    [hashPairCode(code)]
  );
  assert.ok(codeRows[0]?.used_at, "código precisa estar consumido");

  ok("pair atômico: 8 simultâneas emitem exatamente 1 token");
}

async function testStaffBindingWins(base) {
  await resetDb();
  const code = "222222";
  await createPairCode(code, { playerName: "Fulano", label: "Fulano-PC" });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const response = await postPair(base, {
      code,
      deviceId: "staff-bound-device",
      playerName: "Ciclano",
    }, "203.0.113.11");

    assert.equal(response.status, 200);
    assert.equal(response.json.playerName, "Fulano", "nome vinculado pela staff precisa prevalecer");

    const { rows } = await db.pool.query(
      "SELECT player_name FROM albion_telemetry_agent_tokens LIMIT 1"
    );
    assert.equal(rows[0]?.player_name, "Fulano");
    assert.equal(warnings.length, 1, "override de nome precisa gerar um log");
    assert.match(warnings[0], /staff=Fulano/);
    assert.match(warnings[0], /client=Ciclano/);
  } finally {
    console.warn = originalWarn;
  }

  ok("pair vinculado: Fulano prevalece sobre Ciclano e gera log");
}

async function testDeviceNulSanitization(base) {
  await resetDb();

  const response = await postJson(base, "/api/telemetry/ingest", {
    device: {
      deviceId: "device\u0000-nul",
      playerName: "Al\u0000ice",
      version: "v\u00001",
    },
    events: [{
      eventId: "device-nul-event",
      type: "heartbeat",
      occurredAt: new Date().toISOString(),
      playerName: "Alice",
      payload: { source: "pair-route-device-test" },
    }],
  }, {
    ip: "203.0.113.12",
    authorization: process.env.TELEMETRY_INGEST_KEY,
  });

  assert.equal(response.status, 200, "NUL em device.* não pode gerar HTTP 500");
  assert.equal(response.json.ok, true);

  const { rows: devices } = await db.pool.query(
    "SELECT device_id, player_name, version FROM albion_telemetry_devices"
  );
  assert.deepEqual(devices, [{
    device_id: "device-nul",
    player_name: "Alice",
    version: "v1",
  }]);

  const { rows: events } = await db.pool.query(
    "SELECT device_id FROM albion_telemetry_events WHERE event_id='device-nul-event'"
  );
  assert.equal(events[0]?.device_id, "device-nul");

  ok("ingest: deviceId/playerName/version com NUL são saneados antes do banco");
}

async function testPerIpRateLimit(base) {
  await resetDb();
  const ip = "203.0.113.20";

  for (let attempt = 1; attempt <= 7; attempt++) {
    const response = await postPair(base, {
      code: "999999",
      deviceId: "wrong-ip-" + attempt,
      playerName: "WrongCode",
    }, ip);
    assert.equal(response.status, 401, `tentativa ${attempt} ainda deve permitir nova correção do jogador`);
  }

  const blocked = await postPair(base, {
    code: "999999",
    deviceId: "wrong-ip-8",
    playerName: "WrongCode",
  }, ip);

  assert.equal(blocked.status, 429, "8ª falha do mesmo IP precisa ser bloqueada");
  assert.ok(Number(blocked.retryAfter) >= 1, "429 precisa incluir Retry-After");

  const stillBlocked = await postPair(base, {
    code: "999999",
    deviceId: "wrong-ip-9",
    playerName: "WrongCode",
  }, ip);
  assert.equal(stillBlocked.status, 429);
  assert.ok(Number(stillBlocked.retryAfter) >= 1);

  ok("pair rate limit por IP: 2-3 erros passam, sequência abusiva recebe 429 + Retry-After");
}

async function testGlobalRateLimit(base) {
  await resetDb();

  let blocked = null;
  let attempts = 0;
  for (let index = 0; index < 320; index++) {
    const third = Math.floor(index / 250);
    const fourth = (index % 250) + 1;
    const response = await postPair(base, {
      code: "888888",
      deviceId: "global-" + index,
      playerName: "DistributedWrongCode",
    }, `198.18.${third}.${fourth}`);
    attempts++;
    if (response.status === 429) {
      blocked = response;
      break;
    }
    assert.equal(response.status, 401, "antes do limite global a falha deve ser 401");
  }

  assert.ok(blocked, "limite global precisa bloquear ataque distribuído dentro da janela");
  assert.ok(attempts <= 300, "limite global precisa tornar a varredura do espaço de 6 dígitos inviável");
  assert.ok(Number(blocked.retryAfter) >= 1, "limite global também precisa incluir Retry-After");

  ok("pair rate limit global: ataque distribuído é cortado muito antes de 1.000.000 combinações");
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
  assert.ok(addr && typeof addr === "object");
  const base = "http://127.0.0.1:" + addr.port;

  try {
    await testAtomicSingleUse(base);
    await testStaffBindingWins(base);
    await testDeviceNulSanitization(base);
    await testPerIpRateLimit(base);
    await testGlobalRateLimit(base);
    console.log("\n✅ Pair route suite: TODOS OS TESTES PASSARAM");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Pair route suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
