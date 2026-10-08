"use strict";
const assert = require("node:assert/strict");
const { extractChallengeSnapshots } = require("../src/guildChallenge");
const event = (operationName, direction, parameters) => ({
  event_id: operationName + direction, player_name: "BadMack",
  occurred_at: "2026-10-08T20:00:00Z",
  payload: { operationName, direction, parameters }
});
const good = event("GetGuildChallengePoints", "response", {
  1: ["PlayerA", "PlayerB", "PlayerC"],
  2: [5817978, 5072517, 4890194]
});
const got = extractChallengeSnapshots([
  event("GetGuildMightCategoryContribution", "response", good.payload.parameters),
  event("GetGuildChallengePoints", "request", good.payload.parameters),
  good
]);
assert.equal(got.length, 1);
assert.deepEqual(got[0].members.map(x => x.points), [5817978, 5072517, 4890194]);
assert.deepEqual(extractChallengeSnapshots([event("GetGuildChallengePoints", "response", {1: [1,2,3]})]), []);
assert.deepEqual(extractChallengeSnapshots([event("GetGuildChallengePoints", "response", {1: ["a", "b"],2: [-1,-3]})]), []);
console.log("guild challenge extraction: ok");
