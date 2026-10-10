"use strict";

const assert = require("assert");
const {
  spPerMight,
  referenceWeightsPerMillion,
  inferContributionLayout,
  correlateProbeRows,
  buildContributionSnapshots,
  buildDashboardFromLatestSnapshots
} = require("../src/guildMight");

function near(actual, expected, epsilon, label) {
  assert(Math.abs(actual - expected) <= epsilon, label + ": " + actual + " != " + expected);
}

assert.deepEqual(referenceWeightsPerMillion(), {}, "No screenshot-derived SP weights should be active");
near(spPerMight({level:17,targetMight:256000,seasonPoints:100})*1000000,
  7031.25,0.01,"pure mathematical helper remains available");

const simple = inferContributionLayout({
  "0": ["ESTHER9950", "GiganteCarrara", "BadMack"],
  "1": [1080164, 929247, 777777],
  "4": 12
});
assert(simple.candidates.length >= 1, "deve achar arrays paralelos");
assert.strictEqual(simple.candidates[0].namesPath, "0");
assert.strictEqual(simple.candidates[0].mightPath, "1");
assert.strictEqual(simple.candidates[0].count, 3);
assert(simple.candidates[0].confidence >= 0.9, "confidence alta esperada");

// The IMORTAIS guild can exceed 400 members; arrays must not be silently discarded.
const fullGuild = inferContributionLayout({
  "0": Array.from({length:777}, (_,i) => "Player" + i),
  "1": Array.from({length:777}, (_,i) => 1000000 - i)
});
assert(fullGuild.candidates.length >= 1, "must support a complete 777-player leaderboard");
assert.strictEqual(fullGuild.candidates[0].count, 777);

const nested = inferContributionLayout({
  "5": {
    "2": ["RagnaldoKun", "GoldVex"],
    "8": [333000, 222000]
  }
});
assert(nested.candidates.some(x => x.namesPath === "5.2" && x.mightPath === "5.8"), "caminhos aninhados");

const base = Date.parse("2026-10-07T20:00:00Z");
const rows = [
  {
    event_id: "req-1",
    device_id: "d1",
    player_name: "BadMack",
    occurred_at: new Date(base).toISOString(),
    payload: {
      direction: "request",
      operationName: "GetGuildMightCategoryContribution",
      operationCode: 321,
      parameters: { "0": 7 }
    }
  },
  {
    event_id: "res-1",
    device_id: "d1",
    player_name: "BadMack",
    occurred_at: new Date(base + 250).toISOString(),
    payload: {
      direction: "response",
      operationName: "GetGuildMightCategoryContribution",
      operationCode: 321,
      parameters: {
        "0": ["ESTHER9950", "GiganteCarrara"],
        "1": [1080164, 929247]
      }
    }
  },
  {
    event_id: "res-2",
    device_id: "d2",
    player_name: "Other",
    occurred_at: new Date(base + 500).toISOString(),
    payload: {
      direction: "response",
      operationName: "GetGuildMightCategoryOverview",
      operationCode: 322,
      parameters: { "1": [1, 2, 3] }
    }
  }
];

const correlated = correlateProbeRows(rows);
assert.strictEqual(correlated.pairs.length, 2);
const pair = correlated.pairs.find(x => x.responseEventId === "res-1");
assert(pair, "par req/res");
assert.strictEqual(pair.requestEventId, "req-1");
assert.strictEqual(pair.requestParameters["0"], 7);
assert(pair.discovery.candidates.length >= 1, "discovery no par");
assert.strictEqual(correlated.unpairedResponses.length, 1);

const stale = correlateProbeRows([
  rows[0],
  { ...rows[1], event_id: "res-stale", occurred_at: new Date(base + 15000).toISOString() }
]);
assert.strictEqual(stale.pairs[0].requestEventId, null, "request antigo não pode correlacionar");

console.log("✅ GuildMight discovery: disabled screenshot weights, layout and request correlation OK");


// Old heuristic records without verifiable guild and category MUST NOT enter
// the official 14-category ranking. Discovery stays available for diagnostics.
const legacy = buildContributionSnapshots(rows);
assert.equal(legacy.length,0,"legacy heuristic responses are quarantined");
const guild={kind:"bytes",length:16,base64:"ckzUYJXLFUmTBs0y4mZ+SQ=="};
const verifiedRows=[{
 event_id:"verified-1",device_id:"d3",player_name:"BadMack",
 occurred_at:new Date(base+1200).toISOString(),
 payload:{direction:"response",operationName:"GetGuildMightCategoryContribution",
  parameters:{"0":guild,"1":"PVE","2":"marker","3":1800000,"4":2,
    "6":["BadMack","RagnaldoKun"],"7":[1000000,800000]}}
}];
const verified=buildContributionSnapshots(verifiedRows);
assert.equal(verified.length,1);
assert.equal(verified[0].layout.code,"PVE");
assert.equal(verified[0].category.mapped,true);
assert.equal(verified[0].members.length,2);
assert.equal(buildDashboardFromLatestSnapshots(verified).meta.categoryCount,1);
const foreign=structuredClone(verifiedRows);
foreign[0].payload.parameters["0"]={kind:"bytes",length:16,base64:Buffer.alloc(16,9).toString("base64")};
assert.equal(buildContributionSnapshots(foreign).length,0);
console.log("✅ GuildMight verified Photon only; legacy and other guilds quarantined");

// Exercise Challenge extraction and generated Guild Might page in the CI discovery step.
require("./guild-challenge");
require("./guild-might-page");
require("./guild-photon-capture");
