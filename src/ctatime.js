"use strict";

const ROLLOVER_MARGIN_MS = 2 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ctaPingTime(event) {
  if (!event) return null;

  if (event.remind_10) {
    const reminder = new Date(event.remind_10);
    if (Number.isFinite(reminder.getTime())) {
      return new Date(reminder.getTime() + TEN_MINUTES_MS);
    }
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(String(event.time_label || "").trim());
  if (!match) return null;

  const base = new Date(event.created_at);
  if (!Number.isFinite(base.getTime())) return null;

  let ping = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
    0,
    0
  ));

  if (ping.getTime() < base.getTime() - ROLLOVER_MARGIN_MS) {
    ping = new Date(ping.getTime() + DAY_MS);
  }

  return ping;
}

module.exports = { ctaPingTime };
