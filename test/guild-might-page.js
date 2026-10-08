"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/web"), "utf8");
const pageMatch = source.match(/const PAGE = (`[\s\S]*?`);/);
assert(pageMatch, "PAGE template must exist");
const page = vm.runInNewContext(pageMatch[1]);
assert(page.includes("Emitir relatório HTML"), "HTML report action");
assert(page.includes("Exportar CSV"), "CSV report action");
assert(page.includes("GetGuildChallengePoints") === false, "UI must use API, not raw Photon");
assert(page.includes("guild-challenge?days=90"), "separate Challenge API");
assert(page.includes("guild-might?days=90"), "Might API");
const scriptMatch = page.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, "embedded script exists");
new vm.Script(scriptMatch[1], { filename: "embedded-WarRoom.js" });
const sources = ["PvE (Outlands e Roads)", "Coleta", "Magos Engarrafadores",
  "Núcleos de Esconderijo", "Cristais de Território", "Tesouros das Outlands",
  "Criaturas de Cristal", "Contrabandistas", "Hellgates", "As Profundezas",
  "Masmorras Corrompidas", "Castelos e Postos Avançados",
  "Caça aos Dragões", "Terras Ancestrais"];
sources.forEach(name => assert(page.includes(name), "missing Might source: " + name));
console.log("guild might War Room: 14 cards, exports and JS syntax ok");
