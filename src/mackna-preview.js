"use strict";

// MackNa Cloud staging preview for an isolated PostgreSQL service.
// Production is unchanged unless MACKNA_PREVIEW=1 is explicitly enabled.
function isPreview(env = process.env) {
  return env.MACKNA_PREVIEW === "1";
}

function validatePreview(env = process.env) {
  if (!isPreview(env)) return;
  if (env.DISCORD_TOKEN || env.DISCORD_CLIENT_SECRET) {
    throw new Error("MACKNA_PREVIEW: remova credenciais Discord; este ambiente nunca deve acessar a guilda real.");
  }
  if (!env.DATABASE_URL) throw new Error("MACKNA_PREVIEW exige DATABASE_URL de um PostgreSQL de testes isolado.");
  let hostname;
  try { hostname = new URL(env.DATABASE_URL).hostname.toLowerCase(); }
  catch (_) { throw new Error("MACKNA_PREVIEW: DATABASE_URL inválida."); }
  // MackNa's service-to-service DNS uses .internal; local compose also uses db/postgres.
  if (!(hostname === "db" || hostname === "postgres" ||
        hostname === "127.0.0.1" || hostname === "localhost" ||
        hostname.endsWith(".internal"))) {
    throw new Error("MACKNA_PREVIEW: banco externo bloqueado; use somente PostgreSQL isolado no MackNa.");
  }
}

function health({database, discord, preview = false, at = new Date().toISOString()}) {
  const databaseReady = Boolean(database), discordReady = Boolean(discord);
  const ok = databaseReady && (preview || discordReady);
  return preview
    ? {ok, database: databaseReady, discord: discordReady, mode: "preview", discordRequired: false, at}
    : {ok, database: databaseReady, discord: discordReady, at};
}

module.exports = {isPreview, validatePreview, health};
