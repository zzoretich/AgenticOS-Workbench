'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneAgentRuns } = require('../lib/telemetry-retention.js');

function fixture() {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
  const now = Date.UTC(2026, 8, 4, 12); // 2026-09-04T12:00Z
  const day = (d) => new Date(now - d * 86400000).toISOString().slice(0, 10);
  for (const d of [0, 10, 31, 90]) {
    fs.mkdirSync(path.join(runsDir, day(d)));
    fs.writeFileSync(path.join(runsDir, day(d), 'sess-x.json'), '{}');
  }
  fs.mkdirSync(path.join(runsDir, 'live'));
  fs.writeFileSync(path.join(runsDir, 'runs.jsonl'), [
    JSON.stringify({ id: 'a', started_at: new Date(now - 90 * 86400000).toISOString() }),
    JSON.stringify({ id: 'b', started_at: new Date(now - 10 * 86400000).toISOString() }),
    'not json',
    JSON.stringify({ id: 'c', started_at: new Date(now).toISOString() }),
  ].join('\n') + '\n');
  return { runsDir, now, day };
}

test('pruneAgentRuns removes day folders and rows older than retentionDays, keeps live/', () => {
  const { runsDir, now, day } = fixture();
  const r = pruneAgentRuns({ runsDir, retentionDays: 30, now });
  assert.deepEqual(r, { removedDirs: 2, keptRows: 2, droppedRows: 2, droppedCosts: 0 });
  assert.deepEqual(fs.readdirSync(runsDir).sort(), [day(0), day(10), 'live', 'runs.jsonl'].sort());
  const rows = fs.readFileSync(runsDir + '/runs.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(rows, ['b', 'c']);
});

test('retentionDays 0 or a missing dir is a no-op', () => {
  const { runsDir, now } = fixture();
  assert.deepEqual(pruneAgentRuns({ runsDir, retentionDays: 0, now }), { removedDirs: 0, keptRows: 0, droppedRows: 0, droppedCosts: 0 });
  assert.equal(fs.readdirSync(runsDir).length, 6);
  assert.deepEqual(pruneAgentRuns({ runsDir: path.join(runsDir, 'nope'), retentionDays: 30, now }), { removedDirs: 0, keptRows: 0, droppedRows: 0, droppedCosts: 0 });
});

test('costs.jsonl is pruned by its `at` in the same pass, and no lock file is left behind (append-only-runs D4)', () => {
  const { runsDir, now } = fixture();
  fs.writeFileSync(path.join(runsDir, 'costs.jsonl'), [
    JSON.stringify({ session_id: 'old', cost_usd: 1, at: new Date(now - 40 * 86400000).toISOString() }),
    JSON.stringify({ session_id: 'new', cost_usd: 2, at: new Date(now).toISOString() }),
  ].join('\n') + '\n');
  const r = pruneAgentRuns({ runsDir, retentionDays: 30, now });
  assert.equal(r.droppedCosts, 1);
  const kept = fs.readFileSync(path.join(runsDir, 'costs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).session_id);
  assert.deepEqual(kept, ['new']);
  assert.deepEqual(fs.readdirSync(runsDir).filter((n) => n.endsWith('.lock') || n.endsWith('.tmp')), []);
});
