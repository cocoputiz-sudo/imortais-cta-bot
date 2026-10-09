"use strict";
const {buildContributionSnapshots}=require("./guildMight");
const {validImortaisGuild}=require("./guildPhotonVerified");
const {isApprovedDevice}=require("./guildRankingAuth");
// Read-only planning. A legacy row lacking layout.code is NOT deleted, used
// in the public ranking, or silently rewritten at application startup.
function classifyLegacyRows(rows){
  const eligible=[],quarantined=[];
  for(const row of rows||[]){
    const raw=row.payload?.parameters||{};
    const reason=!isApprovedDevice(row.device_id)?"device_not_approved":
      !validImortaisGuild(raw,row.payload?.operationName)
      ?"guild_not_verified":null;
    const fake={event_id:row.response_event_id,device_id:row.device_id,
      player_name:row.player_name,occurred_at:row.occurred_at,payload:row.payload};
    const redecoded=reason?[]:buildContributionSnapshots([fake]);
    const snap=redecoded.find(x=>x.layout?.code&&x.category?.mapped&&x.members?.length);
    if(reason||!snap){quarantined.push({snapshotId:row.id,
      reason:reason||"cannot_reconstruct_verified_category"});continue;}
    eligible.push({snapshotId:row.id,responseEventId:row.response_event_id,
      oldCategory:row.category_key,code:snap.layout.code,
      category:snap.category,layout:snap.layout,members:snap.members});
  }
  return {eligible,quarantined};
}
async function planLegacyRepair(pool,{limit=5000}={}){
  const n=Math.max(1,Math.min(20000,Number(limit)||5000));
  const result=await pool.query(
    "SELECT s.id,s.response_event_id,s.category_key,e.device_id,e.player_name,e.occurred_at,e.payload "+
    "FROM guild_might_snapshots s "+
    "LEFT JOIN albion_telemetry_events e ON e.event_id=s.response_event_id "+
    "WHERE s.members_complete=true AND "+
    "(s.category_mapped=false OR COALESCE(s.layout->>'code','')='') "+
    "ORDER BY s.id ASC LIMIT $1",[n]);
  return classifyLegacyRows(result.rows);
}
// A caller must opt in explicitly. A copy of old snapshot metadata + member
// rows is journaled before each transactionally applied correction.
async function applyLegacyRepair(pool,plan,{allowApply=false}={}){
  if(!allowApply)throw Error("explicit_legacy_repair_approval_required");
  let repaired=0;
  for(const item of plan.eligible||[]){
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query(
        "CREATE TABLE IF NOT EXISTS guild_might_reprocess_audit ("+
        "snapshot_id BIGINT PRIMARY KEY, original_snapshot JSONB NOT NULL,"+
        "original_members JSONB NOT NULL, repaired_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const before=await client.query(
        "SELECT * FROM guild_might_snapshots WHERE id=$1 FOR UPDATE",[item.snapshotId]);
      if(!before.rows.length){await client.query("ROLLBACK");continue;}
      const old=before.rows[0];
      if(old.category_mapped&&old.layout?.code){await client.query("ROLLBACK");continue;}
      const members=await client.query(
        "SELECT * FROM guild_might_snapshot_members WHERE snapshot_id=$1",[item.snapshotId]);
      await client.query("INSERT INTO guild_might_reprocess_audit(snapshot_id,original_snapshot,original_members) "+
        "VALUES($1,$2::jsonb,$3::jsonb) ON CONFLICT DO NOTHING",
        [item.snapshotId,JSON.stringify(old),JSON.stringify(members.rows)]);
      await client.query(
        "UPDATE guild_might_snapshots SET category_key=$2,category_name=$3,category_mapped=true,"+
        "layout=$4::jsonb WHERE id=$1",
        [item.snapshotId,item.category.key,item.category.name,JSON.stringify(item.layout)]);
      await client.query("DELETE FROM guild_might_snapshot_members WHERE snapshot_id=$1",[item.snapshotId]);
      for(const member of item.members){
        await client.query("INSERT INTO guild_might_snapshot_members "+
          "(snapshot_id,player_key,player_name,might,estimated_sp,member_rank) VALUES($1,$2,$3,$4,NULL,$5)",
          [item.snapshotId,String(member.player).toLowerCase(),member.player,member.might,Number.isSafeInteger(member.rank)?member.rank:null]);
      }
      await client.query("COMMIT");
      repaired++;
    }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err}
    finally{client.release()}
  }
  return {repaired,quarantined:plan.quarantined?.length||0};
}
module.exports={classifyLegacyRows,planLegacyRepair,applyLegacyRepair};
