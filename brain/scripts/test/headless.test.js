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
  assert.deepEqual(H.resolveRunner({ cfg: both, kind: 'routines', env: ENV, lookup: none, candidates: false }), { host: 'claude', bin: CLAUDE, model: null, home: null, reason: 'auto' });
  const codexOnly = { ...both, hosts: { claude: { enabled: false, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } } };
  assert.deepEqual(H.resolveRunner({ cfg: codexOnly, kind: 'persona', env: ENV, lookup: none, candidates: false }), { host: 'codex', bin: CODEX, model: 'gpt-5-mini', home: null, reason: 'auto' });
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
  assert.deepEqual(H.resolveRunner({ cfg: pinned, kind: 'routines', env: ENV, lookup: none, candidates: false }), { host: 'codex', bin: CODEX, model: 'gpt-5-mini', home: null, reason: 'routines.runner=codex' });
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
  // A recorded Codex home travels to the child unless the environment already names one.
  assert.equal(H.headlessEnv({}, { codexHome: '/c/home' }).CODEX_HOME, '/c/home');
  assert.equal(H.headlessEnv({ CODEX_HOME: '/mine' }, { codexHome: '/c/home' }).CODEX_HOME, '/mine');
  assert.equal(H.headlessEnv({}).CODEX_HOME, undefined);
});

test('--resolve prints host, bin, model and the recorded codex home (tab-separated) or exits 3 with the reason', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hl-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none', codex: { model: 'gpt-5-mini' } }));
  const cfg = path.join(vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault, hosts: { claude: { enabled: false }, codex: { enabled: true, bin: CODEX, home: '/c/home' } } }));
  const env = { ...process.env, AOS_VAULT: vault, AOS_CONFIG: cfg, PATH: '/usr/bin:/bin' };
  const ok = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve', '--kind', 'persona'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `codex\t${CODEX}\tgpt-5-mini\t/c/home\n`);
  const no = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js'), '--resolve'], { encoding: 'utf8', env: { ...env, AOS_NO_CODEX: '1' } });
  assert.equal(no.status, 3);
  assert.match(no.stderr, /no runner for routines/);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'headless.js')], { encoding: 'utf8', env }).status, 2);
});

test('a kind\'s own Codex model wins over codex.model (persona.codexModel, routines.codexModel)', () => {
  const cfg = { hosts: { claude: { enabled: false }, codex: { enabled: true, bin: CODEX } }, codex: { model: 'gpt-5-mini' }, persona: { codexModel: 'gpt-5' } };
  assert.equal(H.resolveRunner({ cfg, kind: 'persona', env: ENV, lookup: none, candidates: false }).model, 'gpt-5');
  assert.equal(H.resolveRunner({ cfg, kind: 'routines', env: ENV, lookup: none, candidates: false }).model, 'gpt-5-mini');
  assert.equal(H.resolveRunner({ cfg: { ...cfg, codex: {} }, kind: 'routines', env: ENV, lookup: none, candidates: false }).model, null, 'the user\'s Codex default');
});

test('graphRunner: a pinned runner, else an explicit provider, else Claude when it is a host with a binary, else Codex', () => {
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  const bins = { claude: '/b/claude', codex: '/b/codex' };
  assert.deepEqual(H.graphRunner(both, { bins }), { host: 'claude', bin: '/b/claude' });
  assert.deepEqual(H.graphRunner(both, { bins: { claude: null, codex: '/b/codex' } }), { host: 'codex', bin: '/b/codex' });
  assert.deepEqual(H.graphRunner({ ...both, provider: 'codex' }, { bins }), { host: 'codex', bin: '/b/codex' }, 'provider codex names Codex');
  assert.deepEqual(H.graphRunner({ ...both, graph: { semantic: { runner: 'codex' } } }, { bins }), { host: 'codex', bin: '/b/codex' });
  assert.equal(H.graphRunner({ ...both, provider: 'claude' }, { bins: { claude: null, codex: '/b/codex' } }), null, 'an explicit provider claude never falls to Codex');
  assert.deepEqual(H.graphRunner({ hosts: { claude: { enabled: false }, codex: { enabled: true } } }, { bins }), { host: 'codex', bin: '/b/codex' });
  assert.deepEqual(H.graphRunner({}, { bins }), { host: 'claude', bin: '/b/claude' }, 'a config without hosts is Claude only');
  assert.equal(H.graphRunner({}, { bins: { claude: null, codex: '/b/codex' } }), null);
});

// Spec 2026-09-23-cross-review D4: every isolation flag is pinned, per host and mode.
test('crossArgs: codex review is read-only, ephemeral, hooks and tool features off, strict schema file last', () => {
  const r = H.crossArgs('codex', { mode: 'review', schemaFile: '/t/schema.json', outFile: '/t/reply.txt', model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(r.argv, ['exec', '-', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
    '-c', 'features.hooks=false', '-c', 'features.apps=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false', '-c', 'features.image_generation=false',
    '-c', 'approval_policy="never"', '--json', '-o', '/t/reply.txt', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="high"', '--output-schema', '/t/schema.json']);
  const consult = H.crossArgs('codex', { mode: 'consult', schemaFile: '/t/schema.json', outFile: '/t/r' }).argv;
  assert.ok(consult.includes('read-only') && !consult.includes('--output-schema'), 'consult: read-only, free-text reply');
  assert.ok(!consult.includes('-m'), 'no model: the user\'s Codex default');
});

test('crossArgs: codex build writes inside the workspace with our hooks off; an effort codex does not take is left off', () => {
  const b = H.crossArgs('codex', { mode: 'build', outFile: '/t/r', effort: 'max' }).argv;
  assert.deepEqual(b, ['exec', '-', '--ephemeral', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'features.hooks=false', '-c', 'approval_policy="never"', '--json', '-o', '/t/r']);
});

test('crossArgs: claude review runs in safe mode with only Read/Glob/Grep, no MCP, no persistence, the schema inline', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const r = H.crossArgs('claude', { mode: 'review', schema, model: 'claude-fable-5-1', effort: 'max', budget: 3 }).argv;
  assert.deepEqual(r, ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-prompts', 'none',
    '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
    '--permission-mode', 'dontAsk', '--no-chrome', '--json-schema', JSON.stringify(schema),
    '--model', 'claude-fable-5-1', '--effort', 'max', '--max-budget-usd', '3']);
  const consult = H.crossArgs('claude', { mode: 'consult', schema }).argv;
  assert.ok(consult.includes('--safe-mode') && !consult.includes('--json-schema'), 'consult: read-only, free-text reply');
  assert.ok(!consult.includes('--model') && !consult.includes('--max-budget-usd'), 'unset model and budget are left to the CLI');
});

test('crossArgs: claude build uses acceptEdits with the user\'s permissions, never safe mode or a bypass', () => {
  const b = H.crossArgs('claude', { mode: 'build', effort: 'minimal', budget: 2.5 }).argv;
  assert.deepEqual(b, ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-prompts', 'none', '--permission-mode', 'acceptEdits', '--max-budget-usd', '2.5']);
  assert.ok(!b.includes('bypassPermissions') && !b.includes('--dangerously-skip-permissions'));
  assert.throws(() => H.crossArgs('claude', { mode: 'write' }), /unknown mode write/);
});
