"use strict";

const assert = require("assert/strict");

process.env.PGSSL = "disable";
process.env.GUILD_ID = "guild-test";

const db = require("../src/db");
const attendance = require("../src/attendance");

const GUILD = process.env.GUILD_ID;

function ok(name) { console.log("✅ " + name); }

function mapToPlain(map) {
  return [...map.entries()].map(([k, v]) => [String(k), {
    ...v,
    prepIn: v.prepIn || null,
    prepOut: v.prepOut || null,
    bombIn: v.bombIn || null,
    bombOut: v.bombOut || null
  }]);
}

async function resetDb() {
  await db.pool.query(
    "TRUNCATE TABLE cta_signups, bomb_confirms, voice_presence, cta_events RESTART IDENTITY CASCADE"
  );
}

async function seed() {
  const events = [];
  for (const [i, time] of ["17:20", "19:20", "21:20"].entries()) {
    const { rows } = await db.pool.query(
      "INSERT INTO cta_events(guild_id,channel_id,caller_id,time_label,status,created_at) " +
      "VALUES($1,$2,'caller',$3,'closed',$4) RETURNING *",
      [GUILD, "chan-" + i, time, "2026-10-05T12:00:0" + i + "Z"]
    );
    events.push(rows[0]);
  }

  for (const [i, ev] of events.entries()) {
    await db.pool.query(
      "INSERT INTO cta_signups(event_id,user_id,username,weapon,presence,party_index,slot_index) " +
      "VALUES($1,'u1','Alice','HEAVY MACE','online',0,0),($1,'u2','Bob','LONG BOW','online',0,1)",
      [ev.id]
    );
    await db.pool.query(
      "INSERT INTO bomb_confirms(event_id,user_id,username,coming) VALUES($1,'u2','Bob',$2)",
      [ev.id, i !== 1]
    );

    const win = attendance.windowFor(ev);
    await db.pool.query(
      "INSERT INTO voice_presence(guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) VALUES " +
      "($1,'u1','Alice',$2,'prep',$3,$4)," +
      "($1,'u2','Bob',$2,'prep',$5,$6)," +
      "($1,'u2','Bob',$2,'bomb',$5,$6)",
      [
        GUILD,
        "voice-" + i,
        new Date(win.start.getTime() + 5 * 60000),
        new Date(win.end.getTime() - 5 * 60000),
        new Date(win.start.getTime() + 50 * 60000),
        new Date(win.start.getTime() + 75 * 60000)
      ]
    );
  }

  return events;
}

async function countQueries(fn) {
  const original = db.pool.query.bind(db.pool);
  let count = 0;
  db.pool.query = async function(...args) {
    count++;
    return original(...args);
  };
  try {
    const value = await fn();
    return { count, value };
  } finally {
    db.pool.query = original;
  }
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await resetDb();
  const events = await seed();

  const legacy = await countQueries(async () => {
    const out = [];
    for (const ev of events) out.push(mapToPlain(await attendance.processEvent(ev)));
    return out;
  });

  const batched = await countQueries(async () => {
    const ctx = await attendance.__test.loadEventsContext(GUILD, events);
    const out = [];
    for (const ev of events) out.push(mapToPlain(await attendance.processEvent(ev, ctx)));
    return out;
  });

  assert.deepEqual(batched.value, legacy.value);
  assert.equal(legacy.count, events.length * 4, "legado deve fazer quatro consultas por CTA");
  assert.equal(batched.count, 3, "lote deve fazer exatamente inscrições + confirmações + presença");
  assert.ok(batched.count < legacy.count);

  ok("processEvent(event, ctx) é equivalente ao legado");
  ok("consultas: legado=" + legacy.count + " / lote=" + batched.count);

  const report = await countQueries(() =>
    attendance.buildReport(
      GUILD,
      new Date("2026-10-05T00:00:00Z"),
      new Date("2026-10-06T00:00:00Z")
    )
  );
  assert.equal(report.count, 4, "buildReport deve usar 1 query de eventos + 3 lotes");
  assert.equal(report.value.ctaCount, 3);
  ok("buildReport usa 4 consultas fixas para 3 CTAs");

  console.log("\n✅ Attendance batch suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Attendance batch suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });
