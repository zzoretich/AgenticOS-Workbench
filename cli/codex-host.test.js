'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CH = require('./codex-host.js');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin');
const LAUNCHER = '/vaults/demo/brain/scripts/bin/aos';
const CONFIG = '/cfg/agenticos.json';
const CTX = { launcher: LAUNCHER, config: CONFIG };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A fake `run`: records calls; `mcp get` answers from `state.registered`, `mcp add` sets it, `mcp remove` clears it. */
function fakeRun(state = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (key === 'login status') return state.loggedOut ? { status: 1, stdout: 'Not logged in\n', stderr: '' } : { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
    if (key === 'mcp get') return state.registered ? { status: 0, stdout: JSON.stringify({ name: 'agenticos', transport: { type: 'stdio', command: 'sh', args: [state.registered, 'mcp-server'], env: state.hostEnv ? { AOS_CONFIG: CONFIG, AOS_HOST: 'codex' } : { AOS_CONFIG: CONFIG } } }), stderr: '' } : { status: 1, stdout: '', stderr: 'no such server' };
    if (key === 'mcp add') { if (state.failAdd) return { status: 1, stdout: '', stderr: 'boom' }; state.registered = args[args.indexOf('--') + 2]; state.hostEnv = args.includes('AOS_HOST=codex'); return { status: 0, stdout: '', stderr: '' }; }
    if (key === 'mcp remove') { state.registered = null; state.hostEnv = false; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls, state };
}

test('mergeHooks writes the five events through the launcher with AOS_HOST=codex, SessionEnd under the 3 s cap, and is idempotent', () => {
  const doc = CH.mergeHooks(null, CTX);
  assert.deepEqual(Object.keys(doc.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
  const names = (ev) => doc.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command.replace(/^env AOS_HOST=codex AOS_CONFIG='[^']*' sh '[^']*' /, '')));
  assert.deepEqual(names('SessionStart'), ['telemetry-hook', 'update-notice', 'persona-watchdog', 'reconcile-sessions', 'inject-conventions']);
  assert.deepEqual(names('UserPromptSubmit'), ['inject-context']);
  assert.deepEqual(names('PostToolUse'), ['telemetry-hook']);
  assert.deepEqual(names('Stop'), ['update-session', 'heartbeat-writer', 'reconcile-sessions']);
  assert.deepEqual(names('SessionEnd'), ['telemetry-hook', 'auto-cost', 'heartbeat-writer', 'auto-wrap', 'scan-vault --quiet']);
  for (const g of doc.hooks.SessionEnd) for (const h of g.hooks) assert.equal(h.timeout, 3);
  for (const g of doc.hooks.Stop) for (const h of g.hooks) { assert.equal(h.timeout, 10); assert.equal(h.type, 'command'); }
  assert.equal(doc.hooks.Stop[0].hooks[0].command, `env AOS_HOST=codex AOS_CONFIG='${CONFIG}' sh '${LAUNCHER}' update-session`);
  assert.ok(!('matcher' in doc.hooks.PostToolUse[0]), 'no matcher means every tool');
  assert.deepEqual(CH.mergeHooks(doc, CTX), doc, 'merging twice changes nothing');
  assert.deepEqual(CH.mergeHooks(CH.mergeHooks(doc, CTX), CTX).hooks.Stop.length, 1, 'never duplicated');
});

test('mergeHooks keeps foreign entries and unknown keys; a moved launcher replaces the old entry', () => {
  const foreign = { hooks: [{ type: 'command', command: 'echo theirs', timeout: 5 }] };
  const existing = { note: 'mine', hooks: { Stop: [foreign], PreToolUse: [foreign] } };
  const doc = CH.mergeHooks(existing, CTX);
  assert.equal(doc.note, 'mine');
  assert.deepEqual(doc.hooks.PreToolUse, [foreign]);
  assert.equal(doc.hooks.Stop.length, 2);
  assert.deepEqual(doc.hooks.Stop[0], foreign);
  const moved = CH.mergeHooks(doc, { launcher: '/elsewhere/brain/scripts/bin/aos', config: CONFIG });
  assert.equal(moved.hooks.Stop.length, 2);
  assert.match(moved.hooks.Stop[1].hooks[0].command, /elsewhere/);
  assert.equal(CH.countOurEvents(moved), 5);
  assert.equal(CH.countOurEvents({ hooks: { Stop: [foreign] } }), 0);
});

test('stripHooks removes only ours and reports an empty document as null', () => {
  const foreign = { hooks: [{ type: 'command', command: 'echo theirs' }] };
  const doc = CH.mergeHooks({ hooks: { Stop: [foreign] } }, CTX);
  const { doc: left, removed } = CH.stripHooks(doc);
  assert.equal(removed, 5);
  assert.deepEqual(left, { hooks: { Stop: [foreign] } });
  assert.deepEqual(CH.stripHooks(CH.mergeHooks(null, CTX)), { doc: null, removed: 5 });
  assert.deepEqual(CH.stripHooks(null), { doc: null, removed: 0 });
  assert.deepEqual(CH.stripHooks({ other: 1 }), { doc: { other: 1 }, removed: 0 });
});

test('hook commands shell-quote the paths', () => {
  const c = CH.hookCommand({ launcher: "/v/it's here/bin/aos", config: '/c/a b.json' }, 'inject-context');
  assert.equal(c, `env AOS_HOST=codex AOS_CONFIG='/c/a b.json' sh '/v/it'\\''s here/bin/aos' inject-context`);
  assert.ok(CH.isOurs(c));
  assert.ok(!CH.isOurs('sh something inject-context'));
});

test('commandToSkill rewrites every Claude Code idiom and carries the marker', () => {
  const src = [
    '---', 'description: Append a note; tag #promote to make it permanent at /wrap', 'allowed-tools: Read, Edit', 'argument-hint: <text>', '---', '',
    'Remember: **$ARGUMENTS**. Vault: `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json`.',
    'Bash: `aos wrap-session` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" wrap-session`); call `mcp__plugin_agenticos_agenticos__wrap_session` once.',
    'Then run /wrap, not brain/_index/wrap or /wrap-session. Also ${CLAUDE_PLUGIN_ROOT}/bin/aos alone. A Claude Code session ends.',
  ].join('\n');
  const out = CH.commandToSkill('remember', src, { ...CTX, skillsDir: '/home/demo/.agents/skills', names: ['remember', 'wrap'] });
  assert.match(out, /^---\nname: remember\ndescription: Append a note; tag #promote to make it permanent at \/wrap\n---\n/);
  assert.ok(out.split('\n')[4] === CH.GENERATED_MARKER, 'marker right under the frontmatter');
  assert.ok(!/allowed-tools|argument-hint/.test(out));
  assert.match(out, /Remember: \*\*the text the user wrote after `\$remember`\*\*/);
  assert.match(out, /Vault: `\/cfg\/agenticos\.json`/);
  assert.match(out, /sh "\/vaults\/demo\/brain\/scripts\/bin\/aos" wrap-session/);
  assert.match(out, /mcp__agenticos__wrap_session/);
  assert.ok(!/mcp__plugin_agenticos|CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR|\$ARGUMENTS/.test(out));
  assert.match(out, /Then run \$wrap, not brain\/_index\/wrap or \/wrap-session\./);
  assert.match(out, /Also \/vaults\/demo\/brain\/scripts\/bin\/aos alone\. A Codex session ends\./);
  assert.match(out, /> Host: Codex CLI\. Invoke as `\$remember`/);
});

test('generateSkills turns the real plugin into 23 marked skills, copies skill scripts, and never overwrites a foreign skill', () => {
  const dir = tmp('aos-skills-');
  fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'brain', 'SKILL.md'), '---\nname: brain\ndescription: the user\'s own brain skill\n---\nmine\n');
  const warnings = [];
  const r = CH.generateSkills({ pluginDir: PLUGIN, dir, launcher: LAUNCHER, config: CONFIG, io: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(r.skipped, ['brain']);
  assert.equal(warnings.length, 1);
  assert.equal(r.written.length, 20, 'seventeen commands and six skills, two shared names (wrap, cost), one foreign (brain)');
  assert.equal(CH.countGenerated(dir), 20);
  assert.equal(fs.readFileSync(path.join(dir, 'brain', 'SKILL.md'), 'utf8').trim().endsWith('mine'), true);
  for (const name of r.written) {
    const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`), `${name}: name`);
    assert.ok(text.includes(CH.GENERATED_MARKER), `${name}: marker`);
    assert.ok(!/CLAUDE_PLUGIN_ROOT|CLAUDE_CONFIG_DIR|mcp__plugin_agenticos|\$ARGUMENTS/.test(text), `${name}: leftover Claude idiom`);
  }
  const wrap = fs.readFileSync(path.join(dir, 'wrap', 'SKILL.md'), 'utf8');
  assert.match(wrap, /mcp__agenticos__wrap_session/);
  assert.match(wrap, /## The `\$wrap` procedure/, 'the command steps are appended to the skill of the same name');
  assert.ok(fs.existsSync(path.join(dir, 'persona-flag-closer', 'scripts', 'collect.js')), 'skill scripts travel with the skill');
  assert.match(fs.readFileSync(path.join(dir, 'persona-flag-closer', 'SKILL.md'), 'utf8'), new RegExp(`SKILL_DIR = ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/persona-flag-closer`));
  // re-run: same set, nothing duplicated, foreign still skipped
  const again = CH.generateSkills({ pluginDir: PLUGIN, dir, launcher: LAUNCHER, config: CONFIG });
  assert.deepEqual(again.written.sort(), r.written.sort());
  assert.deepEqual(CH.removeSkills({ dir }).sort(), r.written.sort());
  assert.ok(fs.existsSync(path.join(dir, 'brain', 'SKILL.md')), 'the foreign skill survives removal');
  assert.equal(CH.countGenerated(dir), 0);
});

test('installCodexHost writes hooks.json, registers the MCP server once, generates skills; removeCodexHost reverses it', () => {
  const home = tmp('aos-codex-home-');
  const dir = tmp('aos-skills2-');
  const env = { CODEX_HOME: home };
  const { run, calls, state } = fakeRun();
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.hooksFile, path.join(home, 'hooks.json'));
  assert.equal(r.hooksChanged, true);
  assert.equal(r.mcp, 'added');
  assert.equal(state.registered, LAUNCHER);
  assert.ok(calls.some((c) => c.join(' ') === `/x/codex mcp add agenticos --env AOS_CONFIG=${CONFIG} --env AOS_HOST=codex -- sh ${LAUNCHER} mcp-server`));
  assert.equal(r.skills.written.length, 21);
  const doc = JSON.parse(fs.readFileSync(r.hooksFile, 'utf8'));
  assert.equal(CH.countOurEvents(doc), 5);
  // second run: present, unchanged
  const again = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(again.hooksChanged, false);
  assert.equal(again.mcp, 'present');
  assert.equal(calls.filter((c) => c[1] === 'mcp' && c[2] === 'add').length, 1);
  const st = CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir });
  assert.equal(st.loggedIn, true);
  assert.equal(st.hookEvents, 5);
  assert.equal(st.mcp, 'ok');
  assert.equal(st.skills, 21);
  assert.equal(st.memories, false);
  const rm = CH.removeCodexHost({ cfg: {}, bin: '/x/codex', run, env, dir });
  assert.equal(rm.hooksFileState, 'deleted');
  assert.equal(rm.hooksRemoved, 5);
  assert.equal(rm.mcp, 'removed');
  assert.equal(state.registered, null);
  assert.equal(rm.skills.length, 21);
  assert.ok(!fs.existsSync(r.hooksFile));
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).hookEvents, 0);
});

test('a user hooks.json with its own entries is merged into and left standing after removal; mcp add failure is a warning', () => {
  const home = tmp('aos-codex-home2-');
  const dir = tmp('aos-skills3-');
  const env = { CODEX_HOME: home };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  const { run, state } = fakeRun({ failAdd: true });
  const warnings = [];
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir, io: { warn: (m) => warnings.push(m) } });
  assert.equal(r.mcp, 'failed');
  assert.match(warnings[0], /codex mcp add failed/);
  assert.equal(state.registered, null);
  const doc = JSON.parse(fs.readFileSync(r.hooksFile, 'utf8'));
  assert.equal(doc.hooks.Stop.length, 2);
  assert.equal(doc.hooks.Stop[0].hooks[0].command, 'say done');
  const rm = CH.removeCodexHost({ cfg: {}, bin: null, run, env, dir });
  assert.equal(rm.hooksFileState, 'kept-foreign');
  assert.equal(rm.mcp, 'no-binary');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.hooksFile, 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('codexBin: AOS_NO_CODEX hides it, AOS_CODEX_BIN wins, then the recorded path, then PATH', () => {
  const exe = path.join(tmp('aos-cx-'), 'codex');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(CH.codexBin({}, { env: { AOS_NO_CODEX: '1', AOS_CODEX_BIN: '/x' } }), null);
  assert.equal(CH.codexBin({}, { env: { AOS_CODEX_BIN: '/x' } }), '/x');
  assert.equal(CH.codexBin({ hosts: { codex: { bin: exe } } }, { env: {}, which: () => '/from/path' }), exe);
  assert.equal(CH.codexBin({ hosts: { codex: { bin: '/gone' } } }, { env: {}, which: () => '/from/path' }), '/from/path');
  assert.equal(CH.codexLoggedIn('/x', () => ({ status: 0, stdout: 'Logged in using ChatGPT', stderr: '' })), true);
  assert.equal(CH.codexLoggedIn('/x', () => ({ status: 0, stdout: 'Not logged in', stderr: '' })), false);
  assert.equal(CH.codexLoggedIn(null), false);
});

test('codexHome and memoriesEnabled read the config the way Codex does', () => {
  const home = tmp('aos-cx-home-');
  assert.equal(CH.codexHome({}, { CODEX_HOME: home }), home);
  assert.equal(CH.codexHome({ hosts: { codex: { home: '/cfg-home' } } }, { CODEX_HOME: home }), path.resolve('/cfg-home'));
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), false);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n[features]\nhooks = true\nmemories = true\n[projects."/p"]\ntrust_level = "trusted"\n');
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), true);
  fs.writeFileSync(path.join(home, 'config.toml'), '[memories]\ngenerate_memories = true\n');
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), true);
  fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks = true\n[other]\nmemories = true\n');
  assert.equal(CH.memoriesEnabled({}, { CODEX_HOME: home }), false);
});

test('a 0.5.0 MCP registration (launcher right, no AOS_HOST env) reads as stale and is re-added with the env (codex-parity D2)', () => {
  const home = tmp('aos-codex-home3-');
  const dir = tmp('aos-skills4-');
  const env = { CODEX_HOME: home };
  const { run, calls, state } = fakeRun({ registered: LAUNCHER, hostEnv: false });
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: LAUNCHER }), 'stale');
  assert.equal(CH.mcpRegistered({ bin: '/x/codex', run, launcher: LAUNCHER }), false);
  assert.equal(CH.codexHostStatus({ cfg: {}, launcher: LAUNCHER, run, env: { ...env, AOS_CODEX_BIN: '/x/codex' }, dir }).mcp, 'stale');
  const r = CH.installCodexHost({ cfg: {}, launcher: LAUNCHER, config: CONFIG, pluginDir: PLUGIN, bin: '/x/codex', run, env, dir });
  assert.equal(r.mcp, 'added');
  assert.equal(state.hostEnv, true);
  assert.ok(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove'), 'the stale entry is removed before the add');
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: LAUNCHER }), 'ok');
  assert.equal(CH.mcpState({ bin: null, run, launcher: LAUNCHER }), 'no-binary');
  assert.equal(CH.mcpState({ bin: '/x/codex', run, launcher: '/elsewhere/aos' }), 'missing');
  assert.deepEqual(CH.mcpAddArgs({ config: CONFIG, launcher: LAUNCHER }).slice(0, 7), ['mcp', 'add', 'agenticos', '--env', `AOS_CONFIG=${CONFIG}`, '--env', 'AOS_HOST=codex']);
});
