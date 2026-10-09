"use strict";
const assert = require("assert/strict");
process.env.PGSSL="disable";
process.env.GUILD_ID="guild-test";
const db=require("../src/db");
const telemetry=require("../src/telemetry");
async function main(){
 if(!process.env.DATABASE_URL||!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL))throw Error("Recusado fora do Postgres local");
 await db.init();
 await telemetry.initSchema(db.pool);
 await db.pool.query("TRUNCATE TABLE guild_challenge_snapshots, guild_might_snapshots, albion_telemetry_events RESTART IDENTITY CASCADE");
 const ms=Date.now()-5000;
 for(const [id,direction,at,parameters] of [
   ["req-async","request",new Date(ms).toISOString(),{"0":"PvE (Outlands and Roads)"}],
   ["res-async","response",new Date(ms+250).toISOString(),{"0":["BadMack","RagnaldoKun","ESTHER9950"],"1":[550000,450000,1086795]}]
 ]){
   await db.pool.query(
     "INSERT INTO albion_telemetry_events(event_id,device_id,type,occurred_at,player_name,payload) VALUES($1,'might-test','guild_might_probe',$2,'BadMack',$3::jsonb)",
     [id,at,JSON.stringify({direction,operationName:"GetGuildMightCategoryOverview",operationCode:333,parameters})]
   );
 }
 const first=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(first.snapshots,1);
 assert.equal(first.stored,1);
 const {rows}=await db.pool.query("SELECT id,members_complete,category_name FROM guild_might_snapshots WHERE response_event_id='res-async'");
 assert.equal(rows.length,1);
 assert.equal(rows[0].members_complete,true);
 assert.equal(rows[0].category_name,"PvE");
 const sid=rows[0].id;
 const members=await db.pool.query("SELECT player_name FROM guild_might_snapshot_members WHERE snapshot_id=$1 ORDER BY might DESC",[sid]);
 assert.deepEqual(members.rows.map(x=>x.player_name),["ESTHER9950","BadMack","RagnaldoKun"]);
 const repeat=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(repeat.stored,0,"idempotência");

 // Two observers can receive identical data with distinct event IDs.
 // Content fingerprint must keep only one materialized leaderboard per UTC day.
 for(const [id,direction,parameters] of [
   ["req-same-content","request",{"0":"PvE (Outlands and Roads)"}],
   ["res-same-content","response",{"0":["BadMack","RagnaldoKun","ESTHER9950"],"1":[550000,450000,1086795]}]
 ]){
   await db.pool.query(
     "INSERT INTO albion_telemetry_events(event_id,device_id,type,occurred_at,player_name,payload) "+
     "VALUES($1,'might-other-device','guild_might_probe',now(),'Observer2',$2::jsonb)",
     [id,JSON.stringify({direction,operationName:"GetGuildMightCategoryOverview",operationCode:333,parameters})]
   );
 }
 const crossDevice=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(crossDevice.stored,0,"identical content from another device must not create a second Might snapshot");
 const countSameContent=await db.pool.query("SELECT count(*)::int AS n FROM guild_might_snapshots");
 assert.equal(countSameContent.rows[0].n,1,"one content-fingerprint per day");

 await db.pool.query("UPDATE guild_might_snapshots SET members_complete=false WHERE id=$1",[sid]);
 await db.pool.query("DELETE FROM guild_might_snapshot_members WHERE snapshot_id=$1 AND player_key='badmack'",[sid]);
 const repaired=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(repaired.stored,1);
 const count=await db.pool.query("SELECT count(*)::int AS n FROM guild_might_snapshot_members WHERE snapshot_id=$1",[sid]);
 assert.equal(count.rows[0].n,3);
 const now=Date.now();
 const dashboard=await telemetry.getGuildMightDashboard({days:1});
 assert(Date.now()-now<4000,"painel não pode aguardar backfill");
 assert.equal(dashboard.meta.rawProbes3d,2);
 assert.equal(dashboard.meta.categoryCount,1);
 assert.equal(dashboard.meta.playerCount,3);
 assert.equal(dashboard.ranking[0].player,"ESTHER9950");
 // Guild Challenge is a separate points ranking. Its snapshot must survive even
 // when the batch includes no new Guild Might snapshots.
 await db.pool.query(
   "INSERT INTO albion_telemetry_events(event_id,device_id,type,occurred_at,player_name,payload) " +
   "VALUES('challenge-res-1','challenge-test','guild_might_probe',now(),'BadMack',$1::jsonb)",
   [JSON.stringify({direction:"response",operationName:"GetGuildChallengePoints",parameters:{
     "3":482,"5":["GiganteCarrara","ESTHER9950","JnK1"],"6":[5905587,5179919,4996374]
   }})]
 );
 const challengeBatch=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(challengeBatch.challengeStored,1,"Challenge must store independently of Might");
 const challengeStore=require("../src/guildChallengeStore");
 const challenge=await challengeStore.getDashboard(db.pool,{days:1});
 assert.equal(challenge.available,true);
 assert.equal(challenge.members.length,3);
 assert.deepEqual(challenge.members.map(m=>m.player),["GiganteCarrara","ESTHER9950","JnK1"]);
 assert.equal(challenge.members[0].points,5905587);
 assert.equal(challenge.verified,true,"real Photon field positions validated");
 assert.equal(challenge.complete,false,"a single page must never be presented as complete");
 assert.equal(challenge.expectedMembers,482);
 assert.equal(challenge.observedMembers,3);
 await db.pool.query(
   "INSERT INTO albion_telemetry_events(event_id,device_id,type,occurred_at,player_name,payload) "+
   "VALUES('challenge-res-19','challenge-test','guild_might_probe',now(),'BadMack',$1::jsonb)",
   [JSON.stringify({direction:"response",operationName:"GetGuildChallengePoints",parameters:{
     "3":482,"4":19,"5":["HYPNOSBR01","GoldVex"],"6":[1769816,1734612]
   }})]
 );
 const pageBatch=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(pageBatch.challengeStored,1,"only new page should be stored");
 const combinedChallenge=await challengeStore.getDashboard(db.pool,{days:1});
 assert.equal(combinedChallenge.members.length,5,"two pages must be merged");
 assert.deepEqual(combinedChallenge.members.map(m=>m.rank),[1,2,3,20,21]);
 assert.equal(combinedChallenge.complete,false);
 // Identical Challenge page observed again with a distinct response event ID.
 await db.pool.query(
   "INSERT INTO albion_telemetry_events(event_id,device_id,type,occurred_at,player_name,payload) "+
   "VALUES('challenge-page-duplicate','different-device','guild_might_probe',now(),'Observer2',$1::jsonb)",
   [JSON.stringify({direction:"response",operationName:"GetGuildChallengePoints",parameters:{
     "3":482,"4":19,"5":["HYPNOSBR01","GoldVex"],"6":[1769816,1734612]
   }})]
 );
 const contentReplay=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(contentReplay.challengeStored,0,"identical content from another device must not duplicate Challenge page");
 const challengePageCount=await db.pool.query("SELECT count(*)::int AS n FROM guild_challenge_snapshots");
 assert.equal(challengePageCount.rows[0].n,2,"two distinct page offsets, no duplicates");

 const challengeReplay=await telemetry.materializeGuildMightRecent({minutes:10,limit:100});
 assert.equal(challengeReplay.challengeStored,0,"Challenge snapshots idempotent");
 console.log("✅ Guild Challenge: persistence, separation, rank and idempotency");

 console.log("✅ Guild Might: lote atômico, recuperação, idempotência e painel responsivo");
}
main().then(()=>db.pool.end()).catch(async e=>{
 console.error("❌ Guild Might:",e);
 try{await db.pool.end();}catch(_){}
 process.exitCode=1;
});