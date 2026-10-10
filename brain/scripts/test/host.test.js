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

test('invocation and invocationHint: /name on Claude Code, $agenticos:name (plugin) or $name (direct) on Codex, both when both', () => {
  const H = require('../lib/host.js');
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true, install: 'plugin' } } };
  const codexDirect = { hosts: { claude: { enabled: false }, codex: { enabled: true, install: 'direct' } } };
  assert.equal(H.invocation('wrap', 'claude', { userConfig: both }), '/wrap');
  assert.equal(H.invocation('wrap', 'codex', { userConfig: both }), '$agenticos:wrap');
  assert.equal(H.invocation('wrap', 'codex', { userConfig: codexDirect }), '$wrap');
  assert.equal(H.invocationHint('wrap', { userConfig: null }), '/wrap', 'no config: Claude only');
  assert.equal(H.invocationHint('wrap', { userConfig: codexDirect }), '$wrap');
  assert.equal(H.invocationHint('wrap', { userConfig: both }), '/wrap (Claude Code) or $agenticos:wrap (Codex)');
});

test('sessionFiles (claude): top-level transcripts under a custom claudeConfigDir, subagents and other files skipped (spaces-redesign D25)', () => {
  const { sessionFiles } = require('../lib/host.js');
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-claude-custom-'));
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-claude-env-'));
  const id = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
  const slug = path.join(cfgDir, 'projects', '-w-vault');
  fs.mkdirSync(path.join(slug, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(slug, `${id}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(slug, id, 'subagents', 'agent-a1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(slug, 'notes.txt'), 'x');
  const older = path.join(cfgDir, 'projects', '-w-vault-workspaces-demo', 'older.jsonl');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.writeFileSync(older, '{}\n');
  fs.utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.writeFileSync(path.join(cfgDir, 'projects', 'stray.jsonl'), '{}\n');
  fs.mkdirSync(path.join(envDir, 'projects', '-x'), { recursive: true });
  fs.writeFileSync(path.join(envDir, 'projects', '-x', 'env.jsonl'), '{}\n');

  const want = [path.join('projects', '-w-vault', `${id}.jsonl`), path.join('projects', '-w-vault-workspaces-demo', 'older.jsonl')];
  const rows = sessionFiles('claude', { env: {}, userConfig: { claudeConfigDir: cfgDir } });
  assert.deepEqual(rows.map((r) => path.relative(cfgDir, r.file)), want, 'no CLAUDE_CONFIG_DIR: agenticos.json claudeConfigDir alone; newest first; no subagent, no stray');
  assert.equal(rows[0].host, 'claude');
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].archived, false);
  assert.equal(rows[0].size, 3);
  assert.equal(typeof rows[0].mtimeMs, 'number');
  assert.equal(rows[1].id, 'older');
  const both = sessionFiles('claude', { env: { CLAUDE_CONFIG_DIR: envDir }, userConfig: { claudeConfigDir: cfgDir } });
  assert.deepEqual(both.map((r) => path.relative(cfgDir, r.file)), want, 'claudeConfigDir beats CLAUDE_CONFIG_DIR');
  assert.deepEqual(sessionFiles('claude', { env: { CLAUDE_CONFIG_DIR: envDir }, userConfig: null }).map((r) => r.id), ['env'], 'without claudeConfigDir, CLAUDE_CONFIG_DIR');
});

test('sessionFiles (codex): rollouts under sessions/ and archived_sessions/, the index file beside them (spaces-redesign D25)', () => {
  const { sessionFiles } = require('../lib/host.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-codex-files-'));
  const liveId = '01a0c5bc-1191-77f3-b185-31f412027020';
  const oldId = '0000aaaa-bbbb-cccc-dddd-eeeeffff0000';
  const day = path.join(home, 'sessions', '2026', '10', '05');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
  const live = path.join(day, `rollout-2026-10-05T09-00-00-${liveId}.jsonl`);
  const old = path.join(home, 'archived_sessions', `rollout-2026-08-01T10-00-00-${oldId}.jsonl`);
  fs.writeFileSync(live, '{}\n');
  fs.writeFileSync(old, '{}\n');
  fs.utimesSync(old, new Date('2026-08-01T10:00:00Z'), new Date('2026-08-01T10:00:00Z'));
  fs.writeFileSync(path.join(day, 'notes.jsonl'), '{}\n');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), '{}\n');
  fs.writeFileSync(path.join(home, 'history.jsonl'), '{}\n');

  const d = hostDirs('codex', { env: { CODEX_HOME: home }, userConfig: null });
  assert.equal(d.index, path.join(home, 'session_index.jsonl'));
  assert.equal(hostDirs('codex', { env: {}, userConfig: { hosts: { codex: { home } } } }).index, path.join(home, 'session_index.jsonl'), 'hosts.codex.home moves the index too');
  const rows = sessionFiles('codex', { env: { CODEX_HOME: home }, userConfig: null });
  assert.deepEqual(rows.map((r) => [r.file, r.id, r.archived, r.host]), [[live, liveId, false, 'codex'], [old, oldId, true, 'codex']]);
  assert.deepEqual(sessionFiles('codex', { dirs: d }).map((r) => r.file), [live, old], 'dirs can be passed in');
});

test('sessionFiles: missing folders and an unknown host give nothing; sessionIdFromFile reads each naming scheme', () => {
  const { sessionFiles, sessionIdFromFile } = require('../lib/host.js');
  const nowhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-none-')), 'missing');
  assert.deepEqual(sessionFiles('claude', { env: {}, userConfig: { claudeConfigDir: nowhere } }), []);
  assert.deepEqual(sessionFiles('codex', { env: { CODEX_HOME: nowhere }, userConfig: null }), []);
  assert.deepEqual(sessionFiles('not-a-host', { env: {}, userConfig: null }), []);
  assert.equal(sessionIdFromFile('claude', '/x/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.jsonl'), '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d');
  assert.equal(sessionIdFromFile('claude', '/x/notes.txt'), null);
  assert.equal(sessionIdFromFile('codex', '/x/rollout-2026-10-05T09-00-00-01a0c5bc-1191-77f3-b185-31f412027020.jsonl'), '01a0c5bc-1191-77f3-b185-31f412027020');
  assert.equal(sessionIdFromFile('codex', '/x/rollout-2026-10-05T09-00-00-01A0C5BC-1191-77F3-B185-31F412027020.jsonl'), '01A0C5BC-1191-77F3-B185-31F412027020', 'case kept: the caller insists on lowercase');
  assert.equal(sessionIdFromFile('codex', '/x/rollout-2026-10-05T09-00-00.jsonl'), null);
  assert.equal(sessionIdFromFile('codex', '/x/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.jsonl'), null, 'a codex transcript is always a rollout');
});
