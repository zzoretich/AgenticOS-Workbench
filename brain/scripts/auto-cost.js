#!/usr/bin/env node
/**
 * auto-cost.js — costs sessions and patches their cost_usd into runs.jsonl so the
 * Mission Control Cost panel reflects real token usage without anyone running /cost.
 *
 * Two modes:
 *   (hook)      SessionEnd hook — reads the hook payload on stdin and costs the
 *               session that just ended. Wired in settings.json AFTER
 *               telemetry-hook.js (the run record must exist before we patch it).
 *   --backfill  Costs EVERY session in runs.jsonl that has no cost yet but still
 *               has a transcript on disk. Use this for sessions that were open
 *               before the SessionEnd hook existed, or were otherwise missed:
 *                   node ~/.claude/brain/scripts/auto-cost.js --backfill
 *
 * The per-skill count-tokens API call inside the analyzer only affects co-load
 * attribution, NOT the session total. With no ANTHROPIC_API_KEY it degrades to
 * len-split and never hits the network. Child calls are timeout-bounded so a hung
 * process can't wedge session exit. Best-effort: never throws.
 * Hook mode hands the heavy work to a detached --cost-one worker so session exit is never blocked or cancelled.
 */

const { PATHS } = require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const brain = require('./sdk/lib/brain.js');
const { withReport } = require('./lib/pipeline-report.js');

const VAULT = brain.PATHS.VAULT;
const ANALYZER = path.join(VAULT, 'skills/token-goblin/scripts/analyze_transcript.py');
const COST_SYNC = path.join(VAULT, 'brain/scripts/cost-sync.js');
const RUNS = path.join(VAULT, 'brain/_index/agent-runs/runs.jsonl');
const PROJECTS = brain.PATHS.PROJECTS;

/** Find <sessionId>.jsonl under any direct projects/<slug>/ dir. Sessions whose cwd
 *  was not ~/.claude land in other slugs (e.g. projects/-/), which the old
 *  single-dir fallback never saw — the measured cause of most missed costings. */
function findTranscript(sessionId, projectsRoot = PROJECTS) {
  if (!sessionId) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(projectsRoot); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(projectsRoot, d, `${sessionId}.jsonl`);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Cost one transcript and patch runs.jsonl.
 * Returns {status, detail} where status is one of:
 *   'ok'              — costed and synced
 *   'no-transcript'   — nothing on disk to cost. NOT a failure: sessions that
 *                       end before their transcript is flushed (and subagent /
 *                       job sessions that never get one) legitimately have
 *                       nothing to price, and must not enter the Fix Queue.
 *   'no-analyzer'     — token-goblin analyzer missing. A real misconfiguration.
 *   'analyzer-failed' — python3/cost-sync threw or timed out. A real failure,
 *                       and `detail` carries the tail of its stderr.
 * These used to collapse into a bare `false`, so a missing transcript was
 * indistinguishable from a crashed analyzer and the stderr was discarded.
 */
function costTranscript(transcript, sessionId) {
  if (!transcript || !fs.existsSync(transcript)) return { status: 'no-transcript' };
  if (!fs.existsSync(ANALYZER)) return { status: 'no-analyzer', detail: ANALYZER };
  const out = path.join(os.tmpdir(), `auto-cost-${sessionId || Date.now()}.json`);
  try {
    execFileSync('python3', [ANALYZER, '--transcript', transcript, '--prev', 'auto', '--out', out], {
      timeout: 60000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (fs.existsSync(out)) {
      execFileSync(process.execPath, [COST_SYNC, '--report', out], {
        timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'],
      });
    }
    return { status: 'ok' };
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim().split('\n').slice(-3).join(' | ');
    return {
      status: 'analyzer-failed',
      detail: stderr || (e && e.message) || 'unknown child-process failure',
    };
  } finally {
    try { fs.unlinkSync(out); } catch (_) {}
  }
}

/** Cost every run lacking a cost that still has a transcript in ANY project dir. */
function backfill(report) {
  let lines = [];
  try { lines = fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean); } catch { return; }
  const seen = new Set();
  let costed = 0;
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    // A numeric cost — including a genuine $0.00 — means "already costed".
    if (typeof r.cost_usd === 'number') continue;
    const sid = r.session_id || (r.id || '').replace(/^sess-/, '');
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const transcript = findTranscript(sid);
    if (!transcript) continue;
    const res = costTranscript(transcript, sid);
    if (res.status === 'ok') { costed++; process.stdout.write(`[auto-cost] costed ${sid.slice(0, 8)}\n`); }
    else process.stdout.write(`[auto-cost] skipped ${sid.slice(0, 8)} — ${res.status}${res.detail ? `: ${res.detail}` : ''}\n`);
  }
  if (report) report.counts.costed = costed;
  process.stdout.write(`[auto-cost] backfill done — costed ${costed} session(s)\n`);
}

/** Foreground worker: resolve the transcript (payload path first, then any
 *  projects/<slug>/ dir) and cost it under the 'auto-cost' ledger name. */
async function costOne(sessionId, transcriptArg) {
  await withReport('auto-cost', async (report) => {
    const transcript = (transcriptArg && fs.existsSync(transcriptArg))
      ? transcriptArg
      : findTranscript(sessionId);
    const { status, detail } = costTranscript(transcript, sessionId);
    const sid = sessionId || 'unknown session';
    report.counts.costed = status === 'ok' ? 1 : 0;
    if (status === 'ok') return;

    // A session with no transcript has nothing to cost — record it as skipped
    // and finish clean. Treating it as an error queued a permanent "auto-cost
    // failed" entry for sessions that were never costable in the first place.
    if (status === 'no-transcript') {
      // counts is Record<string, number> on the reader side (the plugin's
      // PipelineEntry) — the human-readable reason goes to stdout, not the ledger.
      report.counts.skipped = 1;
      process.stdout.write(`[auto-cost] no transcript for ${sid} — nothing to cost\n`);
      return;
    }
    throw new Error(`${status} for ${sid}${detail ? `: ${detail}` : ''}`);
  });
}

if (require.main === module) {
  if (process.argv.includes('--backfill')) {
    withReport('auto-cost-backfill', async (report) => { backfill(report); })
      .catch(() => {})
      .finally(() => process.exit(0));
  } else if (process.argv.includes('--cost-one')) {
    const i = process.argv.indexOf('--cost-one');
    costOne(process.argv[i + 1] || '', process.argv[i + 2] || '')
      .catch(() => {})
      .finally(() => process.exit(0));
  } else {
    // Hook mode: parse the SessionEnd payload, hand off to a detached worker,
    // and exit within milliseconds so the hook can never be cancelled mid-work.
    // Same teardown-survival pattern settings.json uses for scan-vault.js.
    let raw = '';
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => {
      try {
        const input = JSON.parse(raw || '{}');
        const sessionId = input.session_id || input.sessionId || '';
        const transcript = input.transcript_path || input.transcriptPath || '';
        if (sessionId || transcript) {
          spawn(process.execPath, [__filename, '--cost-one', sessionId, transcript],
            { detached: true, stdio: 'ignore' }).unref();
        }
      } catch (_) { /* never block or fail session end */ }
      process.exit(0);
    });
  }
}

module.exports = { findTranscript, costTranscript };
