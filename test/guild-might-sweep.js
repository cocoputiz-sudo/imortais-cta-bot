"use strict";
const assert=require("node:assert/strict");
const {assembleMightPages,KNOWN_CATEGORY_LABELS}=require("../src/guildPhotonVerified");
const {buildDashboardFromLatestSnapshots}=require("../src/guildMight");
const base=Date.parse("2026-10-09T04:55:00Z");
const names=Array.from({length:330},(_,i)=>"Player"+String(i).padStart(3,"0"));
const page=(people,N,offset,ms,device="WORKSPACEIGOR",marker="marker")=>({
  pageOffset:offset,totalMembers:N,deviceId:device,
  snapshotMarker:marker,capturedAt:new Date(base+ms).toISOString(),
  members:people.map((player,i)=>({player,might:1000+(N-offset-i),rank:offset+i+1}))
});
function sweep(people,fromMs=0,device="WORKSPACEIGOR"){
  const out=[];for(let i=0;i<people.length;i+=75){
    out.push(page(people.slice(i,i+75),people.length,i,fromMs+(i/75)*40000,
      device,"marker-"+i+"-"+fromMs));
  }
  return out;
}
const first=sweep(names);
const r=assembleMightPages(first,{asOf:"2026-10-09T08:00:00Z"});
assert.equal(r.complete,true);
assert.equal(r.sweepComplete,true);
assert.equal(r.observedMembers,330);
assert.equal(r.sweepCoverage,"330/330");
assert.equal(r.sweepDurationMs,160000);
assert.equal(r.historicalMembers.length,0);
const partial=page(names.slice(0,16),330,0,3*3600000,"WORKSPACEIGOR","latest");
partial.members.forEach(m=>m.might+=3000);
const persisted=assembleMightPages([...first,partial]);
assert.equal(persisted.observedMembers,330);
assert.equal(persisted.complete,true);
assert.equal(persisted.members.find(x=>x.player==="Player329").might,1001);
const partialNewSize=page(names.slice(0,20),329,0,4*3600000);
const uncertain=assembleMightPages([...first,partialNewSize]);
assert.equal(uncertain.observedMembers,330);
assert.equal(uncertain.complete,false);
const nextPeople=names.slice(0,329);
const next=sweep(nextPeople,5*3600000);
const after=assembleMightPages([...first,...next]);
assert.equal(after.observedMembers,329);
assert.equal(after.historicalMembers.length,1);
assert.equal(after.historicalMembers[0].player,"Player329");
assert.equal(after.sweepCoverage,"329/329");
const mixed=sweep(names).map((p,i)=>({...p,deviceId:i%2?"SECOND":"FIRST"}));
assert.equal(assembleMightPages(mixed).sweepComplete,false);
const tooSlow=sweep(names).map((p,i)=>({...p,capturedAt:new Date(base+i*130000).toISOString()}));
assert.equal(assembleMightPages(tooSlow).sweepComplete,false);
const unstable=sweep(names).map((p,i)=>i===2?{...p,totalMembers:331}:p);
assert.equal(assembleMightPages(unstable).sweepComplete,false);
const duplicate=sweep(names).map((p,i)=>i===1?{...p,members:p.members.map((m,j)=>j===0?{...m,player:"Player000"}:m)}:p);
assert.equal(assembleMightPages(duplicate).sweepComplete,false);
const noRank=first.map(p=>({...p,members:p.members.map(({rank,...m})=>m)}));
assert.equal(assembleMightPages(noRank).sweepComplete,false);
assert.equal(assembleMightPages(noRank).observedMembers,330);
const codes=Object.keys(KNOWN_CATEGORY_LABELS);
const cat=(code,p)=>({
  deviceId:p.deviceId,category:{name:KNOWN_CATEGORY_LABELS[code],mapped:true},
  layout:{code,pageOffset:p.pageOffset,totalMembers:p.totalMembers,snapshotMarker:p.snapshotMarker},
  capturedAt:p.capturedAt,members:p.members
});
const all=codes.map(code=>cat(code,page(["Player000"],1,0,0)));
const newest=codes.slice(0,2).map(code=>cat(code,page(["Player000"],2,0,3*3600000)));
assert.equal(buildDashboardFromLatestSnapshots([...all,...newest]).categories.length,14);
console.log("Guild Might sweeps: 330/330, cross-marker, safe departure, rank provenance, 14/14");
