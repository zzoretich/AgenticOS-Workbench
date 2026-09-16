'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memw-'));
fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'feedback'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n\n- [Existing](brain/memory/user/existing.md) — already here\n');
process.env.BRAIN_VAULT = TMP;
const { slugify, deriveTitle, writeMemory } = require('../lib/memory-writer.js');

test('slugify matches the plugin semantics (lowercase, dashes, ≤6 words)', () => {
  assert.equal(slugify('Prefers Terse Answers With File Refs Always!!'), 'prefers-terse-answers-with-file-refs');
});

test('writeMemory writes frontmatter + auto keys + body and appends the index line', () => {
  const out = writeMemory({
    type: 'feedback', title: 'Prefers terse answers', description: 'short replies, file:line refs',
    body: 'The owner prefers terse answers.\n\n**Why:** speed.\n**How to apply:** keep replies short.',
    source: 'auto-wrap', session: 'sess-1',
  });
  const raw = fs.readFileSync(path.join(TMP, out.memoryPath), 'utf8');
  assert.match(raw, /^---\ntype: memory\n/);
  assert.match(raw, /tags: \[memory\/feedback, status\/active\]/);
  assert.match(raw, /source: auto-wrap/);
  assert.match(raw, /session: sess-1/);
  assert.match(raw, /reviewed: false/);
  assert.match(raw, /# Prefers terse answers/);
  const idx = fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8');
  assert.match(idx, /- \[Prefers terse answers\]\(brain\/memory\/feedback\/prefers-terse-answers\.md\) — short replies, file:line refs/);
});

test('duplicate slug throws (callers gate first)', () => {
  assert.throws(() => writeMemory({ type: 'feedback', title: 'Prefers terse answers', description: 'd', body: 'b' }),
    /already exists/);
});

test('manual writes (no source) omit the auto keys', () => {
  const out = writeMemory({ type: 'feedback', title: 'Another rule', description: 'd', body: 'b' });
  const raw = fs.readFileSync(path.join(TMP, out.memoryPath), 'utf8');
  assert.ok(!/source:/.test(raw) && !/reviewed:/.test(raw));
});

test('writes for all four types splice into a REAL-SHAPED MEMORY.md (no duplicate/stray headings)', () => {
  // Mirrors the real vault-root MEMORY.md's actual headings: "Feedback (how to
  // work)" not "Feedback", "Projects" (plural) not "Project". TYPE_HEADING's
  // bare singular/short forms must still resolve via prefix match.
  const realShaped = [
    '# Memory Index',
    '',
    '## User',
    '- existing user line',
    '',
    '## Feedback (how to work)',
    '- existing feedback line',
    '',
    '## Reference',
    '- existing reference line',
    '',
    '## Projects',
    '- existing projects line',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), realShaped);

  writeMemory({ type: 'user', title: 'Fixture user item', description: 'd-user', body: 'b' });
  writeMemory({ type: 'feedback', title: 'Fixture feedback item', description: 'd-feedback', body: 'b' });
  writeMemory({ type: 'reference', title: 'Fixture reference item', description: 'd-reference', body: 'b' });
  writeMemory({ type: 'projects', title: 'Fixture projects item', description: 'd-projects', body: 'b' });

  const idx = fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8');
  const lines = idx.split('\n');
  const countExact = (str) => lines.filter((l) => l.trim() === str).length;

  // No stray heading was appended for any type, and the real headings weren't duplicated.
  assert.equal(countExact('## User'), 1, 'no duplicate ## User heading');
  assert.equal(countExact('## Feedback (how to work)'), 1, 'real Feedback heading count unchanged');
  assert.equal(countExact('## Feedback'), 0, 'no stray bare ## Feedback heading appended');
  assert.equal(countExact('## Reference'), 1, 'no duplicate ## Reference heading');
  assert.equal(countExact('## Projects'), 1, 'real Projects heading count unchanged');
  assert.equal(countExact('## Project'), 0, 'no stray ## Project (singular) heading appended');

  // Each entry landed INSIDE its own real section (between that heading and the next).
  const sectionBody = (headingLine) => {
    const start = lines.findIndex((l) => l.trim() === headingLine);
    assert.ok(start !== -1, `${headingLine} must exist`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
  };

  assert.match(sectionBody('## User'), /Fixture user item/);
  assert.match(sectionBody('## Feedback (how to work)'), /Fixture feedback item/);
  assert.match(sectionBody('## Reference'), /Fixture reference item/);
  assert.match(sectionBody('## Projects'), /Fixture projects item/);

  // Cross-check: entries didn't leak into the wrong section.
  assert.doesNotMatch(sectionBody('## User'), /Fixture feedback item|Fixture reference item|Fixture projects item/);
  assert.doesNotMatch(sectionBody('## Reference'), /Fixture feedback item|Fixture projects item/);
});
