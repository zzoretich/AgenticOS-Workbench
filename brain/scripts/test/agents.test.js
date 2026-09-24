'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/agents.js');
const A = require('../lib/agent-translate.js');

const NOW = new Date('2026-09-23T12:00:00.000Z');
const BOTH = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
const CLAUDE_ONLY = { hosts: { claude: { enabled: true }, codex: { enabled: false } } };

/** A private world: a Claude config dir, a Codex home and a vault, all under one tmp dir. */
function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agents-'));
  const r = {
    claudeAgents: path.join(base, 'claude', 'agents'),
    claudePlugins: path.join(base, 'claude', 'plugins', 'installed_plugins.json'),
    claudeSettings: path.join(base, 'claude', 'settings.json'),
    codexAgents: path.join(base, 'codex', 'agents'),
    codexConfig: path.join(base, 'codex', 'config.toml'),
  };
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  return { base, r, vault };
}

function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
const md = (name, desc, body = 'Do the work.\n', extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n${body}`;
const toml = (name, desc, body = 'Do the work.', extra = '') => `name = "${name}"\ndescription = "${desc}"\n${extra}developer_instructions = """\n${body}\n"""\n`;
const row = (cache, id) => cache.agents.find((a) => a.id === id);
const run = (w, userCfg = BOTH, extra = {}) => S.sync({ vault: w.vault, userCfg, roots: w.r, now: NOW, ...extra });
const claudeFile = (w, n) => path.join(w.r.claudeAgents, `${n}.md`);
const codexFile = (w, n) => path.join(w.r.codexAgents, `${n}.toml`);

test('discover: user agents on both hosts, mirrors by marker, enabled plugins only, config.toml roles, subagents off', () => {
  const w = world();
  put(claudeFile(w, 'reviewer'), md('reviewer', 'Reviews'));
  put(path.join(w.r.claudeAgents, 'README.md'), '# not an agent\n');
  put(path.join(w.r.claudeAgents, 'notes.txt'), 'ignored');
  put(codexFile(w, 'triage'), toml('triage', 'Triage'));
  const plug = path.join(w.base, 'cp', 'kit', '1.0.0');
  put(path.join(plug, 'agents', 'planner.md'), md('planner', 'Plans', 'x', 'tools: Read\n'));
  const off = path.join(w.base, 'cp', 'off', '1.0.0');
  put(path.join(off, 'agents', 'hidden.md'), md('hidden', 'no'));
  put(w.r.claudePlugins, JSON.stringify({ plugins: { 'kit@m': [{ installPath: plug }], 'off@m': [{ installPath: off }] } }));
  put(w.r.claudeSettings, JSON.stringify({ enabledPlugins: { 'kit@m': true, 'off@m': false } }));
  put(w.r.codexConfig, '[features]\nmulti_agent = false\n\n[agents]\nmax_threads = 4\n\n[agents.docs_researcher]\ndescription = "Checks \\"APIs\\""\nconfig_file = "agents/docs.toml"\n\n[agents."quoted-role"]\n');
  run(w);
  const f = S.discover(w.r);
  assert.deepEqual(f.claude.user.map((a) => a.name), ['reviewer']);
  assert.deepEqual(f.claude.mirrors.map((a) => a.name), ['triage']);
  assert.deepEqual(f.codex.user.map((a) => a.name), ['triage']);
  assert.deepEqual(f.codex.mirrors.map((a) => a.name), ['reviewer']);
  assert.deepEqual(f.listed.map((l) => `${l.host}:${l.scope}:${l.plugin || ''}:${l.name}:${l.readOnly}`), [
    'claude:plugin:kit:planner:true', 'codex:config::docs_researcher:false', 'codex:config::quoted-role:false',
  ]);
  assert.equal(f.listed[1].description, 'Checks "APIs"');
  assert.deepEqual([...f.codexRoles], ['docs-researcher', 'quoted-role']);
  assert.match(f.codexOff, /features\.multi_agent = false/);
});

test('sync: each host\'s user agents mirrored into the other, translated, with invocations; the cache is written', () => {
  const w = world();
  put(claudeFile(w, 'reviewer'), md('reviewer', 'Reviews diffs', 'Read it with the Read tool.\n', 'tools: Read, Grep\nmodel: sonnet\n'));
  put(codexFile(w, 'pr_explorer'), toml('pr_explorer', 'Maps paths', 'Explore.', 'model = "gpt-5.5"\n'));
  const { cache, result } = run(w);
  assert.deepEqual(result.written.sort(), ['pr-explorer', 'reviewer']);
  const x = A.readCodex(fs.readFileSync(codexFile(w, 'reviewer'), 'utf8'));
  assert.deepEqual([x.name, x.description, x.sandbox, x.model], ['reviewer', 'Reviews diffs', 'read-only', '']);
  assert.match(x.instructions, /Read it\.\n$/);
  const c = A.readClaude(fs.readFileSync(claudeFile(w, 'pr-explorer'), 'utf8'));
  assert.deepEqual([c.name, c.description, c.model], ['pr-explorer', 'Maps paths', null]);

  const r = row(cache, 'reviewer');
  assert.equal(r.status, 'universal');
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.origin, { host: 'claude', scope: 'user', plugin: null, path: claudeFile(w, 'reviewer') });
  assert.deepEqual(r.on.claude, { path: claudeFile(w, 'reviewer'), via: 'native', invoke: '@agent-reviewer', run: 'claude --agent reviewer' });
  assert.equal(r.on.codex.via, 'mirror');
  assert.equal(r.on.codex.invoke, 'reviewer');
  assert.equal(r.on.codex.run, "codex 'Use the reviewer agent. Ask me what it should work on, then spawn it with my answer as its task.'");
  const p = row(cache, 'pr-explorer');
  assert.equal(p.name, 'pr_explorer');
  assert.equal(p.on.codex.invoke, 'pr_explorer');
  assert.equal(p.on.claude.invoke, '@agent-pr-explorer');

  const disk = S.readCache(S.cacheFile(w.vault));
  assert.equal(disk.schema, 1);
  assert.deepEqual(disk.hosts, { claude: true, codex: true });
  assert.deepEqual(disk.codexAgents, { on: true, reason: null });
  assert.equal(disk.sync.at, NOW.toISOString());
  assert.equal(disk.agents.length, 2);
});

test('sync is idempotent: a second run writes and removes nothing', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  put(codexFile(w, 'b'), toml('b', 'B'));
  run(w);
  const before = fs.readFileSync(codexFile(w, 'a'), 'utf8');
  const { result, actions } = run(w);
  assert.deepEqual(result, { written: [], removed: [], errors: [] });
  assert.equal(actions.length, 2); // planned, but nothing changes on disk
  assert.equal(fs.readFileSync(codexFile(w, 'a'), 'utf8'), before);
});

test('a file without our marker is never written: differs', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  put(codexFile(w, 'a'), 'name = "other-name"\ndescription = "hand made"\ndeveloper_instructions = "mine"\n');
  const before = fs.readFileSync(codexFile(w, 'a'), 'utf8');
  const { cache } = run(w);
  assert.equal(fs.readFileSync(codexFile(w, 'a'), 'utf8'), before);
  assert.equal(row(cache, 'a').status, 'differs');
  assert.match(row(cache, 'a').note, /is not an AgenticOS mirror/);
});

test('the same agent by hand on both hosts: universal when the prompts agree, differs otherwise; no mirror either way', () => {
  const w = world();
  put(claudeFile(w, 'same'), md('same', 'S', 'Do it in this Claude Code session.\n'));
  put(codexFile(w, 'same'), toml('same', 'S', 'Do it in this Codex session.'));
  put(claudeFile(w, 'diff'), md('diff', 'D', 'One.\n'));
  put(codexFile(w, 'diff'), toml('diff', 'D', 'Two.'));
  const { cache, actions } = run(w);
  assert.equal(row(cache, 'same').status, 'universal');
  assert.equal(row(cache, 'diff').status, 'differs');
  assert.equal(row(cache, 'diff').on.codex.via, 'native');
  assert.equal(actions.length, 0);
});

test('an edited mirror is kept and reported; reset discards it and the next sync writes it fresh', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  run(w);
  fs.appendFileSync(codexFile(w, 'a'), '# my tweak\n');
  put(claudeFile(w, 'a'), md('a', 'A changed'));
  const { cache } = run(w);
  assert.equal(row(cache, 'a').status, 'edited');
  assert.match(row(cache, 'a').note, /aos agents reset a/);
  assert.match(fs.readFileSync(codexFile(w, 'a'), 'utf8'), /# my tweak/);
  assert.deepEqual(S.reset({ roots: w.r, id: 'a' }), [codexFile(w, 'a')]);
  run(w);
  const x = A.readCodex(fs.readFileSync(codexFile(w, 'a'), 'utf8'));
  assert.equal(x.description, 'A changed');
});

test('a removed source takes its clean mirror; an edited orphan stays as the user\'s own', () => {
  const w = world();
  put(claudeFile(w, 'gone'), md('gone', 'G'));
  put(claudeFile(w, 'kept'), md('kept', 'K'));
  run(w);
  fs.appendFileSync(codexFile(w, 'kept'), '# edited\n');
  fs.rmSync(claudeFile(w, 'gone'));
  fs.rmSync(claudeFile(w, 'kept'));
  const { cache, result } = run(w);
  assert.deepEqual(result.removed, ['gone']);
  assert.equal(fs.existsSync(codexFile(w, 'gone')), false);
  assert.equal(fs.existsSync(codexFile(w, 'kept')), true);
  assert.equal(row(cache, 'kept').status, 'edited');
  assert.equal(row(cache, 'kept').origin.scope, 'mirror');
  assert.equal(row(cache, 'gone'), undefined);
});

test('renaming the source moves the mirror', () => {
  const w = world();
  put(claudeFile(w, 'old'), md('old', 'O'));
  run(w);
  fs.rmSync(claudeFile(w, 'old'));
  put(claudeFile(w, 'new'), md('new', 'O'));
  run(w);
  assert.equal(fs.existsSync(codexFile(w, 'old')), false);
  assert.equal(fs.existsSync(codexFile(w, 'new')), true);
});

test('exclude removes a clean mirror and marks the row; the vault config is read', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  run(w);
  put(path.join(w.vault, 'brain', 'config.json'), JSON.stringify({ agents: { exclude: ['A'] } }));
  const { cache } = run(w);
  assert.equal(fs.existsSync(codexFile(w, 'a')), false);
  assert.equal(row(cache, 'a').status, 'excluded');
  assert.equal(row(cache, 'a').on.codex, null);
});

test('invalid: reserved names on either side, missing fields; a clean mirror goes', () => {
  const w = world();
  put(claudeFile(w, 'explorer'), md('explorer', 'Would replace a Codex built-in'));
  put(codexFile(w, 'plan'), toml('plan', 'Would shadow a Claude Code built-in'));
  put(codexFile(w, 'broken'), 'name = "broken"\ndescription = "no instructions"\n');
  put(claudeFile(w, 'nodesc'), '---\nname: nodesc\n---\n\nBody\n');
  const { cache, actions } = run(w);
  assert.equal(actions.length, 0);
  assert.match(row(cache, 'explorer').note, /Codex's built-in explorer/);
  assert.match(row(cache, 'plan').note, /Claude Code's built-in plan/);
  assert.match(row(cache, 'broken').note, /developer_instructions/);
  assert.match(row(cache, 'nodesc').note, /no description/);
  for (const id of ['explorer', 'plan', 'broken', 'nodesc']) assert.equal(row(cache, id).status, 'invalid');
});

test('a Claude agent whose name a config.toml role already has: differs, nothing written', () => {
  const w = world();
  put(claudeFile(w, 'docs-researcher'), md('docs-researcher', 'D'));
  put(w.r.codexConfig, '[agents.docs_researcher]\ndescription = "Mine"\n');
  const { cache } = run(w);
  assert.equal(row(cache, 'docs-researcher').status, 'differs');
  assert.match(row(cache, 'docs-researcher').note, /config\.toml already declares/);
  assert.equal(fs.existsSync(codexFile(w, 'docs-researcher')), false);
  const role = row(cache, 'docs_researcher');
  assert.equal(role.status, 'listed');
  assert.equal(role.on.codex.invoke, 'docs_researcher');
  assert.match(role.note, /move it to agents\/docs_researcher\.toml/);
});

test('plugin agents are listed with namespaced invocations, never mirrored', () => {
  const w = world();
  const plug = path.join(w.base, 'cp', 'kit', '1.0.0');
  put(path.join(plug, 'agents', 'planner.md'), md('planner', 'Plans'));
  put(w.r.claudePlugins, JSON.stringify({ plugins: { 'kit@m': [{ installPath: plug }] } }));
  const { cache, actions } = run(w);
  assert.equal(actions.length, 0);
  const r = row(cache, 'kit:planner');
  assert.equal(r.status, 'listed');
  assert.deepEqual(r.on.claude, { path: path.join(plug, 'agents', 'planner.md'), via: 'plugin', invoke: '@agent-kit:planner', run: 'claude --agent kit:planner' });
  assert.equal(r.on.codex, null);
  assert.equal(fs.existsSync(codexFile(w, 'planner')), false);
});

test('one host, or sharing off: nothing written, rows pending with the reason', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  const one = run(w, CLAUDE_ONLY).cache;
  assert.equal(row(one, 'a').status, 'pending');
  assert.equal(one.sync.on, false);
  assert.equal(one.sync.reason, 'sharing needs both hosts enabled');
  assert.equal(fs.existsSync(codexFile(w, 'a')), false);
  const off = run(w, { ...BOTH, agents: { sync: false } }).cache;
  assert.equal(off.sync.reason, 'sharing is off (agents.sync is false)');
  assert.equal(fs.existsSync(codexFile(w, 'a')), false);
});

test('dry run plans without touching disk or the cache', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  const { actions, cache } = run(w, BOTH, { dryRun: true });
  assert.deepEqual(actions.map((a) => [a.type, a.id, a.from]), [['mirror', 'a', 'claude']]);
  assert.equal(cache.sync.at, null);
  assert.equal(fs.existsSync(codexFile(w, 'a')), false);
  assert.equal(fs.existsSync(S.cacheFile(w.vault)), false);
});

test('apply refuses a mirror edited between plan and write; the row turns error', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  run(w);
  put(claudeFile(w, 'a'), md('a', 'A2'));
  const found = S.discover(w.r);
  const p = S.plan(found, { roots: w.r, config: S.agentsConfig({}), hosts: ['claude', 'codex'] });
  fs.appendFileSync(codexFile(w, 'a'), '# raced\n');
  const out = S.apply(p.actions);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].message, /changed since the plan/);
  assert.match(fs.readFileSync(codexFile(w, 'a'), 'utf8'), /# raced/);
});

test('isMirrorFile: true only for our marked files', () => {
  const w = world();
  put(claudeFile(w, 'a'), md('a', 'A'));
  run(w);
  assert.equal(S.isMirrorFile(codexFile(w, 'a')), true);
  assert.equal(S.isMirrorFile(claudeFile(w, 'a')), false);
  assert.equal(S.isMirrorFile(path.join(w.base, 'missing.md')), false);
});
