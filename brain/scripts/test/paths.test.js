'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = require.resolve('../lib/paths.js');
function fresh() { delete require.cache[MOD]; return require(MOD); }
function vault(name) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}
const SAVED = {};
beforeEach(() => {
  for (const k of ['AOS_VAULT', 'BRAIN_VAULT', 'AOS_CONFIG', 'CLAUDE_CONFIG_DIR']) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.AOS_CONFIG = path.join(os.tmpdir(), 'no-such-agenticos.json');
});

test('AOS_VAULT wins over everything', () => {
  const a = vault('a'); const b = vault('b');
  process.env.AOS_VAULT = a; process.env.BRAIN_VAULT = b;
  assert.equal(fresh().VAULT, a);
});

test('BRAIN_VAULT is honored as a legacy alias', () => {
  const b = vault('b');
  process.env.BRAIN_VAULT = b;
  const p = fresh();
  assert.equal(p.VAULT, b);
  assert.equal(p.PATHS.INDEX, path.join(b, 'brain', '_index'));
  assert.equal(p.PATHS.PERSONA, path.join(b, 'persona'));
});

test('agenticos.json supplies vault and claudeConfigDir when no env is set', () => {
  const v = vault('cfg'); const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-'));
  const file = path.join(os.tmpdir(), `aos-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ vault: v, claudeConfigDir: cfgDir }));
  process.env.AOS_CONFIG = file;
  const p = fresh();
  assert.equal(p.VAULT, v);
  assert.equal(p.PATHS.CLAUDE_CONFIG_DIR, cfgDir);
  assert.equal(p.PATHS.PROJECTS, path.join(cfgDir, 'projects'));
});

test('with nothing configured and no vault above this file, require throws VaultNotFound', () => {
  assert.throws(() => fresh(), (e) => e.code === 'VAULT_NOT_FOUND' && e.name === 'VaultNotFound');
});

test('dailyNotePath uses the default year/month layout', () => {
  const v = vault('dn'); process.env.AOS_VAULT = v;
  const p = fresh();
  assert.equal(p.dailyNotePath(new Date(2026, 8, 4)), path.join(v, '2026', '2026-09-September', '2026-09-04.md'));
});

test('dailyNotePath honors dailyNote.layout from brain/config.json', () => {
  const v = vault('dn2'); process.env.AOS_VAULT = v;
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ dailyNote: { layout: 'daily/{yyyy}-{MM}-{dd}.md' } }));
  const p = fresh();
  assert.equal(p.dailyNotePath(new Date(2026, 0, 9)), path.join(v, 'daily', '2026-01-09.md'));
});

test('projectSlug encodes a directory the way Claude Code names transcript folders', () => {
  const v = vault('slug'); process.env.AOS_VAULT = v;
  assert.equal(fresh().projectSlug('/home/alice/.claude'), '-home-alice--claude');
});
