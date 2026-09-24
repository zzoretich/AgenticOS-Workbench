#!/usr/bin/env node
/**
 * cost-sync.js — record the cost the cost analyzer derived for a session.
 *
 * Native hooks never emit cost, so runs.jsonl carries cost_usd:null. The analyzer
 * (brain/scripts/cost/analyze_transcript.py) writes a snapshot JSON with the exact
 * transcript-derived total for a Claude Code session; auto-cost.js writes the same shape
 * (source "codex-rollout") for a Codex session. This script keys either by session UUID — the
 * snapshot's `transcript` filename is <uuid>.jsonl (Claude) or rollout-<timestamp>-<uuid>.jsonl
 * (Codex) — and appends a cost record to costs.jsonl (lib/runs-log.js appendCost). It never
 * rewrites runs.jsonl: readers lay the costs over the runs with readRuns(), which counts a session
 * once however many runs it has (spec 2026-09-24-append-only-runs D2). A cost recorded before its
 * run row exists (Codex costs in-process, fast) is simply waiting for it.
 *
 * Usage:
 *   node cost-sync.js                       # record from the newest snapshot
 *   node cost-sync.js --report <path.json>  # record from a specific report/snapshot
 *   node cost-sync.js --backfill            # record from ALL snapshots (newest per uuid)
 *
 * cost_usd is tagged cost_source:"token-analyzer" (or "codex-rollout") — it excludes the
 * platform's hidden system-prompt baseline, so it is a slight, consistent underestimate.
 * Best-effort: never throws.
 */

const fs = require('fs');
const path = require('path');
const brain = require('./sdk/lib/brain.js');
const { appendCost } = require('./lib/runs-log.js');

const VAULT = brain.PATHS.VAULT;
const SNAP_DIR = path.join(VAULT, 'brain/_index/cost/snapshots');

const args = process.argv.slice(2);
const reportFlag = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
const backfill = args.includes('--backfill');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function uuidOf(report) {
  const t = report && report.transcript;
  if (!t) return null;
  const name = path.basename(String(t)).replace(/\.jsonl$/, '');
  const m = name.match(ROLLOUT_RE);
  return m ? m[1] : name;
}
function sourceOf(report) { return report && report.source === 'codex-rollout' ? 'codex-rollout' : 'token-analyzer'; }

// Collect {uuid -> {cost_usd, tokens, ts}} from the chosen report(s), newest per uuid.
function gatherReports() {
  let files = [];
  if (reportFlag) {
    files = [reportFlag];
  } else if (backfill) {
    try { files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SNAP_DIR, f)); } catch { files = []; }
  } else {
    try {
      const all = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SNAP_DIR, f));
      all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      files = all.slice(0, 1);
    } catch { files = []; }
  }
  const byUuid = {};
  for (const f of files) {
    const r = readJson(f);
    const uuid = uuidOf(r);
    const cost = r && r.totals && typeof r.totals.cost_usd === 'number' ? r.totals.cost_usd : null;
    if (!uuid || cost == null) continue;
    const ts = r.generated || '';
    if (!byUuid[uuid] || ts > byUuid[uuid].ts) {
      byUuid[uuid] = { cost_usd: Math.round(cost * 1e6) / 1e6, tokens: r.totals.tokens ?? null, ts, source: sourceOf(r) };
    }
  }
  return byUuid;
}

function main() {
  const byUuid = gatherReports();
  const uuids = Object.keys(byUuid);
  if (uuids.length === 0) { process.stdout.write('[cost-sync] no analyzer snapshots with cost found\n'); return; }

  let recorded = 0;
  try {
    for (const uuid of uuids) {
      const { cost_usd, tokens, source } = byUuid[uuid];
      if (appendCost({ session_id: uuid, cost_usd, cost_source: source, tokens })) recorded++;
    }
  } catch (err) {
    process.stderr.write(`[cost-sync] write failed: ${err.message}\n`);
    return;
  }
  process.stdout.write(recorded
    ? `[cost-sync] recorded ${recorded} cost(s) from ${uuids.length} report(s) → costs.jsonl\n`
    : `[cost-sync] ${uuids.length} report(s) · no cost changed\n`);
}

main();
