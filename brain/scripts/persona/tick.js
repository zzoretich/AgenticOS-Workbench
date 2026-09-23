#!/usr/bin/env node
'use strict';
/**
 * tick.js — the runner-side half of the hourly `tick` duty (docs/superpowers/specs/2026-09-22-persona-tick-design.md).
 * The duty itself is a model run (persona/duties/tick.md through run-duty.sh, 0.10 USD, read-only tools); this script
 * is what makes it cheap and deterministic. run-duty.sh calls two verbs around the model:
 *
 *   precheck   first records the recheck confirmations (spec 2026-09-22-persona-earned-autonomy-design D2: recheck.js
 *              `record`, at most once per local day, never fatal), then compares a signature of the vault's inputs with
 *              the one recorded at the last beat and exits 3 when nothing changed — the runner then skips the model
 *              call (one duty-log line, no journal entry).
 *   beat       after the duty met its contract: records the beat and the signature the next precheck compares with,
 *              then (spec 2026-09-22-persona-reflect-daily-design D7) starts `reflect-daily` early — detached, through
 *              routines/run-routine.js with trigger `early` — when the queue holds persona.tick.earlyReflect.corrections
 *              (3) corrections or duty failures weighing persona.tick.earlyReflect.dutyFailures (2), a queued failure of
 *              duty s weighing max(1, its failStreak in brain/_index/routines.json). At most once per local day, and only
 *              while brain/routines/reflect-daily.md exists and is enabled.
 *
 * and the model calls two more:
 *
 *   signals    the candidates since the last beat, each with a type and a source pointer, computed here so the model
 *              spends its budget on judgement (queue or drop), not on discovery:
 *                correction    a feedback memory or draft written since the last beat
 *                duty-failure  a beat the watchdog marked failed or missed since the last beat
 *                repo-stall    a tracked repo (persona/repos.json) whose .planning/STATE.md idled past the threshold
 *                regressed     an approved proposal the ledger marked regressed since the last beat
 *                flag-aged     a `- [ ] <date>` flag in STATE.md older than persona.tick.flagAgeDays (default 7)
 *   queue <type> --source <ptr> [--note <text>]
 *              appends one line to <vault>/persona/queue.jsonl — { schema: 1, ts, type, source, note, by: "tick" } —
 *              unless the same (type, source) is already queued. Slice 3's daily reflect drains the queue.
 *
 * Signature: newest mtimes of persona/journal, brain/memory/feedback and its _drafts, persona/STATE.md,
 * persona/proposals, persona/ledger.jsonl, and per tracked repo .git/HEAD, .git/index, .git/logs/HEAD and
 * .planning/STATE.md — plus the watchdog's beats by (slug, status, lastRunAt), not the file's mtime, because
 * brain/_index/persona-heartbeat.json is rewritten every 30 minutes whether or not anything happened. `beat`
 * refreshes only the journal and STATE.md keys after the run (the two files the tick writes), so the tick's own
 * writes never wake the next tick while a change that landed during the run still does.
 *
 * State: brain/_index/persona-tick.json (schema 1). Every path is injectable; --root <vault> for the CLI.
 * Exit codes: precheck 3 = unchanged; 2 = usage or an invalid queue call; 0 otherwise (a failure inside precheck or
 * beat is reported on stderr and exits 0 so the duty still runs). Under AOS_HEADLESS=1 (a duty) --root must be the
 * vault, or it exits 2 (lib/pin-root.js, spec 2026-09-23-duty-write-scope-design D3).
 */
const fs = require('fs');
const path = require('path');
const { assertPinned } = require('../lib/pin-root.js');

const SCHEMA = 1;
const TYPES = ['correction', 'duty-failure', 'repo-stall', 'regressed', 'flag-aged'];
const EXIT_UNCHANGED = 3;
const DEFAULT_FLAG_AGE_DAYS = 7;
const DEFAULT_EARLY_REFLECT = { corrections: 3, dutyFailures: 2 };
const REFLECT_DAILY = 'reflect-daily';
const DEFAULT_STALL_DAYS = 4;
const FIRST_RUN_WINDOW_MS = 24 * 3600e3;
const DAY_MS = 86400e3;
const REPO_FILES = ['.git/HEAD', '.git/index', '.git/logs/HEAD', '.planning/STATE.md'];
const FLAG_RE = /^- \[ \] (\d{4}-\d{2}-\d{2}) (.+)$/;

function defaultDeps(root) {
  const vault = root || require('../lib/paths.js').PATHS.VAULT;
  let config = () => ({});
  try { ({ loadConfig: config } = require('../lib/config.js')); } catch { /* no config module: defaults */ }
  return { vault, config, now: () => new Date() };
}

function files(deps) {
  const v = deps.vault;
  return {
    state: path.join(v, 'brain', '_index', 'persona-tick.json'),
    heartbeat: path.join(v, 'brain', '_index', 'persona-heartbeat.json'),
    queue: path.join(v, 'persona', 'queue.jsonl'),
    ledger: path.join(v, 'persona', 'ledger.jsonl'),
    stateMd: path.join(v, 'persona', 'STATE.md'),
    repos: path.join(v, 'persona', 'repos.json'),
    journal: path.join(v, 'persona', 'journal'),
    routines: path.join(v, 'brain', '_index', 'routines.json'),
    routinesDir: path.join(v, 'brain', 'routines'),
    feedback: path.join(v, 'brain', 'memory', 'feedback'),
    drafts: path.join(v, 'brain', 'memory', 'feedback', '_drafts'),
    proposals: path.join(v, 'persona', 'proposals'),
  };
}

function readJson(file, what) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    console.error(`[tick] ${file} is not a JSON object — treating ${what} as empty`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[tick] ${file} unreadable: ${e.message} — treating ${what} as empty`);
  }
  return null;
}
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); else bad++; } catch { bad++; }
  }
  if (bad) console.error(`[tick] ${file}: skipped ${bad} unreadable line(s)`);
  return out;
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readState(deps) {
  const s = readJson(files(deps).state, 'the tick state');
  return s && s.schema === SCHEMA ? s : { schema: SCHEMA, lastBeatAt: null, lastSignature: null, lastPrecheckAt: null, pending: null, beats: 0, skipped: 0, lastEarlyReflectAt: null };
}
function writeState(deps, s) { writeAtomic(files(deps).state, JSON.stringify(s, null, 2) + '\n'); }

function mtime(file) { try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; } }
/** Newest mtime among a directory and its plain files (the directory's own mtime covers a deletion). */
function newest(dir) {
  let best = mtime(dir);
  if (best === null) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return best; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const t = mtime(path.join(dir, e.name));
    if (t !== null && t > best) best = t;
  }
  return best;
}
/** persona/repos.json — the sitrep's shape: { stall_threshold_days?, repos?: [{ name, path }] }. */
function loadRepos(deps) {
  const cfg = readJson(files(deps).repos, 'the repo list') || {};
  const repos = Array.isArray(cfg.repos) ? cfg.repos.filter(r => r && typeof r.name === 'string' && typeof r.path === 'string') : [];
  const threshold = Number.isFinite(cfg.stall_threshold_days) && cfg.stall_threshold_days > 0 ? cfg.stall_threshold_days : DEFAULT_STALL_DAYS;
  return { threshold, repos };
}
function beatsKey(deps) {
  const hb = readJson(files(deps).heartbeat, 'the heartbeat');
  const beats = hb && hb.beats && typeof hb.beats === 'object' ? hb.beats : {};
  return Object.keys(beats).sort().map(slug => `${slug}:${beats[slug].status}:${beats[slug].lastRunAt || ''}`).join('|');
}

/** The change signature (see the header). Pure apart from stats. */
function signature(deps) {
  const f = files(deps);
  const repos = {};
  for (const r of loadRepos(deps).repos) {
    repos[r.name] = REPO_FILES.reduce((best, rel) => { const t = mtime(path.join(r.path, rel)); return t !== null && (best === null || t > best) ? t : best; }, null);
  }
  return {
    journal: newest(f.journal), feedback: newest(f.feedback), drafts: newest(f.drafts), state: mtime(f.stateMd),
    proposals: newest(f.proposals), ledger: mtime(f.ledger), repos, beats: beatsKey(deps),
  };
}
/** The keys that differ between two signatures; `repos.<name>` per repo. */
function diff(prev, cur) {
  if (!prev) return ['first-run'];
  const out = [];
  for (const k of ['journal', 'feedback', 'drafts', 'state', 'proposals', 'ledger', 'beats']) if (prev[k] !== cur[k]) out.push(k);
  const names = new Set([...Object.keys(prev.repos || {}), ...Object.keys(cur.repos || {})]);
  for (const n of [...names].sort()) if ((prev.repos || {})[n] !== (cur.repos || {})[n]) out.push(`repos.${n}`);
  return out;
}

/** The confirmation pass (D2) — a broken recipe or a missing script never stops the tick. */
function recordConfirmations(deps, now) {
  try {
    const recheck = deps.recheck || require('./recheck.js');
    return recheck.record({ root: deps.vault, now });
  } catch (e) {
    console.error(`[tick] confirmations not recorded: ${e.message}`);
    return { recorded: false, error: e.message };
  }
}

/** Runner verb. Records the confirmations, then the pending signature; `changed: false` means the runner skips the model call. */
function precheck({ deps = defaultDeps(), now = deps.now() } = {}) {
  const confirmations = recordConfirmations(deps, now);
  const s = readState(deps);
  const sig = signature(deps);
  const changes = diff(s.lastSignature, sig);
  const changed = changes.length > 0;
  s.lastPrecheckAt = now.toISOString();
  s.pending = changed ? { at: s.lastPrecheckAt, signature: sig, changes } : null;
  if (!changed) s.skipped = (s.skipped || 0) + 1;
  writeState(deps, s);
  return { changed, changes, since: s.lastBeatAt, confirmations };
}

/** Runner verb. Promotes the pending signature, refreshing only what the tick itself writes; then the early-reflect check. */
function beat({ deps = defaultDeps(), now = deps.now() } = {}) {
  const s = readState(deps);
  const f = files(deps);
  const base = s.pending && s.pending.signature ? s.pending.signature : signature(deps);
  s.lastSignature = { ...base, journal: newest(f.journal), state: mtime(f.stateMd) };
  s.lastBeatAt = now.toISOString();
  s.beats = (s.beats || 0) + 1;
  s.pending = null;
  const earlyReflect = startEarlyReflect({ deps, now, state: s });
  writeState(deps, s);
  return { lastBeatAt: s.lastBeatAt, beats: s.beats, earlyReflect };
}

function earlyThresholds(cfg) {
  const e = (cfg && cfg.persona && cfg.persona.tick && cfg.persona.tick.earlyReflect) || {};
  const pick = (k) => (Number.isFinite(e[k]) && e[k] > 0 ? e[k] : DEFAULT_EARLY_REFLECT[k]);
  return { corrections: pick('corrections'), dutyFailures: pick('dutyFailures') };
}
/**
 * Pure: should the queue wake the daily reflect now? `entries` are the queue lines, `routinesState` is
 * brain/_index/routines.json (or null). A queued duty failure counts as that duty's fail streak, so one duty failing
 * twice in a row and two duties failing once both reach the default of 2.
 */
function shouldReflectEarly(entries, routinesState, thresholds = DEFAULT_EARLY_REFLECT) {
  const rows = (routinesState && routinesState.routines && typeof routinesState.routines === 'object') ? routinesState.routines : {};
  let corrections = 0, failures = 0;
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'correction') corrections++;
    else if (e.type === 'duty-failure') {
      const slug = String(e.source || '').split('#')[1] || '';
      failures += Math.max(1, Number(rows[slug] && rows[slug].failStreak) || 0);
    }
  }
  if (corrections >= thresholds.corrections) return { trigger: true, reason: `${corrections} corrections queued (threshold ${thresholds.corrections})`, corrections, failures };
  if (failures >= thresholds.dutyFailures) return { trigger: true, reason: `duty failures weigh ${failures} (threshold ${thresholds.dutyFailures})`, corrections, failures };
  return { trigger: false, reason: null, corrections, failures };
}
const pad2 = (n) => String(n).padStart(2, '0');
function localDay(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** The default starter: run-routine.js next to this script (checkout and vendored copy alike), detached, output ignored. */
function spawnDetached(argv, cwd) {
  const { spawn } = require('child_process');
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  return child.pid;
}
/** The D7 decision plus its guards; mutates `state.lastEarlyReflectAt` when it starts a run. Never throws. */
function startEarlyReflect({ deps, now, state }) {
  const f = files(deps);
  try {
    const decision = shouldReflectEarly(readJsonl(f.queue), readJson(f.routines, 'the routine state'), earlyThresholds(deps.config() || {}));
    if (!decision.trigger) return { started: false, reason: 'below threshold', corrections: decision.corrections, failures: decision.failures };
    if (state.lastEarlyReflectAt && localDay(new Date(state.lastEarlyReflectAt)) === localDay(now)) return { started: false, reason: `already started today (${state.lastEarlyReflectAt})`, why: decision.reason };
    const routine = require('../lib/routines-store.js').read(REFLECT_DAILY, { dir: f.routinesDir });
    if (!routine || routine.errors.length) return { started: false, reason: `no valid brain/routines/${REFLECT_DAILY}.md`, why: decision.reason };
    if (!routine.enabled) return { started: false, reason: `${REFLECT_DAILY} is disabled`, why: decision.reason };
    const argv = [deps.node || process.execPath, path.join(__dirname, '..', 'routines', 'run-routine.js'), REFLECT_DAILY, '--early'];
    const pid = (deps.spawnReflect || spawnDetached)(argv, deps.vault);
    state.lastEarlyReflectAt = now.toISOString();
    return { started: true, reason: decision.reason, pid: pid || null, argv };
  } catch (e) {
    console.error(`[tick] early reflect check failed: ${e.message}`);
    return { started: false, reason: `error: ${e.message}` };
  }
}

function listMd(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name).sort(); } catch { return []; }
}
function firstHeading(file) {
  try { const m = /^#\s+(.+)$/m.exec(fs.readFileSync(file, 'utf8')); return m ? m[1].trim().slice(0, 120) : null; } catch { return null; }
}
function rel(deps, file) { return path.relative(deps.vault, file).split(path.sep).join('/'); }

/** Model verb. Candidates since the last beat (the last 24 h on a first run), each flagged when already queued. */
function signals({ deps = defaultDeps(), now = deps.now() } = {}) {
  const s = readState(deps);
  const f = files(deps);
  const cfg = deps.config() || {};
  const tcfg = (cfg.persona && cfg.persona.tick) || {};
  const flagAgeDays = Number.isFinite(tcfg.flagAgeDays) && tcfg.flagAgeDays > 0 ? tcfg.flagAgeDays : DEFAULT_FLAG_AGE_DAYS;
  const sinceMs = Date.parse(s.lastBeatAt);
  const since = Number.isFinite(sinceMs) ? sinceMs : now.getTime() - FIRST_RUN_WINDOW_MS;
  const out = [];

  for (const dir of [f.drafts, f.feedback]) {
    for (const name of listMd(dir)) {
      const file = path.join(dir, name);
      const t = mtime(file);
      if (t === null || t <= since) continue;
      out.push({ type: 'correction', source: rel(deps, file), title: firstHeading(file) || name, at: new Date(t).toISOString() });
    }
  }

  const hb = readJson(f.heartbeat, 'the heartbeat');
  for (const [slug, b] of Object.entries((hb && hb.beats) || {})) {
    if (!b || (b.status !== 'failed' && b.status !== 'missed')) continue;
    const at = Date.parse(b.status === 'missed' ? b.due : b.lastRunAt);
    if (Number.isFinite(at) && at <= since) continue;
    out.push({ type: 'duty-failure', source: `${rel(deps, f.heartbeat)}#${slug}`, title: `duty '${slug}' ${b.status}`, at: Number.isFinite(at) ? new Date(at).toISOString() : null });
  }

  // The sitrep's stall rule (sitrep-state.js detectPlanning): idle .planning/STATE.md past the threshold. A stall is a
  // standing condition, not an event, so it is not filtered by `since`; the queue's dedupe keeps it to one entry.
  const { threshold, repos } = loadRepos(deps);
  for (const r of repos) {
    const stateFile = path.join(r.path, '.planning', 'STATE.md');
    const t = mtime(stateFile);
    if (t === null) continue;
    const idleDays = (now.getTime() - t) / DAY_MS;
    if (idleDays <= threshold) continue;
    out.push({ type: 'repo-stall', source: `${r.name}:.planning/STATE.md`, title: `${r.name} planning idle ${Math.round(idleDays * 10) / 10}d`, at: new Date(t).toISOString() });
  }

  for (const e of readJsonl(f.ledger)) {
    if (e.event !== 'regressed' || typeof e.slug !== 'string') continue;
    const at = Date.parse(e.ts);
    if (Number.isFinite(at) && at <= since) continue;
    out.push({ type: 'regressed', source: `${rel(deps, f.ledger)}#${e.slug}`, title: `approved proposal '${e.slug}' regressed`, at: e.ts || null });
  }

  let stateMd = '';
  try { stateMd = fs.readFileSync(f.stateMd, 'utf8'); } catch { /* no STATE.md */ }
  const sec = stateMd.split(/^## Flags\s*$/m)[1];
  for (const line of sec ? sec.split(/^## /m)[0].split('\n') : []) {
    const m = FLAG_RE.exec(line.trim());
    if (!m) continue;
    const opened = Date.parse(`${m[1]}T00:00:00`);
    if (!Number.isFinite(opened)) continue;
    const ageDays = Math.floor((now.getTime() - opened) / DAY_MS);
    if (ageDays < flagAgeDays) continue;
    out.push({ type: 'flag-aged', source: `${rel(deps, f.stateMd)}#${m[2].slice(0, 80)}`, title: `flag open ${ageDays}d: ${m[2].slice(0, 80)}`, at: new Date(opened).toISOString() });
  }

  const queued = new Set(readJsonl(f.queue).map(q => `${q.type}\u0000${q.source}`));
  for (const c of out) c.queued = queued.has(`${c.type}\u0000${c.source}`);
  return { since: new Date(since).toISOString(), flagAgeDays, stallDays: threshold, candidates: out };
}

/** Model verb. Appends one queue line unless the same (type, source) is already there. Throws on a bad call. */
function queue({ type, source, note, deps = defaultDeps(), now = deps.now() } = {}) {
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  if (typeof source !== 'string' || !source.trim()) throw new Error('--source <pointer> is required');
  const f = files(deps);
  const existing = readJsonl(f.queue).find(q => q.type === type && q.source === source);
  if (existing) return { duplicate: true, record: existing };
  const record = { schema: SCHEMA, ts: now.toISOString(), type, source, note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null, by: 'tick' };
  fs.mkdirSync(path.dirname(f.queue), { recursive: true });
  fs.appendFileSync(f.queue, JSON.stringify(record) + '\n');
  return { duplicate: false, record };
}

const VALUE_FLAGS = ['--root', '--source', '--note'];
/** argv minus flags and their values, in order (the interview.js pattern): `queue correction --source x` → ['queue', 'correction']. */
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (String(argv[i]).startsWith('--')) continue;
    out.push(argv[i]);
  }
  return out;
}

function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
  const [verb, type] = positionals(argv);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  try { assertPinned({ root: arg('--root') }); } catch (e) { process.stderr.write(`tick: ${e.message}\n`); return 2; }
  let deps;
  try { deps = defaultDeps(arg('--root')); } catch (e) { process.stderr.write(`tick: ${e.message}\n`); return 0; }
  try {
    switch (verb) {
      case 'precheck': { const r = precheck({ deps }); out(r); return r.changed ? 0 : EXIT_UNCHANGED; }
      case 'beat': out(beat({ deps })); return 0;
      case 'signals': process.stdout.write(JSON.stringify(signals({ deps }), null, 2) + '\n'); return 0;
      case 'status': out(readState(deps)); return 0;
      case 'queue': {
        try { out(queue({ type, source: arg('--source'), note: arg('--note'), deps })); return 0; } catch (e) { process.stderr.write(`tick queue: ${e.message}\n`); return 2; }
      }
      default:
        process.stderr.write('usage: tick.js precheck|beat|signals|status|queue <type> --source <pointer> [--note <text>] [--root <vault>]\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`tick ${verb}: ${e.message}\n`);
    return 0;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA, TYPES, EXIT_UNCHANGED, DEFAULT_FLAG_AGE_DAYS, DEFAULT_EARLY_REFLECT, signature, diff, precheck, recordConfirmations, beat, signals, queue, shouldReflectEarly, earlyThresholds, startEarlyReflect, readState, positionals, main };
