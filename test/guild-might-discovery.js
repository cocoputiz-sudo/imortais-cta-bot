"use strict";

const assert = require("assert");
const {
  spPerMight,
  referenceWeightsPerMillion,
  inferContributionLayout,
  correlateProbeRows
} = require("../src/guildMight");

function near(actual, expected, epsilon, label) {
  assert(Math.abs(actual - expected) <= epsilon, label + ": " + actual + " != " + expected);
}

near(referenceWeightsPerMillion().PvE, 384.6153846, 0.01, "peso PvE");
near(referenceWeightsPerMillion().Aranhas, 9660, 0.01, "peso Aranhas");
near(
  spPerMight({ level: 17, targetMight: 256000, seasonPoints: 100 }) * 1000000,
  7031.25,
  0.01,
  "peso Hellgates"
);

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

console.log("✅ GuildMight discovery: pesos, layout e correlação request/response OK");
