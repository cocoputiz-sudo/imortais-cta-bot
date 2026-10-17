'use strict';
// Real, unchanged War Room OAuth handlers, without Discord SDK or bot entrypoint.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const {once} = require('node:events');
const CALLBACK = 'https://imortais.macknacloud.com.br/auth/callback';
const GUILD = '683411304408416285';
let db, backend, gateway;

function validate(config) {
  if (Number(process.versions.node.split('.')[0]) !== 22 || process.env.DISCORD_TOKEN || process.env.TELEMETRY_INGEST_KEY)
    throw new Error('runtime_guard');
  if (!config || Object.keys(config).some(k => !['database_url','database','role','client_secret','session_secret','staff_role_id','bomb_leader_role_id','challenge_ui'].includes(k)))
    throw new Error('configuration_guard');
  const url = new URL(config.database_url);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'postgres18.imortais-producao.internal' || url.port !== '5432' ||
      !/^imortais_rehearsal_[0-9]{14}_[a-f0-9]{6}$/.test(config.database) || url.pathname !== '/'+config.database ||
      !/^imortais_oauth_[a-f0-9]{12}$/.test(config.role) || url.username !== config.role || !/^[a-f0-9]{64}$/.test(url.password) ||
      url.search !== '?sslmode=disable' || url.hash || !/^[a-f0-9]{64}$/.test(config.session_secret) ||
      typeof config.client_secret !== 'string' || !config.client_secret || /[\r\n\x00]/.test(config.client_secret))
    throw new Error('configuration_guard');
  for (const key of ['staff_role_id','bomb_leader_role_id']) if (config[key] && !/^[0-9]{17,20}$/.test(config[key])) throw new Error('role_guard');
  return config;
}

async function start(config) {
  validate(config);
  Object.assign(process.env, {DATABASE_URL:config.database_url, PGSSL:'disable', PORT:'0', GUILD_ID:GUILD,
    DISCORD_CLIENT_ID:'1541617852056862801', DISCORD_CLIENT_SECRET:config.client_secret, SESSION_SECRET:config.session_secret,
    OAUTH_REDIRECT:CALLBACK, STAFF_ROLE_ID:config.staff_role_id || '', BOMB_LEADER_ROLE_ID:config.bomb_leader_role_id || '',
    IMORTAIS_CHALLENGE_UI:config.challenge_ui === '1' ? '1' : '0', SITE_ADMIN_IDS:'', CALLER_TAG_ID:'', OFFICER_ROLE_IDS:''});
  const load = Module._load;
  Module._load = function(name, parent, isMain) {
    if (name === 'discord.js' || name.startsWith('@discordjs/') || /(?:^|\/)src\/index(?:\.js)?$/.test(name)) throw new Error('bot_module_blocked');
    return load.call(this,name,parent,isMain);
  };
  const realFetch = global.fetch;
  const destinations = new Set(['https://discord.com/api/oauth2/token','https://discord.com/api/users/@me',
    `https://discord.com/api/users/@me/guilds/${GUILD}/member`]);
  global.fetch = async (raw, options = {}) => {
    const url = String(raw);
    if (!destinations.has(url) || (options.method || 'GET') !== (url.endsWith('/token') ? 'POST' : 'GET')) throw new Error('oauth_destination_blocked');
    return realFetch(raw,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
  };
  db = require('./src/db');
  const row = (await db.pool.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('default_transaction_read_only') AS read_only,
    rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!row || row.database !== config.database || row.role !== config.role || row.read_only !== 'on' ||
      row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls) throw new Error('database_guard');
  const denied = (await db.pool.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'
    AND (has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT')
    OR has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'UPDATE')
    OR has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'DELETE')
    OR has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'TRUNCATE'))`)).rows[0].n;
  if (denied || (await db.pool.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed)
    throw new Error('database_write_privilege');
  // This validation covers login and roster only. Do not install telemetry routes
  // or initialize its writer/materialization jobs with these read-only credentials.
  const telemetry = require('./src/telemetry');
  telemetry.installRoutes = () => {};
  const web = require('./src/web');
  const client = {isReady:()=>false,guilds:{cache:new Map([[GUILD,{id:GUILD,ownerId:null,roles:{cache:new Map()}}]])}};
  // Bind the original handlers to LOOPBACK; the only exposed port is the gate.
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function(port, callback) {
    if (String(port) !== '0' || typeof callback !== 'function') throw new Error('web_bind_guard');
    return listen.call(this,0,'127.0.0.1',callback);
  };
  try { backend = web.startWebServer(client,{}); }
  finally { http.Server.prototype.listen = listen; }
  await once(backend,'listening');
  let callbackAt = null, callbackMember = null;
  const {createGateway} = require('./oauth-gateway.cjs');
  gateway = createGateway(new URL('http://127.0.0.1:'+backend.address().port), {
    decorate:true,
    health:async()=>{
      await db.pool.query('SELECT 1');
      return {mode:'oauth-validation',database:true,databaseName:config.database,readOnly:true,node:process.versions.node,
        botStarted:false,discord:false,discordModuleLoaded:false,oauthCallbackAt:callbackAt,oauthMember:callbackMember,
        telemetryEnabled:false,publicClientIpChainTested:false};
    },
    observe:(path,status,headers)=>{
      if (path !== '/auth/callback' || status !== 302) return;
      const cookie = (headers['set-cookie'] || []).find(x=>x.startsWith('sid='));
      if (!cookie) return;
      try {
        const token=cookie.slice(4).split(';')[0], [body,mac] = token.split('.');
        if (crypto.createHmac('sha256',config.session_secret).update(body).digest('base64url') !== mac) return;
        const session=JSON.parse(Buffer.from(body,'base64url'));
        callbackAt = new Date().toISOString(); callbackMember = session.isMember === true;
      } catch {}
    }
  });
  gateway.listen(3000,'0.0.0.0'); await once(gateway,'listening');
  if (Object.keys(require.cache).some(p=>/\/discord\.js\//.test(p))) throw new Error('discord_module_loaded');
  process.stdout.write('OAUTH_WEB_VALIDATION_READY\n');
  return {db,backend,gateway};
}
async function stop() {
  for (const server of [gateway,backend]) if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  if (db) await db.pool.end();
}
if (require.main === module) {
  // Do not print app/OAuth exceptions, URLs, bodies or session/provider tokens.
  console.log = console.info = console.warn = console.error = () => {};
  Promise.resolve().then(()=>start(JSON.parse(fs.readFileSync('/run/imortais-oauth/config.json','utf8')))).catch(async()=>{
    process.stderr.write('OAUTH_WEB_VALIDATION_FAILED\n'); await stop().catch(()=>{}); process.exit(1);
  });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{stop().finally(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();});
}
module.exports = {validate,start,stop};
