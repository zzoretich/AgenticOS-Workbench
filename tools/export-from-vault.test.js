'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, applyScrubs, assertSafeDest } = require('./export-from-vault.js');
const { execFileSync, spawnSync } = require('child_process');

const NAME = 'Za' + 'ch';

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
  return v;
}

test('plan copies only allowlisted files and skips excluded ones', () => {
  const source = fixtureVault();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dest-'));
  const r = plan({ source, dest, force: false });
  const files = r.copy.map(c => c.file).sort();
  assert.deepEqual(files, [
    'brain/scripts/lib/feedback-drafts.js',
    'obsidian-plugin/manifest.json',
    'obsidian-plugin/src/a.ts',
  ]);
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
  const TERM = 'Anti' + 'gravity'; // in tools/privacy-terms.json; no SCRUBS entry in tools/export-scrubs.js touches it
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
