'use strict';
// Codex sessions are priced in-process from the rollout's token_count events and recorded in
// costs.jsonl through the same cost-sync path the Claude analyzer uses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cost-cx-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index', 'agent-runs'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ provider: 'none', cost: { enabled: true } }));
process.env.AOS_VAULT = VAULT;
const { costCodexRollout, runModelFor } = require('../auto-cost.js');
const { priceUsd } = require('../sdk/lib/codex-pricing.js');

const SID = '01a0c5bc-1191-77f3-b185-31f412027020';
const FIXTURE = path.join(__dirname, 'fixtures', 'codex-rollout.jsonl');
const RUNS = path.join(VAULT, 'brain', '_index', 'agent-runs', 'runs.jsonl');
const SNAPS = path.join(VAULT, 'brain', '_index', 'cost', 'snapshots');

function rolloutCopy(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const t = path.join(dir, `rollout-2026-09-21T16-50-32-${SID}.jsonl`);
  fs.copyFileSync(FIXTURE, t);
  return t;
}

test('costCodexRollout prices the last token_count event and writes a codex-rollout snapshot', () => {
  const t = rolloutCopy(path.join(VAULT, 'sessions', '2026', '09', '21'));
  const synced = [];
  const r = costCodexRollout(t, SID, { model: 'gpt-5-mini', snapshotsDir: SNAPS, syncFn: (f) => synced.push(f) });
  assert.equal(r.status, 'ok');
  const expected = priceUsd('gpt-5-mini', { inputTokens: 56562, cachedInputTokens: 48384, outputTokens: 420 });
  assert.equal(r.usd, expected);
  assert.equal(synced.length, 1);
  const snap = JSON.parse(fs.readFileSync(synced[0], 'utf8'));
  assert.equal(snap.source, 'codex-rollout');
  assert.equal(snap.schema, 1);
  assert.equal(snap.transcript, t);
  assert.equal(snap.totals.cost_usd, expected);
  assert.equal(snap.totals.tokens, 56982);
  assert.equal(snap.totals.cached_input_tokens, 48384);
  assert.equal(snap.model, 'gpt-5-mini');
});

test('costCodexRollout: no file → no-transcript; a rollout without token_count → no-usage; a sync failure → analyzer-failed', () => {
  assert.equal(costCodexRollout(path.join(VAULT, 'absent.jsonl'), SID).status, 'no-transcript');
  const empty = path.join(VAULT, 'empty-rollout.jsonl');
  fs.writeFileSync(empty, JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }) + '\n');
  assert.equal(costCodexRollout(empty, 'x', { snapshotsDir: SNAPS, syncFn: () => {} }).status, 'no-usage');
  const t = rolloutCopy(path.join(VAULT, 'sessions2'));
  const r = costCodexRollout(t, SID, { snapshotsDir: SNAPS, syncFn: () => { const e = new Error('sync died'); e.stderr = 'runs.jsonl unreadable'; throw e; } });
  assert.equal(r.status, 'analyzer-failed');
  assert.match(r.detail, /unreadable/);
});

test('cost-sync records a rollout-named snapshot\'s cost in costs.jsonl and never rewrites runs.jsonl (append-only-runs D2)', () => {
  const { readRuns } = require('../lib/runs-log.js');
  const COSTS = path.join(VAULT, 'brain', '_index', 'agent-runs', 'costs.jsonl');
  try { fs.unlinkSync(COSTS); } catch { /* first run */ }
  const t = rolloutCopy(path.join(VAULT, 'sessions3'));
  fs.writeFileSync(RUNS, [
    JSON.stringify({ id: `sess-${SID}`, session_id: SID, script: 'session', cost_usd: null, host: 'codex', model: 'gpt-5-mini' }),
    JSON.stringify({ id: 'sess-other', session_id: 'other', script: 'session', cost_usd: null }),
  ].join('\n') + '\n');
  const runsBefore = fs.readFileSync(RUNS, 'utf8');
  const r = costCodexRollout(t, SID, { model: runModelFor(SID, RUNS), snapshotsDir: SNAPS }); // real cost-sync child
  assert.equal(r.status, 'ok', r.detail);
  assert.equal(fs.readFileSync(RUNS, 'utf8'), runsBefore, 'runs.jsonl is not rewritten');
  const rows = readRuns({ runsFile: RUNS, costsFile: COSTS });
  assert.equal(rows[0].cost_source, 'codex-rollout');
  assert.equal(rows[0].cost_usd, r.usd);
  assert.equal(rows[0].tokens, 56982);
  assert.equal(rows[1].cost_usd, null, 'the other run is untouched');
  // a second sync with the same figure records nothing
  const costsBefore = fs.readFileSync(COSTS, 'utf8');
  const again = spawnSync(process.execPath, [path.join(__dirname, '..', 'cost-sync.js'), '--report', r.snapshot], { encoding: 'utf8', env: { ...process.env, AOS_VAULT: VAULT } });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no cost changed/);
  assert.equal(fs.readFileSync(COSTS, 'utf8'), costsBefore);
});

test('runModelFor reads the newest matching run record, else null', () => {
  fs.writeFileSync(RUNS, [
    JSON.stringify({ id: 'sess-a', session_id: 'a', model: 'old' }),
    JSON.stringify({ id: 'sess-a', session_id: 'a', model: 'new' }),
    JSON.stringify({ id: 'sess-b', session_id: 'b' }),
  ].join('\n') + '\n');
  assert.equal(runModelFor('a', RUNS), 'new');
  assert.equal(runModelFor('b', RUNS), null);
  assert.equal(runModelFor('zzz', RUNS), null);
  assert.equal(runModelFor('a', path.join(VAULT, 'no-runs.jsonl')), null);
});

test('hostForRun: AOS_HOST from a hook, else the host the run record carries, else the detection chain', () => {
  const { hostForRun } = require('../auto-cost.js');
  fs.writeFileSync(RUNS, JSON.stringify({ id: 'sess-cx', session_id: 'cx', host: 'codex' }) + '\n' + JSON.stringify({ id: 'sess-cl', session_id: 'cl', host: 'claude' }) + '\n');
  assert.equal(hostForRun('cx', '', {}, RUNS), 'codex', 'a manual --cost-one on a both-hosts machine follows the record');
  assert.equal(hostForRun('cl', '', {}, RUNS), 'claude');
  assert.equal(hostForRun('cx', '', { AOS_HOST: 'claude' }, RUNS), 'claude', 'a hook says which host it is');
  assert.equal(hostForRun('none', '', {}, RUNS), 'claude', 'no record, no hint: the default');
});

test('backfill costs a Codex run from its rollout (by the run record\'s host), not only Claude transcripts', () => {
  const { backfill } = require('../auto-cost.js');
  rolloutCopy(path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '21'));
  try { fs.unlinkSync(path.join(VAULT, 'brain', '_index', 'agent-runs', 'costs.jsonl')); } catch { /* no cost recorded yet */ }
  fs.writeFileSync(RUNS, JSON.stringify({ id: `sess-${SID}`, session_id: SID, script: 'session', cost_usd: null, host: 'codex', model: 'gpt-5-mini' }) + '\n');
  const report = { counts: {} };
  backfill(report);
  assert.equal(report.counts.costed, 1);
  const [row] = require('../lib/runs-log.js').readRuns({ runsFile: RUNS });
  assert.equal(row.cost_source, 'codex-rollout');
  assert.equal(row.cost_usd, priceUsd('gpt-5-mini', { inputTokens: 56562, cachedInputTokens: 48384, outputTokens: 420 }));
});
