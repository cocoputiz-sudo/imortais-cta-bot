// ============================================================================
// SCOUT / DESEMPENHO — histórico permanente por jogador e CTA.
// Consolida os mesmos números canônicos do Combate antes da telemetria bruta expirar.
// ============================================================================
const { WEAPONS } = require("./comps");

let pool = null;
const STATS_VERSION = 1;

function normName(v) {
  let out = String(v || "").trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^[!\s]+/, "").replace(/^\[[^\]]{1,16}\]\s*/i, "");
  } while (out !== prev);
  return out.trim().toLowerCase();
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function canonicalRole(v) {
  const raw = String(v || "").trim();
  const key = raw.toLowerCase();
  if (key === "tank" || key === "tanker") return "Tank";
  if (key === "support" || key === "suporte") return "Support";
  if (key === "healer" || key === "heal") return "Healer";
  if (key === "melee") return "Melee";
  if (key === "ranged") return "Ranged";
  if (key === "looter") return "Looter";
  return raw || null;
}

function roleFor(weapon, fallback) {
  const key = String(weapon || "").trim().toUpperCase();
  return (WEAPONS[key] && WEAPONS[key].role) || canonicalRole(fallback) || null;
}

async function initSchema(dbPool) {
  pool = dbPool;
  await pool.query(
    "CREATE TABLE IF NOT EXISTS player_cta_stats (" +
    "id BIGSERIAL PRIMARY KEY," +
    "guild_id TEXT NOT NULL," +
    "cta_event_id BIGINT NOT NULL REFERENCES cta_events(id) ON DELETE CASCADE," +
    "discord_user_id TEXT," +
    "player_key TEXT NOT NULL," +
    "player_name TEXT NOT NULL," +
    "role TEXT," +
    "weapon TEXT," +
    "planned_party INT," +
    "actual_party INT," +
    "attendance_level TEXT," +
    "voice_minutes INT NOT NULL DEFAULT 0," +
    "damage BIGINT NOT NULL DEFAULT 0," +
    "healing BIGINT NOT NULL DEFAULT 0," +
    "kills INT NOT NULL DEFAULT 0," +
    "deaths INT NOT NULL DEFAULT 0," +
    "fights INT NOT NULL DEFAULT 0," +
    "combat_observed BOOLEAN NOT NULL DEFAULT false," +
    "item_power INT," +
    "equipment JSONB," +
    "equipment_observed_at TIMESTAMPTZ," +
    "observer_count INT NOT NULL DEFAULT 0," +
    "telemetry_events INT NOT NULL DEFAULT 0," +
    "party_snapshots INT NOT NULL DEFAULT 0," +
    "core_verified BOOLEAN NOT NULL DEFAULT false," +
    "profile_main_role TEXT," +
    "stats_version INT NOT NULL DEFAULT 1," +
    "calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()," +
    "UNIQUE(cta_event_id, player_key)" +
    ")"
  );
  await pool.query("CREATE INDEX IF NOT EXISTS idx_player_cta_stats_guild_player ON player_cta_stats(guild_id, player_key, cta_event_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_player_cta_stats_event ON player_cta_stats(cta_event_id)");
}

function flattenConfirm(confirm) {
  const out = new Map();
  function put(row) {
    if (!row || !row.n) return;
    const key = normName(row.n);
    if (!key) return;
    const prev = out.get(key) || {};
    out.set(key, { ...prev, ...row });
  }
  for (const group of (confirm && confirm.pts) || []) {
    for (const row of group.linhas || []) put(row);
  }
  for (const row of (confirm && confirm.discordNoPing) || []) put(row);
  for (const row of (confirm && confirm.gameNoSignup) || []) put(row);
  return out;
}

function fightCounts(combat) {
  const counts = new Map();
  for (const map of (combat && combat.maps) || []) {
    for (const fight of map.fights || []) {
      for (const p of fight.players || []) {
        const key = normName(p.n);
        if (!key) continue;
        if (n(p.damage) || n(p.healing) || n(p.kills) || n(p.deaths)) {
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
  }
  return counts;
}

async function snapshotCta(db, attendance, telemetry, eventId) {
  if (!pool) throw new Error("scout.initSchema(pool) deve rodar antes");
  const ev = await db.getEvent(eventId);
  if (!ev) return { ok: false, reason: "cta-not-found" };

  const [signups, attendanceMap, combat, confirm, profilesResult] = await Promise.all([
    db.getSignups(eventId).catch(() => []),
    attendance.processEvent(ev).catch(() => new Map()),
    telemetry.getCombat(db, eventId).catch(() => ({ players: [], maps: [], audit: {}, meta: {} })),
    telemetry.getConfirm(db, eventId).catch(() => null),
    pool.query(
      "SELECT user_id, username, main_role, core_verified FROM players WHERE guild_id=$1",
      [ev.guild_id]
    ).catch(() => ({ rows: [] }))
  ]);

  const profileByUser = new Map((profilesResult.rows || []).map(p => [String(p.user_id), p]));
  const confirmByName = flattenConfirm(confirm);
  const combatByName = new Map(((combat && combat.players) || []).map(p => [normName(p.n), p]));
  const fightsByName = fightCounts(combat);
  const pl = db.parsePartyList(ev);
  const displayByRaw = new Map(pl.map((raw, i) => [Number(raw), i + 1]));
  const signupByName = new Map(signups.map(s => [normName(s.username), s]));

  const entries = new Map();
  function ensure(name, userId) {
    const key = normName(name);
    if (!key) return null;
    if (!entries.has(key)) entries.set(key, { key, name: String(name || key), userId: userId ? String(userId) : null });
    const e = entries.get(key);
    if (name) e.name = String(name);
    if (userId) e.userId = String(userId);
    return e;
  }

  for (const s of signups) ensure(s.username, s.user_id);
  for (const [uid, a] of attendanceMap) ensure(a.username, uid);
  for (const row of confirmByName.values()) ensure(row.n, null);

  const globalObservers = Array.isArray(combat?.audit?.devices) ? combat.audit.devices.length : 0;
  const telemetryEvents = n(combat?.meta?.totalEventos);
  const partySnapshots = n(confirm?.meta?.partySnapshots);
  const rows = [];

  for (const e of entries.values()) {
    const signup = signupByName.get(e.key) || null;
    const att = e.userId ? attendanceMap.get(e.userId) : null;
    const c = combatByName.get(e.key) || null;
    const conf = confirmByName.get(e.key) || null;
    const profile = e.userId ? profileByUser.get(String(e.userId)) : null;
    const plannedParty = signup && signup.party_index != null
      ? (displayByRaw.get(Number(signup.party_index)) || Number(signup.party_index) + 1)
      : (conf?.plannedParty ?? null);
    rows.push({
      guildId: ev.guild_id,
      ctaEventId: ev.id,
      discordUserId: e.userId,
      playerKey: e.key,
      playerName: e.name,
      role: roleFor(signup?.weapon, profile?.main_role),
      weapon: signup?.weapon || null,
      plannedParty: plannedParty == null ? null : Number(plannedParty),
      actualParty: conf?.actualParty == null ? null : Number(conf.actualParty),
      attendanceLevel: att?.level || null,
      voiceMinutes: n(att?.minutes),
      damage: n(c?.damage),
      healing: n(c?.healing),
      kills: n(c?.kills),
      deaths: n(c?.deaths),
      fights: fightsByName.get(e.key) || 0,
      combatObserved: !!c,
      itemPower: conf?.itemPower == null ? null : Math.max(0, Math.round(n(conf.itemPower))),
      equipment: conf?.equipment || null,
      equipmentObservedAt: conf?.equipmentObservedAt || null,
      observerCount: globalObservers,
      telemetryEvents,
      partySnapshots,
      coreVerified: !!profile?.core_verified,
      profileMainRole: profile?.main_role || null
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM player_cta_stats WHERE cta_event_id=$1", [ev.id]);
    for (const r of rows) {
      await client.query(
        "INSERT INTO player_cta_stats (" +
        "guild_id, cta_event_id, discord_user_id, player_key, player_name, role, weapon, planned_party, actual_party," +
        "attendance_level, voice_minutes, damage, healing, kills, deaths, fights, combat_observed, item_power, equipment," +
        "equipment_observed_at, observer_count, telemetry_events, party_snapshots, core_verified, profile_main_role, stats_version, calculated_at" +
        ") VALUES (" +
        "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,now()" +
        ")",
        [
          r.guildId, r.ctaEventId, r.discordUserId, r.playerKey, r.playerName, r.role, r.weapon,
          r.plannedParty, r.actualParty, r.attendanceLevel, r.voiceMinutes, r.damage, r.healing,
          r.kills, r.deaths, r.fights, r.combatObserved, r.itemPower,
          r.equipment ? JSON.stringify(r.equipment) : null, r.equipmentObservedAt,
          r.observerCount, r.telemetryEvents, r.partySnapshots, r.coreVerified, r.profileMainRole, STATS_VERSION
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return { ok: true, eventId: String(ev.id), players: rows.length, telemetryEvents, observers: globalObservers };
}

async function backfillRecent(db, attendance, telemetry) {
  // Attendance da temporada inteira ainda pode ser reconstruído da voice_presence.
  // Combate/equipamento só estarão presentes enquanto a telemetria bruta existir.
  const guildId = process.env.GUILD_ID || "683411304408416285";
  const season = await db.getCurrentSeason(guildId) || await db.getLastEndedSeason(guildId);
  if (!season) return { total: 0, ok: 0, failed: 0 };

  const { rows } = await pool.query(
    "SELECT e.id FROM cta_events e " +
    "WHERE e.guild_id=$1 AND e.status='closed' AND NOT e.ignored AND e.created_at >= $2 " +
    "AND (COALESCE(e.closed_at,e.created_at) >= now() - interval '3 days' " +
    "OR NOT EXISTS (SELECT 1 FROM player_cta_stats s WHERE s.cta_event_id=e.id AND s.stats_version >= $3)) " +
    "ORDER BY e.id ASC LIMIT 500",
    [guildId, season.started_at, STATS_VERSION]
  );
  let ok = 0, failed = 0;
  for (const row of rows) {
    try {
      await snapshotCta(db, attendance, telemetry, row.id);
      ok++;
    } catch (e) {
      failed++;
      console.error("scout backfill CTA " + row.id + ":", e?.message || e);
    }
  }
  return { total: rows.length, ok, failed };
}

async function seasonContext(db, guildId) {
  let season = await db.getCurrentSeason(guildId);
  let active = true;
  if (!season) {
    season = await db.getLastEndedSeason(guildId);
    active = false;
  }
  if (!season) return null;
  return {
    id: Number(season.id),
    number: Number(season.number),
    startedAt: new Date(season.started_at),
    endedAt: active ? new Date() : new Date(season.ended_at),
    active
  };
}

function confidence(ctas, coveragePct) {
  if (ctas >= 10 && coveragePct >= 70) return "alta";
  if (ctas >= 5 && coveragePct >= 40) return "média";
  return "baixa";
}

function percentile(value, peers, lowerBetter = false) {
  const v = Number(value);
  const vals = (peers || []).map(Number).filter(Number.isFinite);
  if (!Number.isFinite(v) || vals.length < 3) return null;
  if (vals.length === 1) return 50;
  const betterBase = vals.filter(x => lowerBetter ? x > v : x < v).length;
  const equals = vals.filter(x => x === v).length;
  const rank = betterBase + Math.max(0, equals - 1) / 2;
  return Math.max(0, Math.min(100, Math.round((rank / (vals.length - 1)) * 100)));
}

function impactValue(row) {
  if (!row || row.combatCtas < 1) return null;
  if (row.role === "Healer") return row.healingPerMinute;
  if (row.role === "Melee" || row.role === "Ranged") return row.damagePerMinute;
  if (row.role === "Tank" || row.role === "Support") return row.fightsPerCombatCta;
  return Math.max(row.damagePerMinute || 0, row.healingPerMinute || 0);
}

function impactBasis(role) {
  if (role === "Healer") return "cura/min";
  if (role === "Melee" || role === "Ranged") return "dano/min + kills/CTA";
  if (role === "Tank" || role === "Support") return "participação em fights/CTA";
  return "atividade de combate";
}

function attachRolePercentiles(rows) {
  const groups = new Map();
  for (const row of rows) {
    const role = canonicalRole(row.role) || "Sem função";
    row.role = role;
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(row);
  }

  for (const [role, peers] of groups) {
    const presenceVals = peers.map(x => x.presencePct);
    const consistencyVals = peers.map(x => x.integralShare);
    const disciplineVals = peers.map(x => x.partyCorrectPct).filter(x => x != null);
    const survivalVals = peers.map(x => x.deathsPerFight).filter(x => x != null);
    const impactVals = peers.map(impactValue).filter(x => x != null);
    const killVals = peers.map(x => x.killsPerCombatCta).filter(x => x != null);

    for (const row of peers) {
      let impact = percentile(impactValue(row), impactVals);
      if ((role === "Melee" || role === "Ranged") && row.killsPerCombatCta != null) {
        const killPct = percentile(row.killsPerCombatCta, killVals);
        if (impact != null && killPct != null) impact = Math.round(impact * 0.75 + killPct * 0.25);
        else if (killPct != null) impact = killPct;
      }
      row.radar = {
        presence: percentile(row.presencePct, presenceVals),
        impact,
        survival: percentile(row.deathsPerFight, survivalVals, true),
        discipline: percentile(row.partyCorrectPct, disciplineVals),
        consistency: percentile(row.integralShare, consistencyVals),
        peerCount: peers.length,
        impactBasis: impactBasis(role)
      };
    }
  }
}

async function overview(db, guildId) {
  const ctx = await seasonContext(db, guildId);
  if (!ctx) return { season: null, ctaCount: 0, rows: [] };

  const eventsResult = await pool.query(
    "SELECT id, time_label, created_at FROM cta_events WHERE guild_id=$1 AND status='closed' AND NOT ignored AND created_at >= $2 AND created_at <= $3 ORDER BY created_at ASC",
    [guildId, ctx.startedAt, ctx.endedAt]
  );
  const dedup = new Map();
  for (const ev of eventsResult.rows) {
    const key = new Date(ev.created_at).toISOString().slice(0, 10) + " " + ev.time_label;
    const prev = dedup.get(key);
    if (!prev || new Date(ev.created_at) > new Date(prev.created_at)) dedup.set(key, ev);
  }
  const validIds = [...dedup.values()].map(x => Number(x.id));
  const ctaCount = validIds.length;
  if (!ctaCount) return {
    season: { id: ctx.id, number: ctx.number, active: ctx.active, startedAt: ctx.startedAt, endedAt: ctx.endedAt },
    ctaCount: 0,
    capturedCtas: 0,
    rows: []
  };

  const stats = await pool.query(
    "SELECT * FROM player_cta_stats WHERE guild_id=$1 AND cta_event_id = ANY($2::bigint[]) ORDER BY calculated_at ASC",
    [guildId, validIds]
  );

  const profiles = await pool.query(
    "SELECT user_id, username, main_role, role2, fill_role, core_verified FROM players WHERE guild_id=$1",
    [guildId]
  ).catch(() => ({ rows: [] }));
  const profileByUser = new Map((profiles.rows || []).map(p => [String(p.user_id), p]));

  const by = new Map();
  function rowFor(s) {
    if (!by.has(s.player_key)) {
      by.set(s.player_key, {
        playerKey: s.player_key,
        playerName: s.player_name,
        discordUserId: s.discord_user_id,
        roles: new Map(),
        ctasRecorded: 0, attendedCtas: 0, integral: 0, parcial: 0, rapida: 0, fantasma: 0,
        voiceMinutes: 0, damage: 0, healing: 0, kills: 0, deaths: 0, fights: 0,
        combatCtas: 0, partyObserved: 0, partyCorrect: 0, equipmentCtas: 0, ipSum: 0,
        observerSum: 0, coreVerified: false
      });
    }
    return by.get(s.player_key);
  }

  for (const s of stats.rows) {
    const o = rowFor(s);
    o.playerName = s.player_name || o.playerName;
    o.discordUserId = s.discord_user_id || o.discordUserId;
    const role = s.role || s.profile_main_role;
    if (role) o.roles.set(role, (o.roles.get(role) || 0) + 1);
    o.ctasRecorded++;
    if (s.attendance_level === "INTEGRAL") { o.integral++; o.attendedCtas++; }
    else if (s.attendance_level === "PARCIAL") { o.parcial++; o.attendedCtas++; }
    else if (s.attendance_level === "RAPIDA") { o.rapida++; o.attendedCtas++; }
    else if (s.attendance_level === "FANTASMA") o.fantasma++;
    o.voiceMinutes += n(s.voice_minutes);
    o.damage += n(s.damage);
    o.healing += n(s.healing);
    o.kills += n(s.kills);
    o.deaths += n(s.deaths);
    o.fights += n(s.fights);
    if (s.combat_observed) o.combatCtas++;
    if (s.planned_party != null && s.actual_party != null) {
      o.partyObserved++;
      if (Number(s.planned_party) === Number(s.actual_party)) o.partyCorrect++;
    }
    if (s.item_power != null && n(s.item_power) > 0) {
      o.equipmentCtas++;
      o.ipSum += n(s.item_power);
    }
    o.observerSum += n(s.observer_count);
    o.coreVerified = o.coreVerified || !!s.core_verified;
  }

  const rows = [...by.values()].map(o => {
    const profile = o.discordUserId ? profileByUser.get(String(o.discordUserId)) : null;
    const role = profile?.main_role || [...o.roles.entries()].sort((a,b) => b[1] - a[1])[0]?.[0] || "Sem função";
    const presencePct = ctaCount ? Math.round(((o.integral + o.parcial + o.rapida * 0.5) / ctaCount) * 1000) / 10 : 0;
    const coveragePct = o.attendedCtas ? Math.min(100, Math.round((o.combatCtas / o.attendedCtas) * 1000) / 10) : 0;
    const partyCorrectPct = o.partyObserved ? Math.round((o.partyCorrect / o.partyObserved) * 1000) / 10 : null;
    const minutes = Math.max(1, o.voiceMinutes);
    return {
      playerKey: o.playerKey,
      playerName: o.playerName,
      discordUserId: o.discordUserId,
      role,
      coreVerified: !!(profile?.core_verified || o.coreVerified),
      ctasRecorded: o.ctasRecorded,
      attendedCtas: o.attendedCtas,
      integral: o.integral,
      parcial: o.parcial,
      rapida: o.rapida,
      fantasma: o.fantasma,
      presencePct,
      voiceMinutes: o.voiceMinutes,
      damage: o.damage,
      healing: o.healing,
      damagePerMinute: Math.round((o.damage / minutes) * 10) / 10,
      healingPerMinute: Math.round((o.healing / minutes) * 10) / 10,
      kills: o.kills,
      deaths: o.deaths,
      fights: o.fights,
      combatCtas: o.combatCtas,
      coveragePct,
      partyCorrectPct,
      avgItemPower: o.equipmentCtas ? Math.round(o.ipSum / o.equipmentCtas) : null,
      avgObservers: o.ctasRecorded ? Math.round((o.observerSum / o.ctasRecorded) * 10) / 10 : 0,
      killsPerCombatCta: o.combatCtas ? Math.round((o.kills / o.combatCtas) * 100) / 100 : null,
      fightsPerCombatCta: o.combatCtas ? Math.round((o.fights / o.combatCtas) * 100) / 100 : null,
      deathsPerFight: o.fights ? Math.round((o.deaths / o.fights) * 1000) / 1000 : null,
      integralShare: o.attendedCtas ? Math.round((o.integral / o.attendedCtas) * 1000) / 10 : 0,
      confidence: confidence(o.attendedCtas, coveragePct)
    };
  });

  attachRolePercentiles(rows);
  rows.sort((a,b) =>
    b.attendedCtas - a.attendedCtas ||
    b.coveragePct - a.coveragePct ||
    a.playerName.localeCompare(b.playerName, "pt-BR")
  );

  return {
    season: { id: ctx.id, number: ctx.number, active: ctx.active, startedAt: ctx.startedAt, endedAt: ctx.endedAt },
    ctaCount,
    capturedCtas: new Set(stats.rows.map(x => String(x.cta_event_id))).size,
    rows
  };
}

async function playerDetail(db, guildId, playerName) {
  const key = normName(playerName);
  if (!key) return null;

  const ov = await overview(db, guildId);
  const summary = (ov.rows || []).find(x => x.playerKey === key);
  if (!summary) return null;

  const ctx = await seasonContext(db, guildId);
  const historyResult = await pool.query(
    "SELECT s.*, e.time_label, e.created_at, e.closed_at " +
    "FROM player_cta_stats s JOIN cta_events e ON e.id=s.cta_event_id " +
    "WHERE s.guild_id=$1 AND s.player_key=$2 AND e.created_at >= $3 AND e.created_at <= $4 " +
    "ORDER BY e.created_at DESC, e.id DESC LIMIT 100",
    [guildId, key, ctx.startedAt, ctx.endedAt]
  );

  const profileResult = summary.discordUserId
    ? await pool.query(
        "SELECT user_id, username, main_role, role2, fill_role, w1, w2, r2w1, r2w2, fw1, fw2, turnos, core_claimed, core_verified " +
        "FROM players WHERE guild_id=$1 AND user_id=$2 LIMIT 1",
        [guildId, summary.discordUserId]
      ).catch(() => ({ rows: [] }))
    : { rows: [] };

  const history = historyResult.rows.map(r => ({
    eventId: String(r.cta_event_id),
    time: r.time_label,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    role: canonicalRole(r.role || r.profile_main_role),
    weapon: r.weapon,
    plannedParty: r.planned_party == null ? null : Number(r.planned_party),
    actualParty: r.actual_party == null ? null : Number(r.actual_party),
    attendanceLevel: r.attendance_level,
    voiceMinutes: n(r.voice_minutes),
    damage: n(r.damage),
    healing: n(r.healing),
    kills: n(r.kills),
    deaths: n(r.deaths),
    fights: n(r.fights),
    combatObserved: !!r.combat_observed,
    itemPower: r.item_power == null ? null : n(r.item_power),
    equipment: r.equipment || null,
    equipmentObservedAt: r.equipment_observed_at,
    observers: n(r.observer_count),
    telemetryEvents: n(r.telemetry_events)
  }));

  const latestEquipment = history.find(x => x.equipment) || null;
  return {
    season: ov.season,
    ctaCount: ov.ctaCount,
    capturedCtas: ov.capturedCtas,
    summary,
    profile: profileResult.rows[0] || null,
    latestEquipment,
    history
  };
}

module.exports = { initSchema, snapshotCta, backfillRecent, overview, playerDetail, normName };
