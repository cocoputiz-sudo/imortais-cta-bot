"use strict";
const crypto=require("node:crypto");
const {extractChallengeSnapshots,assemblePages}=require("./guildChallenge");
const {getSeasonEpoch,canPublishRankings}=require("./guildSeason");
const {approvedDeviceIds}=require("./guildRankingAuth");
const {IMORTAIS_GUILD_ID_BASE64}=require("./guildPhotonVerified");

async function initSchema(pool){
  await pool.query("CREATE TABLE IF NOT EXISTS guild_challenge_snapshots ("+
    "id BIGSERIAL PRIMARY KEY,response_event_id TEXT UNIQUE NOT NULL,"+
    "device_id TEXT,observer TEXT,confidence DOUBLE PRECISION NOT NULL,"+
    "captured_at TIMESTAMPTZ NOT NULL,layout JSONB NOT NULL DEFAULT '{}'::jsonb,"+
    "members_complete BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("ALTER TABLE guild_challenge_snapshots ADD COLUMN IF NOT EXISTS page_offset INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE guild_challenge_snapshots ADD COLUMN IF NOT EXISTS total_members INTEGER");
  await pool.query("ALTER TABLE guild_challenge_snapshots ADD COLUMN IF NOT EXISTS snapshot_marker TEXT");
  await pool.query("ALTER TABLE guild_challenge_snapshots ADD COLUMN IF NOT EXISTS guild_total_points BIGINT");
  await pool.query("ALTER TABLE guild_challenge_snapshots ADD COLUMN IF NOT EXISTS content_hash TEXT");
  await pool.query("ALTER TABLE guild_challenge_snapshots ADD COLUMN IF NOT EXISTS capture_day DATE");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_challenge_content_dedup ON guild_challenge_snapshots(content_hash,capture_day,page_offset) WHERE content_hash IS NOT NULL AND capture_day IS NOT NULL");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_guild_challenge_snapshot_time ON guild_challenge_snapshots(captured_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_guild_challenge_snapshot_page ON guild_challenge_snapshots(page_offset,captured_at DESC)");
  await pool.query("CREATE TABLE IF NOT EXISTS guild_challenge_snapshot_members ("+
    "snapshot_id BIGINT NOT NULL REFERENCES guild_challenge_snapshots(id) ON DELETE CASCADE,"+
    "player_key TEXT NOT NULL,player_name TEXT NOT NULL,points BIGINT NOT NULL,"+
    "PRIMARY KEY(snapshot_id,player_key))");
  await pool.query("ALTER TABLE guild_challenge_snapshot_members ADD COLUMN IF NOT EXISTS member_rank INTEGER");
}

async function materialize(pool,rows){
  const snapshots=extractChallengeSnapshots(rows);
  if(!snapshots.length)return {candidates:0,stored:0};
  const ids=snapshots.map(s=>s.responseEventId).filter(Boolean);
  if(!ids.length)return {candidates:snapshots.length,stored:0};
  const old=await pool.query("SELECT response_event_id FROM guild_challenge_snapshots WHERE response_event_id=ANY($1::text[]) AND members_complete=true",[ids]);
  const complete=new Set(old.rows.map(x=>x.response_event_id));
  let stored=0;
  for(const snap of snapshots){
    if(!snap.responseEventId||complete.has(snap.responseEventId))continue;
    const memberMap=new Map();
    for(const member of snap.members){
      const key=member.player.toLowerCase();
      memberMap.set(key,{player_key:key,player_name:member.player,
        points:member.points,member_rank:member.rank});
    }
    if(!memberMap.size)continue;
    const contentHash=crypto.createHash("sha256").update(JSON.stringify([
      snap.deviceId,snap.snapshotMarker,snap.guildTotalPoints,snap.pageOffset,snap.totalMembers,snap.members.map(m=>[m.player.toLowerCase(),m.points])
    ])).digest("hex");
    const capturedDay=new Date(snap.capturedAt).toISOString().slice(0,10);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const sameContent=await client.query(
        "SELECT id FROM guild_challenge_snapshots WHERE content_hash=$1 AND capture_day=$2::date AND page_offset=$3 AND members_complete=true LIMIT 1",
        [contentHash,capturedDay,snap.pageOffset]
      );
      if(sameContent.rows.length){
        await client.query("ROLLBACK");
        continue;
      }
      const result=await client.query(
        "INSERT INTO guild_challenge_snapshots(response_event_id,device_id,observer,confidence,captured_at,layout,page_offset,total_members,content_hash,capture_day,snapshot_marker,guild_total_points,members_complete) "+
        "VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::date,$11,$12,false) "+
        "ON CONFLICT(response_event_id) DO UPDATE SET "+
        "confidence=GREATEST(guild_challenge_snapshots.confidence,EXCLUDED.confidence),"+
        "layout=EXCLUDED.layout,page_offset=EXCLUDED.page_offset,total_members=EXCLUDED.total_members,"+
        "content_hash=EXCLUDED.content_hash,capture_day=EXCLUDED.capture_day,"+
        "snapshot_marker=EXCLUDED.snapshot_marker,guild_total_points=EXCLUDED.guild_total_points,"+
        "members_complete=false RETURNING id",
        [snap.responseEventId,snap.deviceId,snap.observer,snap.confidence,snap.capturedAt,
          JSON.stringify(snap.layout),snap.pageOffset,snap.totalMembers,contentHash,capturedDay,snap.snapshotMarker,snap.guildTotalPoints]
      );
      const id=result.rows[0].id;
      await client.query("DELETE FROM guild_challenge_snapshot_members WHERE snapshot_id=$1",[id]);
      await client.query(
        "INSERT INTO guild_challenge_snapshot_members(snapshot_id,player_key,player_name,points,member_rank) "+
        "SELECT $1::bigint,x.player_key,x.player_name,x.points,x.member_rank FROM jsonb_to_recordset($2::jsonb) "+
        "AS x(player_key text,player_name text,points bigint,member_rank integer)",
        [id,JSON.stringify([...memberMap.values()])]
      );
      await client.query("UPDATE guild_challenge_snapshots SET members_complete=true WHERE id=$1",[id]);
      await client.query("COMMIT");
      stored++;
    }catch(e){
      await client.query("ROLLBACK").catch(()=>{});
      if(e.code==="23505"&&e.constraint==="idx_guild_challenge_content_dedup")continue;
      throw e;
    }finally{client.release();}
  }
  return {candidates:snapshots.length,stored};
}

async function getDashboard(pool,{days=90}={}){
  const safeDays=Math.max(1,Math.min(365,Number(days)||90));
  const epoch=await getSeasonEpoch(pool);
  if(!canPublishRankings(epoch))return {available:false,verified:false,season:epoch,
    members:[],totalPoints:null,observedPoints:0,observedMembers:0,expectedMembers:null,
    complete:false,meta:{error:"season_boundary_not_verified"}};
  const devices=[...await approvedDeviceIds(pool)];
  const expectedGuild=IMORTAIS_GUILD_ID_BASE64;
  const [latest,stats,probes]=await Promise.all([
    pool.query("SELECT id,response_event_id,observer,device_id,captured_at,total_members,snapshot_marker,guild_total_points FROM guild_challenge_snapshots "+
      "WHERE members_complete=true AND captured_at >= COALESCE($2::timestamptz,now()-($1::text || ' days')::interval) "+
      "AND total_members IS NOT NULL AND device_id=ANY($3::text[]) "+
      "AND (layout->>'guildVerified'='true' OR EXISTS(SELECT 1 FROM albion_telemetry_events e WHERE e.event_id=guild_challenge_snapshots.response_event_id "+
      "AND e.payload#>>'{parameters,0,kind}'='bytes' AND e.payload#>>'{parameters,0,length}'='16' "+
      "AND COALESCE(e.payload#>>'{parameters,0,base64}',e.payload#>>'{parameters,0,previewBase64}')=$4)) "+
      "ORDER BY captured_at DESC,id DESC LIMIT 1",[safeDays,epoch.startAt,devices,expectedGuild]),
    pool.query("SELECT COUNT(*)::int AS n,MAX(captured_at) AS newest FROM guild_challenge_snapshots WHERE members_complete=true"),
    pool.query("SELECT COUNT(*)::int AS total,"+
      "COUNT(*) FILTER(WHERE lower(COALESCE(payload->>'direction','response'))='response')::int AS responses,"+
      "MAX(occurred_at) AS newest FROM albion_telemetry_events "+
      "WHERE type='guild_might_probe' AND payload->>'operationName'='GetGuildChallengePoints' "+
      "AND occurred_at >= now() - interval '3 days'")
  ]);
  const top=latest.rows[0]||null;
  let combined={members:[],totalMembers:null,observedMembers:0,complete:false,missingRanges:[],pages:0};
  if(top){
    // Always pick the most recent page at each offset, not simply the latest 16 players.
    // A two-hour window avoids mixing historical seasons; report incomplete coverage explicitly.
    const selected=await pool.query(
      "SELECT id,response_event_id,device_id,page_offset,total_members,captured_at,observer,snapshot_marker,guild_total_points "+
      "FROM guild_challenge_snapshots WHERE members_complete=true AND total_members IS NOT NULL "+
      "AND captured_at BETWEEN COALESCE($3::timestamptz,now()-($2::text || ' days')::interval) AND $1::timestamptz "+
      "AND device_id=ANY($4::text[]) "+
      "AND (layout->>'guildVerified'='true' OR EXISTS(SELECT 1 FROM albion_telemetry_events e WHERE e.event_id=guild_challenge_snapshots.response_event_id "+
      "AND e.payload#>>'{parameters,0,kind}'='bytes' AND e.payload#>>'{parameters,0,length}'='16' "+
      "AND COALESCE(e.payload#>>'{parameters,0,base64}',e.payload#>>'{parameters,0,previewBase64}')=$5)) "+
      "ORDER BY captured_at DESC,id DESC",
      [top.captured_at,safeDays,epoch.startAt,devices,expectedGuild]
    );
    const ids=selected.rows.map(x=>x.id);
    let members=[];
    if(ids.length){
      const result=await pool.query("SELECT snapshot_id,player_name,points,member_rank "+
        "FROM guild_challenge_snapshot_members WHERE snapshot_id=ANY($1::bigint[]) "+
        "ORDER BY snapshot_id,member_rank",[ids]);
      members=result.rows;
    }
    const byId=new Map();
    for(const m of members){
      const id=String(m.snapshot_id);
      if(!byId.has(id))byId.set(id,[]);
      byId.get(id).push({player:m.player_name,points:Number(m.points)||0,
        rank:m.member_rank==null?null:Number(m.member_rank)});
    }
    const pages=selected.rows.map(s=>({
      pageOffset:s.page_offset,totalMembers:Number(s.total_members),
      capturedAt:s.captured_at,responseEventId:s.response_event_id,deviceId:s.device_id,observer:s.observer,snapshotMarker:s.snapshot_marker,guildTotalPoints:s.guild_total_points===null?null:Number(s.guild_total_points),members:byId.get(String(s.id))||[]
    }));
    combined=assemblePages(pages,{seasonStartAt:epoch.startAt});
  }
  return {
    available:!!top,verified:!!top,source:"GetGuildChallengePoints",
    capturedAt:top?.captured_at||null,observer:top?.observer||null,
    confidence:top?1:null,
    members:combined.members,totalPoints:combined.guildTotalPoints??null,
    observedPoints:combined.members.reduce((a,m)=>a+m.points,0),
    difference:combined.guildTotalPoints==null?null:combined.observedPoints-Number(combined.guildTotalPoints),
    oldestMemberAt:combined.oldestMemberAt||null,lastCompleteAt:combined.lastCompleteAt||null,
    coverage:combined.coverage||null,
    season:epoch,
    snapshotMarker:combined.snapshotMarker||null,
    complete:combined.complete,expectedMembers:combined.totalMembers,
    historicalObservedMembers:combined.historicalObservedMembers||0,
    historicalMembers:combined.historicalMembers||[],
    recentWindowStart:combined.recentWindowStart||null,
    observedMembers:combined.observedMembers,missingRanges:combined.missingRanges,
    meta:{
      days:safeDays,storedSnapshots:Number(stats.rows[0]?.n)||0,
      newestStoredAt:stats.rows[0]?.newest||null,
      rawProbes3d:Number(probes.rows[0]?.total)||0,
      rawResponses3d:Number(probes.rows[0]?.responses)||0,
      rawNewestAt:probes.rows[0]?.newest||null,
      pageCount:combined.pages,historicalPageCount:combined.historicalPages,
      level:null,seasonPoints:null,
      note:"Ranking consolidado da temporada: valores antigos continuam na soma, com data individual. Reconciliacao exata depende de paginas do mesmo marcador. Niveis e SP nao presentes no Photon."
    }
  };
}
module.exports={initSchema,materialize,getDashboard};
