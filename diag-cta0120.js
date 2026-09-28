const express = require("express");
const { Pool } = require("pg");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function normName(v) {
  let out = String(v || "").trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^[!\s]+/, "").replace(/^\[[^\]]{1,16}\]\s*/i, "");
  } while (out !== prev);
  return out.trim().toLowerCase();
}
function normGuild(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
function isImortaisFamilyGuild(v) {
  const g = normGuild(v);
  return g === "imortais" || g === "imortais2" || g === "imortaisacademy";
}
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

app.get("/result", async (_req, res) => {
  try {
    const ev = (await pool.query(`
      SELECT id,guild_id,time_label,status,created_at,closed_at,remind_30,remind_10
      FROM cta_events
      WHERE time_label='01:20'
      ORDER BY COALESCE(remind_30 + interval '30 minutes',
                        remind_10 + interval '10 minutes',
                        created_at) DESC,
               created_at DESC
      LIMIT 1
    `)).rows[0];
    if (!ev) return res.status(404).json({ error: "cta_0120_not_found" });

    const signups = (await pool.query(
      `SELECT username, party_index, slot_index FROM cta_signups WHERE event_id=$1`,
      [ev.id]
    )).rows;
    const rosterKeys = new Set(signups.map(s => normName(s.username)).filter(Boolean));

    const rows = (await pool.query(`
      SELECT event_id,device_id,type,player_name,payload,occurred_at,received_at
      FROM albion_telemetry_events
      WHERE cta_event_id=$1
        AND type IN ('combat_delta','death','kill','knockout','knocked_out','combat_result','player_death_observed')
      ORDER BY occurred_at ASC, received_at ASC
    `, [ev.id])).rows;

    const counts = {};
    for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;

    const relevantRows = rows.filter(r => {
      if (!["death","kill","player_death_observed"].includes(r.type)) return false;
      if (r.type !== "player_death_observed") return true;
      const p = r.payload || {};
      return isImortaisFamilyGuild(p.killerGuild)
        || isImortaisFamilyGuild(p.victimGuild)
        || rosterKeys.has(normName(p.killer))
        || rosterKeys.has(normName(p.victim));
    });

    const COMBAT_DEATH_DEDUP_MS = 30000;
    const byPair = new Map();
    const canonicalKills = [];

    for (const r of relevantRows) {
      const p = r.payload || {};
      const killer = String(p.killer || "").trim();
      const victim = String(p.victim || "").trim();
      if (!killer || !victim || p.isLethal === false) continue;

      const cluster = String(p.cluster || "").trim() || "Mapa desconhecido";
      const victimKey = normName(victim);
      const baseKey = [cluster, victimKey].join("|");
      if (!byPair.has(baseKey)) byPair.set(baseKey, []);
      const arr = byPair.get(baseKey);

      const occurredMs = new Date(r.occurred_at).getTime();
      const receivedMs = new Date(r.received_at).getTime();
      const victimObjectId = num(p.victimObjectId, 0) > 0 ? String(p.victimObjectId) : null;
      const killerObjectId = num(p.killerObjectId, 0) > 0 ? String(p.killerObjectId) : null;

      let k = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const candidate = arr[i];
        const occurredClose =
          Number.isFinite(occurredMs) &&
          Number.isFinite(candidate.lastOccurredMs) &&
          Math.abs(occurredMs - candidate.lastOccurredMs) <= COMBAT_DEATH_DEDUP_MS;
        const receivedClose =
          Number.isFinite(receivedMs) &&
          Number.isFinite(candidate.lastReceivedMs) &&
          Math.abs(receivedMs - candidate.lastReceivedMs) <= COMBAT_DEATH_DEDUP_MS;
        const objectCompatible =
          !victimObjectId ||
          candidate.victimObjectIds.size === 0 ||
          candidate.victimObjectIds.has(victimObjectId);

        if (objectCompatible && (occurredClose || receivedClose)) {
          k = candidate;
          break;
        }

        const newestKnown = Math.max(
          Number.isFinite(candidate.lastOccurredMs) ? candidate.lastOccurredMs : 0,
          Number.isFinite(candidate.lastReceivedMs) ? candidate.lastReceivedMs : 0
        );
        const currentKnown = Math.max(
          Number.isFinite(occurredMs) ? occurredMs : 0,
          Number.isFinite(receivedMs) ? receivedMs : 0
        );
        if (newestKnown && currentKnown && currentKnown - newestKnown > COMBAT_DEATH_DEDUP_MS * 2) break;
      }

      if (!k) {
        k = {
          map: cluster,
          killer,
          victim,
          occurredAt: r.occurred_at,
          receivedAt: r.received_at,
          lastOccurredMs: Number.isFinite(occurredMs) ? occurredMs : null,
          lastReceivedMs: Number.isFinite(receivedMs) ? receivedMs : null,
          killerGuilds: new Set(),
          victimGuilds: new Set(),
          victimObjectIds: new Set(),
          killerObjectIds: new Set(),
          sourceTypes: new Set(),
          devices: new Set(),
          rawEvents: 0,
          observedDeathEvents: 0,
          killerInRoster: rosterKeys.has(normName(killer)),
          victimInRoster: rosterKeys.has(victimKey),
          killerInFamily: false,
          victimInFamily: false
        };
        arr.push(k);
        canonicalKills.push(k);
      }

      if (Number.isFinite(occurredMs)) {
        k.lastOccurredMs = k.lastOccurredMs == null ? occurredMs : Math.max(k.lastOccurredMs, occurredMs);
      }
      if (Number.isFinite(receivedMs)) {
        k.lastReceivedMs = k.lastReceivedMs == null ? receivedMs : Math.max(k.lastReceivedMs, receivedMs);
      }
      if (victimObjectId) k.victimObjectIds.add(victimObjectId);
      if (killerObjectId) k.killerObjectIds.add(killerObjectId);
      if (p.killerGuild) k.killerGuilds.add(String(p.killerGuild).trim());
      if (p.victimGuild) k.victimGuilds.add(String(p.victimGuild).trim());

      k.rawEvents++;
      if (r.type === "player_death_observed") k.observedDeathEvents++;
      k.sourceTypes.add(r.type);
      k.devices.add(String(r.device_id || "sem-device"));
      k.killerInRoster = k.killerInRoster || rosterKeys.has(normName(killer));
      k.victimInRoster = k.victimInRoster || rosterKeys.has(normName(victim));
      k.killerInFamily = k.killerInFamily || isImortaisFamilyGuild(p.killerGuild);
      k.victimInFamily = k.victimInFamily || isImortaisFamilyGuild(p.victimGuild);
    }

    for (const k of canonicalKills) {
      k.killerIsOurs = k.killerInRoster || k.killerInFamily;
      k.victimIsOurs = k.victimInRoster || k.victimInFamily;
    }

    const ourKills = canonicalKills.filter(k => k.killerIsOurs && !k.victimIsOurs);
    const ourDeaths = canonicalKills.filter(k => k.victimIsOurs && !k.killerIsOurs);
    const friendly = canonicalKills.filter(k => k.killerIsOurs && k.victimIsOurs);
    const external = canonicalKills.filter(k => !k.killerIsOurs && !k.victimIsOurs);

    function enemyGuildName(guilds) {
      for (const raw of guilds || []) {
        const guild = String(raw || "").trim();
        if (guild && !isImortaisFamilyGuild(guild)) return guild;
      }
      return "Sem guilda";
    }

    const score = new Map();
    function scoreRow(guild) {
      const display = String(guild || "").trim() || "Sem guilda";
      const key = display === "Sem guilda" ? "__sem_guilda__" : (normGuild(display) || "__sem_guilda__");
      if (!score.has(key)) score.set(key, { guild: display, weKilledThem: 0, theyKilledUs: 0 });
      return score.get(key);
    }
    for (const k of ourKills) scoreRow(enemyGuildName(k.victimGuilds)).weKilledThem++;
    for (const k of ourDeaths) scoreRow(enemyGuildName(k.killerGuilds)).theyKilledUs++;

    const byGuild = [...score.values()]
      .sort((a,b) => (b.weKilledThem+b.theyKilledUs)-(a.weKilledThem+a.theyKilledUs));

    const rawGuildCounts = { killer: {}, victim: {} };
    for (const r of rows.filter(x => x.type === "player_death_observed")) {
      const p = r.payload || {};
      const kg = String(p.killerGuild || "").trim() || "Sem guilda";
      const vg = String(p.victimGuild || "").trim() || "Sem guilda";
      rawGuildCounts.killer[kg] = (rawGuildCounts.killer[kg] || 0) + 1;
      rawGuildCounts.victim[vg] = (rawGuildCounts.victim[vg] || 0) + 1;
    }

    res.json({
      event: ev,
      signupCount: signups.length,
      combatEventCount: rows.length,
      counts,
      canonical: {
        total: canonicalKills.length,
        ourKills: ourKills.length,
        ourDeaths: ourDeaths.length,
        friendly: friendly.length,
        external: external.length,
        collapsedDeathLikeEvents: relevantRows.length - canonicalKills.length
      },
      killScore: {
        byGuild,
        totals: { weKilled: ourKills.length, wereKilled: ourDeaths.length }
      },
      rawGuildCounts,
      ourDeaths: ourDeaths.map(k => ({
        victim: k.victim,
        victimGuilds: [...k.victimGuilds],
        killer: k.killer,
        killerGuilds: [...k.killerGuilds],
        map: k.map,
        occurredAt: k.occurredAt
      })),
      ourKills: ourKills.map(k => ({
        killer: k.killer,
        killerGuilds: [...k.killerGuilds],
        victim: k.victim,
        victimGuilds: [...k.victimGuilds],
        map: k.map,
        occurredAt: k.occurredAt
      }))
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.stack || e) });
  }
});

app.get("/", (_req,res) => res.send("cta 01:20 read-only diagnostic"));
app.listen(process.env.PORT || 3000, () => console.log("diagnostic ready"));
