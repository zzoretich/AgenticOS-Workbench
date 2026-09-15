#!/usr/bin/env node
/**
 * cost-sync.js — patch runs.jsonl with cost derived by the cost analyzer.
 *
 * Native Claude Code hooks never emit cost, so runs.jsonl carries cost_usd:null.
 * The analyzer (brain/scripts/cost/analyze_transcript.py) writes a snapshot JSON with
 * the exact transcript-derived total. This script joins that back to runs.jsonl by
 * session UUID (the snapshot's `transcript` filename === the run's session_id)
 * and patches cost_usd, so the HUD's Cost panel populates.
 *
 * Usage:
 *   node cost-sync.js                       # patch from the newest snapshot
 *   node cost-sync.js --report <path.json>  # patch from a specific report/snapshot
 *   node cost-sync.js --backfill            # patch from ALL snapshots (newest per uuid)
 *
 * cost_usd is tagged cost_source:"token-analyzer" — it excludes the platform's hidden
 * platform/system-prompt baseline, so it is a slight, consistent underestimate.
 * Best-effort: never throws.
 */

const fs = require('fs');
const path = require('path');
const brain = require('./sdk/lib/brain.js');

const VAULT = brain.PATHS.VAULT;
const RUNS = path.join(VAULT, 'brain/_index/agent-runs/runs.jsonl');
const SNAP_DIR = path.join(VAULT, 'brain/_index/cost/snapshots');

const args = process.argv.slice(2);
const reportFlag = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
const backfill = args.includes('--backfill');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function uuidOf(report) {
  const t = report && report.transcript;
  return t ? path.basename(String(t)).replace(/\.jsonl$/, '') : null;
}

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
      byUuid[uuid] = { cost_usd: Math.round(cost * 1e6) / 1e6, tokens: r.totals.tokens ?? null, ts };
    }
  }
  return byUuid;
}

function matches(rec, uuid) {
  return rec.session_id === uuid || rec.id === `sess-${uuid}` || (typeof rec.id === 'string' && rec.id.includes(uuid));
}

function main() {
  const byUuid = gatherReports();
  const uuids = Object.keys(byUuid);
  if (uuids.length === 0) { process.stdout.write('[cost-sync] no analyzer snapshots with cost found\n'); return; }

  let lines;
  try { lines = fs.readFileSync(RUNS, 'utf8').split('\n'); } catch { process.stderr.write('[cost-sync] runs.jsonl unreadable\n'); return; }

  let patched = 0;
  const out = lines.map(line => {
    if (!line.trim()) return line;
    let rec; try { rec = JSON.parse(line); } catch { return line; }
    for (const uuid of uuids) {
      if (!matches(rec, uuid)) continue;
      const { cost_usd, tokens } = byUuid[uuid];
      if (rec.cost_usd === cost_usd && rec.cost_source === 'token-analyzer') return line; // unchanged
      rec.cost_usd = cost_usd;
      rec.cost_source = 'token-analyzer';
      if (tokens != null) rec.tokens = tokens;
      rec.cost_synced_at = new Date().toISOString();
      patched++;
      return JSON.stringify(rec);
    }
    return line;
  });

  if (patched === 0) { process.stdout.write(`[cost-sync] ${uuids.length} report(s) · 0 runs needed patching\n`); return; }

  const tmp = RUNS + '.tmp';
  try {
    fs.writeFileSync(tmp, out.join('\n'));
    fs.renameSync(tmp, RUNS);  // atomic
    process.stdout.write(`[cost-sync] patched ${patched} run(s) from ${uuids.length} report(s) → runs.jsonl\n`);
  } catch (err) {
    process.stderr.write(`[cost-sync] write failed: ${err.message}\n`);
  }
}

main();
