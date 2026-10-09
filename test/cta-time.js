"use strict";

const assert = require("assert/strict");
const { ctaPingTime } = require("../src/ctatime");
const { publishBeforeThread } = require("../src/cta-publish");

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

async function testWarRoomAnnouncementBeforeThread() {
  const order = [];
  const announcement = {
    edit: async (payload) => {
      order.push("edit");
      assert.equal(payload.content, "CTA 01:20 → thread-123");
      assert.deepEqual(payload.allowedMentions, { parse: [] });
    },
  };
  const thread = await publishBeforeThread({
    publish: async () => { order.push("image"); return announcement; },
    createThread: async () => { order.push("thread"); return { id: "thread-123" }; },
    updateAnnouncement: (message, created) => {
      assert.equal(message, announcement);
      return message.edit({ content: `CTA 01:20 → ${created.id}`, allowedMentions: { parse: [] } });
    },
  });
  assert.equal(thread.id, "thread-123");
  assert.deepEqual(order, ["image", "thread", "edit"], "imagem deve anteceder planilha, mantendo link");
  ok("War Room: imagem publicada antes da thread e atualizada com o link");
}

async function testWarRoomAnnouncementFailures() {
  let created = false;
  await assert.rejects(publishBeforeThread({
    publish: async () => { throw new Error("upload falhou"); },
    createThread: async () => { created = true; },
    updateAnnouncement: async () => {},
  }), /upload falhou/);
  assert.equal(created, false, "sem anúncio, não deve abrir planilha silenciosamente");

  let updateError = null;
  const thread = await publishBeforeThread({
    publish: async () => ({ edit: async () => { throw new Error("edição indisponível"); } }),
    createThread: async () => ({ id: "thread-456" }),
    updateAnnouncement: (message) => message.edit({ content: "link" }),
    onUpdateFailure: (error) => { updateError = error; },
  });
  assert.equal(thread.id, "thread-456");
  assert.match(updateError.message, /edição indisponível/);
  ok("War Room: erro de upload impede CTA; falha de edição preserva thread");
}

async function main() {
  testReminderIsAuthoritativeAcrossMidnight();
  testFallbackUsesAttendanceRolloverRule();
  await testWarRoomAnnouncementBeforeThread();
  await testWarRoomAnnouncementFailures();
  console.log("\n✅ CTA time suite: TODOS OS TESTES PASSARAM");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
