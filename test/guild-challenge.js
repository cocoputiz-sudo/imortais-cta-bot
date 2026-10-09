"use strict";
const assert=require("node:assert/strict");
const {extractChallengeSnapshots,assemblePages}=require("../src/guildChallenge");
const f=require("./fixtures/guild-photon-capture-20261009-minimized.json");
const stamp="2026-10-09T01:11:00.1620572Z";
const event=(id,op,direction,params,at=stamp)=>({
  event_id:id,player_name:"BadMack",device_id:"workstation-test",
  occurred_at:at,payload:{operationName:op,direction,parameters:params}
});
const result=extractChallengeSnapshots([
  event("wrong","GetGuildMightCategoryContribution","response",f.challengeFirst),
  event("request","GetGuildChallengePoints","request",f.challengeFirst),
  event("response-1","GetGuildChallengePoints","response",f.challengeFirst),
  event("response-19","GetGuildChallengePoints","response",f.challengePage19,"2026-10-09T01:11:02Z")
]);
assert.equal(result.length,2);
assert.equal(result[0].pageOffset,19);
assert.equal(result[1].totalMembers,482);
assert.equal(result[1].members[0].player,"GiganteCarrara");
assert.equal(result[1].members[0].points,5905587);
const combined=assemblePages(result);
assert.equal(combined.observedMembers,5);
assert.equal(combined.complete,false);
assert.deepEqual(combined.members.map(m=>m.rank),[1,2,3,4,5]);
assert.equal(extractChallengeSnapshots([event("broken","GetGuildChallengePoints","response",{"5":["BadMack"],"6":[-1],"3":482})]).length,0);
console.log("✅ Guild Challenge: parsing com layout real, paginas e cobertura parcial OK");
