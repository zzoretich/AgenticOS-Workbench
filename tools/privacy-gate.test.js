'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scan, listFiles } = require('./privacy-gate.js');

// Planted terms are built by concatenation so this test file itself stays clean
// (no fragment may itself be a gate term — the gate matches substrings).
const NAME = 'za' + 'chary';
const BRAND = 'Jar' + 'vis';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  fs.mkdirSync(path.join(dir, 'ignored'));
  fs.writeFileSync(path.join(dir, 'ignored', 'x.md'), NAME);
  fs.writeFileSync(path.join(dir, 'clean.md'), 'hello world\n');
  fs.writeFileSync(path.join(dir, 'dirty.md'), `line one\ncontact ${NAME} today\nsee ${BRAND}\n`);
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

test('listFiles sees tracked and untracked files but not ignored ones', () => {
  const dir = repo();
  execFileSync('git', ['add', 'clean.md'], { cwd: dir });
  const files = listFiles(dir).sort();
  assert.deepEqual(files, ['.gitignore', 'clean.md', 'dirty.md', 'pic.png']);
});

test('scan reports every line containing a term, case-insensitively', () => {
  const dir = repo();
  const v = scan({ root: dir, terms: [NAME.toUpperCase(), BRAND], exceptions: [], files: listFiles(dir) });
  assert.deepEqual(v.map(x => [x.file, x.line, x.term]), [
    ['dirty.md', 2, NAME.toUpperCase()],
    ['dirty.md', 3, BRAND],
  ]);
  assert.equal(v[0].text, `contact ${NAME} today`);
});

test('an exception for {path, term} suppresses only that pair; "*" exempts the file', () => {
  const dir = repo();
  const files = listFiles(dir);
  const one = scan({ root: dir, terms: [NAME, BRAND], exceptions: [{ path: 'dirty.md', term: NAME }], files });
  assert.deepEqual(one.map(x => x.term), [BRAND]);
  const all = scan({ root: dir, terms: [NAME, BRAND], exceptions: [{ path: 'dirty.md', term: '*' }], files });
  assert.deepEqual(all, []);
});

test('binary extensions are skipped', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from(NAME));
  const v = scan({ root: dir, terms: [NAME], exceptions: [], files: ['pic.png'] });
  assert.deepEqual(v, []);
});
