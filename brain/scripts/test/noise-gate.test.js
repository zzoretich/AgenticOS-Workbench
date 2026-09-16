'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isJunkSummary, jaccard, gateCandidate } = require('../lib/noise-gate.js');

test('junk summaries are detected', () => {
  assert.equal(isJunkSummary('The log was empty.'), true);
  assert.equal(isJunkSummary('Nothing significant happened this session'), true);
  assert.equal(isJunkSummary('ok'), true); // too short
  assert.equal(isJunkSummary('Shipped the pipelines ledger and wired four writers into it.'), false);
});

test('jaccard token-set similarity', () => {
  assert.equal(jaccard('prefers terse answers', 'prefers terse answers'), 1);
  assert.ok(jaccard('prefers terse answers', 'prefers short terse replies') > 0.3);
  assert.equal(jaccard('alpha beta', 'gamma delta'), 0);
});

const GOOD = { type: 'feedback', title: 'Prefers terse answers', description: 'short replies with file refs', body: 'The owner prefers terse answers.\n**Why:** speed.\n**How to apply:** short replies.' };

test('good candidate passes an empty store', () => {
  assert.deepEqual(gateCandidate(GOOD, { existingTitles: [], revertedSlugs: new Set() }), { ok: true });
});

test('near-duplicate titles are rejected', () => {
  const out = gateCandidate(GOOD, { existingTitles: ['Prefers terse answers always'], revertedSlugs: new Set() });
  assert.equal(out.ok, false);
  assert.match(out.reason, /duplicate/i);
});

test('reverted slugs are never re-written', () => {
  const out = gateCandidate(GOOD, { existingTitles: [], revertedSlugs: new Set(['prefers-terse-answers']) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /reverted/i);
});

test('over-long bodies and thin candidates are rejected', () => {
  assert.equal(gateCandidate({ ...GOOD, body: 'x'.repeat(2000) }, { existingTitles: [], revertedSlugs: new Set() }).ok, false);
  assert.equal(gateCandidate({ ...GOOD, description: 'meh' }, { existingTitles: [], revertedSlugs: new Set() }).ok, false);
  assert.equal(gateCandidate({ ...GOOD, type: 'nonsense' }, { existingTitles: [], revertedSlugs: new Set() }).ok, false);
});
