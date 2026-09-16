'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, fitToBudget } = require('../lib/text-budget.js');

test('estimateTokens is ceil(chars/4)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('fitToBudget includes sections by priority until the budget is hit', () => {
  const out = fitToBudget([
    { name: 'threads', text: 'x'.repeat(400), priority: 3 },
    { name: 'facts', text: 'y'.repeat(400), priority: 1 },
    { name: 'decisions', text: 'z'.repeat(400), priority: 2 },
  ], 250); // 250 tokens = 1000 chars → facts(100t) + decisions(100t) fit, threads(100t) would exceed? 300>250
  assert.ok(out.text.includes('y') && out.text.includes('z'));
  assert.ok(!out.text.includes('x'));
  assert.deepEqual(out.dropped, ['threads']);
});

test('a single over-budget section is dropped, not truncated', () => {
  const out = fitToBudget([{ name: 'big', text: 'q'.repeat(5000), priority: 1 }], 100);
  assert.equal(out.text, '');
  assert.deepEqual(out.dropped, ['big']);
});
