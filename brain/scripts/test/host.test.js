'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { currentHost, isHookInvocation, hostDirs, findTranscript, codexHome } = require('../lib/host.js');

test('currentHost is claude unless AOS_HOST=codex', () => {
  assert.equal(currentHost({}), 'claude');
  assert.equal(currentHost({ AOS_HOST: 'codex' }), 'codex');
  assert.equal(currentHost({ AOS_HOST: 'something-else' }), 'claude');
});

test('isHookInvocation recognises both hosts and nothing else', () => {
  assert.equal(isHookInvocation({}), false);
  assert.equal(isHookInvocation({ CLAUDE_PROJECT_DIR: '/tmp/p' }), true);
  assert.equal(isHookInvocation({ AOS_HOST: 'codex' }), true);
  assert.equal(isHookInvocation({ AOS_HOST: '' }), false);
});

test('hostDirs: codex home from config beats CODEX_HOME beats ~/.codex', () => {
  const home = os.homedir();
  assert.equal(codexHome({}), path.join(home, '.codex'));
  assert.equal(codexHome({ CODEX_HOME: '/tmp/ch' }), path.resolve('/tmp/ch'));
  assert.equal(codexHome({ CODEX_HOME: '/tmp/ch' }, { hosts: { codex: { home: '/tmp/cfg-home' } } }), path.resolve('/tmp/cfg-home'));
  const d = hostDirs('codex', { env: { CODEX_HOME: '/tmp/ch' }, userConfig: null });
  assert.equal(d.sessions, path.resolve('/tmp/ch', 'sessions'));
  assert.equal(d.archived, path.resolve('/tmp/ch', 'archived_sessions'));
  assert.equal(d.history, path.resolve('/tmp/ch', 'history.jsonl'));
});

test('hostDirs: claude config dir from config beats CLAUDE_CONFIG_DIR', () => {
  const d = hostDirs('claude', { env: { CLAUDE_CONFIG_DIR: '/tmp/cc' }, userConfig: null });
  assert.equal(d.configDir, path.resolve('/tmp/cc'));
  assert.equal(d.sessions, path.resolve('/tmp/cc', 'projects'));
  const c = hostDirs('claude', { env: { CLAUDE_CONFIG_DIR: '/tmp/cc' }, userConfig: { claudeConfigDir: '/tmp/cfg-cc' } });
  assert.equal(c.configDir, path.resolve('/tmp/cfg-cc'));
});

test('findTranscript walks codex sessions by date, then archived_sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-codex-home-'));
  const day = path.join(home, 'sessions', '2026', '09', '21');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
  const live = path.join(day, 'rollout-2026-09-21T16-50-32-01a0c5bc-1191-77f3-b185-31f412027020.jsonl');
  const old = path.join(home, 'archived_sessions', 'rollout-2026-08-01T10-00-00-0000aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl');
  fs.writeFileSync(live, '{}\n');
  fs.writeFileSync(old, '{}\n');
  const dirs = hostDirs('codex', { env: { CODEX_HOME: home }, userConfig: null });
  assert.equal(findTranscript('codex', '01a0c5bc-1191-77f3-b185-31f412027020', dirs), live);
  assert.equal(findTranscript('codex', '0000aaaa-bbbb-cccc-dddd-eeeeffff0000', dirs), old);
  assert.equal(findTranscript('codex', 'missing', dirs), null);
  assert.equal(findTranscript('codex', '', dirs), null);
});

test('findTranscript finds a claude transcript under any project slug', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-claude-cfg-'));
  fs.mkdirSync(path.join(cfg, 'projects', '-'), { recursive: true });
  const t = path.join(cfg, 'projects', '-', 'abc.jsonl');
  fs.writeFileSync(t, '{}\n');
  const dirs = hostDirs('claude', { env: { CLAUDE_CONFIG_DIR: cfg }, userConfig: null });
  assert.equal(findTranscript('claude', 'abc', dirs), t);
  assert.equal(findTranscript('claude', 'nope', dirs), null);
});
