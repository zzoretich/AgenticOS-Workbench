'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, formatLine } = require('../feedback-metrics.js');

test('summarize counts events and dedupes recurred rule names', () => {
  const rows = [
    { event: 'captured', title: 'a' }, { event: 'captured', title: 'b' },
    { event: 'applied', title: 'a' }, { event: 'rejected', title: 'b' },
    { event: 'recurred', title: 'x', matched: 'Reach for Grep/Glob/Read, not Bash, when searching' },
    { event: 'recurred', title: 'y', matched: 'Reach for Grep/Glob/Read, not Bash, when searching' },
  ];
  const s = summarize(rows);
  assert.deepEqual(s, {
    captured: 2, applied: 1, rejected: 1, recurred: 2,
    recurredRules: ['Reach for Grep/Glob/Read, not Bash, when searching'],
  });
});

test('formatLine renders the reflect-facing one-liner', () => {
  const line = formatLine({ captured: 2, applied: 1, rejected: 1, recurred: 2,
    recurredRules: ['Reach for Grep/Glob/Read, not Bash, when searching'] }, 7);
  assert.equal(line,
    'feedback-autoloop last 7d: captured 2, applied 1, rejected 1, recurred 2 (recurred rules: Reach for Grep/Glob/Read, not Bash, when searching)');
});

test('formatLine omits the rules tail when nothing recurred', () => {
  const line = formatLine({ captured: 0, applied: 0, rejected: 0, recurred: 0, recurredRules: [] }, 7);
  assert.equal(line, 'feedback-autoloop last 7d: captured 0, applied 0, rejected 0, recurred 0');
});
