"use strict";

// O nome do personagem é o identificador; sufixos do Discord são decoração.
// Regras conservadoras: prefixos ! e [TAG] históricos, seguidos de nome
// alfanumérico (inclusive -/_ legados) de até 16 caracteres. Só descartamos
// um SUFIXO SEPARADO por espaço, inteiramente não alfanumérico.
// Não transformamos "Foo Bar" em "Foo", nem eliminamos pontuação interna.
function normName(value) {
  let out = String(value || "").trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^[!\s]+/u, "").replace(/^\[[^\]]{1,16}\]\s*/iu, "");
  } while (prev !== out);
  const decorated = /^([A-Za-z0-9][A-Za-z0-9_-]{1,15})\s+([^\p{L}\p{N}_-]+)$/u.exec(out);
  if (decorated) out = decorated[1];
  return out.trim().toLowerCase();
}

function findSignupCollisions(signups) {
  const byName = new Map();
  for (const signup of signups || []) {
    const key = normName(signup.username);
    if (!key) continue;
    const matches = byName.get(key) || [];
    matches.push(signup);
    byName.set(key, matches);
  }
  return new Map([...byName.entries()].filter(([, matches]) => matches.length > 1));
}

module.exports = { normName, findSignupCollisions };
