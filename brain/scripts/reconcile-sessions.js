'use strict';
/**
 * reconcile-sessions.js — finish the sessions that never got a SessionEnd (codex-parity D3).
 *
 * Codex fires SessionEnd late (thread close, or 30 minutes idle) and never under `codex exec`;
 * a Claude Code terminal can be killed. Either way a live run header stays behind under
 * brain/_index/agent-runs/live/ and everything that runs at SessionEnd — the telemetry summary,
 * auto-cost, auto-wrap's memory extraction — silently never happens. This hook runs on
 * SessionStart and Stop of both hosts, detaches at once, and for every live run whose header,
 * live file and transcript are all older than telemetry.staleAfterMinutes (default 30):
 *   1. telemetry-hook endRun(id, 'reconciled') with ended_at = the transcript's last change;
 *   2. auto-cost --cost-one, then auto-wrap in its detached mode, each as a child with AOS_HOST set
 *      from the header — the same two workers SessionEnd would have spawned, one session at a time.
 * A later real SessionEnd finds no live file and is a no-op; auto-cost's "numeric cost = costed"
 * check and auto-wrap's ledger keep both workers idempotent. At most one sweep per 5 minutes
 * (an mtime stamp, brain/_index/agent-runs/.reconcile); --force ignores the stamp, --dry-run lists
 * what would be reconciled and changes nothing. Exits 0 with empty stdout on every failure path.
 */
const { PATHS } = require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const host = require('./lib/host.js');

const RUNS_DIR = path.join(PATHS.VAULT, 'brain', '_index', 'agent-runs');
const LIVE_DIR = path.join(RUNS_DIR, 'live');
const STAMP = path.join(RUNS_DIR, '.reconcile');
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MIN = 30;

function readHeader(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n').find(Boolean);
    const h = first ? JSON.parse(first) : null;
    return h && h.type === 'run_start' && h.session_id ? h : null;
  } catch { return null; }
}

function mtimeOf(file) { try { return fs.statSync(file).mtime; } catch { return null; } }

/** The live runs idle for longer than staleMs: [{ sessionId, host, liveFile, transcript, endedAt }]. */
function findStale({ liveDir = LIVE_DIR, staleMs, now = Date.now(), findTranscript = host.findTranscript } = {}) {
  let names = [];
  try { names = fs.readdirSync(liveDir).filter((n) => n.endsWith('.ndjson')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const liveFile = path.join(liveDir, name);
    const header = readHeader(liveFile);
    if (!header) continue;
    const started = Date.parse(header.started_at || '') || 0;
    const liveAt = mtimeOf(liveFile);
    if (!liveAt || now - started < staleMs || now - liveAt.getTime() < staleMs) continue;
    const hostName = header.host === 'codex' ? 'codex' : 'claude';
    let transcript = null;
    try { transcript = findTranscript(hostName, header.session_id) || null; } catch { transcript = null; }
    const tAt = transcript ? mtimeOf(transcript) : null;
    if (tAt && now - tAt.getTime() < staleMs) continue;
    const endedAt = tAt && tAt > liveAt ? tAt : liveAt;
    out.push({ sessionId: header.session_id, host: hostName, liveFile, transcript, endedAt });
  }
  return out;
}

function spawnWorker(script, args, env, spawn = spawnSync) {
  try {
    spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'ignore', env, timeout: 10 * 60 * 1000 });
  } catch { /* the workers keep their own ledgers */ }
}

/** Reconcile every stale run. deps: { endRun, spawn, findTranscript, now, staleMs, liveDir } for tests. */
function reconcile({ dryRun = false, deps = {} } = {}) {
  const staleMs = deps.staleMs != null ? deps.staleMs : staleMinutes() * 60 * 1000;
  const stale = findStale({ liveDir: deps.liveDir, staleMs, now: deps.now, findTranscript: deps.findTranscript });
  const done = [];
  for (const s of stale) {
    if (dryRun) { done.push(s); continue; }
    const endRun = deps.endRun || require('./telemetry-hook.js').endRun;
    let ended = false;
    try { ended = endRun(s.sessionId, 'reconciled', { transcriptPath: s.transcript || '', endedAt: s.endedAt }); } catch { ended = false; }
    if (!ended) continue;
    const env = { ...process.env, AOS_HOST: s.host, AOS_DETACHED: '1' };
    spawnWorker('auto-cost.js', ['--cost-one', s.sessionId, s.transcript || ''], env, deps.spawn);
    spawnWorker('auto-wrap.js', [], { ...env, AUTO_WRAP_DETACHED: '1', BRAIN_TRANSCRIPT: s.transcript || '', BRAIN_SESSION_ID: s.sessionId }, deps.spawn);
    done.push(s);
  }
  return done;
}

function staleMinutes() {
  try {
    const t = require('./lib/config.js').loadConfig().telemetry || {};
    const n = Number(t.staleAfterMinutes);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MIN;
  } catch { return DEFAULT_STALE_MIN; }
}

function telemetryEnabled() {
  try { return (require('./lib/config.js').loadConfig().telemetry || {}).enabled !== false; } catch { return true; }
}

/** True when a sweep ran within the last 5 minutes (and --force is absent). Touches the stamp otherwise. */
function throttled(force, stampFile = STAMP, now = Date.now()) {
  if (force) return false;
  const at = mtimeOf(stampFile);
  if (at && now - at.getTime() < SWEEP_EVERY_MS) return true;
  try { fs.mkdirSync(path.dirname(stampFile), { recursive: true }); fs.writeFileSync(stampFile, new Date(now).toISOString() + '\n'); } catch { /* best effort */ }
  return false;
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  // Under a hook: drain stdin (the payload only tells us the host), answer Stop's JSON contract, and
  // hand the sweep to a detached child so the session never waits.
  if (host.isHookInvocation() && process.env.AOS_DETACHED !== '1') {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      let input = null;
      try { input = JSON.parse(raw || '{}'); } catch { input = null; }
      try { if (telemetryEnabled() && !throttled(force)) require('./lib/detach.js').respawnDetached(argv); } catch { /* never fail a hook */ }
      const ev = input && (input.hook_event_name || input.hookEventName);
      if (ev === 'Stop') require('./lib/hook-entry.js').finishStop(input);
      process.exit(0);
    });
    return;
  }
  try {
    if (!telemetryEnabled()) { process.exit(0); }
    if (!dryRun && !force && process.env.AOS_DETACHED !== '1' && throttled(false)) { process.exit(0); }
    const done = reconcile({ dryRun });
    if (dryRun || process.env.AOS_DETACHED !== '1') {
      for (const s of done) process.stdout.write(`[reconcile] ${dryRun ? 'would reconcile' : 'reconciled'} ${s.host} session ${s.sessionId}${s.transcript ? '' : ' (no transcript)'}\n`);
      if (!done.length) process.stdout.write('[reconcile] nothing stale\n');
    }
  } catch (e) {
    if (process.env.AOS_DEBUG === '1') process.stderr.write(`[reconcile] ${e && e.message}\n`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { findStale, reconcile, throttled, readHeader, SWEEP_EVERY_MS, DEFAULT_STALE_MIN };
