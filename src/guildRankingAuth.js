"use strict";

// Dynamic authorization: the DB is the authority. Revoking the FINAL
// non-revoked pairing token immediately removes this device from rankings.
// A stale heartbeat is not equivalent to token revocation.
function optionalDeviceRestriction(env=process.env){
  const raw=String(env.GUILD_RANKING_ALLOWED_DEVICE_IDS||"").trim();
  if(!raw)return null; // absent = all active paired devices, NOT nobody
  return new Set(raw.split(",").map(x=>x.trim()).filter(Boolean));
}
async function approvedDeviceIds(pool,env=process.env){
  if(!pool || typeof pool.query!=="function")
    throw new Error("guild_rankings_require_db_for_authorization");
  const result=await pool.query(
    "SELECT DISTINCT d.device_id FROM albion_telemetry_devices d "+
    "JOIN albion_telemetry_agent_tokens t ON t.device_id=d.device_id "+
    "WHERE t.revoked_at IS NULL AND t.device_id IS NOT NULL "+
    "AND d.device_id IS NOT NULL AND d.device_id<>''");
  const restrict=optionalDeviceRestriction(env);
  const ids=new Set();
  for(const row of result.rows||[]){
    const id=String(row.device_id||"");
    if(id && (!restrict||restrict.has(id)))ids.add(id);
  }
  return ids;
}
async function isApprovedDevice(pool,id,env=process.env){
  if(!id)return false;
  return (await approvedDeviceIds(pool,env)).has(String(id));
}
module.exports={optionalDeviceRestriction,approvedDeviceIds,isApprovedDevice};
