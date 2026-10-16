"use strict";
const assert = require("node:assert/strict");
const { validateCallerRecovery, recoverPrimaryCaller, assignPrimaryCallerWeapon, CallerTransferError } = require("../src/caller-transfer");
const { canRecoverCaller, handleCallerRecovery } = require("../src/caller-recovery");

const event = { id:601,guild_id:"test-guild",caller_id:"absent",status:"open",party_list:"0,1",time_label:"15:20" };
const args = { eventId:601,guildId:"test-guild",fromUserId:"absent",toUserId:"replacement",
  actorId:"staff",username:"New caller",weapon:"MARTELO DE BATALHA",reason:"Caller desconectou e não responde" };
function interaction({ userId="staff",ownerId="owner",admin=false,manager=false,roles=[] }={}) {
  const replies=[];
  return { user:{id:userId},guildId:"test-guild",
    guild:{ownerId,members:{fetch:async id=>({id,displayName:"New caller"})}},
    member:{permissions:{has:bit=>(bit===8n&&admin)||(bit===32n&&manager)},roles:{cache:new Set(roles)}},
    options:{getUser:()=>({id:"replacement",username:"New caller",bot:false}),
      getString:key=>({arma:args.weapon,motivo:args.reason})[key]},
    replies,reply:async x=>replies.push(x),deferReply:async x=>replies.push(x),editReply:async x=>replies.push(x) };
}

(async()=>{
  for(const opts of [{userId:"owner"},{admin:true},{manager:true},{roles:["war-master"]}])
    assert(canRecoverCaller(interaction(opts),["war-master"]));
  assert.equal(canRecoverCaller(interaction(),[]),false,"missing staff role must fail closed");
  assert.equal(canRecoverCaller(interaction({userId:"absent"}),["war-master"]),false,"caller status is not staff permission");
  assert.equal(canRecoverCaller(interaction({roles:["member"]}),["war-master"]),false);
  assert.equal(canRecoverCaller({user:{id:"owner"},guild:{ownerId:"owner"}},[]),false,"DM is blocked");
  assert.equal(validateCallerRecovery(event,args).weapon,"MARTELO DE BATALHA");
  for(const [ev,patch,code] of [
    [null,{},"not_found"],[{...event,guild_id:"elsewhere"},{},"not_found"],
    [{...event,status:"closed"},{},"closed"],[{...event,status:"cancelled"},{},"closed"],
    [{...event,caller_id:"newer-owner"},{},"concurrent"],
    [event,{actorId:""},"missing_actor"],[event,{toUserId:"absent"},"same_user"],
    [event,{reason:" "},"missing_reason"],[event,{reason:"x".repeat(301)},"missing_reason"],
    [event,{weapon:"INVALID"},"invalid_weapon"],[{...event,party_list:"bad,0"},{},"missing_party"]
  ])assert.throws(()=>validateCallerRecovery(ev,{...args,...patch}),e=>e instanceof CallerTransferError&&e.code===code);

  // Exercise the actual Discord handler: unauthorized users never reach DB;
  // new caller need not have signed up, and a missing/bot member is rejected.
  let calls=0,refreshes=0,logs=0,saved;
  const deps={staffRoleIds:["war-master"],db:{recoverCaller:async input=>{
    calls++;saved=input;return {event:{...event,caller_id:"replacement"},successor:{weapon:args.weapon},previousCallerId:"absent",reason:args.reason};
  }},refreshRoster:async()=>refreshes++,logStaff:async()=>logs++};
  const denied=interaction();
  await handleCallerRecovery(denied,event,deps);
  assert.equal(calls,0);assert.equal(denied.replies[0].flags,64);
  const allowed=interaction({roles:["war-master"]});
  await handleCallerRecovery(allowed,event,deps);
  assert.equal(calls,1);assert.equal(saved.actorId,"staff");assert.equal(saved.fromUserId,"absent");
  assert.equal(saved.toUserId,"replacement");assert.equal(saved.presence,"later");
  assert.equal(refreshes,1);assert.equal(logs,1);
  assert(allowed.replies.at(-1).content.includes("PT1 vaga 1"));
  const gone=interaction({admin:true});gone.guild.members.fetch=async()=>{throw Error("unknown member");};
  await handleCallerRecovery(gone,event,deps);assert.equal(calls,1);
  const bot=interaction({admin:true});bot.options.getUser=()=>({id:"bot",bot:true});
  await handleCallerRecovery(bot,event,deps);assert.equal(calls,1);
  await handleCallerRecovery(interaction({admin:true}),{...event,guild_id:"elsewhere"},deps);
  assert.equal(calls,1,"cross-guild handler cannot mutate");
  console.log("PASS caller recovery authorization, absent/bot target, required reason and stale owner");

  const command=require("../src/commands").commandDefs().find(c=>c.name==="cta_substituir_caller");
  assert(command,"recovery command must be registered");
  assert.deepEqual(command.options.map(o=>o.name),["cta","usuario","arma","motivo"]);
  assert(command.options.every(o=>o.required));
  assert.equal(command.options.find(o=>o.name==="motivo").min_length,5);

  if(!process.env.DATABASE_URL){console.log("SKIP PostgreSQL recovery: DATABASE_URL not set");return;}
  const {Pool}=require("pg");
  // TEMP tables shadow application tables and are removed with this connection.
  const pool=new Pool({connectionString:process.env.DATABASE_URL,
    ssl:process.env.PGSSL==="disable"?false:{rejectUnauthorized:false},max:1});
  try{
    await pool.query(`CREATE TEMP TABLE cta_events
      (id BIGINT PRIMARY KEY,guild_id TEXT,caller_id TEXT,status TEXT,party_list TEXT,time_label TEXT,thread_id TEXT)`);
    await pool.query(`CREATE TEMP TABLE cta_signups
      (event_id BIGINT,user_id TEXT,username TEXT,weapon TEXT,presence TEXT,party_index INT,slot_index INT,
       manual BOOLEAN DEFAULT false,second_caller BOOLEAN DEFAULT false,ip INT,created_at TIMESTAMPTZ DEFAULT now(),
       PRIMARY KEY(event_id,user_id))`);
    await pool.query(`CREATE TEMP TABLE cta_caller_recoveries
      (id BIGSERIAL PRIMARY KEY,event_id BIGINT,guild_id TEXT,actor_id TEXT,previous_caller_id TEXT,new_caller_id TEXT,
       weapon TEXT,reason TEXT CHECK(reason <> 'force audit failure'),created_at TIMESTAMPTZ DEFAULT now())`);
    await pool.query(`INSERT INTO cta_events VALUES
      (601,'test-guild','absent','open','0,1','15:20',NULL),
      (602,'test-guild','absent','open','0,1','17:20',NULL)`);
    await pool.query(`INSERT INTO cta_signups(event_id,user_id,username,weapon,presence,party_index,slot_index,manual,second_caller) VALUES
      (601,'absent','Same name','GOLEM','later',0,0,true,false),
      (601,'alt-account','Same name','MONARCA','online',1,4,false,false),
      (602,'absent','Old caller','GOLEM','later',0,0,true,false),
      (602,'replacement','New caller','MONARCA','online',1,0,true,true)`);
    const done=await recoverPrimaryCaller(pool,args);
    assert.equal(done.event.caller_id,"replacement");
    assert.equal(done.successor.party_index,0);assert.equal(done.successor.slot_index,0);
    assert.equal(done.successor.manual,true);assert.equal(done.successor.second_caller,false);
    let rows=(await pool.query("SELECT * FROM cta_signups WHERE event_id=601")).rows;
    assert.equal(rows.length,3,"creates unsigned replacement without deleting old or alt");
    assert.equal(rows.find(x=>x.user_id==="absent").party_index,null);
    assert.equal(rows.find(x=>x.user_id==="alt-account").party_index,1);
    const audit=(await pool.query("SELECT * FROM cta_caller_recoveries WHERE event_id=601")).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].actor_id,"staff");assert.equal(audit[0].reason,args.reason);
    await assert.rejects(()=>assignPrimaryCallerWeapon(pool,{eventId:601,guildId:"test-guild",userId:"absent",weapon:"GOLEM"}),
      e=>e.code==="not_caller","old caller cannot retake the slot with a stale menu");

    // Failure to persist audit must roll back roster AND leadership.
    await assert.rejects(()=>recoverPrimaryCaller(pool,{...args,eventId:602,reason:"force audit failure"}));
    rows=(await pool.query("SELECT * FROM cta_signups WHERE event_id=602 ORDER BY user_id")).rows;
    assert.equal(rows.find(x=>x.user_id==="absent").party_index,0);
    assert.equal(rows.find(x=>x.user_id==="replacement").party_index,1);
    assert.equal((await pool.query("SELECT caller_id FROM cta_events WHERE id=602")).rows[0].caller_id,"absent");

    // Two requests holding the same expected owner: exactly one may succeed.
    const race=await Promise.allSettled([
      recoverPrimaryCaller(pool,{...args,eventId:602}),
      recoverPrimaryCaller(pool,{...args,eventId:602,toUserId:"other-staff",username:"Other"})]);
    assert.equal(race.filter(x=>x.status==="fulfilled").length,1);
    assert.equal(race.find(x=>x.status==="rejected").reason.code,"concurrent");
    rows=(await pool.query("SELECT * FROM cta_signups WHERE event_id=602")).rows;
    assert.equal(rows.filter(x=>x.party_index===0&&x.slot_index===0).length,1);
    assert.equal(rows.find(x=>x.user_id==="replacement").second_caller,false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM cta_caller_recoveries WHERE event_id=602")).rows[0].n,1);
    console.log("PASS PostgreSQL TEMP recovery: unsigned successor, same-name accounts, rollback, competing requests and revoked old leadership");
  }finally{await pool.end();}
})().catch(err=>{console.error(err);process.exitCode=1;});
