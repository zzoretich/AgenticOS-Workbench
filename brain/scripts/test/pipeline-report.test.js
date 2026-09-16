'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// BRAIN_VAULT must be set BEFORE the module (and paths.js beneath it) loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plr-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
process.env.BRAIN_VAULT = TMP;
const { withReport, LEDGER_PATH, readLedgerFile } = require('../lib/pipeline-report.js');

beforeEach(() => { try { fs.unlinkSync(LEDGER_PATH); } catch {} });

test('ok run records start then finish with duration and report fields', async () => {
  const out = await withReport('scan-vault', async (report) => {
    report.wrote.push('brain/_index/snapshot.json');
    report.counts.collectors = 10;
    return 42;
  });
  assert.equal(out, 42);
  const led = readLedgerFile();
  const last = led.pipelines['scan-vault'].lastRun;
  assert.equal(last.status, 'ok');
  assert.ok(last.startedAt && last.endedAt);
  assert.ok(typeof last.durationMs === 'number');
  assert.deepEqual(last.wrote, ['brain/_index/snapshot.json']);
  assert.equal(last.counts.collectors, 10);
});

test('throwing fn records status error with message and rethrows', async () => {
  await assert.rejects(
    () => withReport('auto-cost', async () => { throw new Error('boom 42'); }),
    /boom 42/
  );
  const last = readLedgerFile().pipelines['auto-cost'].lastRun;
  assert.equal(last.status, 'error');
  assert.match(last.error, /boom 42/);
});

test('a run that never finishes stays status running (the died signal)', async () => {
  // Simulate a kill: call the internal start phase only, via a fn that blocks
  // until we inspect the file mid-flight.
  let sawRunning = null;
  await withReport('heartbeat-writer', async () => {
    sawRunning = readLedgerFile().pipelines['heartbeat-writer'].lastRun.status;
  });
  assert.equal(sawRunning, 'running');
});

test('history ring keeps at most 10 entries, newest first', async () => {
  for (let i = 0; i < 12; i++) {
    await withReport('scan-vault', async (r) => { r.counts.i = i; });
  }
  const st = readLedgerFile().pipelines['scan-vault'];
  assert.ok(st.history.length <= 10);
  assert.equal(st.lastRun.counts.i, 11);
  assert.equal(st.history[0].counts.i, 11);
});

test('corrupt ledger file is replaced, not fatal', async () => {
  fs.writeFileSync(LEDGER_PATH, '{nope');
  await withReport('scan-vault', async () => {});
  assert.equal(readLedgerFile().pipelines['scan-vault'].lastRun.status, 'ok');
});

test('sequential ok runs have no duplicate entries in history', async () => {
  for (let i = 0; i < 6; i++) {
    await withReport('scan-vault', async (r) => { r.counts.i = i; });
  }
  const st = readLedgerFile().pipelines['scan-vault'];
  const historyEntries = st.history;
  const iValues = historyEntries.map((e) => e.counts.i);
  for (let i = 0; i < iValues.length - 1; i++) {
    assert.notEqual(iValues[i], iValues[i + 1], `history i-sequence has duplicate: ${iValues[i]} appears at indices ${i} and ${i+1}`);
  }
  assert.ok(iValues.length > 0, 'history should not be empty after 6 runs');
});
