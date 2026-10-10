"use strict";
const assert=require("node:assert/strict");
const {approvedDeviceIds,isApprovedDevice}=require("../src/guildRankingAuth");
async function main(){
  const records=[
    {device_id:"A",revoked_at:null},{device_id:"A",revoked_at:"2026-10-01T00:00:00Z"},
    {device_id:"B",revoked_at:null},{device_id:"C",revoked_at:"2026-10-01T00:00:00Z"}
  ];
  const pool={async query(sql){
    assert(sql.includes("t.revoked_at IS NULL"),"revoke must be checked in DB, not cached");
    return {rows:[...new Set(records.filter(x=>x.revoked_at===null).map(x=>x.device_id))]
      .map(device_id=>({device_id}))};
  }};
  assert.deepEqual([...await approvedDeviceIds(pool,{})].sort(),["A","B"]);
  assert.deepEqual([...await approvedDeviceIds(pool,{GUILD_RANKING_ALLOWED_DEVICE_IDS:"B,C"})],["B"],
    "optional restriction intersects active tokens; never reauthorizes revoked C");
  assert.equal(await isApprovedDevice(pool,"A",{}),true);
  records[0].revoked_at="2026-10-09T00:00:00Z";
  assert.equal(await isApprovedDevice(pool,"A",{}),false,
    "revoking the last token changes eligibility on next read");
  records[2].revoked_at="2026-10-09T00:00:00Z";
  assert.deepEqual([...await approvedDeviceIds(pool,{})],[]);
  await assert.rejects(()=>approvedDeviceIds(null,{}),/require_db/);
  console.log("Guild pairing auth: dynamic token revocation and optional restriction");
}
main().catch(e=>{console.error(e);process.exitCode=1});
