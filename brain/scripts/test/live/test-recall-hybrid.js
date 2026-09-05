#!/usr/bin/env node
// Unit tests for queryRecallHybrid in brain/scripts/sdk/lib/recall.js.
// Run: node brain/scripts/test/live/test-recall-hybrid.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const recall = require('../../sdk/lib/recall.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hybrid-'));
function write(rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
write('brain/memory/reference/kube.md', '# Kube\nkubernetes cluster upgrade notes.\n');
write('brain/memory/reference/deploy.md', '# Deploy\nshipping process for releases.\n');
write('brain/memory/reference/helm.md', '# Helm\nhelm chart conventions.\n');

const index = recall.buildRecallIndex({ vault: root });

(async () => {
  // no embed index -> BM25-only, hybrid:false
  const r1 = await recall.queryRecallHybrid(index, 'kubernetes upgrade', { vault: root, embedIndex: null });
  assert.strictEqual(r1.hybrid, false);
  assert.strictEqual(r1.hits[0].path, 'brain/memory/reference/kube.md');

  // embed index present: vector leg surfaces a doc BM25 cannot reach for this query
  const embedIndex = { version: 1, dims: 2, chunks: [
    { path: 'brain/memory/reference/kube.md', part: 0, vec: [1, 0] },
    { path: 'brain/memory/reference/deploy.md', part: 0, vec: [0, 1] },
    { path: 'brain/memory/reference/helm.md', part: 0, vec: [0.7071, 0.7071] },
  ] };
  const embedFn = async () => [[0, 1]]; // query vector == deploy.md's vector
  const fusionQuery = 'kubernetes cluster'; // shares zero tokens with deploy.md's name/body
  const bm25Only = recall.queryRecall(index, fusionQuery, { vault: root, limit: 10 });
  assert.ok(!bm25Only.some((h) => h.path === 'brain/memory/reference/deploy.md'),
    'premise: BM25 alone does not surface deploy.md for this query');
  const r2 = await recall.queryRecallHybrid(index, fusionQuery, { vault: root, embedIndex, embedFn });
  assert.strictEqual(r2.hybrid, true);
  const deployHit = r2.hits.find((h) => h.path === 'brain/memory/reference/deploy.md');
  assert.ok(deployHit, 'vector leg surfaced deploy.md that BM25 alone missed');
  assert.ok(deployHit.snippet.length > 0, 'vector-only hit carries a snippet');
  assert.strictEqual(typeof deployHit.flag, 'string', 'vector-only hit carries an age flag');

  // embedder failure -> graceful BM25 degrade
  const r3 = await recall.queryRecallHybrid(index, 'kubernetes', {
    vault: root, embedIndex, embedFn: async () => { throw new Error('down'); },
  });
  assert.strictEqual(r3.hybrid, false);
  assert.strictEqual(r3.hits[0].path, 'brain/memory/reference/kube.md');

  // embedder resolves but yields no usable query vector -> graceful BM25 degrade
  const r4 = await recall.queryRecallHybrid(index, 'kubernetes', {
    vault: root, embedIndex, embedFn: async () => [],
  });
  assert.strictEqual(r4.hybrid, false);
  assert.strictEqual(r4.hits[0].path, 'brain/memory/reference/kube.md');

  // embed index dims mismatch (stale index from a different embedder model) ->
  // graceful BM25 degrade instead of comparing incompatible vector spaces
  const mismatchedIndex = { version: 1, dims: 2, chunks: embedIndex.chunks };
  const r5 = await recall.queryRecallHybrid(index, 'kubernetes', {
    vault: root, embedIndex: mismatchedIndex, embedFn: async () => [[1, 0, 0]],
  });
  assert.strictEqual(r5.hybrid, false, 'dims mismatch degrades to BM25-only');
  assert.strictEqual(r5.hits[0].path, 'brain/memory/reference/kube.md');

  console.log('test-recall-hybrid: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
