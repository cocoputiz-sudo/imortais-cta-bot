"use strict";
const {approvedDeviceIds} = require("./guildRankingAuth");

// Counters measure raw Guild Might probes received by HTTP, not valid snapshots.
// An active pairing is evaluated NOW so today's probes become eligible after
// pairing the same device and re-running materialization.
async function recentGuildMightIngest(pool, env = process.env) {
  const [{rows}, pairedRows, approved] = await Promise.all([
    pool.query(`
      SELECT device_id, COUNT(*)::int AS event_count,
             COUNT(*) FILTER (WHERE payload->>'direction'='response')::int AS response_count,
             MAX(received_at) AS last_received_at
        FROM albion_telemetry_events
       WHERE type='guild_might_probe'
         AND received_at >= now() - interval '24 hours'
       GROUP BY device_id
       ORDER BY event_count DESC, device_id
    `),
    pool.query(`
      SELECT DISTINCT d.device_id
        FROM albion_telemetry_devices d
        JOIN albion_telemetry_agent_tokens t ON t.device_id=d.device_id
       WHERE t.revoked_at IS NULL AND t.device_id IS NOT NULL AND t.device_id<>''
    `),
    approvedDeviceIds(pool, env)
  ]);
  return summarizeRecentGuildMight(rows, pairedRows.rows, approved);
}

function summarizeRecentGuildMight(rows, tokenRows, approvedDeviceIdsSet) {
  const paired = new Set((tokenRows || []).map(x=>String(x.device_id)));
  const approved = new Set(approvedDeviceIdsSet || []);
  let totalEvents=0, excludedNoPairing=0, excludedByRestriction=0;
  const devices=(rows||[]).map(r=>{
    const id=String(r.device_id||"");
    const eventCount=Number(r.event_count)||0;
    const pairingActive=paired.has(id);
    const rankingEligible=approved.has(id);
    totalEvents+=eventCount;
    if(!pairingActive)excludedNoPairing+=eventCount;
    else if(!rankingEligible)excludedByRestriction+=eventCount;
    return {
      deviceId:id, eventCount, responseCount:Number(r.response_count)||0,
      lastReceivedAt:r.last_received_at||null, pairingActive, rankingEligible,
      status:!pairingActive?"sem_pareamento":!rankingEligible?"restrito":"elegivel"
    };
  });
  return {
    windowHours:24,totalEvents,excludedNoPairing,excludedByRestriction,
    eligibleEvents:totalEvents-excludedNoPairing-excludedByRestriction,
    devices,
    note:"Contagem de eventos brutos recebidos; elegibilidade não significa que o evento gerou um snapshot. O método de autenticação utilizado no envio não é gravado por evento."
  };
}

module.exports={recentGuildMightIngest,summarizeRecentGuildMight};
