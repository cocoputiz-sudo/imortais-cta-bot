"use strict";

const assert = require("assert/strict");
const vm = require("node:vm");
const { once } = require("node:events");

process.env.PGSSL = "disable";
process.env.PORT = String(39000 + (process.pid % 1000));

const db = require("../src/db");
const telemetry = require("../src/telemetry");
const web = require("../src/web");

const G = process.env.GUILD_ID || "guild-test";

function ok(name) { console.log("✅ " + name); }

function cookieFor({ canEdit }) {
  const sid = web.__test.signSession({
    id: canEdit ? "staff-test" : "member-test",
    name: canEdit ? "Staff Test" : "Member Test",
    isMember: true,
    canEdit: !!canEdit,
    exp: Date.now() + 60 * 60 * 1000,
  });
  return "sid=" + sid;
}

async function post(base, cookie, body) {
  const response = await fetch(base + "/api/guild-roster/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body || {}),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function testBrowserScriptSyntax() {
  const page = String(web.__test.PAGE || "");
  const match = /<script>([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match && match[1], "script do navegador precisa existir no PAGE");
  new vm.Script(match[1], { filename: "war-room-browser.js" });
  ok("JavaScript do navegador em web.js tem sintaxe válida");
}

function testMobileAndMuralShell() {
  const page = String(web.__test.PAGE || "");
  assert.ok(page.includes('id="mobile-nav"'), "War Room mobile precisa manter menu de navegação");
  assert.ok(page.includes("overflow-x:hidden"), "shell mobile precisa impedir overflow horizontal da página");
  assert.ok(page.includes("100dvh"), "modais mobile precisam respeitar viewport dinâmica");
  assert.ok(page.includes("SepoDeMadeiraRs") && page.includes("VanWes"), "mural precisa manter vencedores do attendance");
  assert.ok(page.includes("IMORTAIS-Combat-Client-Setup-v0.6.0.exe"), "mural precisa manter download estável do Combat Client");
  assert.ok(page.includes("CTA War Room · central operacional da IMORTAIS"), "mural precisa manter card de funcionalidades do War Room");
  ok("War Room mobile e comunicados fixos do mural presentes");
}

async function seedRouteScenario() {
  await db.pool.query("TRUNCATE TABLE voice_presence, cta_signups, cta_events RESTART IDENTITY CASCADE");

  const ev = await db.createEvent({
    guildId: G,
    channelId: "guild-roster-route",
    callerId: "caller",
    timeLabel: "19:20",
    remind30: new Date(),
    remind10: new Date(),
  });

  for (const [uid, username, weapon] of [
    ["1", "[IM] Alfa", "JURADOR"],
    ["3", "[IM] Charlie", "ARCO LONGO"],
    ["6", "[IM] Foxtrot", "GOLEM"],
  ]) {
    await db.upsertSignup({
      eventId: ev.id,
      userId: uid,
      username,
      weapon,
      presence: "online",
      partyIndex: 0,
      slotIndex: 1,
    });
  }

  await db.pool.query(
    "INSERT INTO voice_presence(guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) VALUES " +
    "($1,'1','[IM] Alfa','guild-roster-route','prep',now()-interval '10 minutes',NULL)," +
    "($1,'2','[IM] Bravo','guild-roster-route','prep',now()-interval '10 minutes',NULL)",
    [G]
  );

  return ev;
}

async function testRouteAccessAndResponses() {
  const ev = await seedRouteScenario();
  const roster = [
    '"Character Name"\t"Last Seen"\t"Roles"',
    '"Alfa"\t"Online"\t""',
    '"Bravo"\t"Online"\t""',
    '"Charlie"\t"09/24/2026 00:10:00"\t""',
    '"Delta"\t"Online"\t"CONTRIBUINTE"',
    '"Echo"\t"Online"\t""',
    '"Foxtrot"\t"Online"\t""',
  ].join("\n");

  const server = web.startWebServer(null, {});
  if (!server.listening) await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "servidor de teste deve usar TCP local");
  const base = "http://127.0.0.1:" + addr.port;

  try {
    const member = await post(base, cookieFor({ canEdit: false }), { text: roster, eventId: ev.id });
    assert.equal(member.status, 403);
    assert.equal(member.json.error, "no_edit");

    const empty = await post(base, cookieFor({ canEdit: true }), { text: "", eventId: ev.id });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, "empty");

    const missing = await post(base, cookieFor({ canEdit: true }), { text: roster, eventId: 999999 });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "event_not_found");

    const good = await post(base, cookieFor({ canEdit: true }), { text: roster, eventId: ev.id });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);

    const names = (key) => good.json.groups[key].map((x) => x.name);
    assert.deepEqual(names("pronto"), ["Alfa"]);
    assert.deepEqual(names("naCallSemPing"), ["Bravo"]);
    assert.deepEqual(names("pingouOffline"), ["Charlie"]);
    assert.deepEqual(names("contribuinte"), ["Delta"]);
    assert.deepEqual(names("equipando"), ["Echo"]);
    assert.deepEqual(names("pingouForaDaCall"), ["Foxtrot"]);
    assert.equal(good.json.groups.pronto[0].weapon, "JURADOR");
    assert.equal(good.json.totals.roster, 6);
    assert.equal(good.json.totals.online, 5);
    assert.equal(good.json.totals.pinged, 3);
    assert.equal(good.json.totals.inCall, 2);

    ok("rota: membro=403, vazio=400, CTA ausente=404 e staff=200 com grupos corretos");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await telemetry.initSchema(db.pool);
  testBrowserScriptSyntax();
  testMobileAndMuralShell();
  await testRouteAccessAndResponses();
  console.log("\n✅ Guild roster route suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Guild roster route suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
