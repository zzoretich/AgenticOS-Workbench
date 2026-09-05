'use strict';
/**
 * pipeline-report.js — two-phase run ledger for every brain writer.
 * withReport(name, fn): records {status:"running"} at start and one of
 * {status:"ok"|"skipped"|"disabled"|"error"} at finish in brain/_index/pipelines.json,
 * plus the provider that served the run and a reason for skipped/disabled.
 * fn(report) may call report.skip(reason) / report.disable(reason) and set
 * report.provider; returning normally afterwards records that status, not ok.
 * A process killed mid-run leaves "running" behind — readers treat a
 * long-stale "running" entry as died. Locked + atomic (tmp+rename);
 * a corrupt ledger is replaced rather than fatal. `disabled` never renders red.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');
const { withLock } = require('./snapshotLock.js');

const LEDGER_PATH = path.join(PATHS.INDEX, 'pipelines.json');
const LOCK_PATH = path.join(PATHS.INDEX, '.pipelines.lock');
const HISTORY_MAX = 10;

function readLedgerFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.pipelines) return parsed;
  } catch { /* missing or corrupt — start fresh */ }
  return { version: 1, pipelines: {} };
}

function writeLedgerFile(led) {
  const tmp = LEDGER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(led, null, 2) + '\n');
  fs.renameSync(tmp, LEDGER_PATH);
}

async function patch(name, mutate) {
  await withLock(LOCK_PATH, async () => {
    const led = readLedgerFile();
    const st = led.pipelines[name] || { lastRun: null, history: [] };
    mutate(st);
    led.pipelines[name] = st;
    writeLedgerFile(led);
  }, { retries: 30, retryMs: 50, staleMs: 30000 });
}

async function withReport(name, fn) {
  const startedAt = new Date().toISOString();
  const entry = { startedAt, endedAt: null, durationMs: null, status: 'running',
                  error: null, wrote: [], counts: {}, pid: process.pid, provider: null, reason: null };
  await patch(name, (st) => {
    if (st.lastRun && st.lastRun.status === 'running') st.history = [st.lastRun, ...st.history].slice(0, HISTORY_MAX - 1);
    st.lastRun = entry;
  });
  const report = {
    wrote: entry.wrote, counts: entry.counts, provider: null, reason: null, status: null,
    skip(reason) { report.status = 'skipped'; report.reason = reason == null ? null : String(reason); },
    disable(reason) { report.status = 'disabled'; report.reason = reason == null ? null : String(reason); },
  };
  const finish = async (status, error) => {
    const endedAt = new Date().toISOString();
    await patch(name, (st) => {
      st.lastRun = { ...entry, endedAt, status, error,
                     durationMs: new Date(endedAt) - new Date(startedAt),
                     wrote: report.wrote, counts: report.counts,
                     provider: report.provider == null ? null : String(report.provider),
                     reason: report.reason == null ? null : String(report.reason) };
      st.history = [st.lastRun, ...st.history.filter((h) => h.startedAt !== startedAt)].slice(0, HISTORY_MAX);
    });
  };
  try {
    const out = await fn(report);
    await finish(report.status || 'ok', null);
    return out;
  } catch (e) {
    await finish('error', e && e.message ? e.message : String(e));
    throw e;
  }
}

module.exports = { withReport, LEDGER_PATH, readLedgerFile };
