'use strict';
/**
 * host-process.js — which OS process hosts this session, and is it still running (spec
 * 2026-09-23-codex-session-close-on-exit-design). Quitting the Codex TUI fires no SessionEnd for the session's own
 * thread, so telemetry-hook records the Codex process in the live header and reconcile-sessions finalizes the run
 * once that process is gone instead of waiting out telemetry.staleAfterMinutes.
 *
 *   findHostProcess('codex')                      → { pid, started } | null
 *   hostProcessState({ host_pid, host_started })  → 'alive' | 'gone' | 'unknown'
 *
 * One `ps -A` read under LC_ALL=C, so `lstart` has one format for the hook and the sweep (D2). The match is the
 * exact command basename — macOS reports the full path, and helpers under ~/.codex/ contain the word (D3) — and the
 * OUTERMOST match wins, so a short-lived helper re-exec'd under the same name can never stand in for the session.
 * Gone means the pid is dead (ESRCH), not ours (EPERM), or started at another time (reused); anything uncertain is
 * 'unknown', which leaves the run on the idle rule (D4). Never throws.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_HOPS = 32;
// pid, ppid, lstart (5 fields under LC_ALL=C: "Tue Sep 22 20:50:59 2026"), then comm, which may hold spaces.
const LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

function runPs(args) {
  return execFileSync('ps', args, {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  });
}

/** `ps` lstart (local time) → ISO, or null. */
function parseLstart(s) {
  const t = Date.parse(String(s || '').trim().replace(/\s+/g, ' '));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Map<pid, { ppid, started, comm }> from one process-table read; null when `ps` fails or prints nothing usable. */
function processTable({ run = runPs } = {}) {
  let out;
  try { out = run(['-A', '-o', 'pid=,ppid=,lstart=,comm=']); } catch { return null; }
  const table = new Map();
  for (const line of String(out || '').split('\n')) {
    const m = line.match(LINE);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), started: parseLstart(m[3]), comm: m[4] });
  }
  return table.size ? table : null;
}

/** The outermost ancestor of `pid` (itself included) whose command basename is `binary`: { pid, started } or null. */
function findHostProcess(binary, { pid = process.pid, table } = {}) {
  try {
    const t = table || processTable();
    if (!t) return null;
    let found = null;
    let cur = pid;
    for (let hop = 0; hop < MAX_HOPS && cur > 1; hop++) {
      const p = t.get(cur);
      if (!p) break;
      if (path.basename(p.comm) === binary) found = { pid: cur, started: p.started };
      cur = p.ppid;
    }
    return found;
  } catch { return null; }
}

/** The start time of one live pid as ISO, or null (gone meanwhile, or unreadable). */
function startedOf(pid, run = runPs) {
  try { return parseLstart(run(['-o', 'lstart=', '-p', String(pid)])); } catch { return null; }
}

/** 'gone' when the recorded host process has exited or its pid now names another process; 'alive'; or 'unknown'. */
function hostProcessState(rec, { kill = process.kill.bind(process), started = startedOf } = {}) {
  const pid = rec && rec.host_pid;
  if (!Number.isInteger(pid) || pid <= 1) return 'unknown';
  try { kill(pid, 0); } catch (e) {
    return e && (e.code === 'ESRCH' || e.code === 'EPERM') ? 'gone' : 'unknown';
  }
  if (!rec.host_started) return 'unknown';
  const now = started(pid);
  if (!now) return 'unknown';
  return now === rec.host_started ? 'alive' : 'gone';
}

module.exports = { processTable, findHostProcess, hostProcessState, parseLstart, startedOf };
