'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bumpFiles, checkFiles } = require('./bump-version.js');

function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const w = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), JSON.stringify(obj, null, 2) + '\n'); };
  w('package.json', { name: 'agenticos-workbench', version: '0.1.0', private: true, workspaces: ['obsidian-plugin'] });
  w('brain/scripts/package.json', { name: 'agenticos-brain', private: true, version: '0.1.0', type: 'commonjs' });
  w('obsidian-plugin/package.json', { name: 'agentic-os', version: '1.2.0' });
  w('plugin/.claude-plugin/plugin.json', { name: 'agenticos', version: '0.1.0' });
  w('.claude-plugin/marketplace.json', { name: 'agenticos-workbench', plugins: [{ name: 'agenticos', source: './plugin' }] });
  w('codex-plugin/.codex-plugin/plugin.json', { name: 'agenticos', version: '0.1.0', skills: './skills/' });
  w('app/package.json', { name: 'agenticos-workbench-app', version: '0.1.0', private: true, productName: 'AgenticOS Workbench' });
  return r;
}
const read = (r, rel) => JSON.parse(fs.readFileSync(path.join(r, rel), 'utf8'));

test('bumpFiles rewrites every version surface (root package.json included)', () => {
  const r = repo();
  const out = bumpFiles(r, '1.3.0');
  assert.deepEqual(out.skipped, []);
  assert.equal(out.updated.length, 7);
  assert.equal(read(r, 'package.json').version, '1.3.0');
  assert.deepEqual(read(r, 'package.json').workspaces, ['obsidian-plugin']); // only .version is touched
  assert.equal(read(r, 'brain/scripts/package.json').version, '1.3.0'); // the MCP server reports this one
  assert.equal(read(r, 'brain/scripts/package.json').type, 'commonjs');
  assert.equal(read(r, 'obsidian-plugin/package.json').version, '1.3.0');
  assert.equal(read(r, 'plugin/.claude-plugin/plugin.json').version, '1.3.0');
  assert.equal(read(r, '.claude-plugin/marketplace.json').plugins[0].version, '1.3.0');
  assert.equal(read(r, 'codex-plugin/.codex-plugin/plugin.json').version, '1.3.0');
  assert.equal(read(r, 'codex-plugin/.codex-plugin/plugin.json').skills, './skills/'); // only .version is touched
  assert.equal(read(r, 'app/package.json').version, '1.3.0');
  assert.equal(read(r, 'app/package.json').productName, 'AgenticOS Workbench');
  bumpFiles(r, '1.3.0'); // idempotent
  assert.deepEqual(checkFiles(r, '1.3.0'), []);
});

test('the Obsidian packaging is no surface: a manifest.json or versions.json left in a checkout is neither bumped nor checked', () => {
  const r = repo();
  const w = (rel, obj) => fs.writeFileSync(path.join(r, rel), JSON.stringify(obj, null, 2) + '\n');
  w('obsidian-plugin/manifest.json', { id: 'agentic-os', version: '0.21.0', minAppVersion: '1.4.0' });
  w('obsidian-plugin/versions.json', { '0.21.0': '1.4.0' });
  const out = bumpFiles(r, '1.3.0');
  assert.ok(!out.updated.some((f) => /manifest|versions/.test(f)));
  assert.equal(read(r, 'obsidian-plugin/manifest.json').version, '0.21.0');
  assert.deepEqual(read(r, 'obsidian-plugin/versions.json'), { '0.21.0': '1.4.0' });
  assert.deepEqual(checkFiles(r, '1.3.0'), []);
});

test('checkFiles lists mismatches before a bump and nothing after', () => {
  const r = repo();
  assert.equal(checkFiles(r, '1.3.0').length, 7);
  bumpFiles(r, '1.3.0');
  assert.deepEqual(checkFiles(r, '1.3.0'), []);
});

test('checkFiles agrees with Plan 3: plugin.json and the root package.json share the repo version', () => {
  const r = repo();
  const bad = checkFiles(r, '0.1.0');
  assert.ok(!bad.some((b) => b.startsWith('package.json:')));
  assert.ok(!bad.some((b) => b.startsWith('brain/scripts/package.json:')));
  assert.ok(!bad.some((b) => b.startsWith('plugin/.claude-plugin/plugin.json:')));
  assert.ok(!bad.some((b) => b.startsWith('codex-plugin/.codex-plugin/plugin.json:')));
  assert.ok(!bad.some((b) => b.startsWith('app/package.json:')));
  assert.equal(bad.length, 2); // the HUD's package.json + marketplace (no version yet)
});

test('missing Plan 3 files are reported as skipped, not fatal', () => {
  const r = repo();
  fs.rmSync(path.join(r, 'plugin'), { recursive: true });
  fs.rmSync(path.join(r, 'codex-plugin'), { recursive: true });
  const out = bumpFiles(r, '1.3.0');
  assert.deepEqual(out.skipped, ['plugin/.claude-plugin/plugin.json', 'codex-plugin/.codex-plugin/plugin.json']);
});

test('checkFiles reads the app\'s own lockfile: a stale one is a mismatch', () => {
  const r = repo();
  bumpFiles(r, '1.3.0');
  const lock = (v) => fs.writeFileSync(path.join(r, 'app/package-lock.json'), JSON.stringify({ name: 'agenticos-workbench-app', version: v, lockfileVersion: 3, packages: { '': { name: 'agenticos-workbench-app', version: v } } }, null, 2) + '\n');
  lock('1.2.0');
  assert.deepEqual(checkFiles(r, '1.3.0'), ['app/package-lock.json (version): 1.2.0 != 1.3.0', 'app/package-lock.json (packages[""].version): 1.2.0 != 1.3.0']);
  lock('1.3.0');
  assert.deepEqual(checkFiles(r, '1.3.0'), []);
});

test('an invalid version is rejected', () => {
  assert.throws(() => bumpFiles(repo(), 'v1.3'), /semver/);
});

test('--check also verifies the package-lock.json version fields (brain/scripts too), which bumpFiles deliberately leaves to npm', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, 'package-lock.json'), JSON.stringify({
    name: 'agenticos-workbench',
    version: '0.1.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'agenticos-workbench', version: '0.1.0' },
      'obsidian-plugin': { name: 'agentic-os', version: '1.2.0' },
      'brain/scripts': { name: 'agenticos-brain', version: '0.1.0' },
    },
  }, null, 2) + '\n');
  bumpFiles(r, '1.3.0');
  const bad = checkFiles(r, '1.3.0');
  assert.equal(bad.length, 4);
  assert.ok(bad.every((b) => b.startsWith('package-lock.json (')));
  assert.ok(bad.some((b) => b.includes('packages["brain/scripts"]')));
  // Simulate `npm install --package-lock-only --ignore-scripts` refreshing the lock.
  const lock = read(r, 'package-lock.json');
  lock.version = '1.3.0';
  lock.packages[''].version = '1.3.0';
  lock.packages['obsidian-plugin'].version = '1.3.0';
  lock.packages['brain/scripts'].version = '1.3.0';
  fs.writeFileSync(path.join(r, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  assert.deepEqual(checkFiles(r, '1.3.0'), []);
});
