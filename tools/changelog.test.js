'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./changelog.js');

const URL = 'https://github.com/example/repo';
const TEXT = `# Changelog

Intro.

## [Unreleased]

### Fixed
- A fix.

## [0.2.0] — 2026-09-20

### Added
- A thing (#2).

### Upgrading
- Run \`aos upgrade\`.

## [0.1.0] — 2026-09-10

### Added
- The first thing.

[Unreleased]: ${URL}/compare/v0.2.0...HEAD
[0.2.0]: ${URL}/releases/tag/v0.2.0
[0.1.0]: ${URL}/releases/tag/v0.1.0
`;

test('section: a version\'s body up to the next heading, or to the link references for the last one', () => {
  assert.equal(C.section(TEXT, '0.2.0'), '### Added\n- A thing (#2).\n\n### Upgrading\n- Run `aos upgrade`.');
  assert.equal(C.section(TEXT, '0.1.0'), '### Added\n- The first thing.');
  assert.equal(C.section(TEXT, 'Unreleased'), '### Fixed\n- A fix.');
  assert.equal(C.section(TEXT, '0.3.0'), null);
  assert.equal(C.section(TEXT, '0.2'), null, 'no prefix match');
});

test('roll: [Unreleased] becomes the dated version under a fresh empty one; links follow; a second roll changes nothing', () => {
  const r = C.roll(TEXT, '0.3.0', '2026-09-24');
  assert.equal(r.changed, true);
  assert.match(r.text, /\n## \[Unreleased\]\n\n## \[0\.3\.0\] — 2026-09-24\n\n### Fixed\n- A fix\.\n\n## \[0\.2\.0\]/);
  assert.equal(C.section(r.text, 'Unreleased'), '');
  assert.match(r.text, new RegExp(`\\n\\[Unreleased\\]: ${URL}/compare/v0\\.3\\.0\\.\\.\\.HEAD\\n\\[0\\.3\\.0\\]: ${URL}/releases/tag/v0\\.3\\.0\\n\\[0\\.2\\.0\\]:`));
  assert.deepEqual(C.roll(r.text, '0.3.0', '2026-09-25'), { text: r.text, changed: false, message: 'CHANGELOG.md already has [0.3.0]' });
  assert.throws(() => C.roll(r.text, '0.4.0'), /\[Unreleased\] is empty/);
  assert.throws(() => C.roll('# Changelog\n', '0.4.0'), /no ## \[Unreleased\]/);
  assert.match(C.localDate(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('main: notes, check (current = package.json), roll writes the file; missing or empty exits 1, usage 2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), TEXT);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const out = []; const errs = [];
  const io = { root, log: (s) => out.push(s), err: (s) => errs.push(s) };
  assert.equal(C.main(['notes', '0.2.0'], io), 0);
  assert.match(out.pop(), /^### Added\n- A thing \(#2\)\./);
  assert.equal(C.main(['check', 'current'], io), 0);
  assert.equal(C.main(['check', '0.9.0'], io), 1);
  assert.match(errs.pop(), /no ## \[0\.9\.0\] section — run: node tools\/changelog\.js roll 0\.9\.0/);
  assert.equal(C.main(['roll', '0.3.0', '--date', '2026-09-24'], io), 0);
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.3\.0\] — 2026-09-24/);
  assert.equal(C.main(['check', 'Unreleased'], io), 2, 'only versions');
  assert.equal(C.main(['roll', '0.4.0'], io), 1, 'nothing unreleased');
  assert.equal(C.main(['nope', '1.0.0'], io), 2);
  assert.equal(C.main(['check', 'v1.0'], io), 2);
});

test('this repo: package.json\'s version has a non-empty section, and every section heading is well formed', () => {
  const root = path.resolve(__dirname, '..');
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.ok(C.section(text, version), `CHANGELOG.md has [${version}]`);
  for (const h of text.split('\n').filter((l) => l.startsWith('## '))) {
    assert.match(h, /^## \[(Unreleased|\d+\.\d+\.\d+)\]( — \d{4}-\d{2}-\d{2})?$/, h);
  }
});
