'use strict';
// lib/statusline-install.js and statusline.js (spec 2026-09-28-statusline-design): the opt-in install into Claude
// Code's settings.json and Codex's config.toml (D1, D7, D8), the chain and its bookkeeping (D2, D9), the refusals, and
// the render/subagents hot path that never fails a session.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../lib/statusline-install.js');
const M = require('../lib/statusline-model.js');
const SL = require('../statusline.js');

const NOW = new Date('2026-09-28T19:00:00Z');
const GSD = { type: 'command', command: 'node ~/.claude/hooks/gsd-statusline.js', refreshInterval: 5 };
const CFG = { statusline: { segments: ['needs-you', 'runs', 'spend', 'health'], links: true, subagents: true, refreshSeconds: 5, codexItems: ['model-with-reasoning', 'git-branch'] } };
const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;

/** A machine: Claude config dir, Codex home, agenticos.json, and a vault, all in one temp folder. */
function machine({ settings = { model: 'opus', statusLine: GSD }, toml = 'model = "gpt-5"\n', hosts = { claude: { enabled: true }, codex: { enabled: true } } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-install-'));
  const claudeDir = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  const vault = path.join(root, 'vault');
  for (const d of [claudeDir, codexHome, path.join(vault, 'brain', '_index')]) fs.mkdirSync(d, { recursive: true });
  if (settings !== null) fs.writeFileSync(path.join(claudeDir, 'settings.json'), pretty(settings));
  if (toml !== null) fs.writeFileSync(path.join(codexHome, 'config.toml'), toml);
  const userConfigFile = path.join(claudeDir, 'agenticos.json');
  const userCfg = { vault, claudeConfigDir: claudeDir, ...(hosts ? { hosts: { ...hosts, codex: hosts.codex ? { ...hosts.codex, home: codexHome } : undefined } } : {}) };
  fs.writeFileSync(userConfigFile, pretty(userCfg));
  const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome };
  const ctx = { vault, userConfigFile, userCfg, cfg: CFG, env, now: NOW };
  return { root, claudeDir, codexHome, vault, userConfigFile, userCfg, env, ctx, settingsFile: path.join(claudeDir, 'settings.json'), tomlFile: path.join(codexHome, 'config.toml') };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function run(m, argv, opts = {}) {
  const out = [];
  const err = [];
  const code = await SL.main(argv, {
    stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { ...m.env, AOS_NO_SPAWN: '1' }, now: () => NOW,
    vault: m.vault, cfg: CFG, userConfigFile: m.userConfigFile, userCfg: m.userCfg, stdin: async () => '', cwd: m.vault,
    spawnSyncFn: () => ({ status: 1, stdout: '' }), ...opts,
  });
  return { code, out: out.join(''), err: err.join('') };
}

// ── Claude Code ──

test('claude install: our line takes the slot, the previous one is recorded for the chain, a backup is kept', () => {
  const m = machine();
  const before = fs.readFileSync(m.settingsFile, 'utf8');
  const [r] = I.install(m.ctx, { host: 'claude' });
  assert.equal(r.ok, true);
  assert.equal(r.chained, GSD.command);
  const s = readJson(m.settingsFile);
  assert.equal(s.model, 'opus', 'other settings are kept');
  assert.ok(I.isOurs(s.statusLine.command, 'render'));
  assert.equal(s.statusLine.command, `sh '${path.join(m.vault, 'brain/scripts/bin/aos')}' statusline render`);
  assert.equal(s.statusLine.refreshInterval, 5);
  assert.equal(s.statusLine.hideVimModeIndicator, true);
  assert.ok(I.isOurs(s.subagentStatusLine.command, 'subagents'), 'D8: subagent rows come with the same opt-in install');
  assert.equal(fs.readFileSync(`${m.settingsFile}.aos-statusline.bak`, 'utf8'), before);
  const state = readJson(I.statePath(m.userConfigFile));
  assert.deepEqual(state.claude.previous, GSD);
  assert.equal(state.claude.previousSubagent, null);
  assert.deepEqual(readJson(m.userConfigFile), m.userCfg, 'agenticos.json is never written (hosts semantics stay as they were)');
});

test('claude re-install keeps the first chain; a slot someone took is taken back and the newcomer chained (D9)', () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude' });
  I.install(m.ctx, { host: 'claude' });
  assert.deepEqual(readJson(I.statePath(m.userConfigFile)).claude.previous, GSD, 're-install over our own line');
  const other = { type: 'command', command: 'node ~/.claude/hooks/other.js' };
  fs.writeFileSync(m.settingsFile, pretty({ ...readJson(m.settingsFile), statusLine: other }));
  assert.equal(I.slotTakenBy(m.ctx), other.command);
  const [r] = I.install(m.ctx, { host: 'claude' });
  assert.equal(r.retook, true);
  assert.equal(r.chained, other.command);
  assert.equal(I.slotTakenBy(m.ctx), null);
});

test('claude uninstall restores settings.json byte for byte, with or without a previous line', () => {
  for (const settings of [{ model: 'opus', statusLine: GSD }, { model: 'opus', hooks: { Stop: [] } }]) {
    const m = machine({ settings });
    const before = fs.readFileSync(m.settingsFile, 'utf8');
    I.install(m.ctx, { host: 'claude' });
    const [r] = I.uninstall(m.ctx, { host: 'claude' });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(m.settingsFile, 'utf8'), before);
    assert.equal(fs.existsSync(I.statePath(m.userConfigFile)), false, 'no state left behind');
    assert.equal(fs.existsSync(`${m.settingsFile}.aos-statusline.bak`), false, 'nor the backup');
  }
});

test('claude uninstall leaves a slot someone else took, and says so', () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude' });
  const other = { type: 'command', command: 'other' };
  fs.writeFileSync(m.settingsFile, pretty({ ...readJson(m.settingsFile), statusLine: other }));
  const [r] = I.uninstall(m.ctx, { host: 'claude' });
  assert.deepEqual(readJson(m.settingsFile).statusLine, other);
  assert.match(r.notes.join(), /now other; left as it is/);
  assert.ok(fs.existsSync(`${m.settingsFile}.aos-statusline.bak`), 'the backup stays when the file changed hands');
  assert.equal(readJson(m.settingsFile).subagentStatusLine, undefined, 'our subagent rows still come out');
});

test('claude refusals and skips: invalid JSON, a headless run, no config folder; subagents off', () => {
  const m = machine();
  fs.writeFileSync(m.settingsFile, '{ nope');
  assert.throws(() => I.install(m.ctx, { host: 'claude' }), I.Refusal);
  assert.equal(fs.readFileSync(m.settingsFile, 'utf8'), '{ nope');
  const h = machine();
  assert.throws(() => I.install({ ...h.ctx, env: { ...h.env, AOS_HEADLESS: '1' } }, { host: 'claude' }), /headless run cannot change it/);
  assert.throws(() => I.uninstall({ ...h.ctx, env: { AOS_HEADLESS: '1' } }), I.Refusal);
  const gone = machine();
  fs.rmSync(gone.claudeDir, { recursive: true });
  assert.equal(I.install({ ...gone.ctx, userConfigFile: path.join(gone.root, 'agenticos.json') }, { host: 'claude' })[0].skipped, true);
  const off = machine({ settings: { subagentStatusLine: { type: 'command', command: 'mine' } } });
  I.install({ ...off.ctx, cfg: { statusline: { subagents: false } } }, { host: 'claude' });
  assert.deepEqual(readJson(off.settingsFile).subagentStatusLine, { type: 'command', command: 'mine' }, 'left alone when off');
});

test('targetHosts: --host, every enabled host, or Claude Code for a config with no hosts block', () => {
  assert.deepEqual(I.targetHosts({ hosts: { claude: {}, codex: {} } }), ['claude', 'codex']);
  assert.deepEqual(I.targetHosts({ hosts: { claude: { enabled: false }, codex: {} } }), ['codex']);
  assert.deepEqual(I.targetHosts({}), ['claude']);
  assert.deepEqual(I.targetHosts({}, 'codex'), ['codex']);
  assert.throws(() => I.targetHosts({}, 'emacs'), I.Refusal);
});

test('reapply: our entries follow the vault; a lost slot is never retaken (D9)', () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude' });
  const moved = { ...m.ctx, vault: path.join(m.root, 'moved') };
  assert.deepEqual(I.reapply(moved), ['claude']);
  assert.match(readJson(m.settingsFile).statusLine.command, /moved\/brain\/scripts\/bin\/aos/);
  assert.deepEqual(I.reapply(moved), [], 'idempotent');
  fs.writeFileSync(m.settingsFile, pretty({ statusLine: GSD }));
  assert.deepEqual(I.reapply(m.ctx), []);
  assert.deepEqual(readJson(m.settingsFile).statusLine, GSD);
});

// ── Codex config.toml ──

test('tomlInstall: the four shapes, an inline table refused, an existing value only with --force', () => {
  const items = ['model', 'git-branch'];
  const ours = `status_line = ["model", "git-branch"]  ${I.MARK}`;
  assert.equal(I.tomlInstall('', items).text, `[tui]\n${ours}\n`);
  assert.equal(I.tomlInstall('model = "x"\n', items).text, `model = "x"\n\n[tui]\n${ours}\n`);
  assert.equal(I.tomlInstall('[tui]\ntheme = "dark"\n\n[mcp_servers.a]\ncommand = "x"\n', items).text, `[tui]\n${ours}\ntheme = "dark"\n\n[mcp_servers.a]\ncommand = "x"\n`);
  assert.equal(I.tomlInstall('tui.theme = "dark"\n[x]\n', items).text, `tui.theme = "dark"\ntui.${ours}\n[x]\n`, 'dotted keys stay dotted');
  assert.throws(() => I.tomlInstall('tui = { theme = "dark" }\n', items), /inline table/);
  const theirs = '[tui]\nstatus_line = [\n  "model",\n  "current-dir", # mine\n]\nx = 1\n';
  assert.throws(() => I.tomlInstall(theirs, items), /tui\.status_line is already set.*--force/);
  const forced = I.tomlInstall(theirs, items, { force: true });
  assert.equal(forced.text, `[tui]\n${ours}\nx = 1\n`, 'a multi-line value is replaced whole');
  assert.equal(forced.previous, 'status_line = [\n  "model",\n  "current-dir", # mine\n]');
  assert.equal(I.tomlInstall(forced.text, ['model'], { own: forced.written }).text, `[tui]\nstatus_line = ["model"]  ${I.MARK}\nx = 1\n`, 'our own line is updated in place');
  const edited = forced.text.replace('"git-branch"', '"hostname"');
  assert.throws(() => I.tomlInstall(edited, ['model'], { own: forced.written }), /changed since install/, 'SL-03: the marker alone is not ownership');
  assert.equal(I.scanToml('[[tui]]\nstatus_line = 1\n').key, null, 'an array of tables is not the tui table');
});

test('tomlUninstall: every install round-trips to the original text', () => {
  const items = ['model'];
  for (const original of ['', 'model = "x"\n', '[tui]\ntheme = "dark"\n', 'tui.theme = "d"\n[x]\ny = 1\n', '[a]\nb = 1\n\n[tui]\n\n[c]\nd = 2\n']) {
    const r = I.tomlInstall(original, items);
    assert.equal(I.tomlUninstall(r.text, r).text, original, JSON.stringify(original));
  }
  const theirs = '[tui]\nstatus_line = ["a"]\n';
  const f = I.tomlInstall(theirs, items, { force: true });
  assert.equal(I.tomlUninstall(f.text, f).text, theirs, 'a forced value comes back');
  assert.equal(I.tomlUninstall('[tui]\nstatus_line = ["b"]\n', f).found, false);
});

test('codex install/uninstall through the host files; a changed line is left alone', () => {
  const m = machine();
  const before = fs.readFileSync(m.tomlFile, 'utf8');
  const [r] = I.install(m.ctx, { host: 'codex' });
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(m.tomlFile, 'utf8'), /\[tui\]\nstatus_line = \["model-with-reasoning", "git-branch"\]/);
  assert.equal(fs.readFileSync(`${m.tomlFile}.aos-statusline.bak`, 'utf8'), before);
  assert.equal(I.status(m.ctx).codex.present, true);
  I.uninstall(m.ctx, { host: 'codex' });
  assert.equal(fs.readFileSync(m.tomlFile, 'utf8'), before);
  assert.equal(fs.existsSync(`${m.tomlFile}.aos-statusline.bak`), false);
  const c = machine();
  I.install(c.ctx, { host: 'codex' });
  fs.writeFileSync(c.tomlFile, fs.readFileSync(c.tomlFile, 'utf8').replace('"git-branch"', '"hostname"'));
  const [u] = I.uninstall(c.ctx, { host: 'codex' });
  assert.match(u.notes.join(), /changed since install/);
  assert.ok(fs.existsSync(`${c.tomlFile}.aos-statusline.bak`));
  assert.match(fs.readFileSync(c.tomlFile, 'utf8'), /hostname/);
});

// ── statusline.js ──

test('aos statusline install: every enabled host, a Codex refusal does not stop Claude Code, exit 1', async () => {
  const m = machine({ toml: '[tui]\nstatus_line = ["model"]\n' });
  const r = await run(m, ['install']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^claude {2}status line installed in .*; chains the previous line: node ~\/\.claude\/hooks\/gsd-statusline\.js$/m);
  assert.match(r.out, /^codex {3}refused: config\.toml's tui\.status_line is already set/m);
  assert.ok(M.read(m.vault), 'the model is built at install so the first render has it');
  const f = await run(m, ['install', '--host', 'codex', '--force']);
  assert.equal(f.code, 0);
  assert.match(f.out, /replaced your status_line; uninstall puts it back/);
  const s = await run(m, ['status', '--json']);
  const j = JSON.parse(s.out);
  assert.equal(j.claude.ownsSlot, true);
  assert.equal(j.claude.chained, GSD.command);
  assert.equal(j.codex.present, true);
  assert.equal(j.model.stale, false);
  assert.equal((await run(m, ['bogus'])).code, 2);
  assert.equal((await run(m, ['install', '--nope'])).code, 2);
});

test('render: chains the previous line with the same stdin, refreshes a stale model, prints up to three lines', async () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude' });
  const spawned = [];
  const spawnFn = (cmd, a, o) => {
    const opts = Array.isArray(a) ? o : a;
    const input = [];
    spawned.push({ cmd, args: Array.isArray(a) ? a : null, opts, input });
    return { on() {}, unref() {}, stdin: { on() {}, end(s) { input.push(s); } } };
  };
  const payload = JSON.stringify({ session_id: 's1', model: { display_name: 'Opus 5.5' }, workspace: { current_dir: m.vault }, context_window: { remaining_percentage: 90 } });
  const r = await run(m, ['render'], { stdin: async () => payload, spawnFn, env: { ...m.env } });
  assert.equal(r.code, 0);
  assert.match(r.out.split('\n')[0], /Opus 5\.5/);
  const chain = spawned.find((s) => s.cmd === GSD.command);
  assert.ok(chain, 'the previous status line runs');
  assert.equal(chain.opts.detached, true);
  assert.deepEqual(chain.input, [payload], 'with the same stdin');
  assert.ok(spawned.some((s) => s.cmd === process.execPath && s.args[1] === 'refresh'), 'a missing model is rebuilt in the background');
  M.write(m.vault, M.build(m.vault, { now: NOW }));
  spawned.length = 0;
  await run(m, ['render'], { stdin: async () => payload, spawnFn, env: { ...m.env } });
  assert.ok(!spawned.some((s) => s.cmd === process.execPath && s.args[1] === 'refresh'), 'a fresh model is not rebuilt');
});

test('render: --chain-output shows the previous first line; our own command is never chained; failures print nothing', async () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude', chainOutput: true });
  const r = await run(m, ['render'], { stdin: async () => '{}', spawnSyncFn: (cmd) => (cmd === GSD.command ? { status: 0, stdout: '\nGSD │ Phase 3\n' } : { status: 1, stdout: '' }) });
  assert.equal(r.out.split('\n')[0], 'GSD │ Phase 3');
  // Our own command recorded as the previous line (a hand-edited state) is never chained: no loop.
  const self = machine();
  I.install(self.ctx, { host: 'claude' });
  const st = I.readState(self.userConfigFile);
  fs.writeFileSync(I.statePath(self.userConfigFile), JSON.stringify({ ...st, claude: { ...st.claude, previous: { type: 'command', command: st.claude.command } } }));
  const cmds = [];
  await run(self, ['render'], { stdin: async () => '{}', spawnFn: (cmd) => { cmds.push(cmd); return {}; } });
  assert.deepEqual(cmds, []);
  // SL-R02: another vault's AgenticOS line is a real previous line, and it keeps running.
  const other = `sh '/v/brain/scripts/bin/aos' statusline render`;
  const two = machine({ settings: { statusLine: { type: 'command', command: other } } });
  I.install(two.ctx, { host: 'claude' });
  await run(two, ['render'], { stdin: async () => '{}', spawnFn: (cmd) => { cmds.push(cmd); return {}; } });
  assert.deepEqual(cmds, [other]);
  const bad = await run(m, ['render'], { stdin: async () => { throw new Error('boom'); } });
  assert.deepEqual([bad.code, bad.out], [0, '']);
  const junk = await run(m, ['render'], { stdin: async () => 'not json', userConfigFile: path.join(m.root, 'none.json') });
  assert.equal(junk.code, 0);
  assert.match(junk.out.replace(/\x1b\[[0-9;]*m/g, ''), /^Claude\n$/, 'bad stdin still renders the model line');
});

test('subagents: rows only once installed with subagent rows on', async () => {
  const m = machine();
  const input = JSON.stringify({ columns: 120, tasks: [{ id: 't', name: 'Explore', model: 'claude-haiku-4-5' }] });
  assert.equal((await run(m, ['subagents'], { stdin: async () => input })).out, '');
  I.install(m.ctx, { host: 'claude' });
  const r = await run(m, ['subagents'], { stdin: async () => input });
  assert.equal(JSON.parse(r.out.trim()).id, 't');
  assert.equal((await run(m, ['subagents'], { stdin: async () => input, cfg: { statusline: { subagents: false } } })).out, '');
});

test('workOf: this session\'s in-progress task, else the GSD phase; a hostile session id reads nothing', () => {
  const m = machine();
  const tasks = path.join(m.claudeDir, 'tasks', 's1');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, '1.json'), JSON.stringify({ id: '1', subject: 'Done', status: 'completed' }));
  fs.writeFileSync(path.join(tasks, '2.json'), JSON.stringify({ id: '2', subject: 'Write', activeForm: 'Writing the spec', status: 'in_progress' }));
  fs.mkdirSync(path.join(m.vault, '.planning'));
  fs.writeFileSync(path.join(m.vault, '.planning', 'STATE.md'), '---\ncurrent_phase: 02\ncurrent_phase_name: actions-and-release\nstatus: executing\nprogress:\n  total_plans: 10\n  completed_plans: 9\n---\n# State\n');
  assert.deepEqual(SL.workOf({ session_id: 's1', workspace: { project_dir: m.vault } }, m.claudeDir), { kind: 'task', text: 'Writing the spec' });
  assert.deepEqual(SL.workOf({ session_id: 's2', workspace: { project_dir: m.vault } }, m.claudeDir), { kind: 'phase', text: 'Phase 02 actions-and-release · executing · 9/10' });
  assert.deepEqual(SL.workOf({ session_id: '../s1' }, m.claudeDir), null);
  assert.equal(SL.gsdPhase('no frontmatter'), '');
});

test('git: porcelain v2 parsed, one subprocess per 5 s per directory', () => {
  assert.deepEqual(SL.parseGitStatus('# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b f.js\n'), { branch: 'main', dirty: true, ahead: 2, behind: 1 });
  assert.deepEqual(SL.parseGitStatus('# branch.oid 1234567890\n# branch.head (detached)\n'), { branch: '1234567', dirty: false, ahead: 0, behind: 0 });
  assert.equal(SL.parseGitStatus(''), null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-git-'));
  let calls = 0;
  const spawnSyncFn = () => { calls++; return { status: 0, stdout: '# branch.head main\n' }; };
  const dir = path.join(tmp, 'repo');
  assert.equal(SL.gitOf(dir, { now: 1000, spawnSyncFn, tmp }).branch, 'main');
  SL.gitOf(dir, { now: 5000, spawnSyncFn, tmp });
  assert.equal(calls, 1);
  SL.gitOf(dir, { now: 7000, spawnSyncFn, tmp });
  assert.equal(calls, 2);
});

test('SL-02: another vault\'s status line is not ours to claim, rewrite or remove', () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude' });
  const other = { type: 'command', command: I.commandFor(path.join(m.root, 'other-vault'), 'render') };
  fs.writeFileSync(m.settingsFile, pretty({ ...readJson(m.settingsFile), statusLine: other }));
  assert.equal(I.status(m.ctx).claude.ownsSlot, false);
  assert.equal(I.slotTakenBy(m.ctx), other.command);
  assert.deepEqual(I.reapply(m.ctx), []);
  I.uninstall(m.ctx, { host: 'claude' });
  assert.deepEqual(readJson(m.settingsFile).statusLine, other);
});

test('SL-04: a host file that cannot be written leaves no install record behind', { skip: process.getuid && process.getuid() === 0 }, () => {
  const m = machine();
  const ctx = { ...m.ctx, userConfigFile: path.join(m.root, 'state', 'agenticos.json') };
  fs.mkdirSync(path.dirname(ctx.userConfigFile));
  fs.copyFileSync(m.settingsFile, `${m.settingsFile}.aos-statusline.bak`);
  fs.chmodSync(m.claudeDir, 0o555);
  try {
    assert.throws(() => I.install(ctx, { host: 'claude' }), /EACCES|EPERM/);
  } finally { fs.chmodSync(m.claudeDir, 0o755); }
  assert.equal(I.readState(ctx.userConfigFile).claude, undefined, 'the record was rolled back');
  assert.deepEqual(readJson(m.settingsFile).statusLine, GSD);
});

test('SL-05: uninstall puts back the original bytes of a minified settings.json, and removes one it created', () => {
  const m = machine({ settings: null });
  const minified = JSON.stringify({ model: 'opus', statusLine: GSD });
  fs.writeFileSync(m.settingsFile, minified);
  I.install(m.ctx, { host: 'claude' });
  I.uninstall(m.ctx, { host: 'claude' });
  assert.equal(fs.readFileSync(m.settingsFile, 'utf8'), minified);
  const fresh = machine({ settings: null });
  I.install(fresh.ctx, { host: 'claude' });
  assert.ok(fs.existsSync(fresh.settingsFile));
  I.uninstall(fresh.ctx, { host: 'claude' });
  assert.equal(fs.existsSync(fresh.settingsFile), false);
});

test('SL-06: a pipe that never closes is released after the timeout', async () => {
  const { PassThrough } = require('stream');
  const pipe = new PassThrough();
  pipe.write('{"partial":');
  const text = await SL.readStdin(30, pipe);
  assert.equal(text, '{"partial":');
  assert.equal(pipe.destroyed, true);
  assert.equal(pipe.listenerCount('data'), 0);
  const done = new PassThrough();
  const p2 = SL.readStdin(1000, done);
  done.end('{"a":1}');
  assert.equal(await p2, '{"a":1}');
});

test('SL-R01: a settings.json write racing the install is merged, not lost; one that never settles is refused', () => {
  const m = machine();
  let raced = false;
  const ctx = { ...m.ctx, onBeforeReplace: (file) => { if (!raced) { raced = true; fs.writeFileSync(file, pretty({ ...readJson(file), theme: 'dark' })); } } };
  const [r] = I.install(ctx, { host: 'claude' });
  assert.equal(r.ok, true);
  const s = readJson(m.settingsFile);
  assert.equal(s.theme, 'dark', 'the racing write survived');
  assert.ok(I.isOurs(s.statusLine.command, 'render'));
  const busy = machine();
  let n = 0;
  const always = { ...busy.ctx, onBeforeReplace: (file) => fs.writeFileSync(file, pretty({ ...readJson(file), n: ++n })) };
  assert.throws(() => I.install(always, { host: 'claude' }), /kept changing/);
  assert.equal(I.readState(busy.userConfigFile).claude, undefined, 'no record for an install that did not land');
});

test('SL-R04: status names a project settings file that overrides the status line here', () => {
  const m = machine();
  I.install(m.ctx, { host: 'claude' });
  const proj = path.join(m.root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  assert.equal(I.status({ ...m.ctx, cwd: proj }).claude.projectOverride, null);
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'proj-line' } }));
  assert.deepEqual(I.status({ ...m.ctx, cwd: proj }).claude.projectOverride, { file: path.join(proj, '.claude', 'settings.json'), command: 'proj-line' });
});

test('SL-R05: a stray argument or a flag the verb does not take is a usage error before anything is written', async () => {
  const m = machine();
  const before = fs.readFileSync(m.settingsFile, 'utf8');
  for (const argv of [['uninstall', 'codex'], ['install', 'claude'], ['install', '--width', '3'], ['status', '--force'], ['git']]) {
    const r = await run(m, argv);
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(fs.readFileSync(m.settingsFile, 'utf8'), before);
});

test('SL-R06: an item Codex does not show is refused at config set and at install', () => {
  const S = require('../lib/settings-schema.js');
  assert.match(S.validate(S.entry('statusline.codexItems'), ['model', 'nope']), /unknown item nope/);
  assert.equal(S.validate(S.entry('statusline.codexItems'), ['model', 'git-branch']), null);
  assert.match(S.validate(S.entry('statusline.segments'), ['runs', 'weather']), /unknown item weather/);
  assert.equal(S.validate(S.entry('recallRoots'), ['my/own/root']), null, 'other lists stay open');
  const m = machine();
  assert.throws(() => I.install({ ...m.ctx, cfg: { statusline: { codexItems: ['nope'] } } }, { host: 'codex' }), /does not show/);
  assert.equal(fs.readFileSync(m.tomlFile, 'utf8'), 'model = "gpt-5"\n');
});

test('SL-R07: uninstall touches only the effective tui.status_line', () => {
  const r = I.tomlInstall('', ['model']);
  const copied = `[other]\n${r.written}\n\n[tui]\nstatus_line = ["x"]\n`;
  assert.deepEqual(I.tomlUninstall(copied, r), { text: copied, found: false });
  assert.equal(I.holdsLine(copied, r.written), false);
});

test('SL-R08: a hosts block that enables no host targets none', () => {
  assert.throws(() => I.targetHosts({ hosts: { claude: { enabled: false }, codex: { enabled: false } } }), /enables no host/);
});

test('SL-R09: render never runs git; a stale cache is refreshed by one detached child', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-gitr-'));
  const dir = path.join(tmp, 'repo');
  const spawned = [];
  const spawnFn = (cmd, args) => { spawned.push(args); return {}; };
  assert.equal(SL.gitForRender(dir, { now: 1000, tmp, spawnFn, env: {} }), null);
  assert.deepEqual(spawned.map((a) => a.slice(1)), [['git', dir]]);
  SL.gitForRender(dir, { now: 2000, tmp, spawnFn, env: {} });
  assert.equal(spawned.length, 1, 'one refresher at a time');
  SL.refreshGit(dir, { now: 3000, tmp, spawnSyncFn: () => ({ status: 0, stdout: '# branch.head main\n' }) });
  assert.deepEqual(SL.gitForRender(dir, { now: 4000, tmp, spawnFn, env: {} }), { branch: 'main', dirty: false, ahead: 0, behind: 0 });
  assert.equal(spawned.length, 1);
});
