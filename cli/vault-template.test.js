'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const T = path.resolve(__dirname, '..', 'vault-template');
const read = (rel) => fs.readFileSync(path.join(T, rel), 'utf8');
const h2s = (text) => text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

test('MEMORY.md has the five fixed H2s, each followed by a blank line', () => {
  const m = read('MEMORY.md');
  assert.match(m, /^# Memory Index\n/);
  assert.deepEqual(h2s(m), ['User', 'Feedback (how to work)', 'Project', 'Reference', 'Patterns']);
  for (const h of h2s(m)) assert.ok(m.includes(`## ${h}\n\n`), `blank line after ${h}`);
  assert.ok(!/^- \[/m.test(m), 'no entries shipped');
});

test('SESSION.md is byte-identical to wrap-session.js resetSessionWM() apart from the date', () => {
  const s = read('brain/_index/SESSION.md');
  const expected = `---
type: session
updated: 2026-09-04
---

# Current Session Working Memory

> Ephemeral — cleared/promoted at session end. Max ~400 tokens.
> Use this to track context within the current conversation.

## Active Task

## Key Context This Session

## Decisions Made

## Things to Remember

## Promote to Memory on Close
`;
  assert.equal(s.replace(/^updated: .*$/m, 'updated: 2026-09-04'), expected);
});

test('BRAIN.md placeholder and the three MOCs', () => {
  assert.equal(read('brain/_index/BRAIN.md'), '# BRAIN\n\n_compiled on first scan_\n');
  for (const [file, title] of [['MOC-reference.md', 'Reference'], ['MOC-projects.md', 'Projects'], ['MOC-patterns.md', 'Patterns']]) {
    assert.equal(read(`brain/_index/${file}`), `# ${title}\n\n## Manual index\n`);
  }
});

test('scanner-config.json and brain/config.json', () => {
  assert.deepEqual(JSON.parse(read('brain/_index/scanner-config.json')), {
    extraProjectRoots: [], autoSweepOrphans: false, orphanUuidMinAgeMinutes: 60, sweepTransientResidue: false,
    transientResiduePatterns: [], allowedOrphanHooks: [], fileMapBudgetPerScan: 40,
  });
  assert.deepEqual(JSON.parse(read('brain/config.json')), {});
});

test('profile example, READMEs, daily-note template', () => {
  const body = read('brain/memory/user/profile.md').replace(/^---\n[\s\S]*?\n---\n/, '');
  const firstPara = body.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b && !b.startsWith('#'));
  assert.ok(firstPara && firstPara.length > 40 && firstPara.length < 400, 'first paragraph becomes BRAIN.md ## Who');
  for (const d of ['feedback', 'projects', 'reference']) assert.match(read(`brain/memory/${d}/README.md`), /^# /);
  assert.match(read('brain/patterns/README.md'), /^# /);
  const dn = read('templates/daily-note.md');
  assert.ok(dn.includes('{{date}}'));
  assert.ok(dn.includes('## Claude Code Sessions'));
  assert.ok(!dn.includes('<%'), 'core-plugin syntax only');
  // The three export-allowlisted templates (spec §8.1): core syntax, an H1 from {{title}}, no Templater/Dataview.
  for (const [file, h2] of [['meeting-note.md', '## Action items'], ['decision-record.md', '## Decision'], ['project-note.md', '## Next steps']]) {
    const t = read(`templates/${file}`);
    assert.ok(t.includes('# {{title}}'), `${file}: {{title}} H1`);
    assert.ok(t.includes('{{date}}'), `${file}: {{date}}`);
    assert.ok(t.includes(h2), `${file}: ${h2}`);
    assert.ok(!/<%|dataview/i.test(t), `${file}: core-plugin syntax only`);
  }
});

test('AGENTICOS.md sections and .obsidian seeds', () => {
  assert.deepEqual(h2s(read('AGENTICOS.md')), ['Memory System (3-file rule)', 'Capture vocabulary', 'Conventions', 'Providers', 'Routines']);
  assert.deepEqual(JSON.parse(read('.obsidian/app.json')), {});
  assert.deepEqual(JSON.parse(read('.obsidian/appearance.json')), { theme: 'obsidian' });
  assert.deepEqual(JSON.parse(read('.obsidian/community-plugins.json')), ['agentic-os']);
  const core = JSON.parse(read('.obsidian/core-plugins.json'));
  assert.equal(core['daily-notes'], true);
  assert.equal(core['file-explorer'], true);
  assert.ok(!fs.existsSync(path.join(T, '.obsidian', 'daily-notes.json')), 'installer writes it');
});

test('_gitignore carries the spec rules and is stored without the dot', () => {
  const g = read('_gitignore');
  for (const line of ['brain/_index/*', '!brain/_index/scanner-config.json', '!brain/_index/MOC-*.md', 'persona/journal/', 'persona/STATE.md', 'persona/answers.json', 'persona/autoapply.json', 'persona/DISABLED', 'persona/flag-closer/', '.obsidian/workspace.json', '.obsidian/plugins/*/data.json', '.obsidian/plugins/*/node_modules/']) {
    assert.ok(g.split('\n').includes(line), `missing rule ${line}`);
  }
  assert.ok(!fs.existsSync(path.join(T, '.gitignore')));
});

test('brain/routines seeds the three duty routines (valid, guarded, enabled) and a README', () => {
  const store = require('../brain/scripts/lib/routines-store.js');
  const all = store.list({ dir: path.join(T, 'brain', 'routines') });
  assert.deepEqual(all.map((r) => r.slug), ['monitor', 'reflect', 'sitrep']);
  for (const r of all) {
    assert.deepEqual(r.errors, [], r.slug);
    assert.equal(r.kind, 'duty', r.slug);
    assert.equal(r.guarded, true, r.slug);
    assert.equal(r.enabled, true, r.slug);
    assert.match(r.body, new RegExp(`persona/duties/${r.slug}\\.md`), `${r.slug}: body points at its duty prompt`);
  }
  // The cadences the static plists carried before routines existed — a migrated vault keeps its times.
  assert.deepEqual(all.map((r) => r.schedule), ['0 13 * * *', '0 18 * * 0', '45 7 * * 1-5']);
  assert.match(read('brain/routines/README.md'), /^# /);
});

test('persona/routines seeds the watchdog heartbeat (command) and the hourly tick (duty, 0.05 USD, read-only allowlist)', () => {
  const store = require('../brain/scripts/lib/routines-store.js');
  const all = store.list({ dir: path.join(T, 'persona', 'routines') });
  assert.deepEqual(all.map((r) => [r.slug, r.kind, r.schedule, r.enabled]), [['heartbeat', 'command', '*/30 * * * *', true], ['tick', 'duty', '0 * * * *', true]]);
  for (const r of all) assert.deepEqual(r.errors, [], r.slug);
  const tick = all.find((r) => r.slug === 'tick');
  assert.equal(tick.guarded, true);
  assert.equal(tick.budgetUsd, 0.05);
  assert.match(tick.tools, /^Read,Glob,Grep,Write,Edit,Bash\(date:\*\),Bash\(\{\{NODE\}\} \{\{VAULT\}\}\/brain\/scripts\/persona\/tick\.js:\*\)/);
  assert.ok(!/git/.test(tick.tools), 'the tick never runs git');
  assert.match(tick.body, /persona\/duties\/tick\.md/);
  assert.match(read('persona/duties/tick.md'), /tick\.js signals/);
  assert.match(read('persona/STATE.template.md'), /- tick: never/);
});
