'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;
const GC = require('./graph-cmd.js');

const FAKE_UV = path.join(__dirname, 'fixtures', 'fake-uv.sh');
const FAKE_GRAPHIFY = path.join(__dirname, 'fixtures', 'fake-graphify.sh');
const TEMPLATE = path.join(__dirname, '..', 'vault-template', '.graphifyignore');
const quiet = { log() {}, error() {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-graph-')); }
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** A config dir with agenticos.json, a vault, and a tool home — the three places install() touches. */
function world() {
  const dir = tmp();
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'brain'), { recursive: true });
  const configDir = path.join(dir, 'cfg');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ vault, graph: { enabled: true } }, null, 2));
  return { dir, vault, configDir, home: path.join(dir, 'share', 'agenticos', 'graphify'), uvLog: path.join(dir, 'uv.log') };
}
const cfgOf = (w) => JSON.parse(fs.readFileSync(path.join(w.configDir, 'agenticos.json'), 'utf8'));
/** A fake graphify that reports `version`, placed where install() would put it. */
function placeGraphify(home, version) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(FAKE_GRAPHIFY, path.join(bin, 'graphify'));
  fs.chmodSync(path.join(bin, 'graphify'), 0o755);
  fs.writeFileSync(path.join(bin, '.fake-graphify-version'), `${version}\n`);
  return path.join(bin, 'graphify');
}

test('uvBin: AOS_UV_BIN empty means absent, a missing path is absent, an existing path is used', () => {
  withEnv({ AOS_UV_BIN: '' }, () => assert.equal(GC.uvBin(), null));
  withEnv({ AOS_UV_BIN: path.join(os.tmpdir(), `no-uv-${process.pid}`) }, () => assert.equal(GC.uvBin(), null));
  withEnv({ AOS_UV_BIN: FAKE_UV }, () => assert.equal(GC.uvBin(), FAKE_UV));
});

test('the tool dir lives under XDG_DATA_HOME (else ~/.local/share), in agenticos/graphify', () => {
  withEnv({ XDG_DATA_HOME: '/x/data' }, () => assert.equal(GC.toolHome(), path.join('/x/data', 'agenticos', 'graphify')));
  withEnv({ XDG_DATA_HOME: undefined }, () => assert.equal(GC.toolHome(), path.join(os.homedir(), '.local', 'share', 'agenticos', 'graphify')));
  assert.deepEqual(GC.toolDirs('/h'), { home: '/h', tools: path.join('/h', 'tools'), bin: path.join('/h', 'bin'), graphify: path.join('/h', 'bin', 'graphify') });
});

test('install: a fresh machine gets the pin through uv into our own tool dirs, recorded as graph.bin', () => {
  const w = world();
  const r = withEnv({ FAKE_UV_LOG: w.uvLog }, () => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, template: TEMPLATE, io: quiet, home: w.home }));
  assert.equal(r.action, `installed ${GC.PIN}`);
  assert.equal(r.bin, path.join(w.home, 'bin', 'graphify'));
  assert.equal(fs.readFileSync(w.uvLog, 'utf8'), `tool install --python >=3.10 graphifyy==${GC.PIN}\n`);
  assert.deepEqual(cfgOf(w).graph, { enabled: true, bin: r.bin });
  assert.equal(GC.installedVersion(r.bin), GC.PIN);
  assert.ok(r.seeded && fs.existsSync(path.join(w.vault, '.graphifyignore')));

  // At the pin: no uv call at all, and uv is not even needed.
  fs.writeFileSync(w.uvLog, '');
  const again = GC.install({ vault: w.vault, configDir: w.configDir, uv: null, template: TEMPLATE, io: quiet, home: w.home });
  assert.equal(again.action, `kept ${GC.PIN}`);
  assert.equal(fs.readFileSync(w.uvLog, 'utf8'), '');
  assert.equal(again.seeded, false, 'an existing .graphifyignore is the owner\'s');
});

test('install: a drifted version is reinstalled with --reinstall', () => {
  const w = world();
  placeGraphify(w.home, '0.9.1');
  fs.mkdirSync(path.join(w.home, 'tools'), { recursive: true });
  const r = withEnv({ FAKE_UV_LOG: w.uvLog }, () => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, io: quiet, home: w.home }));
  assert.equal(r.action, `updated 0.9.1 → ${GC.PIN}`);
  assert.equal(fs.readFileSync(w.uvLog, 'utf8'), `tool install --python >=3.10 --reinstall graphifyy==${GC.PIN}\n`);
});

test('install refuses without uv, on a failed uv run, and when the result is not the pin — recording nothing', () => {
  const w = world();
  assert.throws(() => GC.install({ vault: w.vault, configDir: w.configDir, uv: null, io: quiet, home: w.home }), new RegExp(`uv not found .*graphify ${GC.PIN.replace(/\./g, '\\.')} is not installed`));
  withEnv({ FAKE_UV_FAIL: '1' }, () => assert.throws(() => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, io: quiet, home: w.home }), /uv tool install graphifyy==.* failed: error: fake uv install failure/));
  withEnv({ FAKE_UV_INSTALLS_VERSION: '0.0.1' }, () => assert.throws(() => GC.install({ vault: w.vault, configDir: w.configDir, uv: FAKE_UV, io: quiet, home: w.home }), /reports 0\.0\.1 after the install, expected/));
  assert.deepEqual(cfgOf(w).graph, { enabled: true }, 'graph.bin is never recorded for a failed install');
});

test('ensureGitignore appends only the missing graph rules, once, and never creates a .gitignore', () => {
  const w = world();
  const g = { out: 'brain/graphify-out' };
  assert.deepEqual(GC.ensureGitignore(w.vault, g), [], 'no .gitignore: not ours to create');
  assert.ok(!fs.existsSync(path.join(w.vault, '.gitignore')));
  fs.writeFileSync(path.join(w.vault, '.gitignore'), '**/graphify-out/\nbrain/graphify-out/');   // no trailing newline
  assert.deepEqual(GC.ensureGitignore(w.vault, g), ['brain/graphify-out.pre-aos/']);
  assert.equal(fs.readFileSync(path.join(w.vault, '.gitignore'), 'utf8'),
    '**/graphify-out/\nbrain/graphify-out/\n# the vault knowledge graph (aos graph) is a derived cache, rebuilt from the notes\nbrain/graphify-out.pre-aos/\n');
  assert.deepEqual(GC.ensureGitignore(w.vault, g), [], 'idempotent');
  assert.deepEqual(GC.ensureGitignore(w.vault, { out: 'graph' }), ['graph/', 'graph.pre-aos/'], 'follows graph.out');
});

test('moveAside: a graph without our marker is renamed once; a marked graph and an empty dir stay', () => {
  const w = world();
  const g = { out: 'brain/graphify-out' };
  const out = path.join(w.vault, 'brain', 'graphify-out');
  assert.equal(GC.moveAside(w.vault, g), null, 'nothing there');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, GC.MARKER), '{}');
  fs.writeFileSync(path.join(out, 'graph.json'), '{"nodes":[]}');
  assert.equal(GC.moveAside(w.vault, g), null, 'ours');
  fs.rmSync(path.join(out, GC.MARKER));
  assert.equal(GC.moveAside(w.vault, g), `${out}.pre-aos`);
  assert.ok(fs.existsSync(path.join(`${out}.pre-aos`, 'graph.json')));
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'graph.json'), '{"nodes":[]}');
  assert.match(GC.moveAside(w.vault, g), /graphify-out\.pre-aos-\d+$/, 'never overwrites an earlier move');
});

test('doctorRows: missing binary fails, drift warns, marker age decides freshness, off is info', () => {
  const w = world();
  const now = Date.parse('2026-09-23T12:00:00Z');
  let rows = GC.doctorRows({ cfg: { graph: {} }, vault: w.vault, now });
  assert.deepEqual(rows[0], { name: `graphify ${GC.PIN}`, ok: false, detail: 'not installed — run aos upgrade', level: 'fail' });
  assert.deepEqual(rows[1], { name: 'graph fresh', ok: false, detail: 'no graph yet — run aos graph build', level: 'warn' });

  const bin = placeGraphify(w.home, '0.9.1');
  rows = GC.doctorRows({ cfg: { graph: { bin } }, vault: w.vault, now });
  assert.deepEqual(rows[0], { name: `graphify ${GC.PIN}`, ok: false, detail: `installed 0.9.1, pinned ${GC.PIN} — run aos upgrade`, level: 'warn' });

  fs.writeFileSync(path.join(w.home, 'bin', '.fake-graphify-version'), `${GC.PIN}\n`);
  const out = path.join(w.vault, 'brain', 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, GC.MARKER), JSON.stringify({ lastStructural: '2026-09-23T09:00:00Z', nodes: 5, edges: 4 }));
  rows = GC.doctorRows({ cfg: { graph: { bin } }, vault: w.vault, now });
  assert.equal(rows[0].ok, true);
  assert.deepEqual(rows[1], { name: 'graph fresh', ok: true, detail: 'built 3h ago · 5 nodes · 4 edges', level: 'warn' });

  fs.writeFileSync(path.join(out, GC.MARKER), JSON.stringify({ lastStructural: '2026-09-01T12:00:00Z', nodes: 5, edges: 4 }));
  rows = GC.doctorRows({ cfg: { graph: { bin } }, vault: w.vault, now });
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].detail, /built 22d ago .* older than 7 days, run aos graph build$/);

  rows = GC.doctorRows({ cfg: { graph: { bin, enabled: false } }, vault: w.vault, now });
  assert.deepEqual(rows[1], { name: 'graph fresh', ok: false, detail: 'graph off (aos graph on)', level: 'info' });
});

test('removeTools removes only a …/agenticos/graphify dir', () => {
  const w = world();
  fs.mkdirSync(w.home, { recursive: true });
  assert.equal(GC.removeTools(path.join(w.dir, 'share')), null, 'not ours');
  assert.ok(fs.existsSync(w.home));
  assert.equal(GC.removeTools(w.home), w.home);
  assert.ok(!fs.existsSync(w.home));
  assert.equal(GC.removeTools(w.home), null, 'already gone');
});

test('run: usage is exit 2; without a config it is exit 1; on/off write graph.enabled', async () => {
  const w = world();
  const errs = [];
  const io = { log() {}, error: (m) => errs.push(m) };
  assert.equal(await GC.run(['frobnicate'], { configDir: w.configDir, io }), 2);
  assert.equal(await GC.run(['on', 'extra'], { configDir: w.configDir, io }), 2);
  assert.equal(await GC.run(['status'], { configDir: path.join(w.dir, 'nowhere'), io }), 1);
  assert.match(errs.pop(), /no agenticos\.json .* \(run `aos init` first\)/);
  assert.equal(await GC.run(['off'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.enabled, false);
  assert.equal(await GC.run(['on'], { configDir: w.configDir, io }), 0);
  assert.equal(cfgOf(w).graph.enabled, true);
});
