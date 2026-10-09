"use strict";
const assert=require("node:assert/strict");
const manual=require("../src/guildManualProgress");
(async()=>{
  let writes=[];
  const pool={query:async (sql,args)=>{
    if(sql.startsWith("SELECT"))return {rows:[{category_code:"GVGSEASON",level:10,season_points:"180",updated_by:"admin",updated_at:"2026-10-09T05:00:00Z"}]};
    writes.push({sql,args});return {rows:[]};
  }};
  assert.equal((await manual.save(pool,{categoryCode:"GVGSEASON",level:10,seasonPoints:180},"owner")).categoryCode,"GVGSEASON");
  assert.equal(writes.length,1);
  assert.equal(writes[0].args[3],"owner");
  assert.equal((await manual.all(pool))[0].source,"admin_manual");
  await assert.rejects(()=>manual.save(pool,{categoryCode:"OTHER",level:10},"owner"),/invalid_category/);
  await assert.rejects(()=>manual.save(pool,{categoryCode:"PVE",level:-1},"owner"),/invalid_number/);
  await assert.rejects(()=>manual.save(pool,{categoryCode:"PVE",seasonPoints:"1.5"},"owner"),/invalid_number/);
  assert(manual.VALID.has("GUILD_CHALLENGE"));
  const fs=require("node:fs");
  const t=fs.readFileSync(require.resolve("../src/telemetry"),"utf8");
  const w=fs.readFileSync(require.resolve("../src/web"),"utf8");
  assert(t.includes("requireAdmin?.(req,res)"),"write endpoint requires admin callback");
  assert(w.includes("sess.isSiteAdmin"),"site permission must be admin");
  console.log("✅ Guild manual level/SP: validation, provenance and admin write gate");
})().catch(e=>{console.error(e);process.exitCode=1});
