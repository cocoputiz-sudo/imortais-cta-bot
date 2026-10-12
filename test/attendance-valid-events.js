"use strict";

// Regras de quais CTAs contam no attendance. Casos reais da Temporada 34.
// Teste puro: não usa banco.
const assert = require("assert/strict");

process.env.PGSSL = "disable";
const attendance = require("../src/attendance");

const G = "guild-test";
function ok(name) { console.log("✅ " + name); }
function ev(id, created, label, status = "closed", closed = null) {
  return { id, guild_id: G, time_label: label, status, created_at: created, closed_at: closed };
}
function ids(list) { return list.map((e) => Number(e.id)); }

// 1) Duas noites diferentes criadas no mesmo dia UTC: as duas contam (ids 132 e 136).
{
  const r = attendance.selectCountedEvents([
    ev(132, "2026-10-07T00:44:00Z", "01:20", "closed", "2026-10-07T03:19:00Z"),
    ev(136, "2026-10-07T21:38:00Z", "01:20", "closed", "2026-10-08T04:14:00Z"),
  ]);
  assert.deepEqual(ids(r.events), [132, 136]);
  assert.equal(r.merged.length, 0);
  ok("01:20 de noites diferentes no mesmo dia UTC contam separados");
}

// 2) Criado na véspera e recriado no dia: mesma janela, conta uma vez (ids 48 e 49).
{
  const r = attendance.selectCountedEvents([
    ev(48, "2026-09-16T23:57:00Z", "15:20"),
    ev(49, "2026-09-17T13:51:00Z", "15:20"),
  ]);
  assert.deepEqual(ids(r.events), [49]);
  assert.deepEqual(r.merged.map((m) => [Number(m.event.id), Number(m.keptId)]), [[48, 49]]);
  ok("CTA criado na véspera e recriado no dia conta uma vez");
}

// 3) Cancelado e reposto: fica o reposto (ids 107 e 108).
{
  const r = attendance.selectCountedEvents([
    ev(107, "2026-10-01T14:26:00Z", "15:20", "cancelled", "2026-10-01T14:28:00Z"),
    ev(108, "2026-10-01T14:28:00Z", "15:20", "closed", "2026-10-01T17:11:00Z"),
  ]);
  assert.deepEqual(ids(r.events), [108]);
  ok("cancelado e reposto: conta só o reposto");
}

// 4) O mais recente é inválido: fica o válido, não o mais recente.
{
  const r = attendance.selectCountedEvents([
    ev(1, "2026-10-01T14:00:00Z", "17:20", "closed", "2026-10-01T19:17:00Z"),
    ev(2, "2026-10-01T14:05:00Z", "17:20", "cancelled", "2026-10-01T14:06:00Z"),
  ]);
  assert.deepEqual(ids(r.events), [1]);
  ok("cópia cancelada depois não derruba o CTA válido");
}

// 5) Grade recriada e fechada em minutos: janela inteira fora (10/10 15:20 e 21:20).
{
  const r = attendance.selectCountedEvents([
    ev(147, "2026-10-10T14:41:00Z", "15:20", "closed", "2026-10-10T14:45:00Z"),
    ev(150, "2026-10-10T14:42:00Z", "15:20", "closed", "2026-10-10T14:47:00Z"),
    ev(153, "2026-10-10T14:48:00Z", "15:20", "closed", "2026-10-10T14:49:00Z"),
    ev(155, "2026-10-10T15:07:00Z", "15:20", "closed", "2026-10-10T15:08:00Z"),
    ev(158, "2026-10-10T15:08:00Z", "15:20", "closed", "2026-10-10T15:57:00Z"),
    ev(148, "2026-10-10T14:41:00Z", "21:20", "closed", "2026-10-10T14:45:00Z"),
    ev(151, "2026-10-10T14:42:00Z", "21:20", "closed", "2026-10-10T14:47:00Z"),
    ev(159, "2026-10-10T15:08:00Z", "17:20", "closed", "2026-10-10T19:15:00Z"),
  ]);
  assert.deepEqual(ids(r.events), [159]);
  assert.deepEqual(r.discarded.map((d) => Number(d.event.id)).sort(), [151, 158]);
  assert.equal(r.discarded.find((d) => Number(d.event.id) === 158).copies, 4);
  ok("janela só com CTAs fechados sem acontecer não conta");
}

// 6) Limites do fechamento: 39 min após o início não conta, 41 min conta.
{
  const win = attendance.windowFor(ev(1, "2026-10-04T14:41:00Z", "21:20"));
  assert.equal(attendance.invalidReason(ev(124, "2026-10-04T14:41:00Z", "21:20", "closed", "2026-10-04T21:59:00Z"), win), "fechado antes do início da batalha");
  assert.equal(attendance.invalidReason(ev(1, "2026-10-04T14:41:00Z", "21:20", "closed", "2026-10-04T22:01:00Z"), win), null);
  assert.equal(attendance.invalidReason(ev(1, "2026-10-04T14:41:00Z", "21:20", "closed", "2026-10-04T20:00:00Z"), win), "fechado antes do horário");
  ok("fechado antes de início+40min não conta; depois conta");
}

// 7) Sem closed_at (CTAs antigos) e CTA ainda aberto continuam contando.
{
  const r = attendance.selectCountedEvents([
    ev(34, "2026-09-12T12:36:00Z", "15:20", "closed", null),
    ev(163, "2026-10-11T21:00:00Z", "21:20", "open", null),
  ]);
  assert.deepEqual(ids(r.events), [34, 163]);
  ok("CTA antigo sem closed_at e CTA aberto contam");
}

// 8) Dia do CTA: madrugada pertence à noite anterior.
{
  const day = (e) => attendance.eventDay(e, attendance.windowFor(e));
  assert.equal(day(ev(1, "2026-10-09T21:20:00Z", "01:20")), "2026-10-09");
  assert.equal(day(ev(140, "2026-10-09T00:32:00Z", "01:20")), "2026-10-08");
  assert.equal(day(ev(1, "2026-10-09T14:06:00Z", "15:20")), "2026-10-09");
  ok("dia do CTA de madrugada é o da noite anterior");
}

console.log("\n✅ Attendance valid events suite: TODOS OS TESTES PASSARAM");
