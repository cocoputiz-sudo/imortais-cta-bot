"use strict";

// The Guild Challenge leaderboard is NOT Guild Might. It uses its own
// GetGuildChallengePoints response and must never be merged into Might totals.
const { inferContributionLayout, getByPath } = require("./guildMight");

function extractChallengeSnapshots(rows, { minConfidence = 0.90 } = {}) {
  const snapshots = [];
  for (const row of rows || []) {
    const payload = row.payload || {};
    if (payload.operationName !== "GetGuildChallengePoints"
      || String(payload.direction || "").toLowerCase() !== "response") continue;
    const params = payload.parameters || {};
    const candidates = inferContributionLayout(params).candidates || [];
    const candidate = candidates.find(c => c.confidence >= minConfidence && c.count >= 2);
    if (!candidate) continue;
    const names = getByPath(params, candidate.namesPath);
    const points = getByPath(params, candidate.mightPath);
    if (!Array.isArray(names) || !Array.isArray(points) || names.length !== points.length) continue;

    const players = new Map();
    for (let i = 0; i < names.length; i++) {
      const player = String(names[i] || "").trim();
      const amount = points[i];
      if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(player)
        || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) continue;
      const key = player.toLocaleLowerCase("en");
      const before = players.get(key);
      if (!before || amount > before.points) players.set(key, { player, points: amount });
    }
    if (players.size < 2 || ![...players.values()].some(p => p.points > 0)) continue;
    snapshots.push({
      responseEventId: row.event_id,
      observer: row.player_name || null,
      deviceId: row.device_id || null,
      capturedAt: row.occurred_at,
      confidence: candidate.confidence,
      layout: { namesPath: candidate.namesPath, pointsPath: candidate.mightPath },
      members: [...players.values()].sort((a, b) => b.points - a.points || a.player.localeCompare(b.player))
    });
  }
  return snapshots.sort((a, b) => new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0));
}

module.exports = { extractChallengeSnapshots };
