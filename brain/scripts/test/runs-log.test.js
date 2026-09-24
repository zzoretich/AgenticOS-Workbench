'use strict';
// lib/runs-log.js: costs laid over an append-only runs.jsonl (spec 2026-09-24-append-only-runs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyCosts, readRuns, appendCost, sessionOf, readJsonl } = require('../lib/runs-log.js');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'apply-costs.json'), 'utf8')).cases;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runslog-'));

for (const c of CASES) {
  test(`applyCosts: ${c.name}`, () => {
    const out = applyCosts(c.runs, c.costs);
    assert.equal(out.length, c.expect.length);
    c.expect.forEach((want, i) => {
      for (const [k, v] of Object.entries(want)) assert.deepEqual(out[i][k], v, `${c.name} · row ${i} · ${k}`);
    });
    assert.notEqual(out[0], c.runs[0], 'new row objects: the input is left alone');
  });
}

test('sessionOf reads session_id, else a session run id with its segment suffix dropped', () => {
  assert.equal(sessionOf({ session_id: 'abc' }), 'abc');
  assert.equal(sessionOf({ id: 'sess-abc' }), 'abc');
  assert.equal(sessionOf({ id: 'sess-abc-s3' }), 'abc');
  assert.equal(sessionOf({ id: 'run-tick-1' }), '');
  assert.equal(sessionOf(null), '');
});

test('appendCost appends one record per change and skips a repeat of the newest', () => {
  const costsFile = path.join(DIR, 'costs.jsonl');
  assert.equal(appendCost({ session_id: 's1', cost_usd: 1.5, cost_source: 'token-analyzer', tokens: 10 }, { costsFile }), true);
  assert.equal(appendCost({ session_id: 's1', cost_usd: 1.5, cost_source: 'token-analyzer', tokens: 10 }, { costsFile }), false);
  assert.equal(appendCost({ session_id: 's1', cost_usd: 2, cost_source: 'token-analyzer' }, { costsFile }), true);
  assert.equal(appendCost({ session_id: 's2', cost_usd: 0, cost_source: 'codex-rollout' }, { costsFile }), true, 'a genuine $0.00 is a cost');
  assert.equal(appendCost({ session_id: '', cost_usd: 1 }, { costsFile }), false);
  assert.equal(appendCost({ session_id: 's3', cost_usd: null }, { costsFile }), false);
  const rows = readJsonl(costsFile);
  assert.deepEqual(rows.map((r) => [r.session_id, r.cost_usd, r.schema]), [['s1', 1.5, 1], ['s1', 2, 1], ['s2', 0, 1]]);
  assert.ok(!fs.existsSync(`${costsFile}.lock`), 'the lock is released');
});

test('readRuns lays costs.jsonl over runs.jsonl and never writes either', () => {
  const runsFile = path.join(DIR, 'runs.jsonl');
  const costsFile = path.join(DIR, 'costs-read.jsonl');
  fs.writeFileSync(runsFile, `${JSON.stringify({ id: 'sess-x', session_id: 'x', script: 'session', ended_at: '2026-09-24T10:00:00Z', cost_usd: null })}\nnot json\n`);
  fs.writeFileSync(costsFile, `${JSON.stringify({ session_id: 'x', cost_usd: 4, cost_source: 'token-analyzer', at: '2026-09-24T10:01:00Z' })}\n`);
  const before = fs.readFileSync(runsFile, 'utf8');
  const rows = readRuns({ runsFile, costsFile });
  assert.equal(rows.length, 1, 'a torn line is skipped');
  assert.equal(rows[0].cost_usd, 4);
  assert.equal(fs.readFileSync(runsFile, 'utf8'), before);
  assert.deepEqual(readRuns({ runsFile: path.join(DIR, 'missing.jsonl'), costsFile }), []);
});
