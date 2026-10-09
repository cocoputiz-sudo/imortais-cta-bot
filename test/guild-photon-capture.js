"use strict";
const assert=require("node:assert/strict");
const fixture=require("./fixtures/guild-photon-capture-20261009-minimized.json");
const {parseChallengeResponse,parseMightContributionResponse,parseMightOverviewResponse,assemblePages}
  =require("../src/guildPhotonVerified");

const challenge=parseChallengeResponse(fixture.challengeFirst);
assert(challenge);
assert.equal(challenge.totalMembers,482);
assert.equal(challenge.pageOffset,0);
assert.deepEqual(challenge.members.map(m=>[m.player,m.points,m.rank]),[
  ["GiganteCarrara",5905587,1],["ESTHER9950",5179919,2],["JnK1",4996374,3]
]);
assert.equal(challenge.level,null);
assert.equal(challenge.seasonPoints,null);
const later=parseChallengeResponse(fixture.challengeFirstLater);
const second=parseChallengeResponse(fixture.challengePage19);
assert.deepEqual(second.members.map(x=>x.rank),[20,21]);
const assembled=assemblePages([
 {...challenge,capturedAt:"2026-10-09T01:11:00.1620572Z"},
 {...second,capturedAt:"2026-10-09T01:11:01.6814015Z"},
 {...later,capturedAt:"2026-10-09T01:34:55.1410536Z"}
]);
assert.equal(assembled.observedMembers,5);
assert.equal(assembled.complete,false);
assert.equal(assembled.members[0].points,5906593);
assert.equal(assembled.missingCount,477);
assert.equal(assembled.members[3].rank,4);

const overview=parseMightOverviewResponse(fixture.mightOverview);
assert.equal(overview.categories.length,14);
assert.equal(overview.categories.find(x=>x.code==="CASTLE").guildMight,200180630894);
assert(overview.categories.every(x=>x.level===null&&x.seasonPoints===null));

const castle=parseMightContributionResponse(fixture.mightCastleFirst);
assert.equal(castle.pageOffset,0);
assert.equal(castle.totalMembers,328);
assert.equal(castle.guildMight,200180630894);
assert.deepEqual(castle.members.map(x=>x.might),[4869656034,4081404282,4034899669]);
const pve=parseMightContributionResponse(fixture.mightPveFirst);
assert.equal(pve.totalMembers,465);
assert.equal(pve.members[0].player,"ESTHER9950");
assert.equal(pve.level,null);
assert.equal(pve.seasonPoints,null);
assert.equal(assemblePages([{...castle,capturedAt:"2026-10-09T01:08:48Z"}]).observedMembers,3);

// Do not accidentally classify an overview guild-totals table as a players leaderboard.
assert.equal(parseMightContributionResponse(fixture.mightOverview),null);
// Missing field 4 means first page; but an inconsistent total must fail closed.
assert.equal(parseChallengeResponse({...fixture.challengeFirst,"3":2}),null);
assert.equal(parseMightContributionResponse({...fixture.mightCastleFirst,"4":2}),null);
console.log("✅ Real Photon fixtures: 14 overview categories, challenge top, per-player Might, pagination & missing spans OK");
