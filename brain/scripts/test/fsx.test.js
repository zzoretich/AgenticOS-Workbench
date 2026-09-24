'use strict';
// lib/fsx.js: unique temp names, an owner-aware lock, and no lost write between processes (spec 2026-09-24-append-only-runs D1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fsx = require('../lib/fsx.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fsx-'));
const FSX = path.join(__dirname, '..', 'lib', 'fsx.js');

function runChildren(count, code) {
  return Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (status) => (status === 0 ? resolve() : reject(new Error(`child ${i} exited ${status}: ${err}`))));
  })));
}

test('writeAtomic writes the whole file and leaves no temp file', () => {
  const file = path.join(DIR, 'nested', 'a.json');
  fsx.writeAtomic(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  fsx.writeAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
});

test('updateSync writes only a changed string and passes null for a missing file', () => {
  const file = path.join(DIR, 'u.txt');
  assert.equal(fsx.updateSync(file, (t) => { assert.equal(t, null); return 'one'; }), 'one');
  const mtime = fs.statSync(file).mtimeMs;
  fsx.updateSync(file, (t) => t);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'unchanged text is not rewritten');
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test('a lock whose owner is gone or past its deadline is broken; a live one is waited for, then busy', () => {
  const file = path.join(DIR, 'held.txt');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, id: 'dead', until: new Date(Date.now() + 60000).toISOString() }));
  assert.equal(fsx.withLockSync(file, () => 'ran'), 'ran', 'a dead pid');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, id: 'expired', until: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(fsx.withLockSync(file, () => 'ran'), 'ran', 'past its until');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, id: 'live', until: new Date(Date.now() + 60000).toISOString() }));
  assert.throws(() => fsx.withLockSync(file, () => 'never', { timeoutMs: 60 }), (e) => e.code === 'LOCK_BUSY');
  assert.equal(fsx.withLockSync(file, () => 'anyway', { timeoutMs: 60, onBusy: 'run' }), 'anyway');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).id, 'live', 'a lock that is not ours is never removed');
  fs.unlinkSync(`${file}.lock`);
});

test('the lock is released after fn throws', () => {
  const file = path.join(DIR, 'throws.txt');
  assert.throws(() => fsx.withLockSync(file, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test('four processes incrementing one counter lose no update', async () => {
  const file = path.join(DIR, 'counter.txt');
  const code = `const fsx = require(${JSON.stringify(FSX)});
    for (let i = 0; i < 40; i++) fsx.updateSync(${JSON.stringify(file)}, (t) => String((parseInt(t || '0', 10) || 0) + 1), { timeoutMs: 20000 });`;
  await runChildren(4, code);
  assert.equal(fs.readFileSync(file, 'utf8'), '160');
});

test('rows appended while another process rewrites the log are never lost (the retention race)', async () => {
  const file = path.join(DIR, 'runs.jsonl');
  fs.writeFileSync(file, '');
  const appender = `const fsx = require(${JSON.stringify(FSX)}); const me = process.argv[1];
    for (let i = 0; i < 50; i++) fsx.appendLineSync(${JSON.stringify(file)}, JSON.stringify({ me, i }), { lock: true, timeoutMs: 20000, onBusy: 'throw' });`;
  const rewriter = `const fs = require('fs'); const fsx = require(${JSON.stringify(FSX)});
    const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
    for (let i = 0; i < 60; i++) fsx.withLockSync(${JSON.stringify(file)}, () => {
      const text = fs.readFileSync(${JSON.stringify(file)}, 'utf8'); pause(); fsx.writeAtomic(${JSON.stringify(file)}, text);
    }, { timeoutMs: 20000 });`;
  await Promise.all([runChildren(4, appender), runChildren(1, rewriter)]);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 200);
  assert.equal(new Set(lines).size, 200);
});
