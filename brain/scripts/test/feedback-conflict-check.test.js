'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fconf-'));
fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
process.env.BRAIN_VAULT = TMP;
const { checkPair, checkAllPairs } = require('../feedback-conflict-check.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DIR = path.join(TMP, 'brain', 'memory', 'feedback');
const rule = (name, h1, body) => fs.writeFileSync(path.join(DIR, name),
  `---\ntype: memory\n---\n\n# ${h1}\n\n${body}\n`);
rule('a-node-usr-local.md', 'node is at /usr/local/bin/node', 'Always use /usr/local/bin/node.');
rule('b-node-homebrew.md', 'node is at /opt/homebrew/bin/node', 'Always use /opt/homebrew/bin/node.');
rule('c-lead-with-rec.md', 'Lead with the recommendation', 'State the recommendation first.');

const conflictChat = (args) => {
  const both = /usr\/local\/bin\/node/.test(args.prompt) && /opt\/homebrew\/bin\/node/.test(args.prompt);
  return JSON.stringify(both
    ? { conflict: true, reason: 'two different canonical paths for the same binary' }
    : { conflict: false, reason: 'different topics' });
};

test('pairwise mode enumerates C(3,2)=3 pairs and flags the contradiction', async () => {
  const results = await checkAllPairs({ chatFn: conflictChat });
  assert.equal(results.length, 3);
  const hits = results.filter((r) => r.conflict);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].a, hits[0].b].sort(), ['a-node-usr-local.md', 'b-node-homebrew.md']);
  assert.match(hits[0].reason, /canonical paths/);
});

test('--draft mode checks one file against every active rule', async () => {
  const draft = path.join(DIR, '_drafts', 'new-node-rule.md');
  fs.writeFileSync(draft, '---\ntype: memory\n---\n\n# Prefer /opt/homebrew/bin/node\n\nUse /opt/homebrew/bin/node always.\n');
  const results = await checkAllPairs({ chatFn: conflictChat, draftPath: draft });
  assert.equal(results.length, 3); // draft × 3 active rules
  assert.equal(results.filter((r) => r.conflict).length, 1);
});

test('a failing qwen call degrades to a non-conflict with error flag, never throws', async () => {
  const boom = () => { throw new Error('ollama down'); };
  const r = await checkPair(path.join(DIR, 'a-node-usr-local.md'), path.join(DIR, 'c-lead-with-rec.md'), { chatFn: boom });
  assert.equal(r.conflict, false);
  assert.equal(r.error, true);
  assert.match(r.reason, /check-failed/);
});

test('a missing file degrades to a non-conflict with error flag, never throws', async () => {
  const r = await checkPair(path.join(DIR, 'nonexistent.md'), path.join(DIR, 'a-node-usr-local.md'), { chatFn: conflictChat });
  assert.equal(r.conflict, false);
  assert.equal(r.error, true);
  assert.match(r.reason, /check-failed/);
});

const { formatLine } = require('../feedback-conflict-check.js');

test('formatLine prints unverified (never ok) for a failed check', () => {
  assert.match(formatLine({ a: 'a.md', b: 'b.md', conflict: false, reason: 'check-failed: no provider', error: true }), /^unverified: a\.md × b\.md — check-failed/);
  assert.match(formatLine({ a: 'a.md', b: 'b.md', conflict: true, reason: 'same binary' }), /^CONFLICT: /);
  assert.match(formatLine({ a: 'a.md', b: 'b.md', conflict: false, reason: 'different topics' }), /^ok: /);
});
