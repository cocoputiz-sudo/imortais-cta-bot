"use strict";
const assert = require("node:assert/strict");
const { transferPrimaryCaller, validateCallerTransfer, CallerTransferError } = require("../src/caller-transfer");

function database(events = {}, signups = []) {
  let storedEvent = { id: "169", guild_id: "guild1", caller_id: "caller-main",
    time_label: "17:20", status: "open", party_list: "0,1", ...events };
  let stored = signups.map(s => ({ party_index: null, slot_index: null,
    second_caller: false, manual: false, ...s }));
  const log = [];
  let backup;
  return {
    state: () => ({ ev: storedEvent, signups: stored }),
    log,
    pool: {
      async connect() {
        const conn = {
          async query(sql, p) {
            log.push({ sql, params: p });
            if (sql === "BEGIN") {
              backup = JSON.parse(JSON.stringify({ ev: storedEvent, signups: stored }));
              return {};
            }
            if (sql === "COMMIT") return {};
            if (sql === "ROLLBACK") {
              storedEvent = backup.ev;
              stored = backup.signups;
              return {};
            }
            if (sql.startsWith("SELECT * FROM cta_events")) return { rows: [structuredClone(storedEvent)] };
            if (sql.startsWith("SELECT * FROM cta_signups")) return { rows: structuredClone(stored) };
            if (sql.includes("SET party_index=NULL")) {
              const moved = stored.filter(s => String(s.event_id) === String(p[0])
                && Number(s.party_index) === Number(p[1]) && Number(s.slot_index) === 0
                && String(s.user_id) !== String(p[2]));
              for (const s of moved) { s.party_index = null; s.slot_index = null; s.manual = false; }
              return { rows: structuredClone(moved) };
            }
            if (sql.includes("SET party_index=$3")) {
              const s = stored.find(s => String(s.event_id) === String(p[0]) && String(s.user_id) === String(p[1]));
              if (!s) return { rows: [] };
              s.party_index = p[2]; s.slot_index = 0; s.manual = true; s.second_caller = false;
              return { rows: [structuredClone(s)] };
            }
            if (sql.startsWith("UPDATE cta_events")) {
              if (String(storedEvent.caller_id) !== String(p[2]) || storedEvent.status !== "open")
                return { rows: [] };
              storedEvent.caller_id = p[1];
              return { rows: [structuredClone(storedEvent)] };
            }
            throw new Error("SQL unexpected: " + sql);
          },
          release() { log.push({ sql: "RELEASE" }); }
        };
        return conn;
      }
    }
  };
}
const transfer = d => transferPrimaryCaller(d.pool, {
  eventId: "169", guildId: "guild1", fromUserId: "caller-main", toUserId: "successor"
});

(async function run() {
  const old = { event_id: "169", user_id: "caller-main", username: "[IM] BadMack",
    weapon: "GOLEM", party_index: 0, slot_index: 0, manual: true };
  const alt = { event_id: "169", user_id: "other-account", username: "!![IM]BadMack",
    weapon: "GOLEM", party_index: null, slot_index: null };
  const successor = { event_id: "169", user_id: "successor", username: "[IM] Ragnaldokun",
    weapon: "GOLEM", party_index: 1, slot_index: 5, second_caller: true };

  // Same name on different IDs must never be merged or removed.
  const db = database({}, [old, alt, successor]);
  const result = await transfer(db);
  assert.equal(result.event.caller_id, "successor");
  assert.deepEqual(result.displaced.map(x => x.user_id), ["caller-main"]);
  const rows = db.state().signups;
  assert.equal(rows.length, 3);
  assert.equal(rows.find(s => s.user_id === "caller-main").party_index, null);
  assert.equal(rows.find(s => s.user_id === "other-account").weapon, "GOLEM");
  assert.equal(rows.find(s => s.user_id === "successor").party_index, 0);
  assert.equal(rows.find(s => s.user_id === "successor").slot_index, 0);
  assert.equal(rows.find(s => s.user_id === "successor").second_caller, false);
  assert(db.log.some(x => x.sql === "BEGIN") && db.log.some(x => x.sql === "COMMIT"));
  assert(!db.log.some(x => /^DELETE/.test(x.sql)), "transfer cannot delete any signup");

  // New caller already at PT1 slot1: no displacement, and no phantom duplicate.
  const already = database({}, [alt, { ...successor, party_index: 0, slot_index: 0 }]);
  const done = await transfer(already);
  assert.equal(done.displaced.length, 0);
  assert.equal(already.state().signups.length, 2);

  // Stale requester, missing successor, closed event, wrong guild: reject and rollback.
  for (const [event, rows, code] of [
    [{ caller_id: "other-caller" }, [old, successor], "not_caller"],
    [{ status: "closed" }, [old, successor], "closed"],
    [{ guild_id: "other-guild" }, [old, successor], "not_found"],
    [{}, [old], "not_signed"],
    [{}, [old, { ...successor, weapon: "ARCO LONGO" }], "invalid_weapon"],
  ]) {
    const d = database(event, rows);
    await assert.rejects(() => transfer(d), e => e instanceof CallerTransferError && e.code === code);
    assert(d.log.some(x => x.sql === "ROLLBACK"), "must rollback on "+code);
    assert.equal(d.state().ev.caller_id, event.caller_id || "caller-main");
  }

  // Identical usernames are legal; control by Discord user ID only.
  validateCallerTransfer(db.state().ev, db.state().signups,
    { guildId: "guild1", fromUserId: "successor", toUserId: "caller-main" });
  console.log("PASS caller-transfer: atomic authority, PT1, reserved occupant, second caller, dual accounts, rollback");
})().catch(e => { console.error(e); process.exitCode = 1; });
