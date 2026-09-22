'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SCRIPTS = path.join(__dirname, '..', '..', '..', 'plugin', 'skills', 'persona-flag-closer', 'scripts');
const { collect, defaultRoot, defaultLogDir, KINDS } = require(path.join(SCRIPTS, 'collect.js'));
const { recheck, runRecipe, gateAutoApply, loadConfig } = require(path.join(SCRIPTS, 'recheck.js'));   // loadConfig: execution amendment 2026-09-15 (A32)
const { render } = require(path.join(SCRIPTS, 'render-digest.js'));

const PROPOSAL = (recipe) => `---
slug: fix-thing
filed: 2026-08-10
target: duties/monitor.md (guarded)
recheck: "${recipe}"
autoapply_class: doc-typo
---
## What
change x
## Premises
| Premise | Status | Evidence |
|---|---|---|
| file exists | VERIFIED | ls |
| nobody edited it | ASSUMED | hope |
`;

function vault(recipe = 'true') {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'pfc-'));
  fs.mkdirSync(path.join(v, 'persona', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(v, 'persona', 'journal', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(v, 'persona', 'proposals', 'README.md'), '# Proposals\n');
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-08-10-fix-thing.md'), PROPOSAL(recipe));
  fs.writeFileSync(path.join(v, 'persona', 'STATE.md'), '# Persona State\n## Flags\n- [ ] open flag\n- [x] closed flag\n## Priorities\n');
  fs.writeFileSync(path.join(v, 'persona', 'journal', 'logs', 'duty-monitor-error.log'), 'boom\n');
  fs.writeFileSync(path.join(v, 'persona', 'journal', 'logs', 'launchd-monitor-error.log'), 'ignored\n');
  return v;
}

test('collect reads proposals, open flags and new duty error-log lines from the vault layout', () => {
  const v = vault();
  const out = collect(v, { updateState: true });
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0].slug, 'fix-thing');
  assert.equal(out.proposals[0].premises.length, 2);
  assert.deepEqual(out.flags.map(f => f.text), ['open flag']);
  assert.deepEqual(out.logFindings.map(l => path.basename(l.log)), ['duty-monitor-error.log']);
  assert.equal(out.changedSinceLastRun, true);
  assert.ok(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'log-offsets.json')));
  assert.ok(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'last-hash.txt')));
  const again = collect(v, { updateState: false });
  assert.equal(again.logFindings.length, 0, 'offsets consumed');
  assert.equal(again.changedSinceLastRun, false);
});

test('defaultRoot honors AOS_VAULT, then agenticos.json; defaultLogDir follows PERSONA_LOG_DIR', () => {
  const saved = { AOS_VAULT: process.env.AOS_VAULT, AOS_CONFIG: process.env.AOS_CONFIG, PERSONA_LOG_DIR: process.env.PERSONA_LOG_DIR };
  try {
    process.env.AOS_VAULT = '/v1';
    assert.equal(defaultRoot(), '/v1');
    delete process.env.AOS_VAULT;
    const cfg = path.join(os.tmpdir(), `pfc-cfg-${process.pid}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ vault: '/v2' }));
    process.env.AOS_CONFIG = cfg;
    assert.equal(defaultRoot(), '/v2');
    delete process.env.PERSONA_LOG_DIR;
    assert.equal(defaultLogDir('/v2'), path.join('/v2', 'persona', 'journal', 'logs'));
    process.env.PERSONA_LOG_DIR = '/logs';
    assert.equal(defaultLogDir('/v2'), '/logs');
  } finally {
    for (const [k, val] of Object.entries(saved)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  }
});

test('recheck verdicts and the dormant auto-apply gate', () => {
  assert.equal(runRecipe('true', os.tmpdir()), 'STILL-VALID');
  assert.equal(runRecipe('false', os.tmpdir()), 'STALE');
  assert.equal(runRecipe('exit 127', os.tmpdir()), 'RECIPE-ERROR');
  const v = vault('true');
  const review = recheck(collect(v), v, { record: true });
  assert.equal(review.proposals[0].verdict, 'STILL-VALID');
  assert.equal(review.proposals[0].autoApply.eligible, false, 'autoapply.json is missing → nothing is whitelisted');
  assert.deepEqual(review.autoApplyWhitelist, []);
  fs.writeFileSync(path.join(v, 'persona', 'autoapply.json'), JSON.stringify({ classes: ['doc-typo'] }));
  // execution amendment 2026-09-15 (A32): the one Produces claim this task does not implement itself — Task 1's scrub repointed
  // loadConfig at <vault>/persona/autoapply.json — is asserted here so a mis-scrubbed path cannot ship green.
  assert.deepEqual(loadConfig(v).classes, ['doc-typo'], 'whitelist read from <vault>/persona/autoapply.json');
  const gated = gateAutoApply({ slug: 'fix-thing', autoapply_class: 'doc-typo', verdict: 'STILL-VALID' }, { classes: ['doc-typo'] }, { 'fix-thing': 2 });
  assert.equal(gated.eligible, true);
  assert.ok(fs.existsSync(path.join(v, 'persona', 'flag-closer', 'confirmations.json')));
});

test('render escapes and titles the digest neutrally', () => {
  const v = vault();
  const html = render(recheck(collect(v), v));
  assert.match(html, /<title>Persona Flag Review<\/title>/);
  assert.match(html, /open flag/);
  assert.ok(!html.includes('{{'));
});

test('proposal kind: defaults to self, is read from frontmatter, an unknown value lints; the digest shows a Kind column', () => {
  const v = vault();
  const withKind = (slug, kind) => PROPOSAL('true').replace('slug: fix-thing', `slug: ${slug}`).replace('target:', `kind: ${kind}\ntarget:`);
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-20-idea-two.md'), withKind('idea-two', 'product'));
  fs.writeFileSync(path.join(v, 'persona', 'proposals', '2026-09-21-odd-three.md'), withKind('odd-three', 'meta'));
  const out = collect(v);
  assert.deepEqual(out.proposals.map(p => [p.slug, p.kind]), [['fix-thing', 'self'], ['idea-two', 'product'], ['odd-three', 'meta']]);
  assert.deepEqual(out.proposals[0].lint, []);
  assert.deepEqual(out.proposals[2].lint, ['unknown kind "meta" (self | vault | workflow | product)']);
  assert.deepEqual(KINDS, ['self', 'vault', 'workflow', 'product']);
  const html = render(recheck(out, v));
  assert.match(html, /<th>Kind<\/th>/);
  assert.match(html, /<td>product<\/td>/);
});
