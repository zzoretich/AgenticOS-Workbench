'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { withLock } = require('../lib/snapshotLock');

test('withLock runs fn and releases the lock dir', async () => {
  const lockPath = path.join(os.tmpdir(), `aos-lock-${Date.now()}`);
  let ran = false;
  const r = await withLock(lockPath, async () => { ran = true; return 42; });
  assert.equal(ran, true);
  assert.equal(r, 42);
  assert.equal(fs.existsSync(lockPath), false);
});

test('withLock breaks a stale lock older than staleMs', async () => {
  const lockPath = path.join(os.tmpdir(), `aos-lock-stale-${Date.now()}`);
  fs.mkdirSync(lockPath);
  // backdate the lock dir
  const old = Date.now() - 120000;
  fs.utimesSync(lockPath, new Date(old), new Date(old));
  let ran = false;
  await withLock(lockPath, async () => { ran = true; }, { staleMs: 1000, retries: 3, retryMs: 10 });
  assert.equal(ran, true);
});
