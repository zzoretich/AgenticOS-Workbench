'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { respawnDetached } = require('../lib/detach.js');

beforeEach(() => { delete process.env.CLAUDE_PROJECT_DIR; delete process.env.AOS_DETACHED; });

test('outside a hook (no CLAUDE_PROJECT_DIR) it does nothing and returns false', () => {
  let spawned = 0;
  assert.equal(respawnDetached(['--quiet'], () => { spawned++; return { unref() {} }; }), false);
  assert.equal(spawned, 0);
});

test('inside a hook it respawns itself detached with AOS_DETACHED=1 and returns true', () => {
  process.env.CLAUDE_PROJECT_DIR = '/tmp/project';
  const calls = [];
  const r = respawnDetached(['--quiet'], (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; });
  assert.equal(r, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [process.argv[1], '--quiet']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(calls[0].opts.env.AOS_DETACHED, '1');
});

test('the detached child (AOS_DETACHED=1) runs inline', () => {
  process.env.CLAUDE_PROJECT_DIR = '/tmp/project';
  process.env.AOS_DETACHED = '1';
  assert.equal(respawnDetached([], () => { throw new Error('must not spawn'); }), false);
});
