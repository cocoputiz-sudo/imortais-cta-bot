"use strict";

const assert = require("assert/strict");
const { sortCtaTimes, timeForCtaLabelUTC } = require("../src/ctatime");

function check(label, input, now, expected) {
  const before = [...input];
  const result = sortCtaTimes(input, new Date(now));
  assert.deepEqual(result, expected, label);
  assert.deepEqual(input, before, "ordenação não deve modificar os horários selecionados");
  console.log("✅ " + label);
}

// Regressão: 00:00 de amanhã não pode ser criado antes dos CTAs de hoje.
check("15:20 e 17:20 antes de 00:00 de amanhã",
  ["00:00", "17:20", "15:20"], "2026-10-10T14:48:00Z",
  ["15:20", "17:20", "00:00"]);

check("CTAs de noite atravessam meia-noite e seguem até 01:20",
  ["01:20", "21:20", "00:00", "19:20"], "2026-10-10T18:00:00Z",
  ["19:20", "21:20", "00:00", "01:20"]);

// 00:00 pode ser o próximo CTA real, mas não por ser o menor número.
check("00:00 é primeiro quando é de fato o próximo CTA",
  ["15:20", "01:20", "00:00"], "2026-10-10T22:30:00Z",
  ["00:00", "01:20", "15:20"]);

check("00:00 recém-iniciado mantém a margem de 2h",
  ["17:20", "00:00", "01:20"], "2026-10-11T00:15:00Z",
  ["00:00", "01:20", "17:20"]);

check("ordenação diurna permanece natural",
  ["21:20", "15:20", "17:20"], "2026-10-10T12:00:00Z",
  ["15:20", "17:20", "21:20"]);

assert.equal(
  timeForCtaLabelUTC("00:00", new Date("2026-10-10T14:48:00Z")).toISOString(),
  "2026-10-11T00:00:00.000Z"
);
assert.equal(
  timeForCtaLabelUTC("00:00", new Date("2026-10-11T00:15:00Z")).toISOString(),
  "2026-10-11T00:00:00.000Z"
);
console.log("\n✅ CTA chronological UTC order: TODOS OS TESTES PASSARAM");
