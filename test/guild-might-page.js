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
  "Challenge is independently enabled by feature flag");
const productionWithOverride=execFileSync(process.execPath,
  ["-e","process.stdout.write(require('./src/web').renderWarRoomPage())"],
  {cwd:require("node:path").join(__dirname,".."),
   env:{...process.env,HOMOLOG_MODE:"0",IMORTAIS_CHALLENGE_UI:"1"},
   encoding:"utf8"});
assert(productionWithOverride.includes("var guildChallengeVisible=true;"),
  "Challenge is enabled by its own flag in production");
const telemetrySource=fs.readFileSync(require.resolve("../src/telemetry"),"utf8");
assert(telemetrySource.includes('const CHALLENGE_UI_ENABLED = process.env.IMORTAIS_CHALLENGE_UI === "1"'), "telemetry must use the independent feature flag");
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

// Same source rendered by src/homolog.js and production Web UI.
// Admin in homolog must see Might editor when a category card is selected,
// and Challenge editor only inside the explicit homolog feature flag.
const homologSource=fs.readFileSync(require.resolve("../src/homolog"),"utf8");
assert(homologSource.includes('app.get("/",(_req,res)=>res.type("html").send(web.renderWarRoomPage()))'),
  "homolog must serve real War Room HTML, not its own duplicate page");
assert(homologSource.includes("isSiteAdmin:true"),
  "homolog's isolated test identity must be site admin");
assert(page.includes("authState.isSiteAdmin?'<button"),
  "Might edit button must be gated by site-admin");
assert(page.includes('id="gm-edit-progress"'),
  "Might edit level / season points button must exist");
assert(page.includes('id="gm-edit-challenge-progress"'),
  "Challenge editor remains admin-only and flag-dependent");
assert(page.includes("gmEditManual(sc.snapshot.layout.code)"),
  "Might button must open the real editing flow with category code");
assert(page.includes("gmEditManual('GUILD_CHALLENGE')"),
  "Challenge button must open real editing flow");
assert(page.includes("gm-config-warning"),
  "production must display a clear notice when season or observers are missing");
assert(page.includes("Cobertura integral"),
  "Might card must show complete sweep coverage");
assert(page.includes("var extra=authState.isSiteAdmin?'<th>Dispositivo de origem</th><th>Jogador observador</th>':'';"),
  "source provenance columns must only be added in admin mode");
assert(page.includes("m.sourceDeviceId"),"winning value must carry source device into UI");
assert(page.includes("m.sourceObserver"),"winning value must carry source observer into UI");
const root=require("node:path").join(__dirname,"..");
const example=fs.readFileSync(require("node:path").join(root,"env.example"),"utf8");
assert(example.includes("# GUILD_SEASON_START_AT="));
assert(example.includes("# GUILD_RANKING_ALLOWED_DEVICE_IDS="));

const sources = ["PvE (Outlands e Roads)", "Coleta", "Magos Engarrafadores",
  "Núcleos de Esconderijo", "Cristais de Território", "Tesouros das Outlands",
  "Criaturas de Cristal", "Contrabandistas", "Hellgates", "As Profundezas",
  "Masmorras Corrompidas", "Castelos e Postos Avançados",
  "Caça aos Dragões", "Terras Ancestrais"];
sources.forEach(name => assert(page.includes(name), "missing Might source: " + name));

// Regression: loading() mutates innerHTML outside setView's cache. Even when
// the next API response has identical HTML, a second draw must restore buttons.
const view={innerHTML:""};
const ctx={document:{getElementById(){return view;}}};
const setViewSource=page.match(/function setView\(id,html\)\{[^\n]*\}/);
const loadingSource=page.match(/function loading\(id,title\)\{[^\n]*\}/);
assert(setViewSource && loadingSource,"view functions must exist");
vm.runInNewContext("var _viewCache={};\n"+setViewSource[0]+"\n"+loadingSource[0],ctx);
const unchangedMight='<button id="gm-refresh">Atualizar dados</button>';
ctx.setView("view-might",unchangedMight);
ctx.loading("view-might","Guild Might");
assert(!view.innerHTML.includes('gm-refresh'),"loading must replace the view");
ctx.setView("view-might",unchangedMight);
assert(view.innerHTML.includes('gm-refresh'),"cached HTML must redraw after loading");
assert(page.includes("gmIngestPanel(guildMightIngestStatus)"),
  "admin ingest diagnostics must render alongside Might without replacing ranking");
assert(page.includes("if(!authState.isSiteAdmin)return '';"),
  "members must never see admin ingest data");
assert(page.includes("/api/telemetry/guild-might-ingest-status"),
  "admin-only diagnostics must be fetched by the Might page");

assert(page.includes('id="gm-player-search"'),"War Room Must include player search");
assert(page.includes('data-gm-player'),"search must cover Might and Challenge rows");
assert(page.includes('gmFilterPlayers(guildMightSearchTerm)'),"search persists across redraw and category switches");
assert(page.includes("gmFilterPlayers(playerSearch.value)"),"search filters without re-requesting network data");
assert(page.includes("label===gmNorm(info.name)"),"PvE card must match Photon full category name");
assert(page.includes("weeklyDelta"),"Might weekly delta visible per player");
assert(page.includes("Might há 7 dias"),"CSV exports weekly baseline");
assert(page.includes("Diferença 7 dias"),"Might table and export include weekly delta");
assert(page.includes("SEM BASE"),"Missing prior capture cannot show made-up zero");
console.log("guild might War Room: categories, weekly difference, exports and JS syntax ok");
