"use strict";
// Configuration preflight only. It never contacts Discord or starts the bot.
// Run before npm start in the dedicated, separate Discord staging project.
const PRODUCTION_GUILD = "683411304408416285";
const PRODUCTION_CLIENT = "1541617852056862801";
const PROJECT = "imortais-discord-homologacao";
const REQUIRED_IDS = ["GUILD_ID","DISCORD_CLIENT_ID","CTA_CHANNEL_ID","IMORTAL_ROLE_ID",
  "STAFF_LOG_CHANNEL_ID","CONTENT_PING_CHANNEL_ID","RANKING_CHANNEL_ID","ROAMING_CATEGORY_ID"];
function validateConfig(env=process.env) {
  const errors=[];
  if(env.MACKNA_DISCORD_STAGING!=="1")errors.push("MACKNA_DISCORD_STAGING=1 obrigatório");
  if(env.MACKNA_PREVIEW!=="0")errors.push("MACKNA_PREVIEW deve ser 0 somente neste projeto Discord separado");
  if(env.MACKNA_PROJECT_NAME!==PROJECT)errors.push("projeto deve ser "+PROJECT);
  for(const key of REQUIRED_IDS)if(!/^\d{15,22}$/.test(env[key]||""))errors.push(key+" de testes obrigatório");
  if(env.GUILD_ID===PRODUCTION_GUILD)errors.push("guilda de produção bloqueada");
  if(env.DISCORD_CLIENT_ID===PRODUCTION_CLIENT)errors.push("aplicativo de produção bloqueado");
  if(!env.DISCORD_TOKEN)errors.push("DISCORD_TOKEN de um NOVO bot de testes obrigatório");
  const oauthDisabled=env.MACKNA_STAGING_OAUTH==="disabled";
  if(env.MACKNA_STAGING_OAUTH && !["enabled","disabled"].includes(env.MACKNA_STAGING_OAUTH))errors.push("MACKNA_STAGING_OAUTH inválido");
  if(!oauthDisabled&&!env.DISCORD_CLIENT_SECRET)errors.push("DISCORD_CLIENT_SECRET de testes obrigatório para OAuth");
  if(oauthDisabled&&env.DISCORD_CLIENT_SECRET)errors.push("OAuth desabilitado exige DISCORD_CLIENT_SECRET ausente");
  const voiceIds=String(env.PREP_VOICE_ID||"").split(",").map(x=>x.trim()).filter(Boolean);
  if(!voiceIds.length||voiceIds.some(id=>!/^\d{15,22}$/.test(id)))errors.push("PREP_VOICE_ID de testes obrigatório");
  let database;
  try{database=new URL(env.DATABASE_URL);}catch{}
  if(!database||!["postgres:","postgresql:"].includes(database.protocol)||
    database.hostname!=="postgres."+PROJECT+".internal")
    errors.push("DATABASE_URL deve usar o PostgreSQL exclusivo do projeto Discord de testes");
  if(env.PGSSL!=="disable")errors.push("PGSSL=disable obrigatório para a conexão interna");
  let redirect;
  try{redirect=new URL(env.OAUTH_REDIRECT);}catch{}
  if(!redirect||redirect.protocol!=="https:"||redirect.pathname!=="/auth/callback"||
    redirect.username||redirect.password||redirect.hostname.endsWith(".railway.app"))
    errors.push("OAUTH_REDIRECT exige HTTPS próprio de homologação com /auth/callback, fora do Railway");
  if(oauthDisabled&&env.OAUTH_REDIRECT!=="https://discord-staging.invalid/auth/callback")
    errors.push("OAuth desabilitado exige redirect reservado discord-staging.invalid");
  if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32)errors.push("SESSION_SECRET exclusivo de testes obrigatório (32+ caracteres)");
  return {ok:errors.length===0,errors,project:PROJECT,
    guildId:env.GUILD_ID||null,clientId:env.DISCORD_CLIENT_ID||null,oauthEnabled:!oauthDisabled};
}
if(require.main===module){
  const result=validateConfig();
  console.log(JSON.stringify({status:result.ok?"DISCORD_STAGING_CONFIG_OK":"DISCORD_STAGING_BLOCKED",...result}));
  if(!result.ok)process.exitCode=1;
}
module.exports={validateConfig,PROJECT,PRODUCTION_GUILD,PRODUCTION_CLIENT};
