'use strict';
/**
 * telemetry-retention.js — prunes brain/_index/agent-runs/ to config telemetry.retentionDays:
 * day folders <YYYY-MM-DD>/ older than the window are deleted and runs.jsonl is rewritten
 * to the rows whose started_at is inside it. live/ is never touched. Called by scan-vault.
 */
const fs = require('fs');
const path = require('path');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pruneAgentRuns({ runsDir, retentionDays, now = Date.now() }) {
  const out = { removedDirs: 0, keptRows: 0, droppedRows: 0 };
  if (!(retentionDays > 0) || !fs.existsSync(runsDir)) return out;
  const cutoff = now - retentionDays * 86400000;

  for (const name of fs.readdirSync(runsDir)) {
    if (!DAY_RE.test(name)) continue;
    const endOfDay = Date.parse(`${name}T23:59:59Z`);
    if (Number.isNaN(endOfDay) || endOfDay >= cutoff) continue;
    try { fs.rmSync(path.join(runsDir, name), { recursive: true, force: true }); out.removedDirs++; } catch { /* leave it */ }
  }

  const log = path.join(runsDir, 'runs.jsonl');
  let raw;
  try { raw = fs.readFileSync(log, 'utf8'); } catch { return out; }
  const kept = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { out.droppedRows++; continue; }
    const t = Date.parse(row.started_at || row.ended_at || '');
    if (Number.isNaN(t) || t < cutoff) { out.droppedRows++; continue; }
    kept.push(line);
    out.keptRows++;
  }
  if (out.droppedRows) {
    const tmp = log + '.tmp';
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
    fs.renameSync(tmp, log);
  }
  return out;
}

module.exports = { pruneAgentRuns };
