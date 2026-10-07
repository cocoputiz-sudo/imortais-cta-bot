"use strict";

const assert = require("assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";

const db = require("../src/db");
const {
  parseConsolidationSteps,
  isCtaFrozen,
  consolidationStepsToRun,
} = require("../src/consolidation-state");

function ok(name) {
  console.log("✅ " + name);
}

async function resetDb() {
  await db.pool.query("TRUNCATE TABLE cta_events RESTART IDENTITY CASCADE");
}

async function createTestEvent(label = "19:20") {
  return db.createEvent({
    guildId: process.env.GUILD_ID,
    channelId: "cta-freeze-test",
    callerId: "caller",
    timeLabel: label,
    remind30: null,
    remind10: null,
  });
}

function testFrozenDecisionAndUsage() {
  assert.equal(isCtaFrozen(null), false);
  assert.equal(isCtaFrozen({}), false);
  assert.equal(isCtaFrozen({ frozen_at: null }), false);
  assert.equal(isCtaFrozen({ frozen_at: "" }), false);
  assert.equal(isCtaFrozen({ frozen_at: "2026-10-07T05:00:00.000Z" }), true);
  assert.equal(isCtaFrozen({ frozen_at: new Date("2026-10-07T05:00:00.000Z") }), true);

  const indexSource = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  assert.match(
    indexSource,
    /if\s*\(\s*isCtaFrozen\(fresh\)\s*\)\s*\{/,
    "applyReallocation precisa usar a decisão pura isCtaFrozen(fresh)"
  );

  ok("freeze: decisão pura é usada por applyReallocation");
}

function testPureWindows() {
  const done = new Set();

  assert.deepEqual(consolidationStepsToRun(24, done, "open"), [25]);
  done.add(25);
  assert.deepEqual(consolidationStepsToRun(24, done, "open"), []);

  assert.deepEqual(consolidationStepsToRun(19, done, "open"), [20]);
  done.add(20);
  assert.deepEqual(consolidationStepsToRun(19, done, "open"), []);

  assert.deepEqual(consolidationStepsToRun(14, done, "open"), [15]);
  done.add(15);
  assert.deepEqual(consolidationStepsToRun(14, done, "open"), []);

  assert.deepEqual(consolidationStepsToRun(9, done, "open"), [10]);
  done.add(10);
  assert.deepEqual(consolidationStepsToRun(9, done, "open"), [], "passo 10 não pode repetir");

  assert.deepEqual(consolidationStepsToRun(24, new Set(), "closed"), []);
  assert.deepEqual(consolidationStepsToRun(9, new Set(), "finished"), []);
  assert.deepEqual(consolidationStepsToRun(-5, new Set(), "open"), []);

  ok("função pura: cada janela dispara uma vez, passo 10 não repete e CTA finalizado não dispara");
}

async function testPersistenceSurvivesRestart() {
  await resetDb();
  const event = await createTestEvent();

  assert.equal(event.frozen_at, null, "CTA antigo/default começa destravado");
  assert.equal(event.consolid_warned, "", "CTA antigo/default começa sem avisos persistidos");

  const frozenAt = await db.markCtaFrozen(event.id);
  assert.ok(frozenAt, "marcar trava precisa persistir frozen_at");

  for (const step of [25, 20, 15, 10]) {
    assert.equal(
      await db.markConsolidationWarned(event.id, step),
      true,
      `primeiro registro do passo ${step} precisa alterar o banco`
    );
    assert.equal(
      await db.markConsolidationWarned(event.id, step),
      false,
      `segundo registro do passo ${step} precisa ser idempotente`
    );
  }

  // "Reinício": nenhum estado em memória é reaproveitado; só uma nova leitura do banco.
  const fresh = await db.getEvent(event.id);
  assert.ok(fresh.frozen_at, "trava precisa sobreviver ao reinício");
  assert.deepEqual(
    [...parseConsolidationSteps(fresh.consolid_warned)],
    [25, 20, 15, 10],
    "avisos persistidos precisam sobreviver ao reinício"
  );

  const doneAfterRestart = parseConsolidationSteps(fresh.consolid_warned);
  assert.deepEqual(consolidationStepsToRun(24, doneAfterRestart, fresh.status), []);
  assert.deepEqual(consolidationStepsToRun(19, doneAfterRestart, fresh.status), []);
  assert.deepEqual(consolidationStepsToRun(14, doneAfterRestart, fresh.status), []);
  assert.deepEqual(consolidationStepsToRun(9, doneAfterRestart, fresh.status), []);

  ok("banco: frozen_at e avisos sobrevivem ao reinício sem reexecutar passos");
}

async function testLegacyDefaults() {
  await resetDb();
  const event = await createTestEvent("17:20");
  const fresh = await db.getEvent(event.id);

  assert.equal(fresh.frozen_at, null);
  assert.equal(fresh.consolid_warned, "");
  assert.equal(Boolean(fresh.frozen_at), false);
  assert.deepEqual([...parseConsolidationSteps(fresh.consolid_warned)], []);

  ok("CTA antigo/default: não travado e nenhum aviso feito");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  testFrozenDecisionAndUsage();
  testPureWindows();
  await testPersistenceSurvivesRestart();
  await testLegacyDefaults();
  console.log("\n✅ CTA freeze suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ CTA freeze suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
