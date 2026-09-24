'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./skills.js');

const NOW = new Date('2026-09-23T12:00:00.000Z');

/** A vault, an agenticos.json with both hosts, and private host roots (never the developer's). */
function world({ hosts = { claude: { enabled: true }, codex: { enabled: true } } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skills-cli-'));
  const configDir = path.join(base, 'cfg');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ vault, hosts }));
  const roots = {
    claudeSkills: path.join(base, 'claude', 'skills'),
    claudePlugins: path.join(base, 'claude', 'plugins', 'installed_plugins.json'),
    claudeSettings: path.join(base, 'claude', 'settings.json'),
    codexSkills: path.join(base, 'agents', 'skills'),
    codexSystem: path.join(base, 'codex', 'skills', '.system'),
    codexConfig: path.join(base, 'codex', 'config.toml'),
    codexPluginCache: path.join(base, 'codex', 'plugins', 'cache'),
  };
  const put = (dir, name, desc) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nBody\n`); };
  const logs = []; const errs = [];
  const io = { log: (m) => logs.push(String(m)), error: (m) => errs.push(String(m)) };
  const opts = { configDir, roots, io, now: NOW };
  return { base, vault, roots, put, opts, logs, errs, out: () => logs.join('\n'), reset: () => { logs.length = 0; errs.length = 0; } };
}

test('list before any sync: a dry-run plan, nothing written, and a hint', async () => {
  const w = world();
  w.put(w.roots.claudeSkills, 'deploy', 'Ship it');
  assert.equal(await K.main(['list'], w.opts), 0);
  assert.match(w.out(), /^1 yours \(1 universal\) · 0 from plugins and built-ins · sharing on, not synced yet$/m);
  assert.match(w.out(), /deploy\s+\/deploy\s+\$deploy\s+claude\s+universal/);
  assert.match(w.out(), /not synced yet — `aos skills sync` shares them/);
  assert.equal(fs.existsSync(w.roots.codexSkills), false);
  assert.equal(fs.existsSync(path.join(w.vault, 'brain', '_index', 'skills.json')), false);
});

test('sync writes the mirrors and the cache; list reads the cache; --json prints it', async () => {
  const w = world();
  w.put(w.roots.claudeSkills, 'deploy', 'Ship it');
  w.put(w.roots.codexSkills, 'triage', 'Triage');
  assert.equal(await K.main(['sync'], w.opts), 0);
  assert.match(w.out(), /^synced: 2 written, 0 removed/);
  assert.ok(fs.existsSync(path.join(w.roots.codexSkills, 'deploy', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(w.roots.claudeSkills, 'triage', 'SKILL.md')));
  w.reset();
  assert.equal(await K.main(['list', '--json'], w.opts), 0);
  const cache = JSON.parse(w.out());
  assert.equal(cache.schema, 1);
  assert.deepEqual(cache.skills.map((s) => s.id), ['deploy', 'triage']);
  w.reset();
  await K.main(['list'], w.opts);
  assert.match(w.out(), /triage\s+\/triage\s+\$triage\s+codex\s+universal/);
  assert.doesNotMatch(w.out(), /not synced yet/);
});

test('sync --dry-run lists the actions and writes nothing', async () => {
  const w = world();
  w.put(w.roots.claudeSkills, 'deploy', 'Ship it');
  assert.equal(await K.main(['sync', '--dry-run'], w.opts), 0);
  assert.match(w.out(), /^mirror deploy \(claude → codex\) at .*agents\/skills\/deploy$/);
  assert.equal(fs.existsSync(w.roots.codexSkills), false);
});

test('exclude / include round-trip through <vault>/brain/config.json, keeping other keys', async () => {
  const w = world();
  w.put(w.roots.claudeSkills, 'Deploy', 'Ship it');
  const cfgFile = path.join(w.vault, 'brain', 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: 'none', skills: { sync: true } }));
  await K.main(['sync'], w.opts);
  assert.ok(fs.existsSync(path.join(w.roots.codexSkills, 'deploy')));
  w.reset();
  assert.equal(await K.main(['exclude', 'Deploy'], w.opts), 0);
  assert.match(w.out(), /^deploy is no longer shared\nsynced: 0 written, 1 removed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), { provider: 'none', skills: { sync: true, exclude: ['deploy'] } });
  assert.equal(fs.existsSync(path.join(w.roots.codexSkills, 'deploy')), false);
  w.reset();
  assert.equal(await K.main(['include', 'deploy'], w.opts), 0);
  assert.match(w.out(), /^deploy is shared again\nsynced: 1 written/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).skills.exclude, []);
});

test('exclude refuses an unparseable config instead of replacing it', async () => {
  const w = world();
  const cfgFile = path.join(w.vault, 'brain', 'config.json');
  fs.writeFileSync(cfgFile, '{ not json');
  await assert.rejects(K.main(['exclude', 'deploy'], w.opts), /is not valid JSON/);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), '{ not json');
});

test('reset deletes an edited mirror and the sync writes it fresh; an unknown name exits 1', async () => {
  const w = world();
  w.put(w.roots.claudeSkills, 'deploy', 'Ship it');
  await K.main(['sync'], w.opts);
  const mirror = path.join(w.roots.codexSkills, 'deploy', 'SKILL.md');
  fs.appendFileSync(mirror, 'edit\n');
  w.reset();
  await K.main(['sync'], w.opts);
  assert.match(w.out(), /deploy: the copy at .* was edited; aos skills reset deploy replaces it/);
  w.reset();
  assert.equal(await K.main(['reset', 'deploy'], w.opts), 0);
  assert.match(w.out(), /^removed .*agents\/skills\/deploy\nsynced: 1 written/);
  assert.doesNotMatch(fs.readFileSync(mirror, 'utf8'), /edit\n$/);
  w.reset();
  assert.equal(await K.main(['reset', 'nope'], w.opts), 1);
  assert.match(w.out(), /no mirror named nope/);
});

test('one host enabled: list only, and the summary says why', async () => {
  const w = world({ hosts: { claude: { enabled: true } } });
  w.put(w.roots.claudeSkills, 'deploy', 'Ship it');
  assert.equal(await K.main(['sync'], w.opts), 0);
  assert.match(w.out(), /sharing needs both hosts enabled/);
  assert.match(w.out(), /deploy\s+\/deploy\s+—\s+claude\s+pending/);
  assert.equal(fs.existsSync(w.roots.codexSkills), false);
});

test('usage errors: unknown verb, a missing name, --dry-run outside sync', async () => {
  const w = world();
  await assert.rejects(K.main(['frobnicate'], w.opts), K.UsageError);
  await assert.rejects(K.main(['exclude'], w.opts), K.UsageError);
  await assert.rejects(K.main(['reset'], w.opts), K.UsageError);
  await assert.rejects(K.main(['list', '--dry-run'], w.opts), K.UsageError);
});

test('doctorRow: info before the first sync, ok after, warn on an edited mirror', async () => {
  const w = world();
  w.put(w.roots.claudeSkills, 'deploy', 'Ship it');
  assert.deepEqual(K.doctorRow({ vault: w.vault, now: NOW }), { name: 'skills', ok: true, detail: 'not synced yet — it runs at session end, or `aos skills sync`', level: 'info' });
  await K.main(['sync'], w.opts);
  const ok = K.doctorRow({ vault: w.vault, now: NOW });
  assert.equal(ok.ok, true); assert.equal(ok.level, 'warn');
  assert.match(ok.detail, /^1 yours \(1 universal\) · 0 from plugins and built-ins · sharing on, synced just now$/);
  fs.appendFileSync(path.join(w.roots.codexSkills, 'deploy', 'SKILL.md'), 'edit\n');
  await K.main(['sync'], w.opts);
  const bad = K.doctorRow({ vault: w.vault, now: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /deploy edited: aos skills list$/);
});
