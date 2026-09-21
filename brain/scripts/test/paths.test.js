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
  assert.equal(p.PATHS.ROUTINES, path.join(b, 'brain', 'routines'));
  assert.equal(p.PATHS.ROUTINES_STATE, path.join(b, 'brain', '_index', 'routines.json'));
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

test('looksLikeVault requires brain/_index — a bare CLAUDE.md is not enough', () => {
  const v = vault('llv'); process.env.AOS_VAULT = v; // keep module load from throwing while the predicate is exercised directly
  const { looksLikeVault } = fresh();
  const checkoutLike = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-only-'));
  fs.writeFileSync(path.join(checkoutLike, 'CLAUDE.md'), '# repo docs, not a vault\n');
  fs.mkdirSync(path.join(checkoutLike, 'brain')); // brain/ without _index — a checkout carrying a stray CLAUDE.md, not a vault
  assert.equal(looksLikeVault(checkoutLike), false);
  const realVault = fs.mkdtempSync(path.join(os.tmpdir(), 'real-vault-'));
  fs.mkdirSync(path.join(realVault, 'brain', '_index'), { recursive: true });
  assert.equal(looksLikeVault(realVault), true);
});

test('listDailyNotes walks the default layout and ignores entries outside it', () => {
  const v = vault('ldn'); process.env.AOS_VAULT = v;
  const w = (rel) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), '# note\n'); };
  w('2026/2026-09-September/2026-09-04.md');
  w('2026/2026-01-January/2026-01-09.md');
  w('2026/2026-09-September/notes.md');   // filename is not a date
  w('2026/scratch/2026-09-05.md');        // month directory does not match {yyyy}-{MM}-{MMMM}
  w('docs/2026-09-06.md');                // outside the layout entirely
  const notes = fresh().listDailyNotes();
  assert.deepEqual(notes.map((n) => n.date), ['2026-01-09', '2026-09-04']);
  assert.equal(notes[1].path, '2026/2026-09-September/2026-09-04.md');
  assert.equal(notes[1].absPath, path.join(v, '2026', '2026-09-September', '2026-09-04.md'));
});

test('listDailyNotes derives its depth from a custom dailyNote.layout', () => {
  const v = vault('ldn2'); process.env.AOS_VAULT = v;
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ dailyNote: { layout: '{yyyy}/{yyyy}-{MM}-{dd}.md' } }));
  fs.mkdirSync(path.join(v, '2026', '2026-09-September'), { recursive: true });
  fs.writeFileSync(path.join(v, '2026', '2026-09-14.md'), '# note\n');
  fs.writeFileSync(path.join(v, '2026', '2026-09-September', '2026-09-04.md'), '# left over from the default layout\n');
  const p = fresh();
  assert.deepEqual(p.listDailyNotes().map((n) => n.date), ['2026-09-14']);
  assert.equal(p.dailyNoteLayoutFor(v), '{yyyy}/{yyyy}-{MM}-{dd}.md');
  // An explicit layout wins over the vault's config, and the default layout sees only the nested note.
  assert.deepEqual(p.listDailyNotes({ vault: v, layout: p.DEFAULT_LAYOUT }).map((n) => n.date), ['2026-09-04']);
});
