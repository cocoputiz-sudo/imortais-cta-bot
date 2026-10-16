"use strict";
const assert = require("node:assert/strict");
const {isPreview, validatePreview, health} = require("../src/mackna-preview");
const dt = "2026-10-16T00:00:00Z";
assert.equal(isPreview({MACKNA_PREVIEW:"1"}), true);
assert.equal(isPreview({}), false);
for (const host of ["postgres", "db", "postgres.imortais-homologacao.internal", "localhost"]) {
  assert.doesNotThrow(() => validatePreview({MACKNA_PREVIEW:"1", DATABASE_URL:`postgres://user:test@${host}:5432/testdb`}));
}
for (const host of ["railway.app", "db.example.com", "private.railway.internal.net"]) {
  assert.throws(() => validatePreview({MACKNA_PREVIEW:"1", DATABASE_URL:`postgres://user:test@${host}:5432/testdb`}), /externo/);
}
assert.throws(() => validatePreview({MACKNA_PREVIEW:"1", DISCORD_TOKEN:"example", DATABASE_URL:"postgres://u:p@postgres:5432/testdb"}), /credenciais Discord/);
assert.throws(() => validatePreview({MACKNA_PREVIEW:"1", DISCORD_CLIENT_SECRET:"example", DATABASE_URL:"postgres://u:p@postgres:5432/testdb"}), /credenciais Discord/);
assert.throws(() => validatePreview({MACKNA_PREVIEW:"1"}), /DATABASE_URL/);
assert.deepEqual(health({database:true, discord:false, preview:true, at:dt}),{ok:true,database:true,discord:false,mode:"preview",discordRequired:false,at:dt});
assert.equal(health({database:false,discord:false,preview:true,at:dt}).ok,false);
assert.deepEqual(health({database:true,discord:false,at:dt}),{ok:false,database:true,discord:false,at:dt});
assert.equal(health({database:true,discord:true,at:dt}).ok,true);
console.log("PASS: MackNa Cloud preview isolation and health");
