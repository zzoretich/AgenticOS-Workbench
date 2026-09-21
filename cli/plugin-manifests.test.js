'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const HOOK_RE = /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/aos" ([a-z-]+)((?: --[a-z-]+)*)$/;

test('marketplace.json names the marketplace and points at ./plugin', () => {
  const m = read('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'agenticos-workbench');
  assert.equal(m.owner.name, 'AgenticOS Workbench contributors');
  assert.deepEqual(m.plugins.map((p) => [p.name, p.source]), [['agenticos', './plugin']]);
  assert.ok(m.plugins[0].description.length > 20);
});

test('plugin.json carries the repo version and the neutral author', () => {
  const p = read('plugin/.claude-plugin/plugin.json');
  assert.equal(p.name, 'agenticos');
  assert.equal(p.version, read('package.json').version);
  assert.equal(p.author.name, 'AgenticOS Workbench contributors');
});

test('hooks.json wires exactly the contract events, in order, through bin/aos', () => {
  const h = read('plugin/hooks/hooks.json').hooks;
  assert.deepEqual(Object.keys(h), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
  const names = (event) => h[event].flatMap((g) => g.hooks.map((x) => {
    const m = HOOK_RE.exec(x.command);
    assert.ok(m, `bad hook command: ${x.command}`);
    assert.equal(x.type, 'command');
    assert.equal(typeof x.timeout, 'number');
    return m[1] + m[2];
  }));
  assert.deepEqual(names('SessionStart'), ['telemetry-hook', 'update-notice']);
  assert.deepEqual(names('UserPromptSubmit'), ['inject-context']);
  assert.deepEqual(names('PostToolUse'), ['telemetry-hook']);
  assert.equal(h.PostToolUse[0].matcher, '');
  assert.deepEqual(names('Stop'), ['update-session', 'heartbeat-writer']);
  assert.deepEqual(names('SessionEnd'), ['telemetry-hook', 'auto-cost', 'heartbeat-writer', 'auto-wrap', 'scan-vault --quiet']);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) for (const g of h[ev]) for (const x of g.hooks) assert.equal(x.timeout, 10);
  for (const g of h.SessionEnd) for (const x of g.hooks) assert.equal(x.timeout, 15);
  assert.ok(!JSON.stringify(h).includes('bash -c'));
});

test('the Codex hook table (cli/codex-host.js) carries every hooks.json command plus inject-conventions, under the 3 s SessionEnd cap', () => {
  const h = read('plugin/hooks/hooks.json').hooks;
  const { HOOKS } = require('./codex-host.js');
  assert.deepEqual(HOOKS.map(([ev]) => ev), Object.keys(h));
  for (const [event, cmds] of HOOKS) {
    const claude = h[event].flatMap((g) => g.hooks.map((x) => HOOK_RE.exec(x.command)).map((m) => m[1] + m[2]));
    const codex = cmds.map(([name]) => name);
    const extra = codex.filter((n) => !claude.includes(n));
    assert.deepEqual(extra, event === 'SessionStart' ? ['inject-conventions'] : [], `${event}: codex-only commands`);
    assert.deepEqual(claude.filter((n) => !codex.includes(n)), [], `${event}: commands missing on codex`);
    for (const [, timeout] of cmds) assert.equal(timeout, event === 'SessionEnd' ? 3 : 10);
  }
  const shim = fs.readFileSync(path.join(ROOT, 'plugin', 'bin', 'aos'), 'utf8');
  assert.match(shim, /^\s*inject-conventions\) SCRIPT=inject-conventions\.js/m);
});

test('.mcp.json declares the agenticos stdio server through bin/aos', () => {
  const m = read('plugin/.mcp.json');
  assert.deepEqual(m, { agenticos: { type: 'stdio', command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/bin/aos', 'mcp-server'] } });
});

test('claude plugin validate accepts the plugin and the marketplace (skipped without claude)', (t) => {
  const which = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  if (which.status !== 0) return t.skip('claude CLI not on PATH');
  for (const target of ['plugin', '.']) {
    const r = spawnSync('claude', ['plugin', 'validate', path.join(ROOT, target)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('bin/aos dispatches every hook and CLI name the manifests reference', () => {
  const shim = fs.readFileSync(path.join(ROOT, 'plugin', 'bin', 'aos'), 'utf8');
  const h = read('plugin/hooks/hooks.json').hooks;
  const referenced = new Set(Object.values(h).flatMap((groups) => groups.flatMap((g) => g.hooks.map((x) => HOOK_RE.exec(x.command)[1]))));
  for (const name of referenced) {
    assert.match(shim, new RegExp(`(^|[|(])\\s*${name}[)|]`, 'm'), `bin/aos does not dispatch ${name}`);
  }
  for (const name of ['update-check', 'update-status', 'update-notice', 'routines']) {
    assert.match(shim, new RegExp(`[|(]${name}[|)]`), `bin/aos does not route ${name} to cli/aos.js`);
  }
  // The two routine entrypoints the HUD and /routines reach by name: the runner (a runtime script) and the verb (cli/aos.js).
  assert.match(shim, /^\s*run-routine\) SCRIPT=routines\/run-routine\.js/m, 'bin/aos does not dispatch run-routine');
});
