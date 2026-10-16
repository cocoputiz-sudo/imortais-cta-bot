"use strict";
const assert=require("node:assert/strict");
const {validateConfig,PRODUCTION_GUILD,PRODUCTION_CLIENT}=require("../scripts/mackna-discord-staging-preflight.cjs");
const base={MACKNA_DISCORD_STAGING:"1",MACKNA_PREVIEW:"0",MACKNA_PROJECT_NAME:"imortais-discord-homologacao",
 DISCORD_TOKEN:"synthetic-test-token",DISCORD_CLIENT_SECRET:"synthetic-test-secret",
 DATABASE_URL:"postgresql://qa:qa@postgres.imortais-discord-homologacao.internal:5432/app",PGSSL:"disable",
 OAUTH_REDIRECT:"https://discord-homolog.example.test/auth/callback",
 SESSION_SECRET:"synthetic-exclusive-staging-secret-with-32-characters",PREP_VOICE_ID:"900000000000000001"};
for(const key of ["GUILD_ID","DISCORD_CLIENT_ID","CTA_CHANNEL_ID","IMORTAL_ROLE_ID","STAFF_LOG_CHANNEL_ID",
 "CONTENT_PING_CHANNEL_ID","RANKING_CHANNEL_ID","ROAMING_CATEGORY_ID"])base[key]="900000000000000002";
assert.equal(validateConfig(base).ok,true);
assert.equal(validateConfig({}).ok,false);
for(const override of [
 {GUILD_ID:PRODUCTION_GUILD},{DISCORD_CLIENT_ID:PRODUCTION_CLIENT},{MACKNA_PROJECT_NAME:"imortais-homologacao"},
 {DATABASE_URL:"postgresql://qa:qa@postgres.imortais-homologacao.internal:5432/app"},
 {DATABASE_URL:"postgresql://qa:qa@database.railway.internal:5432/app"},
 {MACKNA_PREVIEW:"1"},{DISCORD_TOKEN:""},{DISCORD_CLIENT_SECRET:""},{PREP_VOICE_ID:""},
 {OAUTH_REDIRECT:"https://cta-imortais.up.railway.app/auth/callback"},{SESSION_SECRET:"short"}
])assert.equal(validateConfig({...base,...override}).ok,false,JSON.stringify(Object.keys(override)));
const botOnly={...base,MACKNA_STAGING_OAUTH:"disabled",DISCORD_CLIENT_SECRET:"",
 OAUTH_REDIRECT:"https://discord-staging.invalid/auth/callback"};
assert.equal(validateConfig(botOnly).ok,true);
assert.equal(validateConfig(botOnly).oauthEnabled,false);
for(const override of [
 {DISCORD_CLIENT_SECRET:"unexpected-secret"},
 {OAUTH_REDIRECT:base.OAUTH_REDIRECT},
 {OAUTH_REDIRECT:"https://cta-imortais.up.railway.app/auth/callback"},
 {MACKNA_STAGING_OAUTH:"typo"},
 {GUILD_ID:PRODUCTION_GUILD},{DISCORD_CLIENT_ID:PRODUCTION_CLIENT},
 {DATABASE_URL:"postgresql://qa:qa@database.railway.internal:5432/app"}
])assert.equal(validateConfig({...botOnly,...override}).ok,false);
assert.equal(validateConfig({...botOnly,MACKNA_STAGING_OAUTH:"enabled"}).ok,false);
const result=JSON.stringify(validateConfig(base));
assert(!result.includes(base.DISCORD_TOKEN));assert(!result.includes(base.DISCORD_CLIENT_SECRET));
assert(!result.includes(base.SESSION_SECRET));assert(!result.includes(base.DATABASE_URL));
console.log("PASS: separate Discord staging configuration, blocked production defaults and secret-free output");
