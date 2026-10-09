"use strict";

// Lista da guilda (exportada do jogo) x pings x call. Roda só em PostgreSQL local.

const assert = require("assert/strict");

process.env.PGSSL = "disable";

const db = require("../src/db");
const gr = require("../src/guildroster");

const G = "roster-test";
function ok(name) { console.log("✅ " + name); }
const q = (sql, params) => db.pool.query(sql, params).then((r) => r.rows);

// Linhas REAIS do export do jogo (TAB entre as colunas, aspas em tudo).
const REAL_EXPORT = [
  '"Character Name"\t"Last Seen"\t"Roles"',
  '"RagnaldoKun"\t"09/23/2026 21:04:09"\t"Guild Master;Officer"',
  '"2varinha10"\t"Online"\t"CONTRIBUINTE"',
  '"Shrekosaurus"\t"Online"\t""',
  '"HJR6"\t"Online"\t"Callers;Police;CONTRIBUINTE;ZVZ HEALER;Officer;transportador;Recruit"',
  '"Jrds66"\t"Online"\t"Strike 1"',
  '"BadMack"\t"Online"\t"Police;zvz caller;Mestre Guild;Officer;transportador;Recruit"',
  '"Latamantis"\t"09/24/2026 00:42:59"\t""',
  '"Aa4r0n"\t"09/20/2026 14:59:04"\t"Callers;Police;Member;Mestre Guild;Warmaster;ZVZ HEALER;The Right Hand;Officer;Guardsman;Master of Coin"',
  '"ANGELXXOFC"\t"Online"\t"Callers;CONTRIBUINTE;Officer;Recruit"',
].join("\n");

function testParseRealExport() {
  const r = gr.parseGuildRoster(REAL_EXPORT);
  assert.equal(r.ok, true);
  assert.equal(r.hadHeader, true, "cabeçalho reconhecido e pulado");
  assert.equal(r.members.length, 9);
  const by = Object.fromEntries(r.members.map((m) => [m.name, m]));
  assert.equal(by["2varinha10"].online, true);
  assert.deepEqual(by["2varinha10"].roles, ["CONTRIBUINTE"]);
  assert.deepEqual(by["Shrekosaurus"].roles, [], "cargo vazio vira lista vazia");
  assert.equal(by["HJR6"].roles.length, 7);
  assert.ok(by["HJR6"].roles.includes("CONTRIBUINTE"));
  assert.equal(by["Latamantis"].online, false);
  assert.equal(by["Latamantis"].lastSeenAt.toISOString(), "2026-09-24T00:42:59.000Z", "data MM/DD/YYYY lida como UTC");
  assert.equal(by["RagnaldoKun"].lastSeenAt.toISOString(), "2026-09-23T21:04:09.000Z");
  ok("lê o export real do jogo (aspas, TAB, cargos com ;, datas MM/DD/YYYY)");
}

function testParseVariants() {
  const crlf = gr.parseGuildRoster('"A"\t"Online"\t""\r\n"B"\t"09/01/2026 10:00:00"\t"X;Y"\r\n');
  assert.equal(crlf.members.length, 2, "CRLF");
  const bom = gr.parseGuildRoster('\uFEFF"Character Name"\t"Last Seen"\t"Roles"\n"A"\t"Online"\t""');
  assert.equal(bom.members.length, 1, "BOM + cabeçalho");
  const raw = gr.parseGuildRoster("Alfa\tOnline\tCONTRIBUINTE\nBravo\t09/01/2026 10:00\t");
  assert.equal(raw.members.length, 2, "sem aspas e sem cabeçalho");
  assert.equal(raw.members[1].lastSeenAt.toISOString(), "2026-09-01T10:00:00.000Z", "segundos opcionais");
  const csv = gr.parseGuildRoster('"Character Name","Last Seen","Roles"\n"Alfa","Online","A;B"\n"Bravo","09/01/2026 10:00:00",""');
  assert.equal(csv.members.length, 2, "CSV com vírgula");
  assert.deepEqual(csv.members[0].roles, ["A", "B"]);
  const dup = gr.parseGuildRoster('"Alfa"\t"09/01/2026 10:00:00"\t""\n"[IM] alfa"\t"Online"\t""');
  assert.equal(dup.members.length, 1);
  assert.equal(dup.members[0].online, true, "duplicado: prefere a linha Online");
  assert.equal(dup.duplicates, 1);
  const bad = gr.parseGuildRoster('"Alfa"\t"Online"\t""\n"Bravo"\t"ontem"\t""\n"Charlie"\n\t"Online"\t""');
  assert.equal(bad.members.length, 1);
  assert.equal(bad.skipped.length, 3, "linhas inválidas são listadas, não derrubam");
  const feb = gr.parseGuildRoster('"Alfa"\t"02/31/2026 10:00:00"\t""');
  assert.equal(feb.ok, false, "data impossível não passa");
  ok("variantes: CRLF, BOM, sem aspas, CSV, duplicados e linhas inválidas");
}

function testParseLimits() {
  assert.equal(gr.parseGuildRoster("").error, "empty");
  assert.equal(gr.parseGuildRoster("   \n  ").error, "empty");
  assert.equal(gr.parseGuildRoster("texto qualquer sem separador").error, "unknown_format");
  assert.equal(gr.parseGuildRoster("x".repeat(gr.MAX_CHARS + 1)).error, "too_large");
  assert.equal(gr.parseGuildRoster(Array(gr.MAX_LINES + 1).fill('"A"\t"Online"\t""').join("\n")).error, "too_many_lines");
  ok("limites: vazio, formato desconhecido, tamanho e número de linhas");
}

function testNormName() {
  for (const [inp, out] of [["![IM] [ESP] Bravo", "bravo"], ["[IMT2] Nick", "nick"], ["!!BadMack", "badmack"], ["BadMack", "badmack"], ["  [AC] [ESP] Zoiudo ", "zoiudo"]])
    assert.equal(gr.normName(inp), out);
  ok("normName: tags, ! e espaços (mesma regra do resto do projeto)");
}

function testClassifyScenario() {
  const now = new Date("2026-09-24T01:12:59Z");
  const members = gr.parseGuildRoster(REAL_EXPORT).members;
  const signups = [
    { user_id: "1", username: "![IM] BadMack", weapon: "GOLEM" },          // online + ping
    { user_id: "2", username: "[IM] HJR6", weapon: "JURADOR" },            // online + ping + call
    { user_id: "3", username: "[IM] RagnaldoKun", weapon: "ARCO LONGO" },  // OFFLINE + ping
    { user_id: "9", username: "[IM] Fantasma", weapon: "CANÇÃO" },         // nao esta na lista colada
  ];
  const voice = [
    { user_id: "2", username: "[IM] HJR6" },
    { user_id: "4", username: "[IM] Shrekosaurus" },                       // online + call, sem ping
    { user_id: "5", username: "[IM] Latamantis" },                         // OFFLINE + call
    { user_id: "8", username: "[IM] Visitante" },                          // nao esta na lista
  ];
  const r = gr.classifyRoster({ members, signups, voice, now });
  const names = (g) => r.groups[g].map((x) => x.name);

  assert.deepEqual(names("pronto"), ["HJR6"]);
  assert.deepEqual(names("pingouForaDaCall"), ["BadMack"]);
  assert.deepEqual(names("naCallSemPing"), ["Shrekosaurus"]);
  assert.deepEqual(names("pingouOffline"), ["RagnaldoKun"]);
  assert.deepEqual(names("soDiscord"), ["Latamantis"]);
  // online, sem ping e fora da call: Jrds66 (equipando) e os dois CONTRIBUINTE (autorizados)
  assert.deepEqual(names("equipando"), ["Jrds66"]);
  assert.deepEqual(names("contribuinte"), ["2varinha10", "ANGELXXOFC"]);
  assert.deepEqual(r.groups.semCorrespondencia.map((x) => x.name).sort(), ["[IM] Fantasma", "[IM] Visitante"]);
  assert.equal(r.groups.semCorrespondencia.find((x) => x.name === "[IM] Fantasma").pinged, true);
  assert.equal(r.groups.semCorrespondencia.find((x) => x.name === "[IM] Fantasma").weapon, "CANÇÃO");
  assert.equal(r.groups.semCorrespondencia.find((x) => x.name === "[IM] Visitante").inCall, true);

  assert.equal(r.groups.equipando[0].strike, true, "cargo 'Strike 1' sinalizado");
  assert.equal(r.groups.pronto[0].weapon, "JURADOR");
  assert.equal(r.groups.pingouOffline[0].offlineMinutes, 248, "RagnaldoKun visto 21:04:09, agora 01:12:59 = 248 min");
  assert.equal(r.groups.soDiscord[0].offlineMinutes, 30, "Latamantis visto às 00:42:59, agora 01:12:59 = 30 min");
  assert.equal(r.totals.roster, 9);
  assert.equal(r.totals.online, 6);
  assert.equal(r.totals.offline, 3);
  ok("cruzamento: pronto, fora da call, sem ping, equipando, contribuinte, offline e sem correspondência");
}

function testExemptRolesAreConfigurable() {
  const members = gr.parseGuildRoster([
    '"Alfa"\t"Online"\t"CONTRIBUINTE"',          // cargo legado
    '"Bravo"\t"Online"\t"Bomb"',
    '"Charlie"\t"Online"\t"CONTRIBUINTE 1"',
    '"Delta"\t"Online"\t"Contribuinte 2"',
    '"Echo"\t"Online"\t"contribuinte 3"',
    '"Foxtrot"\t"Online"\t"CONTRIBUINTE 4"',        // nao autorizado
  ].join("\n")).members;
  const names = (g, result) => result.groups[g].map((x) => x.name);
  const base = gr.classifyRoster({ members });
  assert.deepEqual(names("contribuinte", base), ["Alfa", "Charlie", "Delta", "Echo"], "tres novos cargos e legado, sem diferenciar caixa");
  assert.deepEqual(names("equipando", base), ["Bravo", "Foxtrot"], "nome parecido nao autoriza isencao");
  const custom = gr.classifyRoster({ members, exemptRoles: ["contribuinte 2", "bomb"] });
  assert.deepEqual(names("contribuinte", custom), ["Bravo", "Delta"], "configuracao explicita de cargos isentos");
  assert.equal(custom.groups.equipando.length, 4);
  const none = gr.classifyRoster({ members, exemptRoles: [] });
  assert.equal(none.groups.equipando.length, 6, "sem cargos isentos, todos contam");
  ok("cargos isentos: CONTRIBUINTE 1/2/3 e legado, sem aceitar categorias nao previstas");
}

function testContributorWhoParticipatesIsNotExemptGroup() {
  const members = gr.parseGuildRoster('"Alfa"\t"Online"\t"CONTRIBUINTE"\n"Bravo"\t"Online"\t"CONTRIBUINTE"').members;
  const r = gr.classifyRoster({
    members,
    signups: [{ user_id: "1", username: "[IM] Alfa" }],
    voice: [{ user_id: "2", username: "[IM] Bravo" }],
  });
  assert.deepEqual(r.groups.pingouForaDaCall.map((x) => x.name), ["Alfa"], "contribuinte que pingou continua sendo cobrado de entrar na call");
  assert.deepEqual(r.groups.naCallSemPing.map((x) => x.name), ["Bravo"]);
  assert.equal(r.groups.contribuinte.length, 0);
  ok("contribuinte que participa (pingou ou está na call) segue as regras normais");
}

async function testAnalyzeAgainstDatabase() {
  await db.init();
  await db.pool.query("TRUNCATE TABLE voice_presence, cta_signups, cta_events RESTART IDENTITY CASCADE");

  const ev = await db.createEvent({ guildId: G, channelId: "c", callerId: "x", timeLabel: "19:20", remind30: new Date(), remind10: new Date() });
  const other = await db.createEvent({ guildId: G, channelId: "c", callerId: "x", timeLabel: "21:20", remind30: new Date(), remind10: new Date() });

  for (const [uid, nick] of [["1", "[IM] Alfa"], ["2", "![IM] [ESP] Bravo"], ["3", "[IM] Charlie"], ["9", "[IM] Fantasma"]])
    await db.upsertSignup({ eventId: ev.id, userId: uid, username: nick, weapon: "ARCO LONGO", presence: "online", partyIndex: 0, slotIndex: 1 });
  await db.upsertSignup({ eventId: other.id, userId: "7", username: "[IM] India", weapon: "ARCO LONGO", presence: "online", partyIndex: 0, slotIndex: 1 });

  const v = (uid, nick, kind, left) => db.pool.query(
    "INSERT INTO voice_presence (guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) VALUES ($1,$2,$3,'c',$4, now()-interval '30 minutes', $5)",
    [G, uid, nick, kind, left]
  );
  await v("1", "[IM] Alfa", "prep", null);                                   // na call (aberta)
  await v("4", "[IM] Delta", "prep", null);                                  // na call, sem ping
  await v("5", "[IM] Echo", "bomb", null);                                   // call de BOMB: nao conta
  await v("6", "[IM] Foxtrot", "prep", new Date(Date.now() - 600000));       // saiu da call: nao conta
  await v("8", "[IM] Hotel", "prep", null);                                  // na call, offline no jogo

  const roster = [
    '"Character Name"\t"Last Seen"\t"Roles"',
    '"Alfa"\t"Online"\t""', '"Bravo"\t"Online"\t""', '"Charlie"\t"09/24/2026 00:10:00"\t""',
    '"Delta"\t"Online"\t""', '"Echo"\t"Online"\t""', '"Foxtrot"\t"Online"\t""',
    '"Golf"\t"Online"\t"CONTRIBUINTE"', '"Hotel"\t"09/24/2026 00:00:00"\t""', '"India"\t"Online"\t""',
    '"Juliet"\t"09/20/2026 10:00:00"\t""',
  ].join("\n");

  const r = await gr.analyze(db, { text: roster, eventId: ev.id, now: new Date("2026-09-24T01:00:00Z") });
  assert.equal(r.ok, true);
  const names = (g) => r.groups[g].map((x) => x.name);
  assert.deepEqual(names("pronto"), ["Alfa"]);
  assert.deepEqual(names("pingouForaDaCall"), ["Bravo"], "apelido '![IM] [ESP] Bravo' casa com 'Bravo'");
  assert.deepEqual(names("pingouOffline"), ["Charlie"]);
  assert.deepEqual(names("naCallSemPing"), ["Delta"]);
  assert.deepEqual(names("equipando"), ["Echo", "Foxtrot", "India"], "call de bomb e sessão encerrada não contam; ping de OUTRO CTA não conta");
  assert.deepEqual(names("contribuinte"), ["Golf"]);
  assert.deepEqual(names("soDiscord"), ["Hotel"]);
  assert.deepEqual(r.groups.semCorrespondencia.map((x) => x.name), ["[IM] Fantasma"]);
  assert.equal(r.groups.pingouOffline[0].offlineMinutes, 50);
  assert.equal(r.event.timeLabel, "19:20");
  assert.equal(r.totals.roster, 10);

  assert.deepEqual(await gr.analyze(db, { text: roster, eventId: 99999 }), { ok: false, error: "event_not_found" });
  assert.deepEqual(await gr.analyze(db, { text: "", eventId: ev.id }), { ok: false, error: "empty" });
  assert.equal(await gr.loadInputs(db, 99999), null);
  ok("analyze no Postgres real: só a call de preparação, só os pings deste CTA, casando apelidos com tags");
}

async function testNothingIsWritten() {
  const before = (await q("SELECT (SELECT count(*) FROM cta_signups)::int s, (SELECT count(*) FROM voice_presence)::int v, (SELECT count(*) FROM cta_events)::int e"))[0];
  const ev = (await q("SELECT id FROM cta_events ORDER BY id LIMIT 1"))[0];
  await gr.analyze(db, { text: '"Alfa"\t"Online"\t""', eventId: ev.id });
  const after = (await q("SELECT (SELECT count(*) FROM cta_signups)::int s, (SELECT count(*) FROM voice_presence)::int v, (SELECT count(*) FROM cta_events)::int e"))[0];
  assert.deepEqual(after, before);
  ok("a análise é somente leitura: não grava nada no banco");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }
  testParseRealExport();
  testParseVariants();
  testParseLimits();
  testNormName();
  testClassifyScenario();
  testExemptRolesAreConfigurable();
  testContributorWhoParticipatesIsNotExemptGroup();
  await testAnalyzeAgainstDatabase();
  await testNothingIsWritten();
  console.log("\n✅ Guild roster suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Guild roster suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });