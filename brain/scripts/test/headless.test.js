'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../lib/headless.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-headless-'));
const exe = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
const CLAUDE = exe('claude');
const CODEX = exe('codex');
const none = () => null;
const both = { hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } }, codex: { model: 'gpt-5-mini' } };
const ENV = { PATH: '/usr/bin:/bin' };

test('resolveRunner: auto prefers claude, falls back to codex, and honours the enabled flags and the recorded binaries', () => {
  assert.deepEqual(H.resolveRunner({ cfg: both, kind: 'routines', env: ENV, lookup: none, candidates: false }), { host: 'claude', bin: CLAUDE, model: null, reason: 'auto' });
  const codexOnly = { ...both, hosts: { claude: { enabled: false, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } } };
  assert.deepEqual(H.resolveRunner({ cfg: codexOnly, kind: 'persona', env: ENV, lookup: none, candidates: false }), { host: 'codex', bin: CODEX, model: 'gpt-5-mini', reason: 'auto' });
  const claudeGone = { ...both, hosts: { claude: { enabled: true, bin: '/nowhere/claude' }, codex: { enabled: true, bin: CODEX } } };
  assert.equal(H.resolveRunner({ cfg: claudeGone, env: ENV, lookup: none, candidates: false }).host, 'codex');
  const legacy = { claude: { bin: CLAUDE } };
  assert.equal(H.resolveRunner({ cfg: legacy, env: ENV, lookup: none, candidates: false }).host, 'claude', 'a pre-0.5.0 config (no hosts) is claude only');
  const legacyGone = { claude: { bin: '/nowhere/claude' }, codex: { bin: CODEX } };
  const r = H.resolveRunner({ cfg: legacyGone, env: ENV, lookup: none, candidates: false });
  assert.equal(r.host, null);
  assert.match(r.reason, /claude CLI not found; codex host disabled/);
  assert.equal(H.resolveRunner({ cfg: {}, env: ENV, lookup: (n) => (n === 'claude' ? CLAUDE : null), candidates: false }).bin, CLAUDE, 'PATH lookup');
  assert.equal(H.resolveRunner({ cfg: null, env: ENV, lookup: none, candidates: false }).host, null);
});

test('resolveRunner: <kind>.runner and AOS_RUNNER pin a host; AOS_NO_*, AOS_CODEX_BIN and PERSONA_CLAUDE_BIN steer the binaries', () => {
  const pinned = { ...both, routines: { runner: 'codex' }, persona: { runner: 'claude' } };
  assert.deepEqual(H.resolveRunner({ cfg: pinned, kind: 'routines', env: ENV, lookup: none, candidates: false }), { host: 'codex', bin: CODEX, model: 'gpt-5-mini', reason: 'routines.runner=codex' });
  assert.equal(H.resolveRunner({ cfg: pinned, kind: 'persona', env: ENV, lookup: none, candidates: false }).host, 'claude');
  const disabledButPinned = { ...pinned, hosts: { claude: { enabled: false, bin: CLAUDE }, codex: { enabled: false, bin: CODEX } } };
  assert.equal(H.resolveRunner({ cfg: disabledButPinned, kind: 'routines', env: ENV, lookup: none, candidates: false }).host, 'codex', 'an explicit runner ignores the enabled flag');
  assert.equal(H.resolveRunner({ cfg: both, env: { ...ENV, AOS_RUNNER: 'codex' }, lookup: none, candidates: false }).host, 'codex');
  assert.equal(H.resolveRunner({ cfg: both, env: { ...ENV, AOS_NO_CLAUDE: '1' }, lookup: none, candidates: false }).host, 'codex');
  assert.equal(H.resolveRunner({ cfg: both, env: { ...ENV, AOS_NO_CLAUDE: '1', AOS_NO_CODEX: '1' }, lookup: none, candidates: false }).host, null);
  const other = exe('codex2');
  assert.equal(H.resolveRunner({ cfg: { ...both, hosts: { claude: { enabled: false }, codex: { enabled: true } } }, env: { ...ENV, AOS_CODEX_BIN: other }, lookup: none, candidates: false }).bin, other);
  assert.equal(H.resolveRunner({ cfg: both, kind: 'persona', env: { ...ENV, PERSONA_CLAUDE_BIN: '/nowhere/claude' }, lookup: none, candidates: false }).host, 'codex', 'a set but missing PERSONA_CLAUDE_BIN never falls through to another claude');
  assert.equal(H.resolveRunner({ cfg: both, kind: 'routines', env: { ...ENV, PERSONA_CLAUDE_BIN: '/nowhere/claude' }, lookup: none, candidates: false }).host, 'claude', 'PERSONA_CLAUDE_BIN is a persona knob only');
});

test('runnerArgs: the claude recipe is unchanged; codex takes the prompt on stdin with the sandbox and hooks off', () => {
  const spec = { prompt: 'do it', system: 'SYS', model: 'haiku', effort: 'high', tools: 'Read,Glob', budget: 1.5, outFile: '/tmp/x.txt' };
  const c = H.runnerArgs('claude', spec);
  assert.deepEqual(c.argv, ['-p', 'do it', '--model', 'haiku', '--effort', 'high', '--allowedTools', 'Read,Glob', '--max-budget-usd', '1.5', '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence', '--append-system-prompt', 'SYS']);
  assert.equal(c.stdin, null);
  assert.equal(H.runnerArgs('claude', { prompt: 'p', effort: 'xhigh' }).argv[5], 'medium', 'an unknown claude effort falls back');
  const x = H.runnerArgs('codex', { ...spec, model: 'gpt-5-mini' });
  assert.deepEqual(x.argv, ['exec', '-', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-c', 'features.hooks=false', '--json', '-o', '/tmp/x.txt', '-m', 'gpt-5-mini', '-c', 'model_reasoning_effort="high"']);
  assert.equal(x.stdin, 'SYS\n\n---\n\ndo it');
  const bare = H.runnerArgs('codex', { prompt: 'p', model: null, effort: 'nope' });
  assert.ok(!bare.argv.includes('-m') && !bare.argv.some((a) => a.startsWith('model_reasoning_effort')));
  assert.equal(bare.stdin, 'p');
  assert.equal(H.headlessEnv({ CLAUDECODE: '1', X: 'y' }).CLAUDECODE, undefined);
  assert.equal(H.headlessEnv({}).AOS_HEADLESS, '1');
});

test('--resolve prints host, bin and model (tab-separated) or exits 3 with the reason', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hl-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', codex: { model: 'gpt-5-mini' } }));
  const cfg = path.join(vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault, hosts: { claude: { enabled: false }, codex: { enabled: true, bin: CODEX } } }));
  const env = { ...process.env, AOS_VAULT: vault, AOS_CONFIG: cfg, PATH: '/usr/bin:/bin' };
  const ok = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve', '--kind', 'persona'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `codex\t${CODEX}\tgpt-5-mini\n`);
  const no = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve'], { encoding: 'utf8', env: { ...env, AOS_NO_CODEX: '1' } });
  assert.equal(no.status, 3);
  assert.match(no.stderr, /no runner for routines/);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js')], { encoding: 'utf8', env }).status, 2);
});
