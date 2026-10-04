"use strict";

// Regressão da TEMPORADA: foto permanente do placar, off-season, retenção da
// presença na call e ENSAIO do fechamento. Roda só em PostgreSQL local temporário.

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

process.env.PGSSL = "disable";

const db = require("../src/db");
const seasonSnap = require("../src/season");
const attendanceReal = require("../src/attendance");

const G = "season-test";
const G_OLD = "season-test-old";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ok(name) { console.log("✅ " + name); }
const q = (sql, params) => db.pool.query(sql, params).then((r) => r.rows);

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE season_results, seasons, voice_presence, cta_signups, cta_events RESTART IDENTITY CASCADE"
  );
}

// Relatório de attendance FALSO (determinístico) no formato de attendance.buildReport.
function fakeRows(n) {
  const rows = Array.from({ length: n }, (_, i) => ({
    user_id: "U" + i,
    username: "[IM] Jogador" + i,
    integral: 10 + (i % 5),
    parcial: i % 3,
    rapida: i % 2,
    fantasma: i % 7 === 0 ? 1 : 0,
    bomb: 2,
    pingou: 9,
    minutos: 1000 - i,
    score: Math.round((300 - i) * 10) / 10,
    cat: i < 100 ? "Pilar" : "Regular",
    detail: { "2026-10-01": [{ cta: "15:20", level: "INTEGRAL" }] }, // pesado: NÃO pode ir para a foto
  }));
  rows.push({ user_id: "AUS", username: "Ausente", integral: 0, parcial: 0, rapida: 0, fantasma: 0, bomb: 0, pingou: 0, minutos: 0, score: 0, cat: "Ausente" });
  return rows;
}
function fakeAttendance(n, ctaCount = 40, counter = { calls: 0 }) {
  return {
    counter,
    buildReport: async () => { counter.calls++; return { ctaCount, rows: fakeRows(n), events: [] }; },
  };
}

async function testSchemaTwice() {
  await db.init();
  await db.init();
  const cols = await q("SELECT column_name FROM information_schema.columns WHERE table_name='season_results'");
  assert.equal(cols.length, 9, "season_results deve ter 9 colunas");
  ok("db.init roda 2x e cria season_results");
}

async function testSeasonCycleAndPhoto() {
  await db.startSeason(G, 34);
  assert.equal((await db.getCurrentSeason(G)).number, 34);
  const s = await db.finishSeason(G);
  assert.ok(s && s.ended_at, "encerrou");
  assert.equal(await db.getCurrentSeason(G), undefined, "off-season: nenhuma temporada ativa");

  const snap = await seasonSnap.snapshotSeason(db, fakeAttendance(300), G, s);
  assert.equal(snap.number, 34);
  assert.equal(snap.cta_count, 40);
  assert.ok(Array.isArray(snap.standings), "standings é array (jsonb)");
  assert.equal(snap.standings.length, 300, "quem não pontuou (Ausente) fica de fora");
  assert.ok(!snap.standings.some((r) => r.user_id === "AUS"));
  assert.ok(!("detail" in snap.standings[0]), "campo pesado 'detail' não vai para a foto");

  const again = await seasonSnap.snapshotSeason(db, fakeAttendance(5, 99), G, s);
  assert.equal(again.cta_count, 40, "a foto é IMUTÁVEL: a 2ª tentativa devolve a original");
  assert.equal(again.standings.length, 300);
  assert.equal((await db.getLastSeasonResults(G)).number, 34);
  ok("ciclo da temporada: encerrar, foto permanente e imutável");
}

async function testOffSeasonRendering() {
  const last = await db.getLastSeasonResults(G);
  const blocks = seasonSnap.offSeasonBlocks(last);
  assert.ok(blocks.every((b) => b.length <= 2000), "blocos dentro do limite do Discord (2000)");
  assert.ok(blocks[0].includes("OFF-SEASON") && blocks[0].includes("RESULTADO FINAL"));
  assert.equal(blocks.join("\n").split("\n").filter((l) => l.includes(" pts ")).length, 300, "todos os jogadores aparecem");
  assert.ok(seasonSnap.offSeasonMyRank(last, "U7").includes("8º de 300"));
  assert.ok(seasonSnap.offSeasonMyRank(last, "ZZZ").includes("não pontuou"));
  ok("off-season: placar do canal e /cta_meurank");
}

async function testStartWithOpenSeason() {
  await db.startSeason(G, 35);
  const aberta = await db.getCurrentSeason(G);
  const foto = await seasonSnap.snapshotSeason(db, fakeAttendance(50, 12), G, aberta, new Date());
  assert.equal(foto.number, 35);
  assert.equal(foto.cta_count, 12);
  await db.startSeason(G, 36); // fecha a 35 e abre a 36
  assert.equal((await db.getCurrentSeason(G)).number, 36);
  ok("iniciar com temporada aberta: foto da anterior antes de fechá-la");
}

async function testHealing() {
  // G: a 36 acabou de encerrar SEM foto -> a rotina tira a foto
  await db.finishSeason(G);
  const counter = { calls: 0 };
  const att = fakeAttendance(20, 8, counter);
  const healed = await seasonSnap.lastSnapshotOrHeal(db, att, G);
  assert.equal(healed.number, 36);
  assert.equal(counter.calls, 1);
  await seasonSnap.lastSnapshotOrHeal(db, att, G);
  assert.equal(counter.calls, 1, "2ª chamada não recalcula");

  // G_OLD: só uma temporada encerrada há 30 dias, sem foto: não deve ser refeita
  await db.pool.query(
    "INSERT INTO seasons (guild_id, number, started_at, ended_at) VALUES ($1, 1, now()-interval '60 days', now()-interval '30 days')",
    [G_OLD]
  );
  const counter2 = { calls: 0 };
  assert.equal(await seasonSnap.lastSnapshotOrHeal(db, fakeAttendance(20, 8, counter2), G_OLD), null);
  assert.equal(counter2.calls, 0);

  // Foto antiga NÃO pode ser apresentada como "último resultado" quando a última temporada encerrada não tem foto
  await db.pool.query(
    "INSERT INTO seasons (guild_id, number, started_at, ended_at) VALUES ($1, 2, now()-interval '29 days', now()-interval '20 days')",
    [G_OLD]
  );
  const antiga = (await q("SELECT id FROM seasons WHERE guild_id=$1 AND number=1", [G_OLD]))[0];
  await db.saveSeasonResults({
    guildId: G_OLD, seasonId: antiga.id, number: 1,
    startedAt: new Date(Date.now() - 60 * DAY), endedAt: new Date(Date.now() - 30 * DAY),
    ctaCount: 3, standings: [],
  });
  assert.equal(await seasonSnap.lastSnapshotOrHeal(db, fakeAttendance(20, 8), G_OLD), null,
    "foto da temporada 1 não é o resultado da temporada 2");
  ok("autocura: refaz só temporada recém-encerrada e nunca mostra foto de temporada anterior");
}

async function testVoiceRetentionExactText() {
  const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  const linhaDias = (src.match(/const voiceDays = [^;]+;/) || [])[0];
  const sql = (src.match(/"(DELETE FROM voice_presence[^"]+)"/) || [])[1];
  assert.ok(linhaDias && sql, "rotina de retenção da voz não encontrada em src/index.js: atualize este teste");

  const calc = (v) => {
    const process = { env: { VOICE_RETENTION_DAYS: v } };
    let voiceDays;
    eval(linhaDias.replace("const voiceDays", "voiceDays"));
    return voiceDays;
  };
  assert.equal(calc(undefined), 365, "padrão: 365 dias");
  assert.equal(calc("120"), 120);
  assert.equal(calc("30"), 60, "piso de 60 dias");
  assert.equal(calc("abc"), 365);
  assert.equal(calc("0"), 365);

  const ins = (dias, aberto) => db.pool.query(
    "INSERT INTO voice_presence (guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) " +
    "VALUES ($1,'u','n','c','prep', now()-($2::int*interval '1 day'), CASE WHEN $3 THEN NULL ELSE now()-($2::int*interval '1 day')+interval '1 hour' END)",
    [G, dias, aberto]
  );
  await ins(10, false); await ins(100, false); await ins(300, false); await ins(400, false); await ins(500, true);
  await db.pool.query(sql, [365]);
  const r = (await q("SELECT count(*)::int c, count(*) FILTER (WHERE left_at IS NULL)::int abertas FROM voice_presence WHERE guild_id=$1", [G]))[0];
  assert.equal(r.c, 4, "com 365 dias: apaga só a sessão de 400 dias");
  assert.equal(r.abertas, 1, "sessão aberta nunca é apagada");
  await db.pool.query("DELETE FROM voice_presence WHERE guild_id=$1", [G]);
  ok("retenção da presença: 365 dias, piso de 60, sessão aberta preservada");
}

async function testRealAttendanceSnapshot() {
  const GR = "season-test-real";
  await db.pool.query("INSERT INTO seasons (guild_id, number, started_at) VALUES ($1, 34, now()-interval '20 days')", [GR]);
  const dia = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); d.setUTCHours(10, 0, 0, 0); return d; };
  for (const n of [5, 3]) {
    const base = dia(n);
    const ev = await db.createEvent({ guildId: GR, channelId: "c", callerId: "x", timeLabel: "15:20", remind30: new Date(), remind10: new Date() });
    await db.pool.query("UPDATE cta_events SET created_at=$2 WHERE id=$1", [ev.id, base]);
    const hm = (min) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 15, min));
    // Alfa: 15:20 -> 16:58 (integral). Bravo: 15:25 -> 16:10 (parcial, 45 min)
    await db.pool.query("INSERT INTO voice_presence (guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) VALUES ($1,'A','[IM] Alfa','c','prep',$2,$3)", [GR, hm(20), hm(118)]);
    await db.pool.query("INSERT INTO voice_presence (guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) VALUES ($1,'B','[IM] Bravo','c','prep',$2,$3)", [GR, hm(25), hm(70)]);
    await db.upsertSignup({ eventId: ev.id, userId: "A", username: "[IM] Alfa", weapon: "MAÇA PESADA", presence: "online", partyIndex: 0, slotIndex: 1 });
  }
  const season = await db.getCurrentSeason(GR);
  const snap = await seasonSnap.snapshotSeason(db, attendanceReal, GR, season, new Date());
  const a = snap.standings.find((r) => r.user_id === "A");
  const b = snap.standings.find((r) => r.user_id === "B");
  assert.equal(snap.cta_count, 2);
  assert.ok(a && a.integral === 2 && a.score === 6 && a.pingou === 2 && a.cat === "Pilar", "Alfa: 2 integrais, 6 pontos");
  assert.ok(b && b.parcial === 2 && b.score === 2 && b.pingou === 0, "Bravo: 2 parciais, 2 pontos");
  assert.equal(snap.standings[0].user_id, "A", "ordenado por score");
  assert.ok(snap.standings.every((r) => Object.values(r).every((v) => v !== undefined && v !== null)), "nenhum campo vazio");
  ok("foto com o attendance.buildReport REAL (eventos e presença semeados)");
}

async function testPreviewDoesNotSave() {
  const GP = "season-test-preview";
  await db.pool.query("INSERT INTO seasons (guild_id, number, started_at) VALUES ($1, 40, now()-interval '10 days')", [GP]);
  const season = await db.getCurrentSeason(GP);
  const fim = new Date();
  const att = fakeAttendance(300, 25);

  const antes = (await q("SELECT count(*)::int c FROM season_results WHERE guild_id=$1", [GP]))[0].c;
  const pv = await seasonSnap.previewSeason(att, GP, season, fim);
  const depois = (await q("SELECT count(*)::int c FROM season_results WHERE guild_id=$1", [GP]))[0].c;
  assert.equal(antes, 0);
  assert.equal(depois, 0, "o ensaio NÃO grava nada em season_results");

  assert.equal(pv.number, 40);
  assert.equal(pv.ctaCount, 25);
  assert.equal(pv.players, 300);
  assert.ok(Number.isFinite(pv.elapsedMs) && pv.elapsedMs >= 0, "mede o tempo");
  assert.ok(pv.blocks >= 1 && pv.longestBlock <= 2000, "blocos do canal dentro do limite do Discord");

  const snap = await seasonSnap.snapshotSeason(db, att, GP, season, fim);
  assert.deepEqual(pv.standings, snap.standings, "o ensaio mostra EXATAMENTE o que a foto salvaria");
  assert.equal(pv.ctaCount, snap.cta_count);
  ok("ensaio do fechamento: não grava e é idêntico à foto real");
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await resetDb();

  await testSchemaTwice();
  await testSeasonCycleAndPhoto();
  await testOffSeasonRendering();
  await testStartWithOpenSeason();
  await testHealing();
  await testVoiceRetentionExactText();
  await testRealAttendanceSnapshot();
  await testPreviewDoesNotSave();

  console.log("\n✅ Season regression suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Season regression suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });