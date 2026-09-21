'use strict';
/**
 * cron.js — five-field cron expressions for routines (brain/routines/<slug>.md `schedule:`).
 * Zero dependencies. Local time, minute resolution.
 *
 *   parse(expr)                 → { minute, hour, dom, month, dow: Set<number>, restricted: {dom, dow}, raw }
 *   next(expr, after, count=1)  → Date[] — the next `count` fire times strictly after `after` (local time)
 *   describe(expr)              → "Weekdays at 07:45", "Every 15 minutes", … else the raw expression
 *   toLaunchd(expr)             → [{ Minute, Hour, Day?, Month?, Weekday? }, …] for StartCalendarInterval
 *
 * Fields: minute 0-59 · hour 0-23 · day-of-month 1-31 · month 1-12 (or jan..dec) · weekday 0-6 (or sun..sat; 7 = sun).
 * Forms per field: `*`, `n`, `a-b`, a step written as star-slash-n, `a-b/n`, and comma lists of those.
 * Deliberately narrower than Vixie cron: an expression that restricts BOTH day-of-month and weekday is
 * rejected, because cron ORs the two while launchd ANDs them — one meaning on both platforms beats a
 * silent difference. Every expression must expand to at most LAUNCHD_MAX calendar entries.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LAUNCHD_MAX = 64;
const SEARCH_DAYS = 366;

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  { name: 'dow', min: 0, max: 7, names: DAYS },
];

class CronError extends Error {
  constructor(msg) { super(msg); this.name = 'CronError'; }
}

function atom(token, field) {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  if (field.names) {
    const i = field.names.indexOf(t.slice(0, 3));
    if (i !== -1 && t.length === 3) return i + field.min;
  }
  throw new CronError(`${field.name}: "${token}" is not a number${field.names ? ' or a name' : ''}`);
}

function parseField(text, field) {
  const out = new Set();
  let restricted = false;
  for (const part of String(text).split(',')) {
    if (part === '') throw new CronError(`${field.name}: empty list item`);
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new CronError(`${field.name}: "${part}" is malformed`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new CronError(`${field.name}: step must be ≥ 1`);
    let lo, hi;
    if (m[1] === '*') { lo = field.min; hi = field.max; }
    else {
      restricted = true;
      const r = m[1].split('-');
      if (r.length > 2) throw new CronError(`${field.name}: "${part}" is malformed`);
      lo = atom(r[0], field);
      hi = r.length === 2 ? atom(r[1], field) : lo;
      if (m[2] !== undefined && r.length === 1) hi = field.max;   // `5/10` means 5-max/10
    }
    if (lo < field.min || hi > field.max) throw new CronError(`${field.name}: ${lo}-${hi} is outside ${field.min}-${field.max}`);
    if (lo > hi) throw new CronError(`${field.name}: range ${lo}-${hi} runs backwards`);
    for (let v = lo; v <= hi; v += step) out.add(field.name === 'dow' && v === 7 ? 0 : v);
  }
  const full = field.name === 'dow' ? 7 : field.max - field.min + 1;
  if (out.size === full) restricted = false;   // `1-31`, `0-6`, `jan-dec` mean the same as `*`
  return { set: out, restricted };
}

function parse(expr) {
  if (typeof expr !== 'string') throw new CronError('schedule must be a string');
  const raw = expr.trim().replace(/\s+/g, ' ');
  const parts = raw.split(' ');
  if (parts.length !== 5) throw new CronError(`expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  const parsed = FIELDS.map((f, i) => parseField(parts[i], f));
  const [minute, hour, dom, month, dow] = parsed.map(p => p.set);
  const restricted = { dom: parsed[2].restricted, dow: parsed[4].restricted };
  if (restricted.dom && restricted.dow) {
    throw new CronError('day-of-month and weekday cannot both be restricted (cron ORs them, launchd ANDs them)');
  }
  const out = { minute, hour, dom, month, dow, restricted, raw };
  const entries = calendarSize(out);
  if (entries > LAUNCHD_MAX) throw new CronError(`expands to ${entries} calendar entries; the limit is ${LAUNCHD_MAX}`);
  return out;
}

function calendarSize(c) {
  return c.minute.size * c.hour.size * (c.restricted.dom ? c.dom.size : 1) *
    (c.month.size === 12 ? 1 : c.month.size) * (c.restricted.dow ? c.dow.size : 1);
}

function sorted(set) { return [...set].sort((a, b) => a - b); }

function matchesDay(c, d) {
  if (c.month.size !== 12 && !c.month.has(d.getMonth() + 1)) return false;
  if (c.restricted.dom && !c.dom.has(d.getDate())) return false;
  if (c.restricted.dow && !c.dow.has(d.getDay())) return false;
  return true;
}

/** Next `count` fire times strictly after `after` (a Date), in local time. Bounded to SEARCH_DAYS. */
function next(expr, after = new Date(), count = 1) {
  const c = typeof expr === 'string' ? parse(expr) : expr;
  const out = [];
  const floor = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  const hours = sorted(c.hour);
  const minutes = sorted(c.minute);
  for (let i = 0; i < SEARCH_DAYS && out.length < count; i++) {
    const day = new Date(floor.getFullYear(), floor.getMonth(), floor.getDate() + i);
    if (!matchesDay(c, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        // A wall-clock time skipped by a DST jump lands in the next hour; keep only real matches.
        if (t.getHours() !== h || t.getMinutes() !== m) continue;
        if (t <= after) continue;
        out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

function pad(n) { return String(n).padStart(2, '0'); }
function times(c) {
  const out = [];
  for (const h of sorted(c.hour)) for (const m of sorted(c.minute)) out.push(`${pad(h)}:${pad(m)}`);
  return out;
}
function sameSet(set, arr) { return set.size === arr.length && arr.every(v => set.has(v)); }

/** Human cadence for the common shapes; the raw expression otherwise. */
function describe(expr) {
  let c;
  try { c = typeof expr === 'string' ? parse(expr) : expr; } catch { return String(expr); }
  const anyMonth = c.month.size === 12;
  const anyDay = !c.restricted.dom && !c.restricted.dow;
  if (c.hour.size === 24 && anyDay && anyMonth) {
    const m = sorted(c.minute);
    const step = m.length > 1 ? m[1] - m[0] : null;
    if (step && m.every((v, i) => v === m[0] + i * step) && m[0] === 0 && 60 % step === 0) return `Every ${step} minutes`;
    if (m.length === 1) return `Hourly at :${pad(m[0])}`;
  }
  if (c.minute.size === 1 && anyDay && anyMonth && c.hour.size > 1) {
    const h = sorted(c.hour);
    const step = h[1] - h[0];
    if (h.every((v, i) => v === h[0] + i * step) && h[0] === 0 && 24 % step === 0 && sorted(c.minute)[0] === 0) return `Every ${step} hours`;
  }
  if (c.hour.size > 4 || c.minute.size > 4) return c.raw;
  const at = times(c).join(', ');
  if (!anyMonth) return c.raw;
  if (anyDay) return `Every day at ${at}`;
  if (c.restricted.dom) {
    const d = sorted(c.dom);
    return d.length === 1 ? `Monthly on day ${d[0]} at ${at}` : `Monthly on days ${d.join(', ')} at ${at}`;
  }
  const d = sorted(c.dow);
  if (sameSet(c.dow, [1, 2, 3, 4, 5])) return `Weekdays at ${at}`;
  if (sameSet(c.dow, [0, 6])) return `Weekends at ${at}`;
  if (d.length === 1) return `${DAY_NAMES[d[0]]}s at ${at}`;
  return `${d.map(v => DAY_NAMES[v].slice(0, 3)).join(', ')} at ${at}`;
}

/** launchd StartCalendarInterval entries: the cross product of the restricted fields. */
function toLaunchd(expr) {
  const c = typeof expr === 'string' ? parse(expr) : expr;
  const days = c.restricted.dom ? sorted(c.dom) : [null];
  const months = c.month.size === 12 ? [null] : sorted(c.month);
  const weekdays = c.restricted.dow ? sorted(c.dow) : [null];
  const out = [];
  for (const wd of weekdays) for (const mo of months) for (const d of days) for (const h of sorted(c.hour)) for (const m of sorted(c.minute)) {
    const e = { Minute: m, Hour: h };
    if (d !== null) e.Day = d;
    if (mo !== null) e.Month = mo;
    if (wd !== null) e.Weekday = wd;
    out.push(e);
  }
  return out;
}

module.exports = { parse, next, describe, toLaunchd, CronError, LAUNCHD_MAX };
