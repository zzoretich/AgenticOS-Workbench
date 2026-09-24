'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const hp = require('../lib/host-process.js');

// A macOS-shaped table: full paths, a comm with spaces, a helper under ~/.codex/ (a decoy for a substring match),
// the Codex TUI with a short-lived helper re-exec'd under the same name below it, then sh and the hook's node.
const PS = [
  '    1     0 Mon Sep 21 08:00:00 2026     /sbin/launchd',
  '  500     1 Mon Sep 21 08:00:01 2026     /opt/tools/.codex/plugins/cache/helper/Helper for Chrome',
  '  600     1 Mon Sep 21 08:00:02 2026     /Applications/Terminal.app/Contents/MacOS/Terminal',
  '  610   600 Wed Sep 23 01:00:00 2026     -zsh',
  '  620   610 Wed Sep  2 01:02:03 2026     /opt/homebrew/Caskroom/codex/0.156.1/bin/codex',
  '  630   620 Wed Sep 23 01:05:00 2026     codex',
  '  640   630 Wed Sep 23 01:05:00 2026     /bin/sh',
  '  650   640 Wed Sep 23 01:05:00 2026     node',
  '  660   650 Wed Sep 23 01:05:00 2026     /usr/lib/codex-linux-sandbox',
  'not a process line',
].join('\n');

test('processTable parses pid, ppid, start time and a comm with spaces; a failing or empty ps gives null', () => {
  const t = hp.processTable({ run: () => PS });
  assert.equal(t.size, 9);
  assert.deepEqual(t.get(500), { ppid: 1, started: new Date('Mon Sep 21 08:00:01 2026').toISOString(), comm: '/opt/tools/.codex/plugins/cache/helper/Helper for Chrome' });
  assert.equal(t.get(620).started, new Date(2026, 8, 2, 1, 2, 3).toISOString(), 'a single-digit day parses');
  assert.equal(hp.processTable({ run: () => { throw new Error('no ps'); } }), null);
  assert.equal(hp.processTable({ run: () => '' }), null);
  assert.equal(hp.parseLstart('garbage'), null);
});

test('findHostProcess: the OUTERMOST ancestor whose basename is exactly the binary; decoys and broken chains give null', () => {
  const table = hp.processTable({ run: () => PS });
  assert.deepEqual(hp.findHostProcess('codex', { pid: 650, table }), { pid: 620, started: table.get(620).started },
    'the TUI, not the helper re-exec\'d under the same name');
  assert.equal(hp.findHostProcess('codex', { pid: 500, table }), null, 'a path containing .codex is not codex');
  assert.equal(hp.findHostProcess('codex', { pid: 660, table }).pid, 620, 'codex-linux-sandbox is not codex');
  assert.equal(hp.findHostProcess('codex', { pid: 9999, table }), null, 'pid not in the table');
  const loop = new Map([[7, { ppid: 8, started: null, comm: 'a' }], [8, { ppid: 7, started: null, comm: 'b' }]]);
  assert.equal(hp.findHostProcess('codex', { pid: 7, table: loop }), null, 'a ppid cycle ends');
});

test('hostProcessState: dead or foreign pid → gone; changed start time → gone; same → alive; anything unsure → unknown', () => {
  const err = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const ok = () => true;
  assert.equal(hp.hostProcessState({}), 'unknown');
  assert.equal(hp.hostProcessState(null), 'unknown');
  assert.equal(hp.hostProcessState({ host_pid: 1, host_started: 'x' }), 'unknown');
  assert.equal(hp.hostProcessState({ host_pid: '42', host_started: 'x' }), 'unknown');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: 'x' }, { kill: err('ESRCH') }), 'gone');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: 'x' }, { kill: err('EPERM') }), 'gone');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: 'x' }, { kill: err('EINVAL') }), 'unknown');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: null }, { kill: ok, started: () => 'x' }), 'unknown');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: 'x' }, { kill: ok, started: () => null }), 'unknown');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: 'x' }, { kill: ok, started: () => 'x' }), 'alive');
  assert.equal(hp.hostProcessState({ host_pid: 42, host_started: 'x' }, { kill: ok, started: () => 'y' }), 'gone');
});

test('against the real process table: a live child is found and alive, then gone once it exits', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const table = hp.processTable();
  assert.ok(table && table.get(child.pid), 'ps lists the child');
  const found = hp.findHostProcess('sleep', { pid: child.pid, table });
  assert.equal(found.pid, child.pid);
  assert.match(found.started, /^\d{4}-\d{2}-\d{2}T/);
  const rec = { host_pid: found.pid, host_started: found.started };
  assert.equal(hp.hostProcessState(rec), 'alive');
  assert.equal(hp.hostProcessState({ ...rec, host_started: '2000-01-01T00:00:00.000Z' }), 'gone', 'a reused pid');
  await new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });
  assert.equal(hp.hostProcessState(rec), 'gone');
});
