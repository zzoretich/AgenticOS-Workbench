'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFlags, listProposals, detectPlanning, diffAlert } = require('../sitrep-state.js');

let tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('parseFlags extracts only open checkboxes, sorted', () => {
  const md = '# Persona State\n## Flags\n- [ ] zeta flag\n- [x] done flag\n- [ ] alpha flag\nprose line\n';
  assert.deepEqual(parseFlags(md), ['alpha flag', 'zeta flag']);
});

test('listProposals skips README and non-md, sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-props-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  fs.writeFileSync(path.join(dir, '2026-08-11-b.md'), 'x');
  fs.writeFileSync(path.join(dir, '2026-08-10-a.md'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.deepEqual(listProposals(dir), ['2026-08-10-a.md', '2026-08-11-b.md']);
});

test('detectPlanning flags only repos idle beyond threshold', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-plan-'));
  tmpDirs.push(repoDir);
  fs.mkdirSync(path.join(repoDir, '.planning'));
  fs.writeFileSync(path.join(repoDir, '.planning', 'STATE.md'), 'Current phase: 3 of 7 — auth\n');
  const now = Date.now();
  const fresh = detectPlanning([{ name: 'r1', path: repoDir }], 4, now);
  assert.equal(fresh.stalled.length, 0);
  assert.equal(fresh.planning.length, 1);
  assert.match(fresh.planning[0].phase, /phase: 3 of 7/i);
  const stale = detectPlanning([{ name: 'r1', path: repoDir }], 4, now + 5 * 86400000);
  assert.equal(stale.stalled.length, 1);
  assert.match(stale.stalled[0], /^r1: /);
});

test('detectPlanning does not throw on unreadable STATE.md', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-plan-'));
  tmpDirs.push(repoDir);
  fs.mkdirSync(path.join(repoDir, '.planning'));
  const stateFile = path.join(repoDir, '.planning', 'STATE.md');
  fs.writeFileSync(stateFile, 'Current phase: locked\n');
  fs.chmodSync(stateFile, 0o000);
  let threw = false;
  try {
    const result = detectPlanning([{ name: 'locked', path: repoDir }], 4, Date.now());
    assert.equal(typeof result.planning, 'object');
    assert.equal(typeof result.stalled, 'object');
  } catch (e) {
    threw = true;
  }
  fs.chmodSync(stateFile, 0o644);
  assert.equal(threw, false);
});

test('diffAlert reports adds/removes per key; identical state is unchanged', () => {
  const prev = { stalled: ['a'], flags: ['f1'], proposals: [] };
  const cur = { stalled: ['a', 'b'], flags: [], proposals: ['p.md'] };
  const out = diffAlert(prev, cur);
  assert.equal(out.changed, true);
  assert.deepEqual(out.changes.stalled_added, ['b']);
  assert.deepEqual(out.changes.flags_removed, ['f1']);
  assert.deepEqual(out.changes.proposals_added, ['p.md']);
  assert.equal(diffAlert(cur, cur).changed, false);
});
