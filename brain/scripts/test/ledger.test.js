'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../persona/ledger.js');

const DAY = 86400e3;
const NOW = new Date('2026-09-22T12:00:00Z');
function tmpFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  return { root, file: path.join(root, 'persona', 'ledger.jsonl') };
}
const daysAgo = (n) => new Date(NOW - n * DAY);

test('append writes one JSON line with schema 1 and defaults; read returns it', () => {
  const { file } = tmpFile();
  const r = L.append({ event: 'filed', slug: 'trim-state', by: 'reflect', target: 'STATE.md' }, { file, now: NOW });
  assert.equal(r.schema, 1);
  assert.equal(r.kind, 'self');
  assert.equal(r.ts, NOW.toISOString());
  assert.equal(r.recheck, undefined, 'empty optional fields are omitted');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(L.read({ file }), [r]);
});

test('append validates event, slug, kind and string fields', () => {
  const { file } = tmpFile();
  assert.throws(() => L.append({ event: 'shipped', slug: 'x-y' }, { file }), /event must be one of/);
  assert.throws(() => L.append({ event: 'filed', slug: 'Bad Slug' }, { file }), /slug must be kebab-case/);
  assert.throws(() => L.append({ event: 'filed', slug: 'ok-slug', kind: 'meta' }, { file }), /kind must be one of/);
  assert.throws(() => L.append({ event: 'filed', slug: 'ok-slug', note: 42 }, { file }), /note must be a string/);
  assert.ok(!fs.existsSync(file), 'nothing written on a validation error');
});

test('read skips corrupt lines and a missing file reads as empty', () => {
  const { file } = tmpFile();
  assert.deepEqual(L.read({ file }), []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"event":"filed","slug":"a-b","ts":"2026-09-01T00:00:00Z"}\nnot json\n{"nope":1}\n\n{"event":"approved","slug":"a-b","ts":"2026-09-02T00:00:00Z"}\n');
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(m);
  try { assert.equal(L.read({ file }).length, 2); } finally { console.error = orig; }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /skipped 2 unreadable line/);
});

test('verify: regressed at once, verified after settling, settling and out-of-window approvals untouched', () => {
  const { root, file } = tmpFile();
  const put = (slug, event, at, extra = {}) => L.append({ event, slug, ...extra }, { file, now: at });
  put('old-clean', 'approved', daysAgo(8), { recheck: 'exit 1' });      // clean for 8d → verified
  put('young-clean', 'approved', daysAgo(3), { recheck: 'exit 1' });    // clean but settling → nothing
  put('young-bad', 'approved', daysAgo(3), { recheck: 'exit 0' });      // present again → regressed
  put('too-young', 'approved', daysAgo(0.5), { recheck: 'exit 0' });    // under minDays → skipped
  put('too-old', 'approved', daysAgo(20), { recheck: 'exit 0' });       // beyond maxDays → skipped
  put('no-recipe', 'approved', daysAgo(8));                             // nothing to run
  put('done', 'approved', daysAgo(9), { recheck: 'exit 0' });
  put('done', 'verified', daysAgo(1));                                  // already judged → not rechecked
  put('broken', 'approved', daysAgo(8), { recheck: 'exit 127' });       // recipe error → skipped, never judged
  const ran = [];
  const run = (cmd, cwd) => { ran.push([cmd, cwd]); return cmd === 'exit 0' ? 'present' : cmd === 'exit 1' ? 'gone' : 'error'; };
  const out = L.verify({ file, root, now: NOW, run });
  assert.deepEqual(out, { checked: 4, verified: ['old-clean'], regressed: ['young-bad'], skipped: 1 });
  assert.deepEqual(ran.map(([, cwd]) => cwd), [root, root, root, root]);
  const events = L.read({ file }).filter(r => r.event === 'verified' || r.event === 'regressed').map(r => `${r.slug}:${r.event}:${r.by}`);
  assert.deepEqual(events.sort(), ['done:verified:null', 'old-clean:verified:watchdog', 'young-bad:regressed:watchdog']);
  // A second pass judges nothing new: the settling approval and the broken recipe are rechecked, the judged ones are not.
  assert.deepEqual(L.verify({ file, root, now: NOW, run }), { checked: 2, verified: [], regressed: [], skipped: 1 });
});

test('runRecipe maps exit codes like the flag-closer', () => {
  assert.equal(L.runRecipe('exit 0', os.tmpdir()), 'present');
  assert.equal(L.runRecipe('exit 3', os.tmpdir()), 'gone');
  assert.equal(L.runRecipe('exit 127', os.tmpdir()), 'error');
});

test('summary counts the window, rates approvals, and lists open and unverified slugs', () => {
  const { file } = tmpFile();
  const put = (slug, event, at, extra = {}) => L.append({ event, slug, ...extra }, { file, now: at });
  put('a-one', 'filed', daysAgo(10), { kind: 'self' });
  put('a-one', 'approved', daysAgo(9), { kind: 'self', recheck: 'exit 1' });
  put('b-two', 'filed', daysAgo(5), { kind: 'product' });
  put('b-two', 'rejected', daysAgo(4), { kind: 'product' });
  put('c-three', 'filed', daysAgo(2), { kind: 'vault' });
  put('d-four', 'filed', daysAgo(40));                                   // outside the window, still open
  put('e-five', 'approved', daysAgo(3), { recheck: 'exit 1' });
  put('e-five', 'regressed', daysAgo(1));
  const s = L.summary({ file, days: 28, now: NOW });
  assert.equal(s.total, 7);
  assert.equal(s.counts.filed, 3);
  assert.equal(s.counts.approved, 2);
  assert.equal(s.counts.rejected, 1);
  assert.equal(s.approvalRate, 0.67);
  assert.deepEqual(s.byKind.product, { filed: 1, approved: 0, rejected: 1 });
  assert.deepEqual(s.regressed, ['e-five']);
  assert.deepEqual(s.open, ['c-three', 'd-four']);
  assert.deepEqual(s.unverified, ['a-one']);
  const text = L.formatSummary(s);
  assert.match(text, /approval rate 0\.67/);
  assert.match(text, /open: c-three, d-four/);
  assert.equal(L.summary({ file: path.join(os.tmpdir(), 'ledger-none.jsonl') }).approvalRate, null);
});

test('CLI: append and summary through main(); usage errors exit 2', () => {
  const { root, file } = tmpFile();
  let out = '', err = '';
  const io = { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: NOW };
  assert.equal(L.main(['append', 'filed', 'cli-slug', '--kind', 'workflow', '--by', 'reflect', '--target', 'daily note', '--root', root], io), 0);
  assert.equal(JSON.parse(out).kind, 'workflow');
  assert.equal(L.read({ file })[0].target, 'daily note');
  out = '';
  assert.equal(L.main(['summary', '--json', '--file', file], io), 0);
  assert.equal(JSON.parse(out).counts.filed, 1);
  out = '';
  assert.equal(L.main(['verify', '--root', root], io), 0);
  assert.deepEqual(JSON.parse(out), { checked: 0, verified: [], regressed: [], skipped: 0 });
  assert.equal(L.main(['append', 'filed', '--root', root], io), 2);
  assert.match(err, /usage: ledger.js append/);
  assert.equal(L.main(['append', 'bogus', 'cli-slug', '--root', root], io), 2);
  assert.equal(L.main(['dance', '--root', root], io), 2);
});
