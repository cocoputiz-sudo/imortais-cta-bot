"use strict";
const assert = require("node:assert/strict");
const { healthResult } = require("../src/mackna-health");
const at = "2026-10-14T00:00:00.000Z";

assert.deepEqual(healthResult({ database: true, discord: false, preview: true, at }), {
  ok: true, database: true, discord: false,
  mode: "preview", discordRequired: false, at,
}, "preview deve aceitar banco ativo mesmo sem Discord");
assert.equal(healthResult({ database: false, discord: false, preview: true, at }).ok, false,
  "preview deve falhar quando o banco estiver indisponível");
assert.deepEqual(healthResult({ database: true, discord: false, at }), {
  ok: false, database: true, discord: false, at,
}, "produção deve exigir Discord e manter o contrato JSON");
assert.equal(healthResult({ database: true, discord: true, at }).ok, true,
  "produção saudável exige banco e Discord");
assert.equal(healthResult({ database: false, discord: true, at }).ok, false,
  "produção deve falhar quando o banco estiver indisponível");
console.log("✅ MackNa health: preview isolado e produção preservada");
