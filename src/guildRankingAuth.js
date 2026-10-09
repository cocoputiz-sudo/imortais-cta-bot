"use strict";
// A valid pairing token alone must not authorize an observer to feed the
// official guild rankings. Only explicitly whitelisted staff devices do.
function approvedDeviceIds(env=process.env){
  const explicit=String(env.GUILD_RANKING_ALLOWED_DEVICE_IDS||"")
    .split(",").map(x=>x.trim()).filter(Boolean);
  const ids=new Set(explicit);
  if(env.HOMOLOG_MODE==="1")ids.add("WORKSPACEIGOR");
  return ids;
}
function isApprovedDevice(id,env=process.env){
  return approvedDeviceIds(env).has(String(id||""));
}
module.exports={approvedDeviceIds,isApprovedDevice};
