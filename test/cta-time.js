"use strict";

const assert = require("assert/strict");
const { ctaPingTime } = require("../src/ctatime");

function iso(date) {
  return date && date.toISOString();
}

function ok(name) {
  console.log("✅ " + name);
}

function testReminderIsAuthoritativeAcrossMidnight() {
  assert.equal(
    iso(ctaPingTime({
      time_label: "00:00",
      created_at: "2026-10-05T23:30:00Z",
      remind_10: "2026-10-05T23:50:00Z",
    })),
    "2026-10-06T00:00:00.000Z"
  );

  assert.equal(
    iso(ctaPingTime({
      time_label: "01:20",
      created_at: "2026-10-05T23:10:00Z",
      remind_10: "2026-10-06T01:10:00Z",
    })),
    "2026-10-06T01:20:00.000Z"
  );

  assert.equal(
    iso(ctaPingTime({
      time_label: "19:20",
      created_at: "2026-10-05T19:00:00Z",
      remind_10: "2026-10-05T19:10:00Z",
    })),
    "2026-10-05T19:20:00.000Z"
  );

  ok("remind_10 + 10 min resolve 00:00, 01:20 e 19:20 no dia correto");
}

function testFallbackUsesAttendanceRolloverRule() {
  assert.equal(
    iso(ctaPingTime({
      time_label: "00:00",
      created_at: "2026-10-05T23:30:00Z",
      remind_10: null,
    })),
    "2026-10-06T00:00:00.000Z",
    "sem remind_10, CTA de madrugada aberto à noite precisa virar o dia"
  );

  assert.equal(
    iso(ctaPingTime({
      time_label: "00:00",
      created_at: "2026-10-06T00:30:00Z",
      remind_10: null,
    })),
    "2026-10-06T00:00:00.000Z",
    "margem de 2h impede empurrar CTA recém-iniciado para amanhã"
  );

  ok("fallback sem remind_10 replica a margem de 2h do attendance.windowFor");
}

testReminderIsAuthoritativeAcrossMidnight();
testFallbackUsesAttendanceRolloverRule();
console.log("\n✅ CTA time suite: TODOS OS TESTES PASSARAM");
