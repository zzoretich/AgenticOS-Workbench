'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { currentHost, resolveHost, enabledHosts, isHookInvocation, hostDirs, findTranscript, codexHome } = require('../lib/host.js');

test('currentHost is claude unless AOS_HOST=codex', () => {
  assert.equal(currentHost({}), 'claude');
  assert.equal(currentHost({ AOS_HOST: 'codex' }), 'codex');
  assert.equal(currentHost({ AOS_HOST: 'something-else' }), 'claude');
});

test('resolveHost: AOS_HOST wins, then the Claude env, then the transcript path, then a single enabled host, then claude (D1)', () => {
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  const codexOnly = { hosts: { claude: { enabled: false }, codex: { enabled: true } } };
  const claudeOnly = { hosts: { claude: { enabled: true }, codex: { enabled: false } } };
  const rollout = { transcript_path: '/anywhere/rollout-2026-09-22T10-00-00-abc.jsonl' };
  assert.deepEqual(resolveHost({ env: { AOS_HOST: 'codex' }, payload: null, userConfig: claudeOnly }), { host: 'codex', via: 'aos-host' });
  assert.deepEqual(resolveHost({ env: { AOS_HOST: 'claude' }, payload: rollout, userConfig: codexOnly }), { host: 'claude', via: 'aos-host' });
  assert.deepEqual(resolveHost({ env: { CLAUDE_PROJECT_DIR: '/p' }, payload: rollout, userConfig: codexOnly }), { host: 'claude', via: 'claude-env' });
  assert.deepEqual(resolveHost({ env: { CLAUDECODE: '1' }, payload: null, userConfig: codexOnly }), { host: 'claude', via: 'claude-env' });
  assert.deepEqual(resolveHost({ env: {}, payload: rollout, userConfig: both }), { host: 'codex', via: 'transcript' });
  assert.deepEqual(resolveHost({ env: { CODEX_HOME: '/tmp/ch' }, payload: { transcriptPath: '/tmp/ch/archived_sessions/x.jsonl' }, userConfig: null }), { host: 'codex', via: 'transcript' });
  assert.deepEqual(resolveHost({ env: { CLAUDE_CONFIG_DIR: '/tmp/cc' }, payload: { transcript_path: '/tmp/cc/projects/-slug/abc.jsonl' }, userConfig: codexOnly }), { host: 'claude', via: 'transcript' });
  assert.deepEqual(resolveHost({ env: {}, payload: { transcript_path: '/elsewhere/abc.jsonl' }, userConfig: codexOnly }), { host: 'codex', via: 'config' });
  assert.deepEqual(resolveHost({ env: {}, payload: null, userConfig: codexOnly }), { host: 'codex', via: 'config' });
  assert.deepEqual(resolveHost({ env: {}, payload: null, userConfig: claudeOnly }), { host: 'claude', via: 'config' });
  assert.deepEqual(resolveHost({ env: {}, payload: null, userConfig: both }), { host: 'claude', via: 'default' });
  assert.deepEqual(resolveHost({ env: {}, payload: null, userConfig: { claudeConfigDir: '/x' } }), { host: 'claude', via: 'default' });
  assert.deepEqual(resolveHost({ env: {}, payload: { transcript_path: 42 }, userConfig: null }), { host: 'claude', via: 'default' });
  assert.equal(currentHost({}, rollout), 'codex');
});

test('enabledHosts reads hosts.<name>.enabled and treats a missing block as none', () => {
  assert.deepEqual(enabledHosts(null), []);
  assert.deepEqual(enabledHosts({}), []);
  assert.deepEqual(enabledHosts({ hosts: { claude: { enabled: true }, codex: { enabled: true } } }), ['claude', 'codex']);
  assert.deepEqual(enabledHosts({ hosts: { claude: {}, codex: { enabled: false } } }), ['claude']);
  assert.deepEqual(enabledHosts({ hosts: { codex: { enabled: true } } }), ['codex']);
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
