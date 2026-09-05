'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'reference'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'reference', 'scanner.md'), '# Scanner\n\nthe scanner budget is forty files\n');
process.env.BRAIN_VAULT = TMP;
const recall = require('../sdk/lib/recall.js');

test('with provider none, hybrid recall falls back to BM25 (hybrid:false) instead of failing', async () => {
  const index = recall.buildRecallIndex({ vault: TMP });
  const embedIndex = { version: 1, dims: 3, chunks: [{ path: 'brain/memory/reference/scanner.md', part: 0, vec: [1, 0, 0] }] };
  const r = await recall.queryRecallHybrid(index, 'scanner budget', { vault: TMP, embedIndex });
  assert.equal(r.hybrid, false);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].path, 'brain/memory/reference/scanner.md');
});
