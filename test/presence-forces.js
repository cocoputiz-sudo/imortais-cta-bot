"use strict";

const assert = require("assert/strict");
const telemetry = require("../src/telemetry");

const fn = telemetry.__test && telemetry.__test.presenceForcesForWindow;
assert.equal(typeof fn, "function");

const base = Date.parse("2026-10-04T19:20:00Z");
const row = (seconds, device, observer, players, cluster = "Thunderrock Upland") => ({
  occurred_at: new Date(base + seconds * 1000).toISOString(),
  device_id: device,
  player_name: observer,
  payload: { cluster, players }
});
const p = (id, name, guild, alliance = "") => ({ playerId: id, name, guild, alliance });

const rows = [
  row(5, "dev-a", "OurOne", [
    p("ours-2", "OurTwo", "IMORTAIS"),
    p("a1", "EnemyA1", "ARCH", "AAA"),
    p("a2", "EnemyA2", "ARCH", "AAA")
  ]),
  row(12, "dev-b", "OurTwo", [
    p("a1", "EnemyA1", "ARCH", "AAA"),
    p("a3", "EnemyA3", "ARCH", "AAA"),
    p("p1", "EnemyP1", "POE", "POE")
  ]),
  row(20, "dev-c", "OurThree", [
    p("a1", "EnemyA1", "ARCH", "AAA")
  ]),
  row(40, "dev-a", "OurOne", [
    p("a1", "EnemyA1", "ARCH", "AAA")
  ]),
  row(10, "dev-z", "OurOne", [
    p("x1", "OtherMapEnemy", "ARCH", "AAA")
  ], "Deepwood Pines")
];

const forces = fn(
  rows,
  new Set(["ourone", "ourtwo", "ourthree"]),
  "Thunderrock Upland",
  new Date(base),
  new Date(base + 60_000)
);

assert.ok(forces);
assert.equal(forces.sampleCount, 4);
assert.equal(forces.observerCount, 3);
assert.equal(forces.our.unique, 3);
assert.equal(forces.our.peak, 3);

const arch = forces.guilds.find(x => x.guild === "ARCH");
assert.ok(arch);
assert.equal(arch.unique, 3);
assert.equal(arch.peak, 3);
assert.equal(arch.oursAtPeak, 3);
assert.equal(arch.differenceAtPeak, 0);

const poe = forces.guilds.find(x => x.guild === "POE");
assert.ok(poe);
assert.equal(poe.unique, 1);
assert.equal(poe.peak, 1);
assert.equal(poe.oursAtPeak, 3);

const otherMap = fn(
  rows,
  new Set(["ourone", "ourtwo", "ourthree"]),
  "Deepwood Pines",
  new Date(base),
  new Date(base + 30_000)
);
assert.ok(otherMap);
assert.equal(otherMap.guilds.find(x => x.guild === "ARCH").unique, 1);

console.log("✅ Presence forces: dedup multi-observer, guild totals, map filter e pico simultâneo");
