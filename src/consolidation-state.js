"use strict";

const CONSOLIDATION_STEPS = Object.freeze([25, 20, 15, 10]);

function parseConsolidationSteps(value) {
  if (value instanceof Set) {
    return new Set([...value].map(Number).filter((step) => CONSOLIDATION_STEPS.includes(step)));
  }
  if (Array.isArray(value)) {
    return new Set(value.map(Number).filter((step) => CONSOLIDATION_STEPS.includes(step)));
  }
  return new Set(
    String(value || "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((step) => CONSOLIDATION_STEPS.includes(step))
  );
}

function isCtaFrozen(event) {
  return Boolean(event?.frozen_at);
}

function consolidationStepsToRun(minAteSaida, alreadyDone, status = "open") {
  if (status !== "open") return [];
  const minutes = Number(minAteSaida);
  if (!Number.isFinite(minutes)) return [];

  const done = parseConsolidationSteps(alreadyDone);
  if (minutes <= 25 && minutes > 20 && !done.has(25)) return [25];
  if (minutes <= 20 && minutes > 15 && !done.has(20)) return [20];
  if (minutes <= 15 && minutes > 10 && !done.has(15)) return [15];
  if (minutes <= 10 && minutes > -5 && !done.has(10)) return [10];
  return [];
}

module.exports = {
  CONSOLIDATION_STEPS,
  parseConsolidationSteps,
  isCtaFrozen,
  consolidationStepsToRun,
};
