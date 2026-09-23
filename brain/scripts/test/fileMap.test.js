'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// BRAIN_VAULT must be set BEFORE the module (and paths.js beneath it) loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmap-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'workspaces', 'Alpha', 'src'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'workspaces', 'Alpha', 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
fs.writeFileSync(path.join(TMP, 'workspaces', 'Alpha', 'README.md'), '# alpha readme');
fs.writeFileSync(path.join(TMP, 'workspaces', 'Alpha', 'src', 'main.js'), 'console.log(1)');
fs.writeFileSync(path.join(TMP, 'workspaces', 'Alpha', 'node_modules', 'x', 'index.js'), 'ignored');
fs.writeFileSync(path.join(TMP, 'workspaces', 'Alpha', 'photo.png'), Buffer.from([0x89, 0x50]));
process.env.BRAIN_VAULT = TMP;
const { collectFileMaps, describeOneFile, listWorkspaces, MAPS_DIR } = require('../collectors/fileMap.js');

const fakeChat = () => 'Does the thing the test expects';
const mapPath = () => path.join(MAPS_DIR, 'Alpha.json');
const readMap = () => JSON.parse(fs.readFileSync(mapPath(), 'utf8'));

beforeEach(() => { try { fs.rmSync(MAPS_DIR, { recursive: true }); } catch {} });

test('lists workspaces (non-hidden dirs only)', () => {
  assert.deepEqual(listWorkspaces(), ['Alpha']);
});

test('first run describes all eligible files, skips ignored', async () => {
  const out = await collectFileMaps({ budget: 40, chatFn: fakeChat });
  const map = readMap();
  const paths = map.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['README.md', 'src/main.js']); // png + node_modules excluded
  assert.ok(map.files.every((f) => f.status === 'fresh' && typeof f.desc === 'string' && f.descAt));
  assert.equal(map.pending, 0);
  assert.equal(out.perWorkspace['Alpha'].described, 2);
});

test('unchanged files are not re-described (zero qwen calls)', async () => {
  await collectFileMaps({ budget: 40, chatFn: fakeChat });
  let calls = 0;
  await collectFileMaps({ budget: 40, chatFn: () => { calls++; return 'x'; } });
  assert.equal(calls, 0);
  assert.equal(readMap().pending, 0);
});

test('a changed file (mtime/size) is re-described on the next run', async () => {
  await collectFileMaps({ budget: 40, chatFn: fakeChat });
  fs.writeFileSync(path.join(TMP, 'workspaces', 'Alpha', 'src', 'main.js'), 'console.log(2) // changed!');
  let calls = 0;
  await collectFileMaps({ budget: 40, chatFn: () => { calls++; return 'Updated line'; } });
  assert.equal(calls, 1);
  const row = readMap().files.find((f) => f.path === 'src/main.js');
  assert.equal(row.desc, 'Updated line');
  assert.equal(row.status, 'fresh');
});

test('budget overflow records pending and keeps old descs', async () => {
  const out = await collectFileMaps({ budget: 1, chatFn: fakeChat });
  const map = readMap();
  assert.equal(out.described, 1);
  assert.equal(map.pending, 1);
  assert.equal(map.files.filter((f) => f.desc === null).length, 1);
});

test('qwen failure records null desc and counts pending, never throws', async () => {
  const out = await collectFileMaps({ budget: 40, chatFn: () => { throw new Error('ollama down'); } });
  const map = readMap();
  assert.ok(map.files.every((f) => f.desc === null));
  assert.equal(map.pending, 2);
  assert.equal(out.described, 0);
});

test('deleted files drop off the map', async () => {
  await collectFileMaps({ budget: 40, chatFn: fakeChat });
  fs.unlinkSync(path.join(TMP, 'workspaces', 'Alpha', 'README.md'));
  await collectFileMaps({ budget: 40, chatFn: fakeChat });
  assert.deepEqual(readMap().files.map((f) => f.path), ['src/main.js']);
});

test('describeOneFile updates an existing row on disk and returns the new line', async () => {
  await collectFileMaps({ budget: 40, chatFn: fakeChat });
  const line = await describeOneFile('Alpha', 'src/main.js', { chatFn: () => 'Re-described main' });
  assert.equal(line, 'Re-described main');
  const row = readMap().files.find((f) => f.path === 'src/main.js');
  assert.equal(row.desc, 'Re-described main');
  assert.equal(row.status, 'fresh');
  assert.ok(row.descAt);
});

test('budget-starved changed row stays changed across a stats-match scan (does not launder to fresh)', async () => {
  const target = path.join(TMP, 'workspaces', 'Alpha', 'src', 'main.js');
  fs.writeFileSync(target, 'console.log("starve-fixture v1")');

  // 1. full run: everything present (whatever earlier tests left behind) gets described.
  await collectFileMaps({ budget: 40, chatFn: fakeChat });

  // 2. a real content change to the target file only.
  fs.writeFileSync(target, 'console.log("starve-fixture v2 — changed")');

  // 3. starved run (budget 0): must not call chatFn; row is marked changed + pending.
  await collectFileMaps({ budget: 0, chatFn: () => { throw new Error('must not be called'); } });
  let row = readMap().files.find((f) => f.path === 'src/main.js');
  assert.equal(row.status, 'changed');
  assert.ok(readMap().pending >= 1);

  // 4. run again with budget 0 and NO further modification — the stats-match pass.
  //    This is the exact assertion that fails on the unpatched code: mtime/size now
  //    match the row written in step 3, so the old code's stats-match branch would
  //    launder status back to 'fresh' off the stale v1 desc.
  await collectFileMaps({ budget: 0, chatFn: () => { throw new Error('must not be called'); } });
  row = readMap().files.find((f) => f.path === 'src/main.js');
  assert.equal(row.status, 'changed');
  assert.equal(row.desc, 'Does the thing the test expects'); // still the stale v1 desc
  assert.ok(readMap().pending >= 1);

  // 5. run with budget and a counting chatFn — exactly 1 call, and the desc updates.
  let calls = 0;
  await collectFileMaps({ budget: 40, chatFn: () => { calls++; return 'Re-described after starvation'; } });
  row = readMap().files.find((f) => f.path === 'src/main.js');
  assert.equal(calls, 1);
  assert.equal(row.status, 'fresh');
  assert.equal(row.desc, 'Re-described after starvation');
});

test('describeOneFile persists a new row for a file not yet in the map', async () => {
  const absFile = path.join(TMP, 'workspaces', 'Alpha', 'notes.md');
  fs.writeFileSync(absFile, '# scratch notes');
  const line = await describeOneFile('Alpha', 'notes.md', { chatFn: () => 'Scratch notes file' });
  assert.equal(line, 'Scratch notes file');
  const map = readMap();
  const row = map.files.find((f) => f.path === 'notes.md');
  assert.ok(row, 'row should be persisted on disk, not just returned');
  assert.equal(row.desc, 'Scratch notes file');
  assert.equal(row.status, 'fresh');
  const st = fs.statSync(absFile);
  assert.equal(row.mtime, st.mtimeMs);
  assert.equal(row.size, st.size);
  assert.equal(map.pending, 0);
});

const NONE = { name: 'none', reason: 'forced', capabilities: { chat: false, embed: false, structured: false }, chat: async () => { throw new Error('must not be called'); } };
const CLAUDE = (calls) => ({ name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true }, chat: async () => { calls.push(1); return 'Model-described line'; } });
const CONFIG = path.join(TMP, 'brain', 'config.json');
const ALPHA = path.join(TMP, 'workspaces', 'Alpha');
// The earlier describeOneFile test leaves notes.md in the shared Alpha fixture and the map cache
// carries rows from earlier tests; the provider tests assume the two-file fixture and a clean map.
function resetAlpha() {
  fs.rmSync(path.join(ALPHA, 'notes.md'), { force: true });
  fs.rmSync(MAPS_DIR, { recursive: true, force: true });
  fs.writeFileSync(path.join(ALPHA, 'README.md'), '# alpha readme'); // an earlier test unlinks it
  fs.writeFileSync(path.join(ALPHA, 'src', 'main.js'), 'console.log(1)');
}

test('provider none: every eligible file gets a heuristic description, nothing pending, no model call', async () => {
  resetAlpha();
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  fs.writeFileSync(path.join(TMP, 'workspaces', 'Alpha', 'README.md'), '# alpha readme');
  const out = await collectFileMaps({ provider: NONE });
  const map = readMap();
  assert.equal(map.pending, 0);
  assert.equal(out.described, 0, 'model-described count stays zero');
  const readme = map.files.find((f) => f.path === 'README.md');
  assert.equal(readme.desc, 'alpha readme');
  assert.equal(readme.descSource, 'heuristic');
  assert.equal(readme.status, 'fresh');
  assert.equal(map.files.find((f) => f.path === 'src/main.js').desc, 'JavaScript file');
});

test('provider claude: budget is scan.fileMapBudgetUnderClaude (default 0), rest heuristic', async () => {
  resetAlpha();
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  let calls = [];
  await collectFileMaps({ provider: CLAUDE(calls) });
  assert.equal(calls.length, 0);
  assert.equal(readMap().pending, 0);
  fs.rmSync(MAPS_DIR, { recursive: true, force: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', scan: { fileMapBudgetUnderClaude: 1 } }));
  calls = [];
  const out = await collectFileMaps({ provider: CLAUDE(calls) });
  assert.equal(calls.length, 1);
  assert.equal(out.described, 1);
  const map = readMap();
  assert.equal(map.pending, 0);
  assert.deepEqual(map.files.map((f) => f.descSource).sort(), ['heuristic', 'model']);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});

test('provider codex: its own opt-in, scan.fileMapBudgetUnderCodex (default 0); the Claude key does not open it', async () => {
  resetAlpha();
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', scan: { fileMapBudgetUnderClaude: 5 } }));
  let calls = [];
  const CODEX = (c) => ({ ...CLAUDE(c), name: 'codex' });
  await collectFileMaps({ provider: CODEX(calls) });
  assert.equal(calls.length, 0);
  fs.rmSync(MAPS_DIR, { recursive: true, force: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', scan: { fileMapBudgetUnderCodex: 1 } }));
  calls = [];
  const out = await collectFileMaps({ provider: CODEX(calls) });
  assert.equal(calls.length, 1);
  assert.equal(out.described, 1);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});

test('provider ollama: budget from scan.fileMapBudget, overflow stays pending (no heuristics)', async () => {
  resetAlpha();
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', scan: { fileMapBudget: 1 } }));
  const calls = [];
  const OLLAMA = { ...CLAUDE(calls), name: 'ollama' };
  const out = await collectFileMaps({ provider: OLLAMA });
  assert.equal(calls.length, 1);
  assert.equal(out.described, 1);
  assert.equal(readMap().pending, 1);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});

test('switching from none to ollama re-describes heuristic rows within budget, then leaves fresh model rows alone', async () => {
  resetAlpha();
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  await collectFileMaps({ provider: NONE });
  assert.deepEqual(readMap().files.map((f) => f.descSource).sort(), ['heuristic', 'heuristic']);

  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', scan: { fileMapBudget: 2 } }));
  let calls = [];
  const out = await collectFileMaps({ provider: { ...CLAUDE(calls), name: 'ollama' } });
  assert.equal(calls.length, 2);
  assert.equal(out.described, 2);
  const map = readMap();
  assert.equal(map.pending, 0);
  assert.ok(map.files.every((f) => f.descSource === 'model'));

  calls = [];
  await collectFileMaps({ provider: { ...CLAUDE(calls), name: 'ollama' } });
  assert.equal(calls.length, 0, 'fresh model rows are not re-queued');

  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});
