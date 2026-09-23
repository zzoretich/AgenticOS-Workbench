'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadTerms, parseList } = require('./privacy-terms.js');

const NONE = path.join(os.tmpdir(), 'aos-no-such-terms-file');

function termsFile(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'terms-')), 'privacy-terms.local.txt');
  fs.writeFileSync(file, body);
  return file;
}

test('parseList trims lines and drops blanks and # comments', () => {
  assert.deepEqual(parseList('# header\n\n  plover  \r\nquillon\n   # indented comment\n'), ['plover', 'quillon']);
  assert.deepEqual(parseList(undefined), []);
});

test('loadTerms: public from the committed JSON, private from the file and the environment', () => {
  const { public: pub, private: priv } = loadTerms({ env: { AOS_PRIVACY_TERMS_FILE: termsFile('plover\n'), AOS_PRIVACY_TERMS: 'quillon' } });
  assert.deepEqual(pub, JSON.parse(fs.readFileSync(path.join(__dirname, 'privacy-terms.json'), 'utf8')));
  assert.deepEqual(priv, ['plover', 'quillon']);
});

test('loadTerms dedupes case-insensitively and counts a term that is also public as public', () => {
  const [firstPublic] = loadTerms({ env: { AOS_PRIVACY_TERMS_FILE: NONE } }).public;
  const t = loadTerms({ env: { AOS_PRIVACY_TERMS_FILE: termsFile(`Plover\n${firstPublic}\n`), AOS_PRIVACY_TERMS: 'plover\nPLOVER' } });
  assert.deepEqual(t.private, ['Plover']);
});

test('loadTerms without a file or variable has no private terms', () => {
  assert.deepEqual(loadTerms({ env: { AOS_PRIVACY_TERMS_FILE: NONE } }).private, []);
});

test('CLI --check-message exits 1 on a private term and 0 on a clean message', () => {
  const env = { ...process.env, AOS_PRIVACY_TERMS_FILE: NONE, AOS_PRIVACY_TERMS: 'plover' };
  const run = body => spawnSync(process.execPath, [path.join(__dirname, 'privacy-terms.js'), '--check-message', termsFile(body)], { encoding: 'utf8', env });
  const hit = run('feat: thanks Plover\n');
  assert.equal(hit.status, 1);
  assert.match(hit.stderr, /forbidden term\(s\) in message: plover/);
  assert.equal(run('feat: nothing personal\n').status, 0);
});
