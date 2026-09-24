#!/usr/bin/env node
/**
 * auto-cost.js — costs sessions and patches their cost_usd into runs.jsonl so the
 * Mission Control Cost panel reflects real token usage without anyone running /cost.
 * Claude Code sessions go through the Python analyzer; Codex sessions (AOS_HOST=codex, the
 * hook host) are priced in-process from the rollout's token_count events (codex-pricing.js).
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
 * Opt-in: with cost.enabled=false (the default) the stage reports "disabled" and does nothing.
 * The per-skill count-tokens API call inside the analyzer only affects co-load
 * attribution, NOT the session total. With no ANTHROPIC_API_KEY it degrades to
 * len-split and never hits the network. Child calls are timeout-bounded so a hung
 * process can't wedge session exit. Best-effort: never throws.
 * Hook mode hands the heavy work to a detached --cost-one worker so session exit is never blocked or cancelled.
 */

// The hook prologue (AOS_HEADLESS guard, vault-missing guard) runs only when this file is the process entry point.
// auto-wrap.js requires this module for findTranscript() after running its own prologue, and the tests require it
// for pure functions; at module scope the prologue could process.exit(0) the requiring process. `PATHS` was unused here.
if (require.main === module) require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { PATHS } = require('./lib/paths.js');   // execution amendment 2026-09-15 (A13): the file's only path source after this task
const { withReport } = require('./lib/pipeline-report.js');
const { loadConfig } = require('./lib/config.js');
const host = require('./lib/host.js');
const { readTranscriptFile } = require('./lib/transcript.js');
const { priceUsd } = require('./sdk/lib/codex-pricing.js');

const ANALYZER = path.join(PATHS.SCRIPTS, 'cost', 'analyze_transcript.py');   // installed by `aos cost enable`
const COST_SYNC = path.join(__dirname, 'cost-sync.js');   // a sibling of this file in the checkout and in the vendored copy alike
const SNAPSHOTS = path.join(PATHS.INDEX, 'cost', 'snapshots');
const RUNS = path.join(PATHS.AGENT_RUNS, 'runs.jsonl');
const PROJECTS = PATHS.PROJECTS;

function costEnabled() { try { return !!loadConfig().cost.enabled; } catch { return false; } }

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
 *   'no-analyzer'     — analyzer missing under brain/scripts/cost/ (run `aos cost enable`).
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
    fs.mkdirSync(SNAPSHOTS, { recursive: true });
    // execution amendment 2026-09-15 (A36): --no-api — the analyzer's count_tokens call fires whenever ANTHROPIC_API_KEY is
    // inherited by the hook; the SessionEnd path must never contact the API, so docs/cost.md's "nothing leaves your machine" holds.
    execFileSync('python3', [ANALYZER, '--transcript', transcript, '--prev', 'auto', '--out', out, '--no-api', '--snapshots-dir', SNAPSHOTS], {
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

/** The model recorded for a session in runs.jsonl (telemetry-hook writes it from the Codex hook payload). */
function runModelFor(sessionId, runsFile = RUNS) { return runFieldFor(sessionId, 'model', runsFile); }

/** A string field of the newest run record for this session (runs.jsonl), else null. */
function runFieldFor(sessionId, key, runsFile = RUNS) {
  if (!sessionId) return null;
  let lines = [];
  try { lines = fs.readFileSync(runsFile, 'utf8').split('\n'); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    if ((r.session_id === sessionId || r.id === `sess-${sessionId}`) && typeof r[key] === 'string' && r[key]) return r[key];
  }
  return null;
}

/**
 * Which host ran a session: AOS_HOST when a hook set it, else the host its run record carries (telemetry stamps it),
 * else the detection chain. `aos auto-cost --cost-one <uuid>` on a machine with both hosts needs the record: nothing
 * in its environment says which host the session was.
 */
function hostForRun(sessionId, transcriptArg, env = process.env, runsFile = RUNS) {
  if (host.HOSTS.includes(env.AOS_HOST)) return env.AOS_HOST;
  const recorded = runFieldFor(sessionId, 'host', runsFile);
  return host.HOSTS.includes(recorded) ? recorded : host.currentHost(env, { transcript_path: transcriptArg });
}

/**
 * Cost one Codex rollout in-process: the last token_count event is the session total, priced with
 * codex-pricing.js, written as a snapshot the same cost-sync path patches into runs.jsonl.
 * Statuses: 'ok' | 'no-transcript' | 'no-usage' (a rollout without a token_count event) | 'analyzer-failed'.
 */
function costCodexRollout(transcript, sessionId, { model = null, snapshotsDir = SNAPSHOTS, syncFn } = {}) {
  if (!transcript || !fs.existsSync(transcript)) return { status: 'no-transcript' };
  const parsed = readTranscriptFile(transcript, { format: 'codex' });
  if (!parsed.usage) return { status: 'no-usage' };
  const u = parsed.usage;
  const usd = priceUsd(model, u);
  const report = {
    schema: 1, source: 'codex-rollout', transcript, generated: new Date().toISOString(), model: model || null,
    totals: { cost_usd: usd, tokens: u.totalTokens, input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens },
  };
  const out = path.join(snapshotsDir, `codex-${sessionId || Date.now()}.json`);
  try {
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    (syncFn || ((file) => execFileSync(process.execPath, [COST_SYNC, '--report', file], { timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] })))(out);
    return { status: 'ok', usd, snapshot: out };
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim().split('\n').slice(-3).join(' | ');
    return { status: 'analyzer-failed', detail: stderr || (e && e.message) || 'unknown failure' };
  }
}

/** Cost every run lacking a cost that still has a transcript: a Claude Code transcript in any project dir, or a Codex
 *  rollout, by the host the run record carries. */
function backfill(report) {
  if (!costEnabled()) { process.stdout.write('[auto-cost] cost module disabled — run `aos cost enable`\n'); if (report) report.disable('cost disabled'); return; }
  // The runs with costs.jsonl laid over them: a session costed on any of its runs reads as costed on all of them.
  const rows = require('./lib/runs-log.js').readRuns({ runsFile: RUNS });
  const seen = new Set();
  let costed = 0;
  for (const r of rows) {
    // A numeric cost — including a genuine $0.00 — means "already costed".
    if (typeof r.cost_usd === 'number') continue;
    const sid = r.session_id || (r.id || '').replace(/^sess-/, '');
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const codex = r.host === 'codex';
    const transcript = codex ? host.findTranscript('codex', sid) : findTranscript(sid);
    if (!transcript) continue;
    const res = codex ? costCodexRollout(transcript, sid, { model: (typeof r.model === 'string' && r.model) || null }) : costTranscript(transcript, sid);
    if (res.status === 'ok') { costed++; process.stdout.write(`[auto-cost] costed ${sid.slice(0, 8)}\n`); }
    else process.stdout.write(`[auto-cost] skipped ${sid.slice(0, 8)} — ${res.status}${res.detail ? `: ${res.detail}` : ''}\n`);
  }
  if (report) report.counts.costed = costed;
  process.stdout.write(`[auto-cost] backfill done — costed ${costed} session(s)\n`);
}

/** Foreground worker: resolve the transcript (payload path first, then any
 *  projects/<slug>/ dir) and cost it under the 'auto-cost' ledger name. */
async function costOne(sessionId, transcriptArg, hostName = hostForRun(sessionId, transcriptArg)) {
  await withReport('auto-cost', async (report) => {
    if (!costEnabled()) { report.disable('cost disabled'); return; }
    report.host = hostName;
    const transcript = (transcriptArg && fs.existsSync(transcriptArg))
      ? transcriptArg
      : (hostName === 'codex' ? host.findTranscript('codex', sessionId) : findTranscript(sessionId));
    const { status, detail } = hostName === 'codex'
      ? costCodexRollout(transcript, sessionId, { model: runModelFor(sessionId) })
      : costTranscript(transcript, sessionId);
    const sid = sessionId || 'unknown session';
    report.counts.costed = status === 'ok' ? 1 : 0;
    if (status === 'ok') return;

    // A session with no transcript has nothing to cost — record it as skipped
    // and finish clean. Treating it as an error queued a permanent "auto-cost
    // failed" entry for sessions that were never costable in the first place.
    if (status === 'no-transcript' || status === 'no-usage') {
      // counts is Record<string, number> on the reader side (the plugin's
      // PipelineEntry) — the human-readable reason goes to stdout, not the ledger.
      report.counts.skipped = 1;
      process.stdout.write(`[auto-cost] ${status === 'no-usage' ? 'no token usage in the rollout' : 'no transcript'} for ${sid} — nothing to cost\n`);
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

module.exports = { findTranscript, costTranscript, costCodexRollout, runModelFor, hostForRun, backfill, costOne };
