"use strict";
const {parseGuildSeasonResponse}=require("./guildPhotonVerified");
const {approvedDeviceIds}=require("./guildRankingAuth");
// A season boundary is a positive change of the GVG season identifier in
// GetGvgSeasonContributionByActivity field 0, with validated IMORTAIS id in
// field 1. Time of first new-season observation is a conservative boundary.
// When there is no observed transition and no staff-approved start date,
// ranking remains PROVISIONAL: no claim of a verified season boundary.
function resolveEpoch(observations,{manualStartAt=null}={}){
  const accepted=(observations||[]).map(row=>{
    const payload=row.payload||{};
    const p=payload.parameters||row.parameters||{};
    const id=parseGuildSeasonResponse(p);
    const at=row.occurred_at||row.occurredAt||row.capturedAtUtc;
    const ms=Date.parse(at);
    return {id,at,ms};
  }).filter(x=>x.id!=null&&Number.isFinite(x.ms)).sort((a,b)=>a.ms-b.ms);
  const newest=accepted[accepted.length-1];
  const manualMs=manualStartAt?Date.parse(manualStartAt):NaN;
  if(!newest)return {seasonId:null,startAt:Number.isFinite(manualMs)?new Date(manualMs).toISOString():null,
    verified:Number.isFinite(manualMs),source:Number.isFinite(manualMs)?"staff_approved_start":"season_not_observed"};
  const lastOther=[...accepted].reverse().find(x=>x.id!==newest.id);
  let startAt=null,verified=false,source="initial_season_unverified";
  if(lastOther){
    const first=accepted.find(x=>x.ms>lastOther.ms&&x.id===newest.id);
    startAt=first.at;verified=true;source="season_identifier_changed";
  }
  if(Number.isFinite(manualMs)){
    if(startAt && manualMs>Date.parse(startAt)){
      // Never admit observations from a potentially older season than a
      // stricter validated boundary.
      startAt=new Date(manualMs).toISOString();
    }else if(!startAt)startAt=new Date(manualMs).toISOString();
    verified=true;source="staff_approved_start";
  }
  return {seasonId:newest.id,startAt,verified,source,lastObservedAt:newest.at};
}
async function getSeasonEpoch(pool){
  const ids=[...await approvedDeviceIds(pool)];
  const r=await pool.query(
    "SELECT occurred_at,payload FROM albion_telemetry_events "+
    "WHERE type='guild_might_probe' "+
    "AND payload->>'operationName'='GetGvgSeasonContributionByActivity' "+
    "AND payload->>'direction'='response' "+
    "AND device_id=ANY($1::text[]) "+
    "ORDER BY occurred_at DESC LIMIT 250",[ids]);
  return resolveEpoch(r.rows,{manualStartAt:process.env.GUILD_SEASON_START_AT||null});
}
function canPublishRankings(epoch,env=process.env){
  // Only QA can display provisional season data. Production must be bound
  // to a verified transition or a staff-approved start timestamp.
  return !!epoch?.verified || env.HOMOLOG_MODE==="1";
}
module.exports={resolveEpoch,getSeasonEpoch,canPublishRankings};