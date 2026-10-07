"use strict";

const REFERENCE_CATEGORIES_2026_10_07 = Object.freeze({
  "PvE": { level: 49, targetMight: 26000000, seasonPoints: 200 },
  "Coleta": { level: 39, targetMight: 2000000, seasonPoints: 200 },
  "Magos Engarrafadores": { level: 10, targetMight: 43000, seasonPoints: 180 },
  "Núcleos de Esconderijo": { level: 42, targetMight: 15000000, seasonPoints: 660 },
  "Cristais de Território": { level: 58, targetMight: 26000000, seasonPoints: 1200 },
  "Tesouros": { level: 44, targetMight: 5600000, seasonPoints: 368 },
  "Aranhas": { level: 68, targetMight: 5000000, seasonPoints: 700 },
  "Contrabandistas": { level: 51, targetMight: 14000000, seasonPoints: 424 },
  "Hellgates": { level: 17, targetMight: 256000, seasonPoints: 100 },
  "As Profundezas": { level: 56, targetMight: 1200000, seasonPoints: 200 },
  "Masmorras Corrompidas": { level: 28, targetMight: 109000, seasonPoints: 50 },
  "Castelos e Postos": { level: 38, targetMight: 18000000, seasonPoints: 1200 },
  "Caça aos Dragões": { level: 5, targetMight: 594000, seasonPoints: 280 },
  "Terras Ancestrais": { level: 48, targetMight: 2400000, seasonPoints: 200 }
});

function spPerMight({ level, targetMight, seasonPoints }) {
  const n = Number(level);
  const target = Number(targetMight);
  const sp = Number(seasonPoints);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(target) || target <= 0 || !Number.isFinite(sp) || sp < 0) return 0;
  return sp / (target / (n + 1));
}

function referenceWeightsPerMillion() {
  const out = {};
  for (const [name, category] of Object.entries(REFERENCE_CATEGORIES_2026_10_07)) {
    out[name] = spPerMight(category) * 1000000;
  }
  return out;
}

function pathJoin(base, key) {
  return base ? base + "." + key : String(key);
}

function flattenPhoton(value, { depth = 0, path = "", arrays = [], scalars = [] } = {}) {
  if (depth > 7) return { arrays, scalars };

  if (Array.isArray(value)) {
    arrays.push({ path, value });
    for (let i = 0; i < value.length; i++) {
      const nested = value[i];
      if (nested && typeof nested === "object") {
        flattenPhoton(nested, { depth: depth + 1, path: pathJoin(path, i), arrays, scalars });
      }
    }
    return { arrays, scalars };
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = pathJoin(path, key);
      if (Array.isArray(nested) || (nested && typeof nested === "object")) {
        flattenPhoton(nested, { depth: depth + 1, path: nextPath, arrays, scalars });
      } else {
        scalars.push({ path: nextPath, value: nested });
      }
    }
    return { arrays, scalars };
  }

  scalars.push({ path, value });
  return { arrays, scalars };
}

function isPlayerName(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length >= 2 && v.length <= 32 && /^[\p{L}\p{N}_-]+$/u.test(v);
}

function isMightNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value);
}

function inferContributionLayout(parameters) {
  const { arrays, scalars } = flattenPhoton(parameters || {});
  const stringArrays = arrays.filter(entry =>
    entry.value.length >= 2 &&
    entry.value.length <= 500 &&
    entry.value.every(v => typeof v === "string")
  );
  const numericArrays = arrays.filter(entry =>
    entry.value.length >= 2 &&
    entry.value.length <= 500 &&
    entry.value.every(isMightNumber)
  );

  const candidates = [];
  for (const names of stringArrays) {
    const nameQuality = names.value.filter(isPlayerName).length / names.value.length;
    if (nameQuality < 0.6) continue;

    for (const might of numericArrays) {
      if (might.value.length !== names.value.length) continue;
      const positive = might.value.filter(v => v > 0).length / might.value.length;
      const max = Math.max(...might.value);
      let confidence = 0.55 + 0.25 * nameQuality + 0.15 * positive;
      if (max >= 1000) confidence += 0.05;
      confidence = Math.min(1, confidence);

      candidates.push({
        namesPath: names.path,
        mightPath: might.path,
        count: names.value.length,
        confidence: Number(confidence.toFixed(3)),
        sample: names.value.slice(0, 5).map((name, index) => ({
          player: name,
          might: might.value[index]
        }))
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || b.count - a.count);

  return {
    candidates,
    numericScalars: scalars
      .filter(entry => typeof entry.value === "number" && Number.isFinite(entry.value))
      .slice(0, 80),
    stringScalars: scalars
      .filter(entry => typeof entry.value === "string" && entry.value.length <= 120)
      .slice(0, 80)
  };
}

function correlateProbeRows(rows, { windowMs = 10000 } = {}) {
  const ordered = [...(rows || [])].sort((a, b) =>
    new Date(a.occurred_at || a.occurredAt || 0) - new Date(b.occurred_at || b.occurredAt || 0)
  );
  const pending = new Map();
  const pairs = [];
  const unpairedResponses = [];

  for (const row of ordered) {
    const payload = row.payload || {};
    const direction = String(payload.direction || "response").toLowerCase();
    const operationName = String(payload.operationName || "unknown");
    const operationCode = payload.operationCode ?? null;
    const deviceId = String(row.device_id || row.deviceId || "");
    const at = new Date(row.occurred_at || row.occurredAt || 0);
    const atMs = at.getTime();
    const key = deviceId + "\u001f" + operationName;

    if (direction === "request") {
      pending.set(key, row);
      continue;
    }

    const req = pending.get(key) || null;
    const reqAtMs = req ? new Date(req.occurred_at || req.occurredAt || 0).getTime() : NaN;
    const ageMs = Number.isFinite(atMs) && Number.isFinite(reqAtMs) ? atMs - reqAtMs : Number.POSITIVE_INFINITY;
    const correlated = req && ageMs >= 0 && ageMs <= windowMs ? req : null;

    if (correlated) pending.delete(key);
    else unpairedResponses.push(row);

    const responseParameters = payload.parameters || {};
    pairs.push({
      deviceId,
      observer: row.player_name || row.playerName || null,
      operationName,
      operationCode,
      requestEventId: correlated?.event_id || correlated?.eventId || null,
      responseEventId: row.event_id || row.eventId || null,
      requestAt: correlated?.occurred_at || correlated?.occurredAt || null,
      responseAt: row.occurred_at || row.occurredAt || null,
      latencyMs: correlated ? ageMs : null,
      requestParameters: correlated?.payload?.parameters || null,
      responseParameters,
      discovery: inferContributionLayout(responseParameters)
    });
  }

  return {
    pairs: pairs.sort((a, b) => new Date(b.responseAt || 0) - new Date(a.responseAt || 0)),
    pendingRequests: [...pending.values()],
    unpairedResponses
  };
}

module.exports = {
  REFERENCE_CATEGORIES_2026_10_07,
  spPerMight,
  referenceWeightsPerMillion,
  flattenPhoton,
  inferContributionLayout,
  correlateProbeRows
};
