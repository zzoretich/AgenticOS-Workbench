'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./agents.js');

const NOW = new Date('2026-09-23T12:00:00.000Z');

/** A vault, an agenticos.json with both hosts, and private host roots (never the developer's). */
function world({ hosts = { claude: { enabled: true }, codex: { enabled: true } } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agents-cli-'));
  const configDir = path.join(base, 'cfg');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ vault, hosts }));
  const roots = {
    claudeAgents: path.join(base, 'claude', 'agents'),
    claudePlugins: path.join(base, 'claude', 'plugins', 'installed_plugins.json'),
    claudeSettings: path.join(base, 'claude', 'settings.json'),
    codexAgents: path.join(base, 'codex', 'agents'),
    codexConfig: path.join(base, 'codex', 'config.toml'),
  };
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const claude = (name, desc, extra = '') => write(path.join(roots.claudeAgents, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\nBody\n`);
  const codex = (name, desc) => write(path.join(roots.codexAgents, `${name}.toml`), `name = "${name}"\ndescription = "${desc}"\ndeveloper_instructions = "Body"\n`);
  const logs = []; const errs = [];
  const io = { log: (m) => logs.push(String(m)), error: (m) => errs.push(String(m)) };
  const opts = { configDir, roots, io, now: NOW };
  return { base, vault, roots, claude, codex, opts, logs, errs, out: () => logs.join('\n'), reset: () => { logs.length = 0; errs.length = 0; } };
}

test('list before any sync: a dry-run plan, nothing written, a hint and how each host uses an agent', async () => {
  const w = world();
  w.claude('reviewer', 'Reviews', 'tools: Read, Grep\n');
  assert.equal(await G.main(['list'], w.opts), 0);
  assert.match(w.out(), /^1 yours \(1 universal\) · 0 from plugins and config\.toml · sharing on, not synced yet$/m);
  assert.match(w.out(), /reviewer \(read-only\)\s+@agent-reviewer\s+reviewer\s+claude\s+universal/);
  assert.match(w.out(), /claude --agent <name>/);
  assert.match(w.out(), /not synced yet — `aos agents sync` shares them/);
  assert.equal(fs.existsSync(w.roots.codexAgents), false);
  assert.equal(fs.existsSync(path.join(w.vault, 'brain', '_index', 'agents.json')), false);
});

test('sync writes the mirrors and the cache; list reads the cache; --json prints it', async () => {
  const w = world();
  w.claude('reviewer', 'Reviews');
  w.codex('triage', 'Triage');
  assert.equal(await G.main(['sync'], w.opts), 0);
  assert.match(w.out(), /^synced: 2 written, 0 removed/);
  assert.ok(fs.existsSync(path.join(w.roots.codexAgents, 'reviewer.toml')));
  assert.ok(fs.existsSync(path.join(w.roots.claudeAgents, 'triage.md')));
  w.reset();
  assert.equal(await G.main(['list', '--json'], w.opts), 0);
  const cache = JSON.parse(w.out());
  assert.equal(cache.schema, 1);
  assert.deepEqual(cache.agents.map((a) => a.id), ['reviewer', 'triage']);
  w.reset();
  await G.main(['list'], w.opts);
  assert.match(w.out(), /triage\s+@agent-triage\s+triage\s+codex\s+universal/);
  assert.doesNotMatch(w.out(), /not synced yet/);
});

test('sync --dry-run lists the actions and writes nothing', async () => {
  const w = world();
  w.claude('reviewer', 'Reviews');
  assert.equal(await G.main(['sync', '--dry-run'], w.opts), 0);
  assert.match(w.out(), /^mirror reviewer \(claude → codex\) at .*codex\/agents\/reviewer\.toml$/);
  assert.equal(fs.existsSync(w.roots.codexAgents), false);
});

test('exclude / include round-trip through <vault>/brain/config.json, keeping other keys', async () => {
  const w = world();
  w.claude('reviewer', 'Reviews');
  const cfgFile = path.join(w.vault, 'brain', 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ skills: { exclude: ['x'] }, agents: { sync: true } }));
  await G.main(['sync'], w.opts);
  assert.equal(await G.main(['exclude', 'Reviewer'], w.opts), 0);
  assert.match(w.out(), /reviewer is no longer shared/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), { skills: { exclude: ['x'] }, agents: { sync: true, exclude: ['reviewer'] } });
  assert.equal(fs.existsSync(path.join(w.roots.codexAgents, 'reviewer.toml')), false);
  w.reset();
  assert.equal(await G.main(['include', 'reviewer'], w.opts), 0);
  assert.match(w.out(), /reviewer is shared again/);
  assert.ok(fs.existsSync(path.join(w.roots.codexAgents, 'reviewer.toml')));
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).agents.exclude, []);
});

test('exclude refuses an unparseable config instead of replacing it', async () => {
  const w = world();
  const cfgFile = path.join(w.vault, 'brain', 'config.json');
  fs.writeFileSync(cfgFile, '{ not json');
  await assert.rejects(G.main(['exclude', 'reviewer'], w.opts), /is not valid JSON/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), '{ not json');
});

test('reset deletes an edited mirror and the sync writes it fresh; an unknown name exits 1', async () => {
  const w = world();
  w.claude('reviewer', 'Reviews');
  await G.main(['sync'], w.opts);
  const mirror = path.join(w.roots.codexAgents, 'reviewer.toml');
  fs.appendFileSync(mirror, '# edited\n');
  w.reset();
  await G.main(['sync'], w.opts);
  assert.match(w.out(), /reviewer: the copy at .* was edited; aos agents reset reviewer replaces it/);
  w.reset();
  assert.equal(await G.main(['reset', 'reviewer'], w.opts), 0);
  assert.match(w.out(), /^removed .*reviewer\.toml$/m);
  assert.doesNotMatch(fs.readFileSync(mirror, 'utf8'), /# edited/);
  w.reset();
  assert.equal(await G.main(['reset', 'nobody'], w.opts), 1);
  assert.match(w.out(), /no mirror named nobody/);
});

test('one host enabled: list only, and the summary says why', async () => {
  const w = world({ hosts: { claude: { enabled: true }, codex: { enabled: false } } });
  w.claude('reviewer', 'Reviews');
  assert.equal(await G.main(['sync'], w.opts), 0);
  assert.match(w.out(), /^1 yours \(1 pending\) · 0 from plugins and config\.toml · sharing needs both hosts enabled$/m);
  assert.equal(fs.existsSync(w.roots.codexAgents), false);
});

test('Codex subagents switched off show in the summary', async () => {
  const w = world();
  fs.mkdirSync(path.dirname(w.roots.codexConfig), { recursive: true });
  fs.writeFileSync(w.roots.codexConfig, '[agents]\nenabled = false\n');
  await G.main(['list'], w.opts);
  assert.match(w.out(), /Codex subagents are off \(agents\.enabled = false in config\.toml\)/);
});

test('usage errors: unknown verb, a missing name, --dry-run outside sync', async () => {
  const w = world();
  await assert.rejects(G.main(['frobnicate'], w.opts), (e) => e instanceof G.UsageError && /unknown verb "frobnicate"/.test(e.message));
  await assert.rejects(G.main(['exclude'], w.opts), (e) => e instanceof G.UsageError && /aos agents exclude <name>/.test(e.message));
  await assert.rejects(G.main(['reset'], w.opts), (e) => e instanceof G.UsageError);
  await assert.rejects(G.main(['list', '--dry-run'], w.opts), (e) => e instanceof G.UsageError && /only supported by `aos agents sync`/.test(e.message));
});

test('doctorRow: info before the first sync, ok after, warn on an edited mirror', async () => {
  const w = world();
  w.claude('reviewer', 'Reviews');
  assert.deepEqual(G.doctorRow({ vault: w.vault, now: NOW }), { name: 'agents', ok: true, detail: 'not synced yet — it runs at session end, or `aos agents sync`', level: 'info' });
  await G.main(['sync'], w.opts);
  const ok = G.doctorRow({ vault: w.vault, now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.level, 'warn');
  assert.match(ok.detail, /^1 yours \(1 universal\) · 0 from plugins and config\.toml · sharing on, synced just now$/);
  fs.appendFileSync(path.join(w.roots.codexAgents, 'reviewer.toml'), '# edited\n');
  await G.main(['sync'], w.opts);
  const bad = G.doctorRow({ vault: w.vault, now: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /reviewer edited: aos agents list$/);
});
