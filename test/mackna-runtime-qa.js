"use strict";

// Run only in a disposable MackNa QA service. Never point this runner at the preview DB.
const assert = require("node:assert/strict");
const http = require("node:http");
const vm = require("node:vm");
const {spawnSync} = require("node:child_process");
const {performance} = require("node:perf_hooks");

const TARGET = "http://bot-preview.imortais-homologacao.internal:3000";
const report = {runtime: process.version, arch: process.arch, started: new Date().toISOString(),
  state: "running", checks: [], suites: []};

function safety() {
  assert.equal(process.env.MACKNA_QA_DISPOSABLE, "1", "explicit disposable QA flag required");
  assert.equal(process.env.MACKNA_PREVIEW, "1");
  assert.equal(process.env.GUILD_ID, "guild-test");
  assert(!process.env.DISCORD_TOKEN && !process.env.DISCORD_CLIENT_SECRET, "Discord secrets forbidden");
  assert.equal(new URL(process.env.DATABASE_URL).hostname,
    "postgres-qa.imortais-homologacao.internal", "QA must use its own disposable PostgreSQL");
}
async function check(name, fn) {
  try { await fn(); report.checks.push({name, ok:true}); console.log("QA_CHECK_PASS " + name); }
  catch (e) { report.checks.push({name, ok:false, error:e.message}); console.error("QA_CHECK_FAIL " + name + ": " + e.message); }
}
async function request(path, options = {}) {
  const response = await fetch(TARGET + path, {...options, redirect:"manual",
    signal:AbortSignal.timeout(10000)});
  return {status:response.status, headers:response.headers, text:await response.text()};
}
async function smoke() {
  await check("live health: database ready, Discord off", async () => {
    const r=await request("/api/health"); assert.equal(r.status,200);
    const h=JSON.parse(r.text);
    assert.equal(h.ok,true); assert.equal(h.database,true); assert.equal(h.discord,false);
    assert.equal(h.mode,"preview"); assert.equal(h.discordRequired,false);
  });
  await check("War Room HTML and browser script syntax", async () => {
    const r=await request("/"); assert.equal(r.status,200);
    assert.match(r.headers.get("content-type"),/text\/html/);
    assert.match(r.text,/CTA War Room/);
    const script=/<script>([\s\S]*?)<\/script>/.exec(r.text);
    assert(script,"browser script required"); new vm.Script(script[1]);
    assert.match(r.text,/id="mobile-nav"/);
  });
  await check("OAuth login blocked", async () => {
    const r=await request("/auth/login"); assert.equal(r.status,503);
    assert.match(r.text,/homologa.*sem login Discord/i); assert(!r.headers.get("location"));
  });
  await check("invalid OAuth callback rejected", async () => {
    const r=await request("/auth/callback?code=qa-invalid&state=qa-invalid");
    assert.equal(r.status,400); assert(!r.headers.get("set-cookie"));
  });
  await check("anonymous identity", async () => {
    const r=await request("/auth/me"); assert.equal(r.status,200);
    assert.deepEqual(JSON.parse(r.text),{logged:false});
  });
  const gets=["/api/events","/api/roster?event=0","/api/contributors/weekly",
    "/api/contributors/settings","/api/contributors/billing","/api/contributors/billing/search",
    "/api/me/stats","/api/scout"];
  const posts=["/api/guild-roster/analyze","/api/contributors/roster/preview",
    "/api/contributors/roster/confirm","/api/contributors/assignment",
    "/api/contributors/bank-import","/api/contributors/settings",
    "/api/contributors/billing/approve","/api/contributors/billing/link-close",
    "/api/contributors/billing/writeoff","/api/contributors/billing/prior",
    "/api/contributors/billing/settings","/api/contributors/billing/send",
    "/api/cta/open","/api/move"];
  for(const path of gets) await check("anonymous GET denied " + path,async()=>{
    assert.equal((await request(path)).status,401);
  });
  for(const path of posts) await check("anonymous POST denied " + path,async()=>{
    const r=await request(path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(r.status,401);
  });
  await check("forged session denied",async()=>{
    const r=await request("/api/contributors/billing",{headers:{Cookie:"sid=qa-forged.invalid"}});
    assert.equal(r.status,401);
  });
  await check("50 health requests with concurrency 5",async()=>{
    const times=[];
    for(let i=0;i<10;i++) await Promise.all(Array.from({length:5},async()=>{
      const start=performance.now(),r=await request("/api/health");
      assert.equal(r.status,200); assert.equal(JSON.parse(r.text).discord,false);
      times.push(performance.now()-start);
    }));
    times.sort((a,b)=>a-b);
    report.healthSample={requests:times.length,concurrency:5,p50ms:Math.round(times[24]),
      p95ms:Math.round(times[47]),maxMs:Math.round(times[49])};
  });
}
function suites() {
  const extra=["test/contributor-billing.js","test/guild-ranking-season.js",
    "test/guild-ranking-auth.js","test/guild-might-sweep.js","test/guild-legacy-repair.js",
    "test/guild-might-worker.js","test/guild-photon-capture.js"];
  const commands=[["node",["test/mackna-preview.js"]],["npm",["test"]],
    ...extra.map(path=>["node",[path]])];
  for(const [command,args] of commands) {
    const label=command+" "+args.join(" ");
    console.log("QA_SUITE_START "+label);
    const start=performance.now(),r=spawnSync(command,args,{
      cwd:require("node:path").resolve(__dirname,".."),
      env:process.env,encoding:"utf8",timeout:180000,maxBuffer:16*1024*1024
    });
    const result={name:label,ok:r.status===0&&!r.error,durationMs:Math.round(performance.now()-start)};
    if(!result.ok) result.error=r.error?.message||("exit "+r.status);
    report.suites.push(result);
    // Retain useful details while keeping MackNa logs bounded.
    console.log((r.stdout||"").slice(-16000));
    if(r.stderr)console.error(r.stderr.slice(-8000));
    console.log((result.ok?"QA_SUITE_PASS ":"QA_SUITE_FAIL ")+label);
  }
}
async function main() {
  safety();
  console.log("QA_ISOLATION_OK disposable database; no Discord credentials");
  await smoke();
  suites();
  report.state=report.checks.every(x=>x.ok)&&report.suites.every(x=>x.ok)?"passed":"failed";
  report.finished=new Date().toISOString();
  console.log("QA_SUMMARY "+JSON.stringify(report));
}
if(require.main===module) {
  safety();
  http.createServer((req,res)=>{
    if(req.url==="/healthz"){res.writeHead(200);res.end("QA runner available");return;}
    res.writeHead(report.state==="passed"?200:503,{"Content-Type":"application/json"});
    res.end(JSON.stringify(report));
  }).listen(3000,"0.0.0.0");
  main().catch(e=>{
    report.state="failed";report.error=e.message;
    console.error("QA_FATAL "+e.stack);
  });
}
module.exports={safety,report};
