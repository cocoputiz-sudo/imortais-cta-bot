"use strict";
// Deliberately imports the database layer only, never index/web/Discord.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
let db;
async function main() {
  assert.equal(Number(process.versions.node.split(".")[0]), 22);
  assert.ok(!process.env.DISCORD_TOKEN && !process.env.DISCORD_CLIENT_SECRET);
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  assert.match(input.database, /^imortais_rehearsal_[0-9]{14}_[0-9a-f]{6}$/);
  const url = new URL(input.database_url);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "postgres18.imortais-producao.internal");
  assert.equal(url.port, "5432");
  assert.equal(url.username, "imortais_app");
  assert.equal(url.pathname, "/" + input.database);
  process.env.DATABASE_URL = input.database_url;
  process.env.PGSSL = "disable";
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "discord.js" || /(?:^|\/)index\.js$/.test(request) || /(?:^|\/)web(?:\.js)?$/.test(request)) {
      throw new Error("Module outside database rehearsal refused");
    }
    return load.call(this, request, parent, isMain);
  };
  db = require("./src/db");
  const q = async (sql, values) => (await db.pool.query(sql, values)).rows;
  const [identity] = await q(`SELECT current_database() AS database, current_user AS role,
    rolsuper, rolcreatedb, rolcreaterole, current_setting('server_version_num')::int/10000 AS major
    FROM pg_roles WHERE rolname=current_user`);
  assert.equal(identity.database, input.database);
  assert.equal(identity.role, "imortais_app");
  assert.equal(identity.major, 18);
  assert.ok(!identity.rolsuper && !identity.rolcreatedb && !identity.rolcreaterole);
  const counts = async () => {
    const [exists] = await q("SELECT to_regclass('public.cta_events') IS NOT NULL AS present");
    return exists.present ? Number((await q("SELECT count(*) AS n FROM public.cta_events"))[0].n) : 0;
  };
  const before = await counts();
  await db.init();
  await db.init();
  assert.equal(await counts(), before);
  const [permissions] = await q(`SELECT
    count(*) FILTER (WHERE c.relkind IN ('r','p'))::int AS tables,
    count(*) FILTER (WHERE c.relkind='S')::int AS sequences,
    count(*) FILTER (WHERE pg_get_userbyid(c.relowner)<>current_user)::int AS foreign_owners,
    count(*) FILTER (WHERE c.relkind IN ('r','p') AND NOT
      (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT') AND
       has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')))::int AS denied_tables,
    count(*) FILTER (WHERE c.relkind='S' AND NOT
      (has_sequence_privilege(c.oid,'USAGE') AND has_sequence_privilege(c.oid,'SELECT') AND
       has_sequence_privilege(c.oid,'UPDATE')))::int AS denied_sequences
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S')`);
  assert.equal(permissions.foreign_owners, 0);
  assert.equal(permissions.denied_tables, 0);
  assert.equal(permissions.denied_sequences, 0);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE public.imortais_runtime_permission_probe(id bigserial PRIMARY KEY, note text)");
    await client.query("ALTER TABLE public.imortais_runtime_permission_probe ADD COLUMN checked boolean DEFAULT false");
    await client.query("INSERT INTO public.imortais_runtime_permission_probe(note) VALUES ('probe')");
    assert.equal((await client.query("UPDATE public.imortais_runtime_permission_probe SET checked=true WHERE note='probe'")).rowCount, 1);
    assert.equal((await client.query("DELETE FROM public.imortais_runtime_permission_probe WHERE checked=true")).rowCount, 1);
    // Exercise the restored CTA table, defaults, sequence and update/delete grants.
    const {rows:[cta]} = await client.query(`INSERT INTO public.cta_events
      (guild_id,channel_id,caller_id,time_label) VALUES ($1,$2,$3,'isolated-runtime-probe') RETURNING id`,
      ["683411304408416285", "000000000000000001", "000000000000000002"]);
    assert.equal((await client.query("UPDATE public.cta_events SET time_label='probe-updated' WHERE id=$1",[cta.id])).rowCount, 1);
    assert.equal((await client.query("DELETE FROM public.cta_events WHERE id=$1",[cta.id])).rowCount, 1);
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  assert.equal(await counts(), before);
  assert.equal((await q("SELECT to_regclass('public.imortais_runtime_permission_probe') IS NULL AS absent"))[0].absent, true);
  assert.ok(!Object.keys(require.cache).some(p => /\/discord\.js\//.test(p)));
  console.log(JSON.stringify({status:"ok",node:process.versions.node,database:input.database,
    role:identity.role,permissions,ctas:before,db_init_runs:2,crud_rollback:true,bot_started:false,
    discord_module_loaded:false,production_secrets_received:false}));
}
main().catch(error => {
  console.error("RUNTIME_PROBE_ERROR: " + (error.code || error.name || "Error"));
  process.exitCode=1;
}).finally(async () => {if (db) await db.pool.end();});
