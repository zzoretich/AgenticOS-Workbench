'use strict';
// lib/pin-root.js and its four callers (spec 2026-09-23-duty-write-scope-design D3): under AOS_HEADLESS=1 a persona
// script refuses a --root / --file / file argument outside the vault; without it every flag still works.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertPinned, real, inside } = require('../lib/pin-root.js');

const PERSONA = path.join(__dirname, '..', 'persona');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  return v;
}
function elsewhere() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pin-elsewhere-')); }

/** A child with AOS_HEADLESS set for real: test/setup.js (NODE_OPTIONS) would delete an inherited one. */
function runScript(script, args, { v, headless }) {
  const env = { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'no-agenticos.json') };
  delete env.NODE_OPTIONS; delete env.BRAIN_VAULT; delete env.AOS_HEADLESS;
  if (headless) env.AOS_HEADLESS = '1';
  return spawnSync(process.execPath, [path.join(PERSONA, script), ...args], { env, encoding: 'utf8', timeout: 30000 });
}

test('assertPinned is a no-op without AOS_HEADLESS=1', () => {
  assert.doesNotThrow(() => assertPinned({ root: '/', file: '/etc/hosts', fileRel: 'persona/ledger.jsonl' }, { env: {}, vault: vault() }));
});

test('assertPinned: root must be the vault (a sibling sharing its name prefix is not), symlinks resolved', () => {
  const v = vault();
  const env = { AOS_HEADLESS: '1' };
  assert.doesNotThrow(() => assertPinned({ root: v }, { env, vault: v }));
  assert.doesNotThrow(() => assertPinned({ root: `${v}/.` }, { env, vault: v }));
  assert.throws(() => assertPinned({ root: `${v}-sibling` }, { env, vault: v }), /is not the vault/);
  assert.throws(() => assertPinned({ root: path.join(v, 'persona') }, { env, vault: v }), /is not the vault/);
  const link = path.join(elsewhere(), 'link');
  fs.symlinkSync(v, link);
  assert.doesNotThrow(() => assertPinned({ root: link }, { env, vault: v }), 'a symlink to the vault is the vault');
});

test('assertPinned: file must be <vault>/<fileRel>; within entries must sit under <vault>/<withinRel>', () => {
  const v = vault();
  const env = { AOS_HEADLESS: '1' };
  const rel = path.join('persona', 'ledger.jsonl');
  assert.doesNotThrow(() => assertPinned({ file: path.join(v, rel), fileRel: rel }, { env, vault: v }), 'a file that does not exist yet');
  assert.throws(() => assertPinned({ file: path.join(elsewhere(), 'ledger.jsonl'), fileRel: rel }, { env, vault: v }), /is not persona\/ledger\.jsonl/);
  const pr = path.join('persona', 'proposals');
  assert.doesNotThrow(() => assertPinned({ within: [path.join(v, pr, '2026-09-23-x.md')], withinRel: pr }, { env, vault: v }));
  assert.throws(() => assertPinned({ within: [path.join(v, pr, '..', 'IDENTITY.md')], withinRel: pr }, { env, vault: v }), /outside persona\/proposals/);
  assert.throws(() => assertPinned({ within: [path.join(elsewhere(), 'a.md')], withinRel: pr }, { env, vault: v }), /outside persona\/proposals/);
});

test('real() resolves a missing leaf through its existing parent; inside() refuses .. and siblings', () => {
  const v = vault();
  assert.equal(real(path.join(v, 'nope', 'deeper.md')), path.join(fs.realpathSync(v), 'nope', 'deeper.md'));
  assert.ok(inside('/a/b', '/a/b'));
  assert.ok(inside('/a/b', '/a/b/c'));
  assert.ok(!inside('/a/b', '/a/bc'));
  assert.ok(!inside('/a/b', '/a'));
});

test('ledger.js: a headless --file or --root outside the vault exits 2 and writes nothing; the vault itself still works', () => {
  const v = vault();
  const out = path.join(elsewhere(), 'target.txt');
  const bad = runScript('ledger.js', ['append', 'filed', 'some-slug', '--file', out, '--note', 'x'], { v, headless: true });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /a headless run cannot redirect it/);
  assert.ok(!fs.existsSync(out));
  const badRoot = runScript('ledger.js', ['append', 'filed', 'some-slug', '--root', path.dirname(out)], { v, headless: true });
  assert.equal(badRoot.status, 2, badRoot.stderr);
  assert.ok(!fs.existsSync(path.join(path.dirname(out), 'persona')));
  const ok = runScript('ledger.js', ['append', 'filed', 'some-slug', '--root', v], { v, headless: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(path.join(v, 'persona', 'ledger.jsonl'), 'utf8'), /"event":"filed"/);
  const interactive = runScript('ledger.js', ['append', 'filed', 'some-slug', '--file', out], { v, headless: false });
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.ok(fs.existsSync(out), 'an interactive caller may still point --file anywhere');
});

test('proposal-html.js: a headless file argument outside persona/proposals exits 2 and is never rewritten', () => {
  const v = vault();
  const target = path.join(elsewhere(), '2026-09-23-evil.md');
  fs.writeFileSync(target, '---\nslug: evil\n---\n\n# Evil\n');
  const before = fs.readFileSync(target, 'utf8');
  const bad = runScript('proposal-html.js', [target], { v, headless: true });
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  const badRoot = runScript('proposal-html.js', ['--root', path.dirname(target)], { v, headless: true });
  assert.equal(badRoot.status, 2, badRoot.stderr);
  const own = path.join(v, 'persona', 'proposals', '2026-09-23-fine.md');
  fs.writeFileSync(own, '---\nslug: fine\n---\n\n# Fine\n');
  const ok = runScript('proposal-html.js', [own], { v, headless: true });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'proposals', '2026-09-23-fine.html')));
});

test('tick.js and reflect.js: a headless --root outside the vault exits 2; the vault as --root still works', () => {
  const v = vault();
  const other = elsewhere();
  const tick = runScript('tick.js', ['queue', 'correction', '--source', 'x', '--root', other], { v, headless: true });
  assert.equal(tick.status, 2, tick.stderr);
  assert.ok(!fs.existsSync(path.join(other, 'persona')), 'no queue written outside the vault');
  const reflect = runScript('reflect.js', ['status', '--root', other], { v, headless: true });
  assert.equal(reflect.status, 2, reflect.stderr);
  const tickOk = runScript('tick.js', ['queue', 'correction', '--source', 'x', '--root', v], { v, headless: true });
  assert.equal(tickOk.status, 0, tickOk.stderr);
  assert.ok(fs.existsSync(path.join(v, 'persona', 'queue.jsonl')));
  assert.equal(runScript('reflect.js', ['status', '--root', other], { v, headless: false }).status, 0, 'interactive --root still works');
});
