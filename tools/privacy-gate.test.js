'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { scan, scanString, listFiles } = require('./privacy-gate.js');

// Synthetic terms only: the real private list never appears in this repository, not even split into pieces.
const NAME = 'plover';
const BRAND = 'Quillon';
const GATE = path.join(__dirname, 'privacy-gate.js');

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

// The gate CLI with only the private terms a test names: the owner's local list is pointed away, and the CI
// variables the runner itself sets are cleared unless the test sets them.
function gate(args, extra = {}, input) {
  const env = { ...process.env, AOS_PRIVACY_TERMS_FILE: path.join(os.tmpdir(), 'aos-no-such-terms-file') };
  for (const k of ['CI', 'GITHUB_ACTIONS', 'AOS_PRIVACY_TERMS']) delete env[k];
  return spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', env: { ...env, ...extra }, input });
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

test('scan marks hits on private terms', () => {
  const dir = repo();
  const v = scan({ root: dir, terms: [BRAND], privateTerms: [NAME], exceptions: [], files: listFiles(dir) });
  assert.deepEqual(v.map(x => [x.term, x.private]), [[BRAND, false], [NAME, true]]);
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

test('a tools/*.local.* file that git can see is a violation, even when exempted', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'privacy-terms.local.txt'), 'x\n');
  const v = scan({ root: dir, terms: [], exceptions: [{ path: 'tools/privacy-terms.local.txt', term: '*' }], files: listFiles(dir) });
  assert.deepEqual(v.map(x => [x.file, x.line]), [['tools/privacy-terms.local.txt', 0]]);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\ntools/*.local.*\n');
  assert.deepEqual(scan({ root: dir, terms: [], exceptions: [], files: listFiles(dir) }), []);
});

test('scanString scans text as one file under its label', () => {
  const v = scanString({ label: 'commits', text: `fix: a\n\nthanks ${NAME}\n`, terms: [], privateTerms: [NAME], exceptions: [] });
  assert.deepEqual(v.map(x => [x.file, x.line, x.private]), [['commits', 3, true]]);
});

test('CLI: --require-private exits 2 when no private term loaded; without it the public terms still run', () => {
  const dir = repo();
  fs.unlinkSync(path.join(dir, 'dirty.md'));
  const required = gate(['--root', dir, '--require-private']);
  assert.equal(required.status, 2, required.stderr);
  assert.match(required.stderr, /no private terms loaded/);
  const open = gate(['--root', dir]);
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stderr, /checking the \d+ public terms only/);
});

test('CLI: a private term from AOS_PRIVACY_TERMS is caught and, locally, printed with its line', () => {
  const dir = repo();
  const r = gate(['--root', dir, '--require-private'], { AOS_PRIVACY_TERMS: `# comment\n\n${NAME}\n` });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.includes(`dirty.md:2: [${NAME}] contact ${NAME} today`), r.stdout);
  assert.match(r.stderr, / \+ 1 private terms/);
});

test('CLI: a private term from the local file (AOS_PRIVACY_TERMS_FILE) is caught', () => {
  const dir = repo();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'terms-')), 'privacy-terms.local.txt');
  fs.writeFileSync(file, `# private\n${BRAND.toLowerCase()}\n`);
  const r = gate(['--root', dir, '--require-private'], { AOS_PRIVACY_TERMS_FILE: file });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.includes('dirty.md:3:'), r.stdout);
});

test('CLI: under CI a private hit prints no term or text, and GitHub Actions masks every private term first', () => {
  const dir = repo();
  const r = gate(['--root', dir], { AOS_PRIVACY_TERMS: NAME, CI: 'true', GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], `::add-mask::${NAME}`);
  assert.deepEqual(lines.slice(1), ['dirty.md:2: [private term]']);
  const json = gate(['--root', dir, '--json'], { AOS_PRIVACY_TERMS: NAME, CI: 'true' });
  assert.deepEqual(JSON.parse(json.stdout), [{ file: 'dirty.md', line: 2, private: true }]);
});

test('CLI: --stdin scans piped text instead of the repo', () => {
  const r = gate(['--stdin', 'pull-request'], { AOS_PRIVACY_TERMS: NAME }, `Title\n\nBody mentions ${NAME}.\n`);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.startsWith(`pull-request:3: [${NAME}]`), r.stdout);
  assert.match(r.stderr, /across stdin \(pull-request\)/);
  const clean = gate(['--stdin', 'commits'], { AOS_PRIVACY_TERMS: NAME }, 'fix: nothing to see\n');
  assert.equal(clean.status, 0, clean.stderr);
});

test('CLI: an unknown or incomplete argument exits 2', () => {
  assert.equal(gate(['--jsn']).status, 2);
  assert.equal(gate(['--stdin']).status, 2);
});
