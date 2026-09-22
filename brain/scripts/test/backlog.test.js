'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../persona/backlog.js');

const NOW = new Date('2026-09-23T09:00:00.000Z');
const PROPOSAL = (slug, kind, extra = '') => `---
slug: ${slug}
filed: 2026-09-22
target: the morning routine
recheck: "true"
kind: ${kind}
${extra}---
## What
Move the standup to **after** the sitrep.

- step one
- step two

## Why
The journal shows the standup repeating the sitrep three days running.

## Risk
None.

## Premises
| Premise | Status | Evidence |
|---|---|---|
| sitrep runs first | VERIFIED | routines.json |
`;

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'));
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  const put = (name, text) => { const f = path.join(v, 'persona', 'proposals', name); fs.writeFileSync(f, text); return f; };
  return { v, put, file: path.join(v, 'persona', 'backlog.md') };
}

test('append creates the backlog with its header, keeps the What and Why verbatim (headings demoted), names the surface', () => {
  const { v, put, file } = vault();
  const wf = put('2026-09-22-standup-order.md', PROPOSAL('standup-order', 'workflow'));
  const r = B.append({ proposal: wf, file, by: 'user', now: NOW });
  assert.deepEqual(r, { file, slug: 'standup-order', kind: 'workflow', surface: null, filed: '2026-09-22' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(B.HEADER));
  assert.match(text, /\n## 2026-09-22 · workflow · standup-order\n- target: the morning routine\n- accepted: 2026-09-23 by user\n\n### What\n\nMove the standup to \*\*after\*\* the sitrep\.\n\n- step one\n- step two\n\n### Why\n\nThe journal shows the standup repeating the sitrep three days running\.\n$/);
  assert.ok(!text.includes('## Risk') && !text.includes('Premises'), 'only What and Why travel');
  assert.ok(!text.includes('- surface:'), 'a workflow entry names no surface');

  const pr = put('2026-09-22-hud-queue-pane.md', PROPOSAL('hud-queue-pane', 'product', 'surface: hud\n'));
  const r2 = B.append({ proposal: pr, file, now: NOW });
  assert.equal(r2.surface, 'hud');
  const text2 = fs.readFileSync(file, 'utf8');
  assert.match(text2, /\n## 2026-09-22 · product · hud-queue-pane\n- target: the morning routine\n- surface: hud\n- accepted: 2026-09-23\n/);
  assert.equal((text2.match(/^# Persona backlog$/mg) || []).length, 1, 'the header is written once');
  assert.ok(text2.indexOf('standup-order') < text2.indexOf('hud-queue-pane'), 'newest last');
  assert.equal(B.section(fs.readFileSync(wf, 'utf8'), 'Nope'), null);
  assert.ok(fs.existsSync(path.join(v, 'persona', 'proposals')));
});

test('append refuses a self or vault proposal, an unknown surface, and a duplicate slug; nothing is written', () => {
  const { put, file } = vault();
  assert.throws(() => B.append({ proposal: put('2026-09-22-fix-thing.md', PROPOSAL('fix-thing', 'self')), file, now: NOW }), /kind 'self' — only workflow and product/);
  assert.throws(() => B.append({ proposal: put('2026-09-22-tidy.md', PROPOSAL('tidy', 'vault')), file, now: NOW }), /kind 'vault'/);
  assert.throws(() => B.append({ proposal: put('2026-09-22-odd.md', PROPOSAL('odd', 'product', 'surface: kitchen\n')), file, now: NOW }), /unknown surface 'kitchen'/);
  assert.ok(!fs.existsSync(file), 'a refused proposal never creates the file');
  const wf = put('2026-09-22-idea.md', PROPOSAL('idea', 'workflow'));
  B.append({ proposal: wf, file, now: NOW });
  assert.throws(() => B.append({ proposal: wf, file, now: NOW }), /'idea' is already in/);
  assert.equal((fs.readFileSync(file, 'utf8').match(/· idea$/mg) || []).length, 1);
  // a product proposal without a surface is accepted (collect.js lints it) and says so
  const noSurface = put('2026-09-22-bare.md', PROPOSAL('bare', 'product'));
  assert.equal(B.append({ proposal: noSurface, file, now: NOW }).surface, null);
  assert.match(fs.readFileSync(file, 'utf8'), /· product · bare\n- target: the morning routine\n- surface: \(unspecified\)\n/);
  // a proposal without a What or Why still lands, with a note in place of the section
  const thin = put('2026-09-22-thin.md', '---\nslug: thin\nkind: workflow\n---\nJust a thought.\n');
  B.append({ proposal: thin, file, now: NOW });
  assert.match(fs.readFileSync(file, 'utf8'), /## 2026-09-22 · workflow · thin\n- target: \(unspecified\)\n[\s\S]*\(the proposal had no What section\)[\s\S]*\(the proposal had no Why section\)/);
});

test('CLI: append prints one JSON line, refusals and usage exit 2', () => {
  const { v, put, file } = vault();
  const wf = put('2026-09-22-cli-idea.md', PROPOSAL('cli-idea', 'product', 'surface: cli\n'));
  let out = '', err = '';
  const io = { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: NOW };
  assert.equal(B.main(['append', wf, '--by', 'user', '--root', v], io), 0);
  assert.deepEqual(JSON.parse(out), { file, slug: 'cli-idea', kind: 'product', surface: 'cli', filed: '2026-09-22' });
  assert.equal(B.main(['append', wf, '--root', v], io), 2);
  assert.match(err, /already in/);
  assert.equal(B.main(['append', '--root', v], io), 2);
  assert.match(err, /usage: backlog\.js append/);
  assert.equal(B.main(['list', '--root', v], io), 2);
  assert.equal(B.defaultFile(v), file);
});
