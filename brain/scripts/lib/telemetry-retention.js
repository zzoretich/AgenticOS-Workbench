'use strict';
/**
 * telemetry-retention.js — prunes brain/_index/agent-runs/ to config telemetry.retentionDays:
 * day folders <YYYY-MM-DD>/ older than the window are deleted, runs.jsonl is rewritten to the
 * rows whose started_at is inside it and costs.jsonl to the records whose `at` is. live/ is never
 * touched. Called by scan-vault.
 *
 * The one rewrite of either log left (spec 2026-09-24-append-only-runs D4): it holds the file's
 * lock (lib/fsx.js) from the read to the rename, and the appenders wait on that lock, so a row
 * appended meanwhile is never lost. A lock it cannot get in time leaves the log for the next scan.
 */
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx.js');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rewrite a JSONL log to the lines whose `when(row)` is inside the window; returns { kept, dropped }. */
function pruneJsonl(file, cutoff, when) {
  const counts = { kept: 0, dropped: 0 };
  if (!fs.existsSync(file)) return counts;
  try {
    fsx.updateSync(file, (raw) => {
      if (raw == null) return null;
      const kept = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { counts.dropped++; continue; }
        const t = Date.parse(when(row) || '');
        if (Number.isNaN(t) || t < cutoff) { counts.dropped++; continue; }
        kept.push(line);
        counts.kept++;
      }
      return counts.dropped ? (kept.length ? kept.join('\n') + '\n' : '') : raw;
    }, { timeoutMs: 5000 });
  } catch (e) {
    if (!e || e.code !== 'LOCK_BUSY') throw e;
  }
  return counts;
}

function pruneAgentRuns({ runsDir, retentionDays, now = Date.now() }) {
  const out = { removedDirs: 0, keptRows: 0, droppedRows: 0, droppedCosts: 0 };
  if (!(retentionDays > 0) || !fs.existsSync(runsDir)) return out;
  const cutoff = now - retentionDays * 86400000;

  for (const name of fs.readdirSync(runsDir)) {
    if (!DAY_RE.test(name)) continue;
    const endOfDay = Date.parse(`${name}T23:59:59Z`);
    if (Number.isNaN(endOfDay) || endOfDay >= cutoff) continue;
    try { fs.rmSync(path.join(runsDir, name), { recursive: true, force: true }); out.removedDirs++; } catch { /* leave it */ }
  }

  const runs = pruneJsonl(path.join(runsDir, 'runs.jsonl'), cutoff, (row) => row.started_at || row.ended_at);
  out.keptRows = runs.kept;
  out.droppedRows = runs.dropped;
  out.droppedCosts = pruneJsonl(path.join(runsDir, 'costs.jsonl'), cutoff, (row) => row.at).dropped;
  return out;
}

module.exports = { pruneAgentRuns };
