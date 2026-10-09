"use strict";

// Exact layout grounded in the 2026-10-09 Albion Photon dumps.
// "5" = player names, "6" = Challenge Points, "4" = 0-based page offset
// (omitted on first page), "3" = number of ranks reported by the game.
// Do not interpret arbitrary scalars as guild level/Season Points.
const {parseChallengeResponse,assemblePages,validImortaisGuild}=require("./guildPhotonVerified");

function extractChallengeSnapshots(rows) {
  const pages=[];
  for(const row of rows||[]){
    const payload=row.payload||{};
    if(payload.operationName!=="GetGuildChallengePoints" ||
      String(payload.direction||"").toLowerCase()!=="response")continue;
    if(!validImortaisGuild(payload.parameters,"GetGuildChallengePoints"))continue;
    const decoded=parseChallengeResponse(payload.parameters);
    if(!decoded||!decoded.members.length)continue;
    pages.push({
      ...decoded,
      responseEventId:row.event_id||row.eventId||null,
      observer:row.player_name||row.playerName||null,
      deviceId:row.device_id||row.deviceId||null,
      capturedAt:row.occurred_at||row.occurredAt||null,
      confidence:1,
      layout:{namesPath:"5",pointsPath:"6",offsetPath:"4",totalMembersPath:"3"}
    });
  }
  return pages.sort((a,b)=>new Date(b.capturedAt||0)-new Date(a.capturedAt||0));
}

module.exports={extractChallengeSnapshots,assemblePages};
