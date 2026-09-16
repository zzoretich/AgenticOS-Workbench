'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Fresh temp vault per test process, set BEFORE requiring the module
// (wrap-session reads VAULT/MEMORY_INDEX at load time).
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-vault-'));
process.env.BRAIN_VAULT = VAULT;

// Seed a MEMORY.md index with the section headers the promoter appends under.
fs.writeFileSync(path.join(VAULT, 'MEMORY.md'),
  '# Memory Index\n\n## User\n\n## Feedback (how to work)\n\n## Reference\n\n## Projects\n\n## Patterns\n');

const { promoteToMemory, slug } = require('../wrap-session');
const { writeMemory } = require('../lib/memory-writer.js');

// Helper: list immediate children of the vault root (to catch junk dirs).
function vaultEntries() { return fs.readdirSync(VAULT); }

test('promote item with URL + backticks + arrow does not create junk paths', () => {
  const session = [
    '## Things to Remember',
    '- New Outlook for Mac ships NO AppleScript → use `mailto:/ms-outlook://` deep links; see `docs/superpowers/plans/2026-06-01-m365-write-skills.md`. #promote',
  ].join('\n');

  const { promoted } = promoteToMemory(session);

  assert.equal(promoted.length, 1, 'exactly one item promoted');
  const { target } = promoted[0];

  // Target must be a clean slug path under brain/memory/<type>/, no spaces/colons/URLs.
  assert.match(target, /^brain\/memory\/(reference|feedback|projects|user)\/[a-z0-9-]+\.md$/,
    `target should be a sanitized memory path, got: ${target}`);
  assert.ok(!/[ :]/.test(target), 'target path has no spaces or colons');

  // A real memory file exists at that path.
  assert.ok(fs.existsSync(path.join(VAULT, target)), 'memory file written at clean path');

  // No junk directory created at the vault root (names with spaces / "mailto" / colon).
  const junk = vaultEntries().filter(e => /[ :]|mailto/i.test(e));
  assert.deepEqual(junk, [], `no junk vault entries, found: ${junk.join(', ')}`);

  // MEMORY.md index line is well-formed: link target is the clean path, not prose.
  const idx = fs.readFileSync(path.join(VAULT, 'MEMORY.md'), 'utf8');
  assert.match(idx, new RegExp(`\\]\\(${target.replace(/[/.]/g, m => '\\' + m)}\\)`),
    'index line links to the clean memory path');
  assert.ok(!/\]\((any |local |https?:|mailto)/i.test(idx),
    'index link target is never raw prose/URL');
});

test('type prefix routes to the right memory folder', () => {
  const session = '- feedback: always lead with the recommendation #promote';
  const { promoted } = promoteToMemory(session);
  assert.equal(promoted.length, 1);
  assert.match(promoted[0].target, /^brain\/memory\/feedback\/[a-z0-9-]+\.md$/);
  // Prefix is stripped from stored content.
  assert.ok(!/^feedback:/i.test(promoted[0].text), 'type prefix stripped from content');
});

test('arrow inside content is not treated as a path separator', () => {
  const session = '- Opus plans → Sonnet executes #promote';
  const { promoted } = promoteToMemory(session);
  assert.equal(promoted.length, 1);
  const { target } = promoted[0];
  assert.match(target, /^brain\/memory\/[a-z0-9/]+\/[a-z0-9-]+\.md$/);
  assert.ok(!/[ :]/.test(target));
  assert.ok(fs.existsSync(path.join(VAULT, target)));
});

test('slug strips slashes and punctuation', () => {
  assert.equal(slug('a/b c:d'), 'a-b-c-d');
  assert.ok(!slug('https://x.com/y').includes('/'));
});

test('a duplicate promote is skipped with a reason, and the wrap continues', () => {
  // Pre-seed the slug directly via writeMemory (not via a prior promoteToMemory
  // call) so the collision is set up independently of the promoter's own logic.
  writeMemory({
    type: 'feedback',
    title: 'Confirm scratch vault deletions first',
    description: 'safety check before destructive scratch cleanup',
    body: 'Confirm scratch vault deletions first.',
  });

  const session = [
    '## Things to Remember',
    '- feedback: Confirm scratch vault deletions first. #promote',
    '- reference: Second item in the same batch still promotes. #promote',
  ].join('\n');

  const { promoted, skipped } = promoteToMemory(session);

  assert.equal(skipped.length, 1, 'the duplicate is recorded as skipped, not silently dropped');
  assert.match(skipped[0].reason, /already exists/, 'reason carries writeMemory\'s own error message');
  assert.ok(skipped[0].title && skipped[0].title.length > 0, 'skip record carries a (derived) title');

  assert.equal(promoted.length, 1, 'the other item in the same batch still promotes — the wrap continues');
  assert.match(promoted[0].target, /^brain\/memory\/reference\/[a-z0-9-]+\.md$/);
});

test('a pattern promote whose file write fails is skipped, not silently counted as promoted', () => {
  // Force appendToMemoryFile's mkdirSync/writeFileSync to fail deterministically:
  // block brain/patterns with a FILE where a directory is expected. Portable,
  // no permission hacks, no mocking — confirmed to throw EEXIST/ENOTDIR.
  const patternsPath = path.join(VAULT, 'brain', 'patterns');
  fs.rmSync(patternsPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(patternsPath), { recursive: true });
  fs.writeFileSync(patternsPath, 'blocking file, not a directory');

  try {
    const session = '- pattern: a pattern that cannot be written to disk #promote';
    const { promoted, skipped } = promoteToMemory(session);

    assert.equal(promoted.length, 0, 'the failed pattern write must not be counted as promoted');
    assert.equal(skipped.length, 1, 'the failed pattern write is recorded as skipped');
    assert.ok(skipped[0].title, 'skip record carries a title');
    assert.ok(skipped[0].reason, 'skip record carries a reason');
  } finally {
    fs.rmSync(patternsPath, { force: true });
  }
});

// --- promote-tag guard (live incident 2026-08-07: a SESSION.md sentence ABOUT
// the tag — "Zero items promoted from memory (none tagged #promote in this
// session)." — was itself promoted into a junk reference memory) ---

test('prose ABOUT the tag (mid-sentence #promote) is never promoted', () => {
  const session = [
    '## Key Context This Session',
    '- Zero items promoted from memory (none tagged #promote in this session).',
  ].join('\n');
  const { promoted, skipped } = promoteToMemory(session);
  assert.equal(promoted.length, 0, 'mid-sentence tag must not promote');
  assert.equal(skipped.length, 0);
});

test('a backticked `#promote` mention is never promoted, even at line end', () => {
  const session = '- the wrap scanner needs a guard for `#promote`';
  const { promoted } = promoteToMemory(session);
  assert.equal(promoted.length, 0, 'code-span mention must not promote');
});

test('a genuine terminal tag still promotes, with punctuation or extra tags after it', () => {
  const session = [
    '## Things to Remember',
    '- terminal tag guard fact one #promote',
    '- terminal tag guard fact two #promote.',
    '- terminal tag guard fact three #promote #urgent',
  ].join('\n');
  const { promoted, skipped } = promoteToMemory(session);
  assert.equal(promoted.length, 3, `all three terminal-tag lines promote (skipped: ${JSON.stringify(skipped)})`);
});

test('a tagged line inside the Promote block is processed once, not twice', () => {
  const session = [
    '## Promote to Memory on Close',
    '- single processing check for block lines #promote',
  ].join('\n');
  const { promoted, skipped } = promoteToMemory(session);
  assert.equal(promoted.length, 1, 'exactly one promotion');
  assert.equal(skipped.length, 0, 'no phantom duplicate-skip from double-collection');
});
