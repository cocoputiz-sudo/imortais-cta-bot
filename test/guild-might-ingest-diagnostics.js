"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {recentGuildMightIngest,summarizeRecentGuildMight}=require("../src/guildMightIngestDiagnostics");

(async()=>{
  const rows=[
    {device_id:"WORKSPACEIGOR",event_count:"876",response_count:"438",last_received_at:"2026-10-10T13:04:00Z"},
    {device_id:"PAREADO",event_count:"10",response_count:"5",last_received_at:"2026-10-10T13:05:00Z"},
    {device_id:"RESTRITO",event_count:"3",response_count:"2",last_received_at:"2026-10-10T13:06:00Z"}
  ];
  const tokens=[{device_id:"PAREADO"},{device_id:"RESTRITO"}];
  const pool={async query(sql){
    if(sql.includes("COUNT(*) FILTER")){
      assert(sql.includes("received_at >= now() - interval '24 hours'"),
        "received_at, not occurred_at, defines the last 24h");
      assert(sql.includes("type='guild_might_probe'"),"Might probes only");
      return {rows};
    }
    if(sql.includes("SELECT DISTINCT d.device_id")){
      assert(sql.includes("revoked_at IS NULL"),"revoked tokens cannot authorize rankings");
      return {rows:tokens};
    }
    throw new Error("unexpected SQL: "+sql);
  }};
  const summary=await recentGuildMightIngest(pool,{GUILD_RANKING_ALLOWED_DEVICE_IDS:"PAREADO"});
  assert.equal(summary.totalEvents,889);
  assert.equal(summary.excludedNoPairing,876);
  assert.equal(summary.excludedByRestriction,3);
  assert.equal(summary.eligibleEvents,10);
  assert.deepEqual(summary.devices.map(x=>x.status),["sem_pareamento","elegivel","restrito"]);
  assert.equal(summary.devices[0].responseCount,438);
  assert(!JSON.stringify(summary).includes("token_hash"),"never return credentials");
  tokens.push({device_id:"WORKSPACEIGOR"});
  const afterPair=await recentGuildMightIngest(pool,{GUILD_RANKING_ALLOWED_DEVICE_IDS:"WORKSPACEIGOR,PAREADO"});
  assert.equal(afterPair.excludedNoPairing,0,"same device becomes eligible after pairing");
  assert.equal(afterPair.eligibleEvents,886,"past raw probes remain eligible");
  assert.equal(summarizeRecentGuildMight([],[],new Set()).totalEvents,0);

  const code=fs.readFileSync(require.resolve("../src/telemetry"),"utf8");
  assert(code.includes('app.get("/api/telemetry/guild-might-ingest-status"'),
    "admin diagnostics endpoint must exist");
  assert(code.includes("const admin=requireAdmin?.(req,res);"),
    "admin routes must retain explicit site-admin authentication");
  console.log("Guild Might 24h ingest diagnostics: paired, unpaired, restricted, backfill visibility OK");
})().catch(e=>{console.error(e);process.exitCode=1;});
