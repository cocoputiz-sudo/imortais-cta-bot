"use strict";
const assert = require("node:assert/strict");
const { assignPrimaryCallerWeapon, CallerTransferError } = require("../src/caller-transfer");

function fixture(eventPatch = {}, rows = []) {
  let ev = { id: 201, guild_id: "imortais", caller_id: "badmack-primary",
    status: "open", party_list: "0,1", ...eventPatch };
  let signups = structuredClone(rows);
  let save;
  const queries = [];
  return {
    state() { return { ev, signups }; },
    queries,
    pool: {
      async connect() {
        return {
          async query(sql, values = []) {
            queries.push(sql);
            if (sql === "BEGIN") { save = structuredClone({ ev, signups }); return {}; }
            if (sql === "COMMIT") return {};
            if (sql === "ROLLBACK") { ev = save.ev; signups = save.signups; return {}; }
            if (sql.startsWith("SELECT id, guild_id, caller_id")) return { rows: [structuredClone(ev)] };
            if (sql.startsWith("UPDATE cta_signups")) {
              const moved = signups.filter(s => String(s.event_id) === String(values[0])
                && s.party_index != null && s.slot_index != null
                && s.party_index === values[1] && s.slot_index === 0
                && s.user_id !== values[2]);
              for (const s of moved) { s.party_index = null; s.slot_index = null; s.manual = false; }
              return { rows: structuredClone(moved) };
            }
            if (sql.startsWith("INSERT INTO cta_signups")) {
              const [eventId, userId, username, weapon, presence, partyIndex, ip] = values;
              let row = signups.find(s => String(s.event_id) === String(eventId) && s.user_id === userId);
              if (!row) {
                row = { event_id: eventId, user_id: userId, username };
                signups.push(row);
              }
              Object.assign(row, { weapon, presence, party_index: partyIndex, slot_index: 0,
                manual: true, second_caller: false, ip: ip ?? row.ip ?? null });
              return { rows: [structuredClone(row)] };
            }
            throw new Error("Unknown test SQL " + sql);
          },
          release() { queries.push("RELEASE"); }
        };
      }
    }
  };
}
const input = (patch = {}) => ({ eventId: 201, guildId: "imortais", userId: "badmack-primary",
  username: "[IM] BadMack", weapon: "MARTELO DE BATALHA", presence: "online", ...patch });

(async () => {
  // Screenshot case: caller is owner but PT1 slot 1 is empty. Normal signup pins it.
  const first = fixture();
  const result = await assignPrimaryCallerWeapon(first.pool, input());
  assert.equal(result.signup.weapon, "MARTELO DE BATALHA");
  assert.equal(result.signup.party_index, 0);
  assert.equal(result.signup.slot_index, 0);
  assert.equal(result.signup.manual, true);
  assert.equal(result.signup.second_caller, false);
  assert.equal(first.state().ev.caller_id, "badmack-primary");
  assert.equal(first.state().signups.length, 1);
  assert(first.queries.includes("COMMIT"));

  // Caller already signed with another weapon in PT2 is moved, not duplicated.
  const existing = fixture({}, [{ event_id: 201, user_id: "badmack-primary",
    username: "BadMack", weapon: "GOLEM", presence: "later", party_index: 1, slot_index: 3,
    second_caller: true, manual: false }]);
  await assignPrimaryCallerWeapon(existing.pool, input({ weapon: "MARTELO DE BATALHA" }));
  assert.equal(existing.state().signups.length, 1);
  assert.equal(existing.state().signups[0].party_index, 0);
  assert.equal(existing.state().signups[0].slot_index, 0);
  assert.equal(existing.state().signups[0].second_caller, false);

  // Valid secondary Discord account with similar name must not be deleted.
  const dual = fixture({}, [
    { event_id: 201, user_id: "badmack-alt", username: "!![IM]BadMack", weapon: "GOLEM",
      party_index: 0, slot_index: 0, manual: true },
    { event_id: 201, user_id: "badmack-primary", username: "[IM] BadMack", weapon: "MONARCA",
      party_index: null, slot_index: null, manual: false }
  ]);
  const moved = await assignPrimaryCallerWeapon(dual.pool, input());
  assert.equal(moved.displaced.length, 1);
  assert.equal(moved.displaced[0].user_id, "badmack-alt");
  assert.equal(dual.state().signups.length, 2);
  assert.equal(dual.state().signups.find(s => s.user_id === "badmack-alt").party_index, null);
  assert.equal(dual.state().signups.find(s => s.user_id === "badmack-primary").slot_index, 0);

  // Any catalog weapon is okay: leadership is not a weapon selection.
  await assignPrimaryCallerWeapon(first.pool, input({ weapon: "QUEDA SANTA" }));
  assert.equal(first.state().signups[0].weapon, "QUEDA SANTA");

  for (const [event, arg, expected] of [
    [{ caller_id: "someone-else" }, {}, "not_caller"],
    [{ status: "closed" }, {}, "closed"],
    [{ guild_id: "elsewhere" }, {}, "not_found"],
    [{}, { weapon: "ARMAMENTO_NAO_CADASTRADO" }, "invalid_weapon"],
    [{ party_list: "invalid" }, {}, "missing_party"],
  ]) {
    const db = fixture(event);
    await assert.rejects(() => assignPrimaryCallerWeapon(db.pool, input(arg)),
      e => e instanceof CallerTransferError && e.code === expected);
    assert(db.queries.includes("ROLLBACK"));
    assert.equal(db.state().signups.length, 0);
  }

  // PostgreSQL real, isolated TEMP tables; no impact on production.
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }, max: 1 });
    try {
      await pool.query(`CREATE TEMP TABLE cta_events
        (id BIGINT PRIMARY KEY, guild_id TEXT, caller_id TEXT, status TEXT, party_list TEXT)`);
      await pool.query(`CREATE TEMP TABLE cta_signups
        (event_id BIGINT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, weapon TEXT NOT NULL,
         presence TEXT NOT NULL, party_index INT, slot_index INT, ip INT, manual BOOLEAN DEFAULT FALSE,
         second_caller BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now(),
         UNIQUE (event_id,user_id))`);
      await pool.query("INSERT INTO cta_events VALUES (201, 'imortais', 'badmack-primary', 'open', '0,1')");
      const saved = await assignPrimaryCallerWeapon(pool, input());
      assert.equal(saved.signup.weapon, "MARTELO DE BATALHA");
      let rows = (await pool.query("SELECT * FROM cta_signups")).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].party_index, 0);
      assert.equal(rows[0].slot_index, 0);
      await pool.query(`INSERT INTO cta_signups
        (event_id, user_id, username, weapon, presence, party_index, slot_index)
        VALUES (201, 'badmack-alt', '!![IM]BadMack', 'GOLEM', 'online', 0, 0)`);
      const moved = await assignPrimaryCallerWeapon(pool, input({ weapon: "QUEDA SANTA" }));
      assert.equal(moved.displaced.length, 1);
      rows = (await pool.query("SELECT * FROM cta_signups ORDER BY user_id")).rows;
      assert.equal(rows.length, 2);
      assert.equal(rows.find(s => s.user_id === "badmack-alt").party_index, null);
      assert.equal(rows.find(s => s.user_id === "badmack-primary").weapon, "QUEDA SANTA");
      const owner = (await pool.query("SELECT caller_id FROM cta_events WHERE id=201")).rows[0];
      assert.equal(owner.caller_id, "badmack-primary");
      console.log("PASS PostgreSQL TEMP: any weapon + PT1 1st slot, preserves both Discord accounts");
    } finally { await pool.end(); }
  }
  console.log("PASS caller main: battle hammer, role/weapon independent, PT1 slot1, transactions");
})().catch(e => { console.error(e); process.exitCode = 1; });
