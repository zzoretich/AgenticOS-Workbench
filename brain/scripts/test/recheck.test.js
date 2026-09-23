'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../persona/recheck.js');

// Mid-day UTC: "recorded today" is the LOCAL day, so NOW ± 2 h must stay on one local day in every timezone CI runs in.
const NOW = new Date('2026-09-22T12:00:00.000Z');
const DAY = 86400e3;
const at = (ms) => new Date(NOW.getTime() + ms);

const PROPOSAL = (slug, recipe, cls = 'doc-typo') => `---
slug: ${slug}
filed: 2026-09-10
target: duties/monitor.md (guarded)
recheck: "${recipe}"
autoapply_class: ${cls}
---
## What
change x
`;
function vault(proposals = { 'fix-thing': 'true' }) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-'));
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'proposals', 'README.md'), '# Proposals\n');
  for (const [slug, recipe] of Object.entries(proposals)) fs.writeFileSync(path.join(v, 'persona', 'proposals', `2026-09-10-${slug}.md`), PROPOSAL(slug, recipe));
  return v;
}
const confFile = (v) => path.join(v, 'persona', 'flag-closer', 'confirmations.json');
const conf = (v) => JSON.parse(fs.readFileSync(confFile(v), 'utf8'));

test('runRecipe maps exit codes to the review verdicts; loadConfig whitelists nothing when the file is missing or corrupt', () => {
  assert.equal(R.runRecipe('true', os.tmpdir()), 'STILL-VALID');
  assert.equal(R.runRecipe('false', os.tmpdir()), 'STALE');
  assert.equal(R.runRecipe('exit 127', os.tmpdir()), 'RECIPE-ERROR');
  const v = vault();
  assert.deepEqual(R.loadConfig(v), { classes: [] });
  fs.writeFileSync(path.join(v, 'persona', 'autoapply.json'), '{not json');
  assert.deepEqual(R.loadConfig(v), { classes: [] });
  fs.writeFileSync(path.join(v, 'persona', 'autoapply.json'), JSON.stringify({ classes: ['doc-typo', 7] }));
  assert.deepEqual(R.loadConfig(v), { classes: ['doc-typo'] });
});

test('gateAutoApply: class declared, whitelisted, STILL-VALID and 2+ confirmations — each missing piece names itself', () => {
  const p = { slug: 'fix-thing', autoapply_class: 'doc-typo', verdict: 'STILL-VALID' };
  assert.match(R.gateAutoApply({ ...p, autoapply_class: null }, { classes: ['doc-typo'] }, {}).reason, /no autoapply_class/);
  assert.match(R.gateAutoApply(p, { classes: [] }, { 'fix-thing': 5 }).reason, /not whitelisted/);
  assert.match(R.gateAutoApply({ ...p, verdict: 'STALE' }, { classes: ['doc-typo'] }, { 'fix-thing': 5 }).reason, /verdict STALE/);
  assert.match(R.gateAutoApply(p, { classes: ['doc-typo'] }, { 'fix-thing': 1 }).reason, /only 1 consecutive/);
  assert.deepEqual(R.gateAutoApply(p, { classes: ['doc-typo'] }, { 'fix-thing': 2 }), { eligible: true, reason: 'class whitelisted, 2 confirmations' });
});

// Spec 2026-09-22-persona-earned-autonomy-design D2: the tick records one pass per local day; STILL-VALID counts up,
// anything else resets, a slug no longer pending is dropped, and the legacy flat file still reads.
test('record: counts once per local day, resets on STALE, drops a gone slug, reads the legacy flat file', () => {
  const v = vault({ 'fix-thing': 'true', 'other': 'false', 'broken': 'exit 127' });
  let r = R.record({ root: v, now: NOW });
  assert.deepEqual(r, { recorded: true, day: '2026-09-22', slugs: { 'fix-thing': 1, other: 0, broken: 0 } });
  assert.deepEqual(conf(v), { schema: 1, recordedDay: '2026-09-22', slugs: { 'fix-thing': 1, other: 0, broken: 0 } });
  r = R.record({ root: v, now: at(2 * 3600e3) });
  assert.equal(r.recorded, false, 'same local day: no second count');
  assert.equal(conf(v).slugs['fix-thing'], 1);
  fs.unlinkSync(path.join(v, 'persona', 'proposals', '2026-09-10-other.md'));
  r = R.record({ root: v, now: at(DAY) });
  assert.deepEqual(r.slugs, { 'fix-thing': 2, broken: 0 }, 'next day counts again; the removed proposal is dropped');
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-10-fix-thing.md'), PROPOSAL('fix-thing', 'false'));
  r = R.record({ root: v, now: at(2 * DAY) });
  assert.equal(r.slugs['fix-thing'], 0, 'a STALE verdict resets the streak');
  // Legacy flat shape from the plugin-era recheck.js reads as the slugs map with no recorded day.
  fs.writeFileSync(confFile(v), JSON.stringify({ 'fix-thing': 4 }));
  assert.deepEqual(R.readConfirmations(v), { schema: 1, recordedDay: null, slugs: { 'fix-thing': 4 } });
  fs.writeFileSync(confFile(v), 'garbage');
  const errs = []; const orig = console.error; console.error = (m) => errs.push(m);
  try { assert.deepEqual(R.readConfirmations(v).slugs, {}); } finally { console.error = orig; }
  assert.equal(errs.length, 1);
});

test('record tolerates a missing proposals dir and a proposal without a recipe', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-empty-'));
  assert.deepEqual(R.record({ root: v, now: NOW }), { recorded: true, day: '2026-09-22', slugs: {} });
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-11-no-recipe.md'), '---\nslug: no-recipe\n---\n## What\nx\n');
  assert.deepEqual(R.pendingProposals(v).map(p => [p.slug, p.recheck]), [['no-recipe', null]]);
  assert.deepEqual(R.record({ root: v, now: at(DAY) }).slugs, { 'no-recipe': 0 });
});

test('recheck (the review verb) counts this run in memory, gates on it, and writes only with record and once a day', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'persona', 'autoapply.json'), JSON.stringify({ classes: ['doc-typo'] }));
  fs.mkdirSync(path.dirname(confFile(v)), { recursive: true });
  fs.writeFileSync(confFile(v), JSON.stringify({ schema: 1, recordedDay: '2026-09-21', slugs: { 'fix-thing': 1 } }));
  const review = () => ({ proposals: [{ slug: 'fix-thing', recheck: 'true', autoapply_class: 'doc-typo' }, { slug: 'legacy', recheck: null, autoapply_class: null }] });
  let out = R.recheck(review(), v, { now: NOW });
  assert.equal(out.proposals[0].verdict, 'STILL-VALID');
  assert.equal(out.proposals[0].confirmations, 2, 'the run itself counts');
  assert.equal(out.proposals[0].autoApply.eligible, true);
  assert.equal(out.proposals[1].verdict, 'NO-RECIPE');
  assert.equal(out.proposals[1].confirmations, 0);
  assert.deepEqual(out.autoApplyWhitelist, ['doc-typo']);
  assert.equal(conf(v).slugs['fix-thing'], 1, 'an interactive review never writes');
  out = R.recheck(review(), v, { now: NOW, record: true });
  assert.deepEqual(conf(v), { schema: 1, recordedDay: '2026-09-22', slugs: { 'fix-thing': 2, legacy: 0 } });
  R.recheck(review(), v, { now: NOW, record: true });
  assert.equal(conf(v).slugs['fix-thing'], 2, 'record on the same day is a no-op');
});

test('CLI: record prints the pass, a review file is rechecked, usage exits 2, a bad file exits 0 with a message', () => {
  const v = vault();
  const io = () => { const o = { out: '', err: '' }; return { io: o, opts: { stdout: (s) => { o.out += s; }, stderr: (s) => { o.err += s; }, now: NOW } }; };
  let { io: o, opts } = io();
  assert.equal(R.main(['record', '--root', v], opts), 0);
  assert.deepEqual(JSON.parse(o.out), { recorded: true, day: '2026-09-22', slugs: { 'fix-thing': 1 } });
  const collect = path.join(v, 'collect.json');
  fs.writeFileSync(collect, JSON.stringify({ proposals: [{ slug: 'fix-thing', recheck: 'true', autoapply_class: 'doc-typo' }] }));
  ({ io: o, opts } = io());
  assert.equal(R.main([collect, '--root', v], opts), 0);
  assert.equal(JSON.parse(o.out).proposals[0].verdict, 'STILL-VALID');
  ({ io: o, opts } = io());
  assert.equal(R.main(['--root', v], opts), 2);
  assert.match(o.err, /usage/);
  ({ io: o, opts } = io());
  assert.equal(R.main([path.join(v, 'missing.json'), '--root', v], opts), 0);
  assert.match(o.err, /recheck: /);
});

test('CLI: without --root the review file is still the first argument (the flag-closer calls it that way)', () => {
  const v = vault();
  const collect = path.join(v, 'collect.json');
  fs.writeFileSync(collect, JSON.stringify({ proposals: [{ slug: 'fix-thing', recheck: 'true' }] }));
  const o = { out: '', err: '' };
  assert.equal(R.main([collect], { stdout: (s) => { o.out += s; }, stderr: (s) => { o.err += s; }, now: NOW }), 0);
  assert.equal(o.err, '');
  assert.equal(JSON.parse(o.out).proposals[0].verdict, 'STILL-VALID');
});

test('a recipe outside the read-only grammar is RECIPE-ERROR with its reason, and neither the review nor record runs it', () => {
  const v = vault({ 'bad-one': 'mkdir ran-it' });
  const review = R.recheck({ proposals: [{ slug: 'bad-one', recheck: 'mkdir ran-it', autoapply_class: 'doc-typo' }] }, v, { now: NOW });
  assert.equal(review.proposals[0].verdict, 'RECIPE-ERROR');
  assert.equal(review.proposals[0].refused, "'mkdir' is not an allowed read-only command");
  assert.equal(R.record({ root: v, now: NOW }).slugs['bad-one'], 0);
  assert.equal(fs.existsSync(path.join(v, 'ran-it')), false);
});
