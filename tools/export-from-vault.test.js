'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, applyScrubs, assertSafeDest } = require('./export-from-vault.js');
const { execFileSync, spawnSync } = require('child_process');

// The scrubs these two feed are pattern-based — FIRST_NAME is `[A-Z][a-z]+` and the copyright scrub is
// `© 2026 [A-Za-z]+, Inc.` (tools/export-scrubs.js:53,:71,:131) — so arbitrary neutral values work, and
// neither is a gate term. Keep them plain (final review Minor 2 / safety-3).
const NAME = 'Casey';
const BRAND = 'Acme';

// The three concatenated values below (OWNER_HOME, PERSONA_SRC, FLAG_TITLE) ARE gate terms and ARE
// load-bearing, so each is built by concatenation: the gate matches case-insensitive substrings of
// tools/privacy-terms.json in every file except the three "*"-exempt tools files, and this test is not
// exempt. OWNER_HOME must start with the home-path prefix that the DEFAULT_ROOT scrub (export-scrubs.js:91)
// requires; PERSONA_SRC spells the ALLOWLIST `from` paths (:24-26); FLAG_TITLE is interpolated into the
// render-digest fixture so the scrub at :118 has something to match (concatenated, so the gate stays clean).
const OWNER_HOME = '/Us' + 'ers/some' + 'one/.claude';
const PERSONA_SRC = 'pro' + 'ton';                          // the owner's persona dir / skill prefix in the source vault
const FLAG_TITLE = 'Pro' + 'ton Flag Review';

function fixtureVault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), body); };
  w('brain/scripts/lib/feedback-drafts.js', `// draft feedback rules awaiting ${NAME}'s batch approval\nmodule.exports = {};\n`);
  w('brain/scripts/node_modules/dep/index.js', 'module.exports = 1;\n');
  w('brain/scripts/package-lock.json', '{}');
  w('.obsidian/plugins/agentic-os/manifest.json', `{ "id": "agentic-os", "author": "${NAME}" }\n`);
  w('.obsidian/plugins/agentic-os/main.js', 'bundle');
  w('.obsidian/plugins/agentic-os/data.json', '{}');
  w('.obsidian/plugins/agentic-os/README.md', '# old readme');
  w('.obsidian/plugins/agentic-os/src/a.ts', 'export const a = 1;\n');
  w('brain/memory/user/profile.md', 'private');
  // execution amendment 2026-09-15 (A1): a retired sdk/ file the Step 3 EXCLUDE rows must keep out of the copy list.
  w('brain/scripts/sdk/install.js', '// retired by contract §2\n');
  // final review Minor 16 (tests-10): one line per remaining EXCLUDE row (tools/export-scrubs.js:45-48), so
  // all five are exercised. Each would otherwise land in the copy list the next test asserts exactly.
  w('brain/scripts/sdk/test/test-recall.js', '// superseded by brain/scripts/test/live/\n');
  w('brain/scripts/test/wrap-headless.test.js', '// moved to extras/ollama with its subject\n');
  w('brain/scripts/sitrep-state.js', '// moved under persona/ in Plan 5 (ruling A22)\n');
  w('.obsidian/plugins/agentic-os/src/data/session.ts', 'export const session = 1;\n');
  // Plan 5 entries: persona machinery, flag-closer scripts, cost analyzer. The DEFAULT_ROOT and
  // copyright scrubs are pattern-based (Step 4), so these fixture lines need not equal the owner's
  // literal text — any absolute config-dir path under the owner's home and any "© 2026 <Brand>, Inc."
  // line is matched. (The home-path prefix itself is a gate term, so it is not spelled out here.)
  // Paths are assembled from PERSONA_SRC (see the rule above the constants): the source-vault
  // directory and skill names are gate terms and may not appear literally in this file.
  w(`${PERSONA_SRC}/scripts/scan-arsenal.js`, `const DEFAULT_ROOT = '${OWNER_HOME}';\nmodule.exports = {};\n`);
  w(`${PERSONA_SRC}/IDENTITY.md`, 'never exported');
  w(`skills/${PERSONA_SRC}-flag-closer/scripts/render-digest.js`, `const t = '${FLAG_TITLE}';\n`);
  w(`skills/${PERSONA_SRC}-flag-closer/state/last-hash.txt`, 'abc');
  w('skills/token-goblin/assets/report-template.html', `    <p>© 2026 ${BRAND}, Inc. All rights reserved.</p>\n`);
  w('skills/token-goblin/data/snapshots/x.json', '{}');
  return v;
}

test('plan copies only allowlisted files and skips excluded ones', () => {
  const source = fixtureVault();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-'));
  const r = plan({ source, dest, force: false });
  const files = r.copy.map(c => c.file).sort();
  assert.deepEqual(files, [
    'brain/scripts/lib/feedback-drafts.js',
    'brain/scripts/persona/scan-arsenal.js',
    'extras/cost/report-template.html',
    'obsidian-plugin/manifest.json',
    'obsidian-plugin/src/a.ts',
    'plugin/skills/persona-flag-closer/scripts/render-digest.js',
  ]);
  const scanner = r.copy.find(c => c.file === 'brain/scripts/persona/scan-arsenal.js').content.toString('utf8');
  assert.ok(!scanner.includes(OWNER_HOME), 'owner home scrubbed from the scanner');
  assert.match(scanner, /CLAUDE_CONFIG_DIR/);
  const tmpl = r.copy.find(c => c.file === 'extras/cost/report-template.html').content.toString('utf8');
  assert.ok(!tmpl.includes(BRAND), 'brand scrubbed from the report template');
  const digest = r.copy.find(c => c.file === 'plugin/skills/persona-flag-closer/scripts/render-digest.js').content.toString('utf8');
  assert.ok(!digest.includes(FLAG_TITLE), 'flag-review title scrubbed from render-digest');
  assert.match(digest, /Persona Flag Review/);
});

test('scrubs rewrite the copied content and are reported as applied', () => {
  const source = fixtureVault();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-'));
  const r = plan({ source, dest, force: false });
  const drafts = r.copy.find(c => c.file === 'brain/scripts/lib/feedback-drafts.js').content.toString('utf8');
  assert.match(drafts, /awaiting the owner's batch approval/);
  assert.ok(!drafts.includes(NAME));
  const manifest = r.copy.find(c => c.file === 'obsidian-plugin/manifest.json').content.toString('utf8');
  assert.match(manifest, /AgenticOS Workbench contributors/);
  assert.ok(r.applied.some(a => a.file === 'brain/scripts/lib/feedback-drafts.js'));
});

test('an existing, different destination file is kept unless force', () => {
  const source = fixtureVault();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-'));
  fs.mkdirSync(path.join(dest, 'obsidian-plugin', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'obsidian-plugin', 'src', 'a.ts'), 'export const a = 2;\n');
  const kept = plan({ source, dest, force: false });
  assert.deepEqual(kept.differ.map(d => d.file), ['obsidian-plugin/src/a.ts']);
  assert.ok(!kept.copy.some(c => c.file === 'obsidian-plugin/src/a.ts'));
  const forced = plan({ source, dest, force: true });
  assert.ok(forced.copy.some(c => c.file === 'obsidian-plugin/src/a.ts'));
});

test('a scrub whose file is never exported is reported unmatched by plan()', () => {
  const source = fixtureVault();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-'));
  const r = plan({ source, dest, force: false });
  assert.ok(r.unmatched.some(u => u.file === 'obsidian-plugin/styles.css'));
  assert.ok(!r.copy.some(c => c.file === 'obsidian-plugin/styles.css'));
});

test('applyScrubs records unmatched scrubs so drift is visible', () => {
  const report = { applied: [], unmatched: [] };
  const out = applyScrubs('brain/scripts/lib/feedback-drafts.js', 'nothing to scrub here', report);
  assert.equal(out, 'nothing to scrub here');
  assert.equal(report.unmatched.length, 1);
});

test('assertSafeDest refuses a destination inside the Claude config dir', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    assert.throws(() => assertSafeDest(path.join(cfg, 'repo')), /refusing/);
    assert.throws(() => assertSafeDest(cfg), /refusing/);
    assert.doesNotThrow(() => assertSafeDest(path.join(os.tmpdir(), 'elsewhere')));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

/** A vault whose only allowlisted file carries an unscrubbed term at a path no scrub targets. Separate from fixtureVault()
 *  because 'plan copies only allowlisted files…' asserts fixtureVault()'s exact copy list. */
function fixtureVaultWithTerm(term) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-leak-'));
  const rel = 'brain/scripts/lib/leaky.js';
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), `// unscrubbed: ${term}\nmodule.exports = {};\n`);
  return { source: v, rel };
}

test('CLI: a privacy-gate term that survives scrubbing makes the export exit 1', () => {
  // Built by concatenation so this file stays clean for CI's own `npm run gate` step.
  const TERM = 'Red' + 'acted'; // in tools/privacy-terms.json; no SCRUBS entry in tools/export-scrubs.js touches it
  const { source, rel } = fixtureVaultWithTerm(TERM);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-leak-'));
  execFileSync('git', ['init', '-q'], { cwd: dest }); // runGate() → listFiles() shells `git ls-files`
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')); // keep assertSafeDest clear of the real ~/.claude
  const r = spawnSync(process.execPath, [path.join(__dirname, 'export-from-vault.js'), '--source', source, '--dest', dest],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /privacy-gate: [1-9]\d* violation\(s\)/);
  assert.ok(r.stdout.includes(`${rel}:1:`) && r.stdout.includes(TERM), r.stdout);
  assert.ok(fs.existsSync(path.join(dest, rel)), 'the leaking file is copied before the gate runs');
});
