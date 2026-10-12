"use strict";

const { normName } = require("./playerName");

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

// Uma observação só é atual enquanto o device tem heartbeat recebido pelo servidor.
// A composição pode não mudar por horas: deduplicação de snapshots não é perda de PT.
function buildPartyObservations(rows, planned = new Map(), options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const heartbeatFreshMs = options.heartbeatFreshMs || 60_000;
  const samples = (rows || []).map(row => {
    const members = new Map();
    const arr = Array.isArray(row.payload?.members) ? row.payload.members : [];
    for (const name of arr) {
      const key = normName(name);
      if (key && !members.has(key)) members.set(key, String(name).trim());
    }
    const solo = members.size === 1 && members.has(normName(row.player_name));
    const heartbeatAt = timestamp(row.heartbeat_received_at);
    const receivedAt = timestamp(row.received_at);
    return {
      deviceId: String(row.device_id || ""), observer: String(row.player_name || ""),
      occurredAt: row.occurred_at, receivedAt: row.received_at,
      heartbeatAt: row.heartbeat_received_at || null,
      ageMs: receivedAt ? Math.max(0, now - receivedAt) : null,
      fresh: !!heartbeatAt && now >= heartbeatAt - 5_000 && now - heartbeatAt <= heartbeatFreshMs,
      solo, members
    };
  }).filter(s => s.members.size);

  // Apenas observadores ativos podem conectar PTs. Uma troca de party pode
  // deixar um nome em comum entre duas listas sem que elas sejam a mesma PT.
  const overlap = (a, b) => {
    let shared = 0;
    for (const key of a.members.keys()) if (b.members.has(key)) shared++;
    return shared;
  };
  const substantial = (a, b, shared) =>
    shared * 2 >= Math.min(a.members.size, b.members.size);
  const parent = samples.map((_, i) => i);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const unite = (a, b) => { const ra = root(a), rb = root(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    if (!a.fresh || a.solo) continue;
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j];
      // Um snapshot solo representa saída da PT, não confirmação de formação.
      if (!b.fresh || b.solo) continue;
      if (substantial(a, b, overlap(a, b))) unite(i, j);
    }
  }

  const clusters = new Map();
  samples.forEach((sample, index) => {
    if (!sample.fresh) return;
    const id = root(index);
    if (!clusters.has(id)) clusters.set(id, []);
    clusters.get(id).push(sample);
  });

  // Snapshots de devices sem heartbeat nunca participam do union-find.
  // Podem complementar UMA party ativa, mas não conectar duas parties.
  const activeClusters = [...clusters.values()];
  samples.forEach((sample, index) => {
    if (sample.fresh) return;
    let best = null, maxShared = 0, bestRatio = 0, ambiguous = false;
    if (!sample.solo) for (const cluster of activeClusters) {
      for (const active of cluster) {
        if (active.solo) continue;
        const shared = overlap(sample, active);
        if (!substantial(sample, active, shared)) continue;
        const ratio = shared / Math.min(sample.members.size, active.members.size);
        if (shared > maxShared || (shared === maxShared && ratio > bestRatio)) {
          best = cluster;
          maxShared = shared;
          bestRatio = ratio;
          ambiguous = false;
        } else if (shared === maxShared && ratio === bestRatio && best !== cluster) {
          ambiguous = true;
        }
      }
    }
    if (best && !ambiguous) best.push(sample);
    else clusters.set(index, [sample]);
  });

  // Resolva duplicações ENTRE clusters antes de construir suas listas,
  // usando exclusivamente received_at (servidor), com desempate pelo heartbeat.
  const newestForName = new Map();
  for (const sample of samples) for (const key of sample.members.keys()) {
    const prior = newestForName.get(key);
    if (!prior || timestamp(sample.receivedAt) > timestamp(prior.receivedAt)
      || (timestamp(sample.receivedAt) === timestamp(prior.receivedAt)
        && sample.fresh && !prior.fresh)) newestForName.set(key, sample);
  }
  const parties = [...clusters.values()].map(cluster => {
    const memberDetails = new Map();
    const devices = new Set(), activeDevices = new Set();
    let occurredAt = null, receivedAt = null;
    for (const sample of cluster) {
      devices.add(sample.deviceId);
      if (sample.fresh && !sample.solo) activeDevices.add(sample.deviceId);
      if (timestamp(sample.occurredAt) > timestamp(occurredAt)) occurredAt = sample.occurredAt;
      if (timestamp(sample.receivedAt) > timestamp(receivedAt)) receivedAt = sample.receivedAt;
      for (const [key, name] of sample.members) {
        if (newestForName.get(key) !== sample) continue;
        const candidate = { name, key, deviceId: sample.deviceId,
          receivedAt: sample.receivedAt, occurredAt: sample.occurredAt,
          heartbeatAt: sample.heartbeatAt, ageMs: sample.ageMs, stale: !sample.fresh, solo: sample.solo };
        const previous = memberDetails.get(key);
        // Fonte mais nova pelo relógio do servidor. Empate: fonte ativa.
        if (!previous || timestamp(candidate.receivedAt) > timestamp(previous.receivedAt)
          || (timestamp(candidate.receivedAt) === timestamp(previous.receivedAt)
            && previous.stale && !candidate.stale)) memberDetails.set(key, candidate);
      }
    }
    return { memberDetails, members: [...memberDetails.values()].map(x => x.name),
      memberKeys: new Set(memberDetails.keys()), devices, activeDevices, receivedAt, occurredAt };
  }).filter(p => p.memberDetails.size);
  const candidates = [];
  parties.forEach((party, i) => {
    // Um snapshot só com o próprio personagem é o estado de saída de party.
    if (!party.activeDevices.size && [...party.memberDetails.values()].every(x => x.solo)) return;
    for (const [display, names] of planned) {
      let overlap = 0;
      for (const key of party.memberKeys) if (names.has(key)) overlap++;
      if (overlap) candidates.push({ index: i, display, overlap,
        score: overlap / (new Set([...party.memberKeys, ...names]).size || 1) });
    }
  });
  candidates.sort((a,b) => b.overlap-a.overlap || b.score-a.score);
  const usedReal = new Set(), usedDisplay = new Set();
  for (const c of candidates) {
    if (usedReal.has(c.index) || usedDisplay.has(c.display)) continue;
    parties[c.index].display = c.display;
    parties[c.index].overlap = c.overlap;
    usedReal.add(c.index); usedDisplay.add(c.display);
  }
  const actualByName = new Map();
  for (const p of parties) for (const [key, detail] of p.memberDetails) {
    const current = actualByName.get(key);
    const candidate = { ...detail, party: detail.solo ? null : (p.display || null),
      partyLabel: detail.solo ? "Fora de PT (solo)"
        : p.display ? `PT ${p.display}` : "Party não identificada",
      devices: p.devices.size, activeDevices: p.activeDevices.size };
    if (!current || timestamp(candidate.receivedAt) > timestamp(current.receivedAt)
      || (timestamp(candidate.receivedAt) === timestamp(current.receivedAt)
          && current.stale && !candidate.stale)) actualByName.set(key,candidate);
  }
  const coverage = new Map();
  for (const p of parties) if (p.display != null) {
    const prev = coverage.get(p.display);
    if (!prev) coverage.set(p.display,{ party:p.display,
      devices:p.devices.size, activeDevices:p.activeDevices.size,
      receivedAt:p.receivedAt, observers: [...p.devices] });
    else {
      prev.devices += p.devices.size; prev.activeDevices += p.activeDevices.size;
    }
  }
  return { parties, actualByName, coverage, samples };
}

module.exports = { buildPartyObservations };
