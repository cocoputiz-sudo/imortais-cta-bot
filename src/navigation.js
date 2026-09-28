const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "assets", "outlands-map.json");

let cache = null;

function norm(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadGraph() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const zones = Array.isArray(raw.zones) ? raw.zones : [];
  const byId = new Map();
  const byName = new Map();

  for (const zone of zones) {
    if (!zone || !zone.id || !zone.name) continue;
    byId.set(String(zone.id), zone);
    const key = norm(zone.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(zone);
  }

  cache = {
    meta: {
      schemaVersion: raw.schemaVersion,
      source: raw.source,
      importedAt: raw.importedAt,
      zoneTypes: raw.zoneTypes || []
    },
    zones,
    byId,
    byName
  };
  return cache;
}

function resetCache() {
  cache = null;
}

function zoneDisplay(zone) {
  if (!zone) return null;
  return {
    id: zone.id,
    name: zone.name,
    type: zone.type,
    tier: zone.tier == null ? null : Number(zone.tier),
    mapPosition: zone.mapPosition || null
  };
}

function searchZones(query, { limit = 25, blackOnly = false } = {}) {
  const graph = loadGraph();
  const q = norm(query);
  let rows = graph.zones.filter(z => !blackOnly || z.type === "black");

  if (q) {
    rows = rows
      .map(z => {
        const name = norm(z.name);
        const id = norm(z.id);
        let score = 99;
        if (name === q || id === q) score = 0;
        else if (name.startsWith(q)) score = 1;
        else if (id.startsWith(q)) score = 2;
        else if (name.includes(q)) score = 3;
        else if (id.includes(q)) score = 4;
        return { z, score };
      })
      .filter(x => x.score < 99)
      .sort((a, b) => a.score - b.score || a.z.name.localeCompare(b.z.name, "en"))
      .map(x => x.z);
  } else {
    rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 25))).map(zoneDisplay);
}

function resolveZone(query, { blackOnly = false } = {}) {
  const graph = loadGraph();
  const raw = String(query || "").trim();
  if (!raw) return { zone: null, matches: [] };

  const direct = graph.byId.get(raw);
  if (direct && (!blackOnly || direct.type === "black")) return { zone: direct, matches: [direct] };

  const key = norm(raw);
  const exact = (graph.byName.get(key) || []).filter(z => !blackOnly || z.type === "black");
  if (exact.length === 1) return { zone: exact[0], matches: exact };
  if (exact.length > 1) return { zone: null, matches: exact };

  const matches = searchZones(raw, { limit: 10, blackOnly })
    .map(x => graph.byId.get(x.id))
    .filter(Boolean);

  return { zone: matches.length === 1 ? matches[0] : null, matches };
}

function shortestRoute(fromQuery, toQuery) {
  const graph = loadGraph();
  const fromResolved = resolveZone(fromQuery);
  const toResolved = resolveZone(toQuery);
  if (!fromResolved.zone || !toResolved.zone) {
    return {
      ok: false,
      error: !fromResolved.zone ? "from_not_found" : "to_not_found",
      fromMatches: fromResolved.matches.map(zoneDisplay),
      toMatches: toResolved.matches.map(zoneDisplay)
    };
  }

  const start = fromResolved.zone;
  const target = toResolved.zone;

  if (start.id === target.id) {
    return {
      ok: true,
      from: zoneDisplay(start),
      to: zoneDisplay(target),
      maps: 0,
      steps: [{ zone: zoneDisplay(start), exit: null, port: null, next: null, entryPort: null }]
    };
  }

  const queue = [start.id];
  const previous = new Map([[start.id, null]]);
  const via = new Map();

  for (let qi = 0; qi < queue.length; qi++) {
    const currentId = queue[qi];
    if (currentId === target.id) break;
    const current = graph.byId.get(currentId);
    if (!current) continue;

    for (const edge of current.ports || []) {
      const nextId = String(edge.to || "");
      if (!nextId || !graph.byId.has(nextId) || previous.has(nextId)) continue;
      previous.set(nextId, currentId);
      via.set(nextId, {
        from: currentId,
        to: nextId,
        port: edge.port || edge.direction || "?",
        direction: edge.direction || edge.port || "?",
        toPort: edge.toPort || null
      });
      queue.push(nextId);
    }
  }

  if (!previous.has(target.id)) {
    return {
      ok: false,
      error: "no_route",
      from: zoneDisplay(start),
      to: zoneDisplay(target),
      fromMatches: [],
      toMatches: []
    };
  }

  const ids = [];
  for (let cur = target.id; cur != null; cur = previous.get(cur)) ids.push(cur);
  ids.reverse();

  const steps = ids.map((id, index) => {
    const zone = graph.byId.get(id);
    if (index === ids.length - 1) {
      return { zone: zoneDisplay(zone), exit: null, port: null, next: null, entryPort: null };
    }
    const nextId = ids[index + 1];
    const edge = via.get(nextId);
    return {
      zone: zoneDisplay(zone),
      exit: edge?.direction || edge?.port || "?",
      port: edge?.port || null,
      next: zoneDisplay(graph.byId.get(nextId)),
      entryPort: edge?.toPort || null
    };
  });

  return {
    ok: true,
    from: zoneDisplay(start),
    to: zoneDisplay(target),
    maps: Math.max(0, steps.length - 1),
    steps
  };
}

function nextInstruction(route) {
  if (!route?.ok || !Array.isArray(route.steps) || !route.steps.length) return null;
  if (route.steps.length === 1) {
    return {
      arrived: true,
      zone: route.steps[0].zone,
      mapsRemaining: 0,
      text: `DESTINO ALCANÇADO: ${route.steps[0].zone.name}`
    };
  }
  const step = route.steps[0];
  return {
    arrived: false,
    zone: step.zone,
    exit: step.exit,
    next: step.next,
    mapsRemaining: route.maps,
    text: `SAIR ${step.exit} → ${step.next.name}`
  };
}

function formatRoute(route, { maxSteps = 8 } = {}) {
  if (!route?.ok) return "Rota indisponível.";
  if (route.steps.length === 1) return `✅ Já estamos em **${route.to.name}**.`;

  const limit = Math.max(1, Math.min(20, Number(maxSteps) || 8));
  const visible = route.steps.slice(0, limit);
  const lines = visible.map((step, index) => {
    if (!step.next) return `${index + 1}. **${step.zone.name}** ✅ DESTINO`;
    return `${index + 1}. **${step.zone.name}** — sair **${step.exit}** → ${step.next.name}`;
  });
  if (route.steps.length > limit) lines.push(`… +${route.steps.length - limit} etapa(s)`);
  return lines.join("\n");
}

function stats() {
  const graph = loadGraph();
  return {
    zones: graph.zones.length,
    directedEdges: graph.zones.reduce((n, z) => n + (Array.isArray(z.ports) ? z.ports.length : 0), 0),
    source: graph.meta.source,
    importedAt: graph.meta.importedAt
  };
}

module.exports = {
  loadGraph,
  resetCache,
  norm,
  zoneDisplay,
  searchZones,
  resolveZone,
  shortestRoute,
  nextInstruction,
  formatRoute,
  stats
};
