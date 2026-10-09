"use strict";
const assert=require("node:assert/strict");
const fixture=require("./fixtures/guild-photon-capture-20261009-minimized.json");
const secondDump=require("./fixtures/guild-photon-second-dump-minimized.json");
const {parseChallengeResponse,parseMightContributionResponse,parseMightOverviewResponse,assemblePages}
  =require("../src/guildPhotonVerified");

const secondTop=parseChallengeResponse(secondDump.challengeTop.parameters);
const secondLast=parseChallengeResponse(secondDump.challengeFinal.parameters);
const secondOverview=parseMightOverviewResponse(secondDump.overview.parameters);

// Normal Combat Client emits previewBase64. A byte-valued final page may
// contain nonzero scores and must not be silently converted to all zeroes.
const bytesNonzero=parseChallengeResponse({
  "1":"newer-marker","2":196981040,"3":3,"4":0,
  "5":["Alpha","Beta","Gamma"],
  "6":{kind:"bytes",length:3,previewBase64:Buffer.from([1,17,255]).toString("base64")}
});
assert.deepEqual(bytesNonzero.members.map(m=>m.points),[1,17,255]);
assert.equal(parseChallengeResponse({"3":3,"5":["Alpha","Beta","Gamma"],
  "6":{kind:"bytes",length:3,previewBase64:Buffer.from([1,17]).toString("base64")}}),null,
  "truncated preview cannot create invented scores");
assert.equal(parseChallengeResponse({"3":3,"5":["Alpha","Beta","Gamma"],
  "6":{kind:"bytes",length:3,previewBase64:"%%%"}}),null,
  "invalid encoded payload must fail closed");

assert.equal(secondTop.totalMembers,483);
assert.deepEqual(secondTop.members.slice(0,3).map(m=>m.points),[5930046,5203391,5018288]);
assert.equal(secondLast.members.length,5,"real zero-byte final page retained");
assert.equal(secondLast.members[0].rank,479);
assert(secondLast.members.every(m=>m.points===0));
assert.equal(secondOverview.categories.length,14);
assert.equal(secondOverview.categories.find(c=>c.code==="GVGSEASON").name,"Magos Engarrafadores");
assert.equal(secondOverview.categories.find(c=>c.code==="HELLDUNGEON").name,"As Profundezas");
assert.equal(secondOverview.categories.find(c=>c.code==="DRAGON_AREA").name,"Terras Ancestrais");
assert(secondOverview.categories.every(c=>c.level===null&&c.seasonPoints===null));

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

// Same player moves from first place to second place between two paginated responses.
// Dedup MUST use player identity and the latest observation, then rerank.
const shifted=assemblePages([
  {totalMembers:3,pageOffset:0,capturedAt:"2026-10-09T01:00:00Z",
    members:[{player:"Alpha",points:500,rank:1},{player:"Beta",points:400,rank:2}]},
  {totalMembers:3,pageOffset:1,capturedAt:"2026-10-09T01:01:00Z",
    members:[{player:"Alpha",points:510,rank:2},{player:"Gamma",points:600,rank:3}]}
]);
assert.equal(shifted.observedMembers,3);
assert.deepEqual(shifted.members.map(m=>[m.player,m.points,m.rank]),[
  ["Gamma",600,1],["Alpha",510,2],["Beta",400,3]
]);
assert.equal(shifted.complete,false,"without a shared marker there is no proven complete server instant");
// Incomplete coverage shows observed ranks only, not fabricated global positions.
const partial=assemblePages([{totalMembers:100,pageOffset:49,
  capturedAt:"2026-10-09T01:00:00Z",members:[{player:"Only",points:123,rank:50}]}]);
assert.equal(partial.members[0].rank,1);
assert.equal(partial.complete,false);
assert.equal(partial.missingCount,99);

// Second real dump: final Challenge page is an all-zero byte buffer.
const finalPage=parseChallengeResponse({
  "3":483,"4":478,"5":["facjj","Yamadha","GivisTabua","GDFP9C12","LastMember"],
  "6":{kind:"bytes",length:5,base64:"AAAAAAA="}
});
assert.equal(finalPage.members.length,5);
assert(finalPage.members.every(m=>m.points===0));
assert.equal(finalPage.members[0].rank,479);

// Historical-only members must not contaminate the recent ranking.
const oldAndNew=assemblePages([
 {totalMembers:3,pageOffset:0,capturedAt:"2026-10-08T19:00:00Z",
  members:[{player:"OldOnly",points:900}]},
 {totalMembers:3,pageOffset:0,capturedAt:"2026-10-09T01:00:00Z",
  members:[{player:"Alpha",points:500},{player:"Beta",points:400}]}
]);
assert.deepEqual(oldAndNew.members.map(m=>m.player),["OldOnly","Alpha","Beta"]);
assert.equal(oldAndNew.historicalObservedMembers,3);
assert.equal(oldAndNew.historicalMembers.length,0);
assert.equal(oldAndNew.members[0].player,"OldOnly");
assert.equal(oldAndNew.members[0].capturedAt,"2026-10-08T19:00:00Z");
// Latest complete 481-person snapshot supersedes the old 483-person roster.
// A departed member stays historical, but must not be in the current ranking.
const newerRoster=assemblePages([
 {snapshotMarker:"old",guildTotalPoints:990,totalMembers:3,pageOffset:0,
  capturedAt:"2026-10-09T01:00:00Z",
  members:[{player:"Alpha",points:500},{player:"Beta",points:300},{player:"Departed",points:190}]},
 {snapshotMarker:"new",guildTotalPoints:800,totalMembers:2,pageOffset:0,
  capturedAt:"2026-10-09T01:03:00Z",
  members:[{player:"Alpha",points:500},{player:"Beta",points:300}]}
]);
assert.equal(newerRoster.complete,true);
assert.deepEqual(newerRoster.members.map(m=>m.player),["Alpha","Beta"]);
assert.equal(newerRoster.totalMembers,2);
assert.equal(newerRoster.guildTotalPoints,800);
assert.equal(newerRoster.historicalMembers.length,1);
assert.equal(newerRoster.historicalMembers[0].player,"Departed");
const secondDumpExact=parseChallengeResponse({"1":"639271263141777982","2":196981040,
 "3":481,"4":86,"5":["Example"],"6":[100]});
assert.equal(secondDumpExact.guildTotalPoints,196981040);
assert.equal(secondDumpExact.snapshotMarker,"639271263141777982");

// Identifiers really match field 2 (contribution) to field 1 (overview).
// The two consecutive server aggregates in GATHERING differ by exactly 43,648;
// never compare the old player sum to the new marker's total.
const {reconcileCategoryAtServerInstant}=require("../src/guildPhotonVerified");
const gaOverview=parseMightOverviewResponse({
 "1":"639271178496263415","2":["GATHERING"],"3":[21934324446]});
const gbOverview=parseMightOverviewResponse({
 "1":"639271178598269601","2":["GATHERING"],"3":[21934368094]});
const ga=parseMightContributionResponse({
 "1":"GATHERING","2":"639271178496263415","3":21934324446,
 "4":2,"6":["Alpha","Beta"],"7":[21934324400,46]});
const gb=parseMightContributionResponse({
 "1":"GATHERING","2":"639271178598269601","3":21934368094,
 "4":2,"6":["Alpha","Beta"],"7":[21934368000,94]});
assert.equal(gbOverview.categories[0].guildMight-gaOverview.categories[0].guildMight,43648);
assert.equal(reconcileCategoryAtServerInstant(gaOverview,[ga,gb],"GATHERING").difference,0);
assert.equal(reconcileCategoryAtServerInstant(gbOverview,[ga,gb],"GATHERING").difference,0);
assert.equal(reconcileCategoryAtServerInstant(gbOverview,[ga],"GATHERING").reason,"no_matching_pages");

// Do not accidentally classify an overview guild-totals table as a players leaderboard.
assert.equal(parseMightContributionResponse(fixture.mightOverview),null);
// Missing field 4 means first page; but an inconsistent total must fail closed.
assert.equal(parseChallengeResponse({...fixture.challengeFirst,"3":2}),null);
assert.equal(parseMightContributionResponse({...fixture.mightCastleFirst,"4":2}),null);
console.log("✅ Real Photon fixtures: 14 overview categories, challenge top, per-player Might, pagination & missing spans OK");
