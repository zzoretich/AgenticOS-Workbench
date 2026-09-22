#!/usr/bin/env node
'use strict';
/**
 * watchdog.js — the persona heartbeat. Model-free: it never calls a provider, so it cannot share the failure
 * mode of the duties it watches. Two callers:
 *   - the `heartbeat` command routine (brain/routines/heartbeat.md, every 30 min under launchd/cron)
 *   - the SessionStart hook (`aos persona-watchdog` → `--hook`), throttled to once per 30 min, silent on stdout
 *
 * A duty is MISSED when a fire time in its schedule has passed by more than persona.watchdog.graceMinutes
 * (default 45 — longer than PERSONA_TIMEOUT, so a duty still running is never a miss) since its last run
 * started, or since the schedules were synced if it never ran. The last run comes from routines-store.overview(),
 * which already merges brain/_index/routines.json with the duty log run-duty.sh writes.
 *
 * On a miss: one `- [ ] <date> duty '<slug>' MISSED — … (watchdog)` line directly under `## Flags` in STATE.md
 * (the same slot run-duty.sh uses for FAILED) and one OS notification, both once per (slug, due). The watchdog
 * removes its own MISSED line when that duty runs again; it never touches any other flag. Once a day it also
 * runs ledger.js verify and flags an approved proposal whose recheck exits 0 again as REGRESSED.
 *
 * State: brain/_index/persona-heartbeat.json (schema 1) — the HUD's source for a heartbeat pill.
 * Exit 0 always under --hook; as a routine, 1 only when the check itself throws.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEMA = 1;
const DEFAULT_GRACE_MIN = 45;
const HOOK_THROTTLE_MS = 30 * 60e3;
const VERIFY_EVERY_MS = 24 * 3600e3;
const MISSED_RE = /^- \[ \] \S+ duty '([a-z0-9-]+)' MISSED — .*\(watchdog\)$/;

function defaultDeps() {
  const { PATHS } = require('../lib/paths.js');
  const store = require('../lib/routines-store.js');
  const { loadConfig } = require('../lib/config.js');
  const cron = require('../lib/cron.js');
  const ledger = require('./ledger.js');
  return {
    vault: PATHS.VAULT,
    personaDir: PATHS.PERSONA,
    stateFile: path.join(PATHS.INDEX, 'persona-heartbeat.json'),
    store, cron, ledger,
    config: loadConfig,
    notify: (title, message) => osNotify(title, message),
    now: () => new Date(),
  };
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtLocal(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  } catch { /* missing or corrupt — start fresh */ }
  return {};
}

/** Best-effort OS notification: osascript on macOS, notify-send on Linux; never throws. */
function osNotify(title, message, { platform = process.platform } = {}) {
  try {
    if (platform === 'darwin') {
      execFileSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', message, title],
        { stdio: 'ignore', timeout: 5000 });
    } else if (platform === 'linux') {
      execFileSync('notify-send', [title, message], { stdio: 'ignore', timeout: 5000 });
    } else return false;
    return true;
  } catch { return false; }
}

function personaOff(cfg, personaDir) {
  return !!(cfg.persona && cfg.persona.enabled === false) || fs.existsSync(path.join(personaDir, 'DISABLED'));
}

/**
 * Pure. `rows` is routines-store.overview(); `syncedAt` the state file's. Every routine gets a beat; only
 * enabled duties can be missed. Status: ok | missed | failed | never | disabled | unwatched | invalid | stale.
 */
function check(rows, { now = new Date(), syncedAt = null, graceMs = DEFAULT_GRACE_MIN * 60e3, cron } = {}) {
  const beats = {};
  const misses = [];
  for (const r of rows) {
    const b = {
      kind: r.kind, schedule: r.schedule || null, enabled: !!r.enabled, health: r.health,
      lastRunAt: r.last ? r.last.at : null, lastExit: r.last ? r.last.exit : null,
      next: r.next && r.next[0] ? r.next[0] : null, due: null, status: 'ok',
    };
    if (!r.enabled) b.status = 'disabled';
    else if (r.kind !== 'duty') b.status = 'unwatched';
    else if (r.health === 'invalid' || r.health === 'stale') b.status = r.health;
    else {
      const from = b.lastRunAt || syncedAt;
      const due = from && cron ? cron.next(r.schedule, new Date(from), 1)[0] : null;
      if (due && now - due > graceMs) {
        b.status = 'missed';
        b.due = due.toISOString();
        misses.push({ slug: r.slug, due: b.due, lastRunAt: b.lastRunAt });
      } else if (typeof b.lastExit === 'number' && b.lastExit !== 0) b.status = 'failed';
      else if (!b.lastRunAt) b.status = 'never';
    }
    beats[r.slug] = b;
  }
  return { checkedAt: now.toISOString(), beats, misses };
}

/**
 * Pure. Adds a MISSED line for each miss not already present (skipping a (slug, due) the user already closed —
 * `alerted`), removes the watchdog's own MISSED lines for duties no longer missed, adds a REGRESSED line per
 * newly regressed approval, and leaves every other line alone. No `## Flags` heading → no change.
 */
function reconcileFlags(text, { misses = [], regressed = [], alerted = {}, today } = {}) {
  const lines = text.split('\n');
  const h = lines.findIndex(l => /^## Flags\s*$/.test(l));
  if (h === -1) return { text, added: [], removed: [] };
  let end = lines.findIndex((l, i) => i > h && /^## /.test(l));
  if (end === -1) end = lines.length;
  const missing = new Map(misses.map(m => [m.slug, m]));
  const kept = [], removed = [], present = new Set();
  for (const l of lines.slice(h + 1, end)) {
    const m = MISSED_RE.exec(l.trim());
    if (m) {
      if (missing.has(m[1])) { kept.push(l); present.add(m[1]); } else removed.push(m[1]);
      continue;
    }
    kept.push(l);
  }
  const added = [];
  for (const m of misses) {
    if (present.has(m.slug) || alerted[m.slug] === m.due) continue;
    added.push(`- [ ] ${today} duty '${m.slug}' MISSED — due ${fmtLocal(m.due)}, last run ${m.lastRunAt ? fmtLocal(m.lastRunAt) : 'never'} (watchdog)`);
  }
  for (const slug of regressed) added.push(`- [ ] ${today} approved proposal '${slug}' REGRESSED — its recheck exits 0 again (watchdog)`);
  if (!added.length && !removed.length) return { text, added, removed };
  const out = [...lines.slice(0, h + 1), ...added, ...kept, ...lines.slice(end)];
  return { text: out.join('\n'), added, removed };
}

/** One check. Returns { skipped } or { state, notified }. */
function run({ hook = false, deps = defaultDeps() } = {}) {
  const now = deps.now();
  const cfg = deps.config();
  if (personaOff(cfg, deps.personaDir)) return { skipped: 'persona off' };
  const wcfg = (cfg.persona && cfg.persona.watchdog) || {};
  const graceMinutes = Number.isFinite(wcfg.graceMinutes) && wcfg.graceMinutes >= 0 ? wcfg.graceMinutes : DEFAULT_GRACE_MIN;
  const notifyOn = wcfg.notify !== false;

  const prev = readState(deps.stateFile);
  const prevAt = Date.parse(prev.checkedAt);
  if (hook && Number.isFinite(prevAt) && now - prevAt >= 0 && now - prevAt < HOOK_THROTTLE_MS) return { skipped: 'fresh' };

  const st = deps.store.readState();
  const rows = deps.store.overview({ now });
  const res = check(rows, { now, syncedAt: st.syncedAt, graceMs: graceMinutes * 60e3, cron: deps.cron });

  let verify = prev.verify || null, lastVerifyAt = prev.lastVerifyAt || null, regressedNow = [];
  const lastVerify = Date.parse(lastVerifyAt);
  if (!Number.isFinite(lastVerify) || now - lastVerify >= VERIFY_EVERY_MS) {
    try {
      verify = deps.ledger.verify({ file: deps.ledger.defaultFile(deps.vault), root: deps.vault, now });
      regressedNow = verify.regressed;
    } catch (e) { verify = { error: e.message }; }
    lastVerifyAt = now.toISOString();
  }

  const alerted = { ...(prev.alerted || {}) };
  let flags = { added: [], removed: [] };
  const stateMd = path.join(deps.personaDir, 'STATE.md');
  try {
    const text = fs.readFileSync(stateMd, 'utf8');
    const r = reconcileFlags(text, { misses: res.misses, regressed: regressedNow, alerted, today: localDate(now) });
    if (r.text !== text) writeAtomic(stateMd, r.text);
    flags = { added: r.added, removed: r.removed };
  } catch { /* no STATE.md: nothing to flag */ }

  const notified = [];
  for (const m of res.misses) {
    if (alerted[m.slug] === m.due) continue;
    if (notifyOn) deps.notify('AgenticOS', `duty '${m.slug}' missed its ${fmtLocal(m.due)} run`);
    notified.push(m.slug);
    alerted[m.slug] = m.due;
  }
  for (const slug of regressedNow) if (notifyOn) deps.notify('AgenticOS', `approved proposal '${slug}' regressed — its recheck exits 0 again`);
  for (const slug of Object.keys(alerted)) if (!res.misses.some(m => m.slug === slug)) delete alerted[slug];

  const state = { schema: SCHEMA, checkedAt: res.checkedAt, graceMinutes, beats: res.beats, misses: res.misses, alerted, flags, lastVerifyAt, verify };
  writeAtomic(deps.stateFile, JSON.stringify(state, null, 2) + '\n');
  return { state, notified };
}

function main(argv) {
  const hook = argv.includes('--hook');
  if (hook) require('../lib/hook-entry.js').hookEntry();   // AOS_HEADLESS or no vault → exit 0 before any work
  let deps;
  try { deps = defaultDeps(); } catch (e) {
    process.stderr.write(`watchdog: ${e.message}\n`);
    return hook ? 0 : 1;
  }
  try {
    const out = run({ hook, deps });
    if (hook) return 0;
    if (out.skipped) { process.stdout.write(`watchdog: skipped — ${out.skipped}\n`); return 0; }
    const duties = Object.values(out.state.beats).filter(b => b.kind === 'duty' && b.enabled).length;
    const missed = out.state.misses.map(m => m.slug);
    process.stdout.write(`watchdog: ${duties} dut${duties === 1 ? 'y' : 'ies'} watched, ${missed.length} missed${missed.length ? ` (${missed.join(', ')})` : ''}${out.notified.length ? `, notified ${out.notified.join(', ')}` : ''}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`watchdog: ${e.message}\n`);
    return hook ? 0 : 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA, DEFAULT_GRACE_MIN, HOOK_THROTTLE_MS, VERIFY_EVERY_MS, check, reconcileFlags, run, osNotify, personaOff, fmtLocal, main };
