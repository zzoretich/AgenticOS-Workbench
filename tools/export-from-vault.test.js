'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, applyScrubs, assertSafeDest } = require('./export-from-vault.js');

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
