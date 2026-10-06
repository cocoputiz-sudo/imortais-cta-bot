"use strict";

const assert = require("assert/strict");
const locale = require("../src/locale");

assert.equal(locale.canonicalWeapon("silencio en la call"), null);
assert.equal(locale.canonicalWeapon("silencio"), "SILENCE");
assert.equal(
  locale.canonicalWeapon("maza pesada con runa de guardia"),
  "MAÇA PESADA W RUNA GUARDA"
);

const labels = Object.entries(locale.WEAPON_ES);
assert.equal(labels.length, 52, "o catálogo espanhol deve continuar com 52 rótulos");

for (const [weapon, label] of labels) {
  assert.equal(
    locale.canonicalWeapon(label),
    weapon,
    "round-trip espanhol falhou para " + label + " -> " + weapon
  );
}

console.log("✅ locale: frase com silencio não casa");
console.log("✅ locale: silencio exato casa SILENCE");
console.log("✅ locale: nome espanhol mais longo vence MAZA PESADA");
console.log("✅ locale: 52/52 rótulos espanhóis fazem round-trip");
console.log("✅ Locale weapons suite: TODOS OS TESTES PASSARAM");
