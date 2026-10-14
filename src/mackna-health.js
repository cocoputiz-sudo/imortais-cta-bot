"use strict";

// In MackNa BTV preview, Discord is intentionally offline. Keep production
// health semantics unchanged; only the isolated preview waives Discord readiness.
function healthResult({ database, discord, preview = false, at = new Date().toISOString() }) {
  const dbReady = Boolean(database);
  const discordReady = Boolean(discord);
  const ok = dbReady && (preview || discordReady);
  return preview
    ? { ok, database: dbReady, discord: discordReady, mode: "preview", discordRequired: false, at }
    : { ok, database: dbReady, discord: discordReady, at };
}

module.exports = { healthResult };
