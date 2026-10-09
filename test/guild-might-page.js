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

const web=require("../src/web");
const hiddenPage=web.renderWarRoomPage();
assert(hiddenPage.includes("var guildChallengeVisible=false;"),
  "Challenge must be hidden by default, including production");
assert(!hiddenPage.includes("__CHALLENGE_VISIBILITY__"),
  "Template placeholder must not leak to clients");
const {execFileSync}=require("node:child_process");
const stagedPage=execFileSync(process.execPath,
  ["-e","process.stdout.write(require('./src/web').renderWarRoomPage())"],
  {cwd:require("node:path").join(__dirname,".."),
   env:{...process.env,HOMOLOG_MODE:"1",IMORTAIS_CHALLENGE_UI:"1"},
   encoding:"utf8"});
assert(stagedPage.includes("var guildChallengeVisible=true;"),
  "Challenge is available only in explicitly opted-in homolog");
const productionWithOverride=execFileSync(process.execPath,
  ["-e","process.stdout.write(require('./src/web').renderWarRoomPage())"],
  {cwd:require("node:path").join(__dirname,".."),
   env:{...process.env,HOMOLOG_MODE:"0",IMORTAIS_CHALLENGE_UI:"1"},
   encoding:"utf8"});
assert(productionWithOverride.includes("var guildChallengeVisible=false;"),
  "Challenge cannot be enabled outside homolog even if a flag is accidentally set");
const telemetrySource=fs.readFileSync(require.resolve("../src/telemetry"),"utf8");
assert(telemetrySource.includes('if(!CHALLENGE_UI_ENABLED)return res.status(404)'),
  "Ranking API must refuse access when Challenge is hidden");
assert(telemetrySource.includes('r.categoryCode!=="GUILD_CHALLENGE"'),
  "Guild progress API must not expose hidden Challenge progress");
assert(telemetrySource.includes('return res.status(403).json({error:"feature_not_enabled"})'),
  "Writing hidden Challenge progress must be refused");


// Capture times must be explicit and deterministic in both timezones.
assert(page.includes("America/Sao_Paulo"),"Might timestamps must use Brasília timezone");
assert(page.includes("(Brasília)"),"Might timestamps must label Brasília");
assert(page.includes("fmtUtcDateTime(d,true)"),"Might timestamps must preserve UTC comparison");

const sources = ["PvE (Outlands e Roads)", "Coleta", "Magos Engarrafadores",
  "Núcleos de Esconderijo", "Cristais de Território", "Tesouros das Outlands",
  "Criaturas de Cristal", "Contrabandistas", "Hellgates", "As Profundezas",
  "Masmorras Corrompidas", "Castelos e Postos Avançados",
  "Caça aos Dragões", "Terras Ancestrais"];
sources.forEach(name => assert(page.includes(name), "missing Might source: " + name));
console.log("guild might War Room: 14 cards, exports and JS syntax ok");
