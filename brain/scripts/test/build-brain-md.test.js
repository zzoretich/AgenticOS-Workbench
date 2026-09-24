'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bbmd-'));
for (const d of [
  'brain/_index',
  'brain/memory/user',
  'brain/memory/feedback',
  'brain/memory/reference',
  'brain/memory/projects',
  'brain/patterns',
]) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}

fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');

// MEMORY.md carries the store the compiler reads from. Beyond the brief's
// "2 indexed memories" (the pinned feedback one + the active project one),
// a plain (unpinned) reference-folder memory is also seeded — without it,
// MOC-reference's regenerated "## Manual index" would have zero bullets and
// test 3's `- \[\[` assertion would fail regardless of implementation
// correctness. Disclosed in the report.
const PRISTINE_MEMORY_MD = `# Memory Index

## User
- [Profile](brain/memory/user/profile.md) — role, expertise, goals

## Feedback (how to work)
- [Pinned rule](brain/memory/feedback/pinned-rule.md) — a rule worth always keeping visible

## Reference
- [Some reference](brain/memory/reference/some-reference.md) — a durable reference note

## Projects
- [Active project](brain/memory/projects/active-project.md) — a project currently in flight
`;

const PRISTINE_PINNED_RULE = '---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\npin: true\n---\n\n# Pinned rule\n\nbody\n';

fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'user', 'profile.md'),
  '---\ntype: memory\ntags: [memory/user, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Profile\n\n' +
  'First paragraph about the fixture user, kept short on purpose.\n\n' +
  'Second paragraph that must never appear in compiled output.\n');

fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'reference', 'some-reference.md'),
  '---\ntype: reference\ntags: [memory/reference, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Some reference\n\nbody\n');

fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'projects', 'active-project.md'),
  '---\ntype: memory\ntags: [memory/projects, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Active project\n\nbody\n');

// Not exercised by the brief's 3 given tests directly, but buildBrainMd
// regenerates all 3 MOCs on every call (including MOC-patterns), so a
// patterns fixture keeps that path real rather than silently no-op-ing on a
// missing directory.
fs.writeFileSync(path.join(TMP, 'brain', 'patterns', 'sample-pattern.md'),
  '---\ntype: pattern\ntags: [pattern/sample]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Sample Pattern\n\n> a fixture pattern.\n');

fs.writeFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'),
  '---\ntype: index\ntags: [brain/bootstrap, status/active]\nupdated: 2026-01-01\n---\n\n# BRAIN\n\n' +
  '> Auto-injected on the first turn of every session. Keep ≤850 tokens — pointers, not content.\n\n' +
  '## Who\n**Fixture User** — a placeholder. Full profile: [[profile]].\n\n' +
  '## Critical rules\n- placeholder rule\n\n' +
  '## Active context\n- placeholder context\n\n' +
  '## Quick links\n- Memory index: `MEMORY.md` (root)\n\n' +
  '## Last Session\n- existing last-session line preserved\n');

// All 3 MOCs seeded WITH a "## Manual index" section (matching the brief's
// fixture spec), even though the real MOC-projects.md currently has none —
// see the report's MOC-projects disclosure for how the compiler handles both.
for (const [file, dvFrom, tag] of [
  ['MOC-reference.md', 'brain/memory/reference', 'reference'],
  ['MOC-projects.md', 'brain/memory/projects', 'projects'],
  ['MOC-patterns.md', 'brain/patterns', 'patterns'],
]) {
  fs.writeFileSync(path.join(TMP, 'brain', '_index', file),
    `---\ntype: moc\ntags: [moc, moc/${tag}]\nupdated: 2026-01-01\n---\n\n# MOC — ${tag}\n\n` +
    '```dataview\n' + `TABLE WITHOUT ID file.link\nFROM "${dvFrom}"\n` + '```\n\n' +
    '## Manual index\n- [[placeholder]] — stale entry that must be replaced\n');
}

process.env.BRAIN_VAULT = TMP;
const { buildBrainMd, BUDGET } = require('../build-brain-md.js');

// Test 2 (over-budget) permanently adds 40 pinned feedback memories + MEMORY.md
// lines to this shared fixture. Reset the two mutable pieces before every test
// so test order never leaks state — same shape as auto-wrap.test.js's beforeEach.
beforeEach(() => {
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), PRISTINE_MEMORY_MD);
  for (const f of fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback'))) {
    fs.unlinkSync(path.join(TMP, 'brain', 'memory', 'feedback', f));
  }
  fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'feedback', 'pinned-rule.md'), PRISTINE_PINNED_RULE);
});

test('compiles BRAIN.md with contract frontmatter and all sections', async () => {
  const out = await buildBrainMd({ report: { wrote: [], counts: {} } });
  const raw = fs.readFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'), 'utf8');
  assert.match(raw, /generatedBy: build-brain-md\.js/);
  assert.match(raw, /generatedAt: \d{4}-/);
  assert.match(raw, /ttl: 24h/);
  assert.match(raw, /## Who/); assert.match(raw, /## Critical rules/);
  assert.match(raw, /## Active context/); assert.match(raw, /## Quick links/);
  assert.match(raw, /## Last Session/);
  assert.match(raw, /existing last-session line preserved/); // seeded in the fixture
  assert.ok(out.tokens <= 850);
  assert.equal(BUDGET, 850);
  // The template's own "Keep ≤N tokens" line must track the constant, not a literal.
  assert.match(raw, /Keep ≤850 tokens/);
  // Supplementary (not in the brief): first-paragraph-only extraction actually holds.
  assert.ok(!raw.includes('Second paragraph that must never appear'));
});

// Seeds enough pinned rules to overflow the compiler-owned sections even after
// each bullet description is clamped to BULLET_DESC_CHARS.
function seedOverflowingPinnedRules(count = 40) {
  let idx = fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8');
  for (let i = 0; i < count; i++) {
    const slug = `pinned-rule-${i}`;
    fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'feedback', `${slug}.md`),
      `---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-08-05\nupdated: 2026-08-05\npin: true\n---\n\n# Pinned rule ${i}\n\nbody\n`);
    idx += `- [Pinned rule ${i}](brain/memory/feedback/${slug}.md) — ${'a very long description that pads the compiled output well past any reasonable budget '.repeat(2)}\n`;
  }
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), idx);
}

test('over-budget compilation THROWS and leaves the previous BRAIN.md intact', async () => {
  seedOverflowingPinnedRules();
  const before = fs.readFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'), 'utf8');
  await assert.rejects(
    () => buildBrainMd({ report: { wrote: [], counts: {} } }),
    /compiler sections leave -?\d+ chars for "## Last Session"/);
  assert.equal(fs.readFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'), 'utf8'), before);
});

// Regression: the budget gate used to sit in front of BOTH writes, so too many
// pinned rules stranded the 3 MOCs along with BRAIN.md — and the Fix Queue's
// "rebuild the compiled brain artifacts" action could then never clear itself.
// The MOCs do not share BRAIN.md's token budget, so they must survive the throw.
test('a compiler-section overflow still refreshes the 3 MOCs', async () => {
  const mocPath = (n) => path.join(TMP, 'brain', '_index', n);
  // Strip the contract stamp an earlier passing test may have left behind, so
  // its reappearance proves THIS run wrote the file.
  for (const n of ['MOC-reference.md', 'MOC-projects.md', 'MOC-patterns.md']) {
    fs.writeFileSync(mocPath(n), fs.readFileSync(mocPath(n), 'utf8')
      .replace(/^generatedBy: .*\n/m, '').replace(/^generatedAt: .*\n/m, ''));
  }
  seedOverflowingPinnedRules();
  const report = { wrote: [], counts: {} };

  await assert.rejects(() => buildBrainMd({ report }), /compiler sections leave/);

  for (const n of ['MOC-reference.md', 'MOC-projects.md', 'MOC-patterns.md']) {
    assert.match(fs.readFileSync(mocPath(n), 'utf8'), /generatedBy: build-brain-md\.js/,
      `${n} should have been rewritten despite the BRAIN.md overflow`);
  }
  // The failed run must still report exactly what it managed to write.
  assert.equal(report.counts.mocsRegenerated, 3);
  assert.equal(report.wrote.length, 3);
  assert.ok(!report.wrote.includes('brain/_index/BRAIN.md'),
    'BRAIN.md must not be reported as written when it overflowed');
});

// Long MEMORY.md descriptions are the compiler's unbounded growth path: they
// used to be able to walk the pinned-rule section into a hard throw one entry
// at a time. Clamping keeps every entry present but bounds each line.
test('long bullet descriptions are clamped, never dropped', async () => {
  const long = 'x'.repeat(400);
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'),
    PRISTINE_MEMORY_MD.replace(/\n$/, '') +
    `\n- [Pinned rule](brain/memory/feedback/pinned-rule.md) — ${long}\n`);

  const out = await buildBrainMd({ report: { wrote: [], counts: {} } });
  const raw = fs.readFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'), 'utf8');

  assert.ok(out.tokens <= BUDGET, `compiled to ${out.tokens} tokens, over ${BUDGET}`);
  assert.match(raw, /- \*\*Pinned rule\*\* — x+…/, 'the entry survives, clamped and marked');
  assert.ok(!raw.includes(long), 'the untruncated description must not reach BRAIN.md');
});

// Regression: a long "## Last Session" block used to throw `over budget` and
// strand BRAIN.md *and* all 3 MOCs, because the compiler measured the whole
// document against its token budget while update-session.js owns that block
// and writes it unbounded. The borrowed block must be clamped, not fatal.
test('an oversized borrowed "## Last Session" block is clamped, not fatal', async () => {
  const brainPath = path.join(TMP, 'brain', '_index', 'BRAIN.md');
  const seeded = fs.readFileSync(brainPath, 'utf8').replace(
    /## Last Session[\s\S]*$/,
    '## Last Session\n- **Date**: 2026-08-11\n- **Summary**: ' +
      'a session summary long enough to blow the whole budget on its own '.repeat(40) + '\n');
  fs.writeFileSync(brainPath, seeded);

  const out = await buildBrainMd({ report: { wrote: [], counts: {} } });

  assert.ok(out.lastSessionClamped, 'the oversized block should report as clamped');
  assert.ok(out.tokens <= BUDGET, `compiled to ${out.tokens} tokens, over the ${BUDGET} budget`);

  const raw = fs.readFileSync(brainPath, 'utf8');
  assert.match(raw, /## Last Session/);            // structure survives the clamp
  assert.match(raw, /- \*\*Date\*\*: 2026-08-11/); // ...including the date line
  assert.match(raw, /…$/m);                        // and the cut is marked
  assert.match(raw, /generatedBy: build-brain-md\.js/); // the write actually happened
  // The MOCs are the real blast radius of the old throw — prove they regenerated.
  assert.match(fs.readFileSync(path.join(TMP, 'brain', '_index', 'MOC-reference.md'), 'utf8'),
    /## Manual index\n[\s\S]*- \[\[/);
});

test('MOC manual indexes regenerate from the store', async () => {
  await buildBrainMd({ report: { wrote: [], counts: {} } });
  const moc = fs.readFileSync(path.join(TMP, 'brain', '_index', 'MOC-reference.md'), 'utf8');
  assert.match(moc, /## Manual index\n[\s\S]*- \[\[/);
  assert.match(moc, /generatedBy: build-brain-md\.js/);
});

// Covers the fix-queue's "rebuild-brain-md" button: the plugin's spawn
// executor runs this file as `node build-brain-md.js` (a real child process,
// not a require()), so a require.main CLI entry is the only thing that makes
// that button do anything. Own tmp fixture (not the shared TMP above) since
// this spawns a separate Node process rather than reusing the in-process
// `buildBrainMd` already required into this file.
test('CLI entry: spawning the script as `node build-brain-md.js` compiles BRAIN.md and logs to the pipeline ledger', () => {
  const cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbmd-cli-'));
  for (const d of [
    'brain/_index',
    'brain/memory/user',
    'brain/memory/feedback',
    'brain/memory/reference',
    'brain/memory/projects',
    'brain/patterns',
  ]) {
    fs.mkdirSync(path.join(cliTmp, d), { recursive: true });
  }
  fs.writeFileSync(path.join(cliTmp, 'CLAUDE.md'), '# t');
  fs.writeFileSync(path.join(cliTmp, 'MEMORY.md'), PRISTINE_MEMORY_MD);
  fs.writeFileSync(path.join(cliTmp, 'brain', 'memory', 'user', 'profile.md'),
    '---\ntype: memory\ntags: [memory/user, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Profile\n\nFixture user for the CLI-entry test.\n');
  fs.writeFileSync(path.join(cliTmp, 'brain', 'memory', 'feedback', 'pinned-rule.md'), PRISTINE_PINNED_RULE);
  fs.writeFileSync(path.join(cliTmp, 'brain', 'memory', 'reference', 'some-reference.md'),
    '---\ntype: reference\ntags: [memory/reference, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Some reference\n\nbody\n');
  fs.writeFileSync(path.join(cliTmp, 'brain', 'memory', 'projects', 'active-project.md'),
    '---\ntype: memory\ntags: [memory/projects, status/active]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Active project\n\nbody\n');
  fs.writeFileSync(path.join(cliTmp, 'brain', 'patterns', 'sample-pattern.md'),
    '---\ntype: pattern\ntags: [pattern/sample]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Sample Pattern\n\n> a fixture pattern.\n');
  fs.writeFileSync(path.join(cliTmp, 'brain', '_index', 'BRAIN.md'),
    '---\ntype: index\ntags: [brain/bootstrap, status/active]\nupdated: 2026-01-01\n---\n\n# BRAIN\n\n' +
    '## Who\nplaceholder\n\n## Critical rules\n- placeholder\n\n## Active context\n- placeholder\n\n' +
    '## Quick links\n- placeholder\n\n## Last Session\n- placeholder last-session line\n');
  for (const [file, , tag] of [ // [MOC file, the folder it indexes (documentation only), tag]
    ['MOC-reference.md', 'brain/memory/reference', 'reference'],
    ['MOC-projects.md', 'brain/memory/projects', 'projects'],
    ['MOC-patterns.md', 'brain/patterns', 'patterns'],
  ]) {
    fs.writeFileSync(path.join(cliTmp, 'brain', '_index', file),
      `---\ntype: moc\ntags: [moc, moc/${tag}]\nupdated: 2026-01-01\n---\n\n# MOC — ${tag}\n\n` +
      '## Manual index\n- [[placeholder]] — stale entry that must be replaced\n');
  }

  const scriptPath = path.join(__dirname, '..', 'build-brain-md.js');
  const result = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, BRAIN_VAULT: cliTmp },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0,
    `expected exit 0 from \`node build-brain-md.js\`, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const ledgerPath = path.join(cliTmp, 'brain', '_index', 'pipelines.json');
  assert.ok(fs.existsSync(ledgerPath), 'pipelines.json ledger should exist after the spawn action runs');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.ok(ledger.pipelines['build-brain-md'], 'ledger should carry a build-brain-md entry');
  assert.equal(ledger.pipelines['build-brain-md'].lastRun.status, 'ok');

  const compiled = fs.readFileSync(path.join(cliTmp, 'brain', '_index', 'BRAIN.md'), 'utf8');
  assert.match(compiled, /generatedBy: build-brain-md\.js/);
  assert.match(compiled, /## Who/);
});
