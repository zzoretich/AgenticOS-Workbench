'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// A vault of our own, set before the scripts (and paths.js beneath them) load: workspaces to name, hidden and archived
// folders, a file, and links that lead out of the vault.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-out-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
const WS = path.join(TMP, 'workspaces');
fs.mkdirSync(path.join(WS, 'harbor', 'src'), { recursive: true });
fs.mkdirSync(path.join(WS, 'Field Notes'), { recursive: true });
fs.mkdirSync(path.join(WS, '_archive', 'old'), { recursive: true });
fs.mkdirSync(path.join(WS, '_spikes'), { recursive: true });
fs.mkdirSync(path.join(WS, '.hidden'), { recursive: true });
fs.writeFileSync(path.join(WS, 'afile'), 'not a folder');
fs.writeFileSync(path.join(WS, 'harbor', 'src', 'tide.ts'), 'export const tide = 1;\n');
fs.writeFileSync(path.join(WS, 'harbor', '.github-notes.md'), '# notes\n');
fs.mkdirSync(path.join(WS, 'harbor', '.github', 'workflows'), { recursive: true });
fs.writeFileSync(path.join(WS, 'harbor', '.github', 'workflows', 'ci.yml'), 'on: push\n');
fs.mkdirSync(path.join(WS, 'harbor', '.git'), { recursive: true });
fs.writeFileSync(path.join(WS, 'harbor', '.git', 'config'), '[remote "origin"]\n');
fs.writeFileSync(path.join(WS, 'harbor', '.env'), 'TOKEN=x\n');
fs.mkdirSync(path.join(WS, 'harbor', 'node_modules', 'dep'), { recursive: true });
fs.writeFileSync(path.join(WS, 'harbor', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(WS, 'harbor', 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
fs.writeFileSync(path.join(WS, 'harbor', 'logo.png'), 'not really a png');
fs.writeFileSync(path.join(OUT, 'secret.txt'), 'outside the vault\n');
fs.symlinkSync(OUT, path.join(WS, 'outlink'));                                   // a workspace name leading out
fs.symlinkSync(OUT, path.join(WS, 'harbor', 'outdir'));                          // a folder on the way leading out
fs.symlinkSync(path.join(WS, 'harbor', 'src', 'tide.ts'), path.join(WS, 'harbor', 'tide-link.ts')); // a link, even inward
process.env.BRAIN_VAULT = TMP;

const { regenInto, checkArgs } = require('../regen-workspace-insight');
const mapWorkspace = require('../map-workspace');
const SCRIPTS = path.join(__dirname, '..');

test('regenInto replaces one workspace insight in a snapshot object', async () => {
  const snap = { workspaces: [
    { name: 'A', inputHash: 'h1', next: { text: null, source: 'derived' }, insight: { text: null, status: 'unavailable' }, objectives: [], subprojects: [], lastEvent: { ageDays: 1 } },
    { name: 'B', inputHash: 'h2', next: { text: null, source: 'derived' }, insight: { text: 'keep', status: 'ok' }, objectives: [], subprojects: [], lastEvent: { ageDays: 1 } },
  ]};
  const updated = await regenInto(snap, 'A', { chatFn: async () => 'INSIGHT: Fresh take.\nNEXT: Do thing.' });
  assert.equal(updated.workspaces[0].insight.text, 'Fresh take.');
  assert.equal(updated.workspaces[0].insight.status, 'ok');
  assert.equal(updated.workspaces[1].insight.text, 'keep'); // untouched
});

test('regenInto never copies the model\'s next into the workspace\'s own next (spaces-redesign D23)', async () => {
  const snap = { workspaces: [{ name: 'A', inputHash: 'h1', next: { text: null, source: 'derived' }, insight: null, objectives: [], subprojects: [], lastEvent: { ageDays: 1 } }] };
  await regenInto(snap, 'A', { chatFn: async () => 'INSIGHT: Fresh take.\nNEXT: Do thing.' });
  assert.deepEqual(snap.workspaces[0].next, { text: null, source: 'derived' });
  const set = { workspaces: [{ name: 'B', inputHash: 'h2', next: { text: 'Ship it', source: 'manifest' }, insight: null, objectives: [], subprojects: [], lastEvent: { ageDays: 1 } }] };
  await regenInto(set, 'B', { chatFn: async () => 'INSIGHT: Fine.\nNEXT: Something else.' });
  assert.deepEqual(set.workspaces[0].next, { text: 'Ship it', source: 'manifest' });
});

test('regenInto throws when workspace name not found', async () => {
  await assert.rejects(() => regenInto({ workspaces: [] }, 'missing', { chatFn: async () => 'x' }));
});

// What the page's WS rule refuses, refused again by the runtime (spaces-redesign §6), plus what only the runtime sees:
// a missing folder, a file. A link out of the vault (outlink) is refused wherever files are read under the name.
const BAD_NAMES = ['..', '.', '_archive', '_archive/old', '_spikes', '.hidden', 'a\\b', '-x', 'har\nbor', '\nharbor', '../x', '/etc/x',
  'harbor/src', '', ' harbor', 'missing', 'afile', 'x'.repeat(129), '\0harbor', 'har\u2028bor'];

test('regen-workspace-insight takes one name: an existing folder directly under workspaces/, a linked one too', () => {
  assert.deepEqual(checkArgs(['harbor'], TMP), { name: 'harbor' });
  assert.deepEqual(checkArgs(['Field Notes'], TMP), { name: 'Field Notes' });
  // Spaces lists a linked code folder (collectWorkspaces follows the link), and ↻ insight only picks its snapshot entry.
  assert.deepEqual(checkArgs(['outlink'], TMP), { name: 'outlink' });
  for (const bad of BAD_NAMES) assert.ok(checkArgs([bad], TMP).error, `refused: ${JSON.stringify(bad)}`);
  assert.match(checkArgs([], TMP).error, /usage/);
  assert.match(checkArgs(['harbor', 'extra'], TMP).error, /usage/);
});

test('map-workspace parses one name and one --file, nothing else', () => {
  assert.deepEqual(mapWorkspace.parseArgs([]), { name: null, relFile: null });
  assert.deepEqual(mapWorkspace.parseArgs(['harbor']), { name: 'harbor', relFile: null });
  assert.deepEqual(mapWorkspace.parseArgs(['harbor', '--file', 'src/tide.ts']), { name: 'harbor', relFile: 'src/tide.ts' });
  assert.deepEqual(mapWorkspace.parseArgs(['--file', 'src/tide.ts', 'harbor']), { name: 'harbor', relFile: 'src/tide.ts' });
  for (const bad of [['--all'], ['-x'], ['harbor', 'field'], ['harbor', '--file'], ['--file', 'x'], ['harbor', '--file', 'a', '--file', 'b'], ['harbor', '--budget', '3']]) {
    assert.ok(mapWorkspace.parseArgs(bad).error, `refused: ${JSON.stringify(bad)}`);
  }
});

test('map-workspace checks the name, and --file as a regular file inside the workspace that the map would list', () => {
  const check = (name, relFile = null) => mapWorkspace.checkTarget({ name, relFile }, TMP);
  assert.deepEqual(check(null), { name: null, relFile: null }, 'no name maps every workspace');
  assert.deepEqual(check('harbor'), { name: 'harbor', relFile: null });
  assert.deepEqual(check('harbor', 'src/tide.ts'), { name: 'harbor', relFile: 'src/tide.ts' });
  assert.deepEqual(check('harbor', '.github/workflows/ci.yml'), { name: 'harbor', relFile: '.github/workflows/ci.yml' });
  for (const bad of [...BAD_NAMES, 'outlink']) assert.ok(check(bad).error, `name refused: ${JSON.stringify(bad)}`);
  // Never a file the map skips: a dot path (a credential in .git/config or .env), a skipped folder, a binary, over 1 MB.
  for (const bad of ['.git/config', '.env', '.github-notes.md', 'node_modules/dep/index.js', 'big.txt', 'logo.png']) {
    assert.match(check('harbor', bad).error || '', /not a file the map lists/, `file refused: ${bad}`);
  }
  for (const bad of ['../x', '/etc/x', '-x', 'src/../../x', '..', '.', './src/tide.ts', 'src/tide.ts\n', 'a\nb', 'src', 'missing.ts',
    'tide-link.ts', 'outdir/secret.txt', path.join(WS, 'harbor', 'src', 'tide.ts')]) {
    assert.ok(check('harbor', bad).error, `file refused: ${JSON.stringify(bad)}`);
  }
});

test('map-workspace --file describes through the provider under feature file-map (D33)', async () => {
  const features = [];
  const chats = [];
  const provider = { name: 'ollama', chat: async (o) => { chats.push(o.feature); return 'Holds the tide constant'; } };
  let printed = '';
  await mapWorkspace.run(['harbor', '--file', 'src/tide.ts'], {
    vault: TMP, getProvider: async (f) => { features.push(f); return provider; }, stdout: { write: (s) => { printed += s; } },
  });
  assert.deepEqual(features, ['file-map']);
  assert.ok(chats.length >= 1 && chats.every((f) => f === 'file-map'), JSON.stringify(chats));
  assert.match(printed, /^src\/tide\.ts: Holds the tide constant/);
  const map = JSON.parse(fs.readFileSync(path.join(TMP, 'brain', '_index', 'workspace-maps', 'harbor.json'), 'utf8'));
  assert.equal(map.files.find((f) => f.path === 'src/tide.ts').desc, 'Holds the tide constant');
});

test('map-workspace --file makes no call with no provider, and says so', async () => {
  let calls = 0;
  const none = { name: 'none', reason: 'test', chat: async () => { calls++; throw new Error('no'); } };
  await assert.rejects(mapWorkspace.run(['harbor', '--file', 'src/tide.ts'], { vault: TMP, getProvider: async () => none, stdout: { write() {} } }),
    /no model provider/);
  assert.equal(calls, 0);
});

test('a refused name or file stops map-workspace before it asks a provider or writes a map', async () => {
  const maps = path.join(TMP, 'brain', '_index', 'workspace-maps');
  const before = fs.existsSync(maps) ? fs.readdirSync(maps).sort() : [];
  let asked = 0;
  const getProvider = async () => { asked++; return { name: 'ollama', chat: async () => 'x' }; };
  for (const args of [['..'], ['_archive'], ['outlink'], ['harbor', '--file', '../../brain/config.json'], ['harbor', '--file', 'outdir/secret.txt']]) {
    await assert.rejects(mapWorkspace.run(args, { vault: TMP, getProvider, stdout: { write() {} } }), (e) => e.usage === true, JSON.stringify(args));
  }
  assert.equal(asked, 0);
  assert.deepEqual(fs.existsSync(maps) ? fs.readdirSync(maps).sort() : [], before);
});

test('both scripts exit 2 on a refused name when run as commands', () => {
  const env = { ...process.env, BRAIN_VAULT: TMP };
  delete env.AOS_VAULT;
  for (const [script, args] of [['map-workspace.js', ['..']], ['map-workspace.js', ['harbor', '--file', '/etc/hosts']],
    ['regen-workspace-insight.js', ['..']], ['regen-workspace-insight.js', ['_archive']]]) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: SCRIPTS, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 2, `${script} ${args.join(' ')}: ${r.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(TMP, 'brain', '_index', 'snapshot.json')), false, 'regen read and wrote no snapshot');
});
