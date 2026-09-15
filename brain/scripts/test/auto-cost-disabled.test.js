'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Own vault so brain/config.json can be toggled without disturbing other tests.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cost-vault-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = VAULT;
delete process.env.AOS_VAULT;

const { costTranscript, costOne } = require('../auto-cost.js');
const { LEDGER_PATH, readLedgerFile } = require('../lib/pipeline-report.js');

// readLedgerFile() → { version, pipelines: { '<name>': { lastRun, history } } } (lib/pipeline-report.js)
const lastRun = () => readLedgerFile().pipelines['auto-cost'].lastRun;

test('with cost disabled, costOne records a disabled ledger entry and costs nothing', async () => {
  await costOne('sess-disabled', '');
  assert.equal(lastRun().status, 'disabled');
  assert.match(String(lastRun().reason), /cost disabled/);
  assert.ok(fs.existsSync(LEDGER_PATH));
});

test('with cost enabled but no analyzer, costTranscript names the vault analyzer path', () => {
  fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ cost: { enabled: true } }));
  const t = path.join(VAULT, 'sess-x.jsonl');
  fs.writeFileSync(t, '{}\n');
  const r = costTranscript(t, 'sess-x');
  assert.equal(r.status, 'no-analyzer');
  assert.equal(r.detail, path.join(VAULT, 'brain', 'scripts', 'cost', 'analyze_transcript.py'));
});

test('with cost enabled and no analyzer, costOne records an error (a real misconfiguration)', async () => {
  fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ cost: { enabled: true } }));
  fs.mkdirSync(path.join(VAULT, 'projects'), { recursive: true });
  const t = path.join(VAULT, 'sess-y.jsonl');
  fs.writeFileSync(t, '{}\n');
  await costOne('sess-y', t).catch(() => {});
  assert.equal(lastRun().status, 'error');
  assert.match(String(lastRun().error), /no-analyzer/);
});
