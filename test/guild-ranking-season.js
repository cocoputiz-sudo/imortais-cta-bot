"use strict";
const assert=require("node:assert/strict");
const {assemblePages,KNOWN_CATEGORY_LABELS,validImortaisGuild,parseGuildSeasonResponse}
  =require("../src/guildPhotonVerified");
const {buildDashboardFromLatestSnapshots}=require("../src/guildMight");
const {resolveEpoch,canPublishRankings}=require("../src/guildSeason");
assert.equal(canPublishRankings({verified:false},{HOMOLOG_MODE:"0"}),false);
assert.equal(canPublishRankings({verified:false},{HOMOLOG_MODE:"1"}),true);
assert.equal(canPublishRankings({verified:true},{HOMOLOG_MODE:"0"}),true);
const guild={kind:"bytes",length:16,base64:"ckzUYJXLFUmTBs0y4mZ+SQ=="};

const {isApprovedDevice}=require("../src/guildRankingAuth");
assert.equal(isApprovedDevice("WORKSPACEIGOR",{HOMOLOG_MODE:"0"}),false,
  "A valid token alone cannot authorize official production ranking");
assert.equal(isApprovedDevice("WORKSPACEIGOR",{HOMOLOG_MODE:"1"}),true);
assert.equal(isApprovedDevice("trusted",{HOMOLOG_MODE:"0",GUILD_RANKING_ALLOWED_DEVICE_IDS:"trusted"}),true);
assert.equal(isApprovedDevice("other",{HOMOLOG_MODE:"0",GUILD_RANKING_ALLOWED_DEVICE_IDS:"trusted"}),false);

const other={kind:"bytes",length:16,base64:Buffer.alloc(16,1).toString("base64")};
assert(validImortaisGuild({"0":guild},"GetGuildChallengePoints"));
assert(!validImortaisGuild({"0":other},"GetGuildChallengePoints"));
assert(!validImortaisGuild({},"GetGuildMightCategoryContribution"));
assert(!validImortaisGuild({"0":{kind:"bytes",length:16,previewBase64:"AAAA"}},"GetGuildMightCategoryOverview"));
assert.equal(parseGuildSeasonResponse({"0":35,"1":guild}),35);
assert.equal(parseGuildSeasonResponse({"0":35,"1":other}),null);
const ev=(id,at)=>({occurred_at:at,payload:{parameters:{"0":id,"1":guild}}});
assert.equal(resolveEpoch([ev(34,"2026-10-01T00:00:00Z"),ev(35,"2026-10-09T08:34:21Z")]).seasonId,35);
assert.equal(resolveEpoch([ev(34,"2026-10-01T00:00:00Z"),ev(35,"2026-10-09T08:34:21Z")]).startAt,"2026-10-09T08:34:21Z");
assert.equal(resolveEpoch([ev(35,"2026-10-09T08:34:21Z")]).verified,false);
const at="2026-10-09T21:00:00Z", after="2026-10-09T21:30:00Z";
const names=Array.from({length:481},(_,i)=>"Member"+String(i+1).padStart(3,"0"));
const baseline=Array.from({length:31},(_,i)=>({
  pageOffset:i*16,totalMembers:481,snapshotMarker:"complete-481",capturedAt:at,
  members:names.slice(i*16,i*16+16).map((player,n)=>({player,points:1000-i*16-n}))
}));
// Real-world regression shape: a complete 481-player capture followed by a
// single 16-player page at 16:23 Brasília (19:23 UTC).
const partial={pageOffset:0,totalMembers:481,snapshotMarker:"new-marker",
  capturedAt:after,members:names.slice(0,16).map((player,i)=>({player,points:1200+i}))};
const assembled=assemblePages([...baseline,partial],{asOf:"2026-10-09T22:00:00Z"});
assert.equal(assembled.members.length,481,"16-person partial cannot erase 481-player ranking");
assert.equal(new Date(assembled.lastCompleteAt).getTime(),new Date(at).getTime());
assert.equal(assembled.complete,false,"current marker is partial");
assert.equal(assembled.members.find(x=>x.player==="Member481").points,520);
const lower={...partial,capturedAt:"2026-10-09T21:31:00Z",
  members:[{player:"Member001",points:2}]};
const lowerDash=assemblePages([...baseline,partial,lower],{asOf:"2026-10-09T22:00:00Z"});
assert.equal(lowerDash.members.find(x=>x.player==="Member001").points,1200,
  "single lower reading cannot decrease season floor");
const oldMember=assemblePages([
 {pageOffset:0,totalMembers:1,snapshotMarker:"old",capturedAt:"2026-10-09T01:00:00Z",members:[{player:"Departed",points:50}]},
 {pageOffset:0,totalMembers:1,snapshotMarker:"new",capturedAt:after,members:[{player:"Current",points:70}]}
]);
assert.equal(oldMember.members.length,1);
assert.equal(oldMember.members[0].player,"Current","later complete capture can remove departed members");
const stale=assemblePages([
 {pageOffset:0,totalMembers:1,snapshotMarker:"same",capturedAt:"2026-10-08T01:00:00Z",members:[{player:"Retained",might:100}]}
],{asOf:"2026-10-09T22:00:00Z"});
assert.equal(stale.members.length,1);
assert.equal(stale.members[0].stale,true,"24h age is badge not removal");
const codes=Object.keys(KNOWN_CATEGORY_LABELS);
assert.equal(codes.length,14);
const seasonSamples=codes.map((code,i)=>({
  category:{key:"name:"+code,name:KNOWN_CATEGORY_LABELS[code],mapped:true},
  layout:{code,pageOffset:0,totalMembers:1,snapshotMarker:"first"},
  capturedAt:"2026-10-09T04:55:00Z",
  members:[{player:"BadMack",might:100+i}]
}));
const newerPartial=codes.slice(0,2).map((code,i)=>({
  category:{key:"name:"+code,name:KNOWN_CATEGORY_LABELS[code],mapped:true},
  layout:{code,pageOffset:0,totalMembers:2,snapshotMarker:"new"},
  capturedAt:"2026-10-09T07:11:00Z",
  members:[{player:"BadMack",might:300+i}]
}));
const early=buildDashboardFromLatestSnapshots(seasonSamples);
const late=buildDashboardFromLatestSnapshots([...seasonSamples,...newerPartial]);
assert.equal(early.meta.categoryCount,14);
assert.equal(late.meta.categoryCount,14,"Might 04:55 -> 07:11 may not fall from 14 to 2");
assert(late.ranking[0].might>=early.ranking[0].might);
assert.equal(buildDashboardFromLatestSnapshots([...seasonSamples,{
  category:{key:"legacy:unknown",name:"Categoria não mapeada",mapped:false},
  layout:{namesPath:"0",mightPath:"1"},capturedAt:after,
  members:[{player:"BadMack",might:9999999999}]
}]).meta.categoryCount,14,"unknown legacy snapshots do not create cards");
console.log("✅ Guild ranking: season floors, 481 retained after 16, 14 categories, stale, guild/season validation");
