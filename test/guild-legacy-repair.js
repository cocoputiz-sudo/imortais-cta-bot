"use strict";
const assert=require("node:assert/strict");
const {classifyLegacyRows,applyLegacyRepair}=require("../src/guildLegacyRepair");
const guild={kind:"bytes",length:16,base64:"ckzUYJXLFUmTBs0y4mZ+SQ=="};
const good={
 id:100,response_event_id:"old-event",category_key:"request:heuristic",
 device_id:"WORKSPACEIGOR",player_name:"BadMack",
 occurred_at:"2026-10-09T04:55:00Z",
 payload:{direction:"response",operationName:"GetGuildMightCategoryContribution",
 parameters:{"0":guild,"1":"PVE","2":"marker","3":1000000,"4":2,
 "6":["BadMack","PlayerTwo"],"7":[700000,300000]}}
};
const invalid=structuredClone(good);invalid.id=101;
invalid.payload.parameters["0"]={kind:"bytes",length:16,base64:Buffer.alloc(16).toString("base64")};
const missing=structuredClone(good);missing.id=102;delete missing.payload.parameters["1"];
const p=classifyLegacyRows([good,invalid,missing]);
assert.equal(p.eligible.length,1);
assert.equal(p.quarantined.length,2);
assert.equal(p.eligible[0].code,"PVE");
assert.equal(p.eligible[0].members.length,2);
assert.equal(p.eligible[0].responseEventId,"old-event",
  "repair must retain the original event identity");
(async()=>{
 await assert.rejects(()=>applyLegacyRepair(null,p),/explicit_legacy_repair_approval_required/);
 console.log("✅ Legacy snapshot repair is quarantined by default and requires explicit approval");
})().catch(e=>{console.error(e);process.exitCode=1});
