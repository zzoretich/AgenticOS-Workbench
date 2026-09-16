#!/usr/bin/env node
// Unit tests for brain/scripts/embed-vault.js (injected embedFn — no HTTP).
// Run: node brain/scripts/test/live/test-embed-vault.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refreshEmbedIndex } = require('../../embed-vault.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-embed-'));
function write(rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

write('brain/memory/reference/a.md', '---\ntype: memory\n---\n\n# A\nalpha content about kubernetes.\n');
write('brain/memory/reference/b.md', '---\ntype: memory\n---\n\n# B\nbeta content about helm charts.\n');
// oversized file: two ## sections, each small, total > 24000 chars forces a split
write('brain/patterns/big.md', '# Big\n\n## One\n' + 'x'.repeat(15000) + '\n\n## Two\n' + 'y'.repeat(15000) + '\n');

(async () => {
  let embedCalls = 0;
  const embedFn = async (texts) => { embedCalls++; return texts.map(() => [1, 0]); };

  // first run embeds everything
  const r1 = await refreshEmbedIndex({ vault: root, budget: 40, embedFn });
  assert.strictEqual(r1.embedded, 3, 'three files embedded');
  assert.strictEqual(r1.pending, 0);
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'brain/_index/embed-index.json'), 'utf8'));
  assert.strictEqual(idx.version, 1);
  assert.ok(idx.files['brain/memory/reference/a.md'], 'hash recorded');
  const bigChunks = idx.chunks.filter((c) => c.path === 'brain/patterns/big.md');
  assert.ok(bigChunks.length >= 2, 'oversized file split into parts');
  assert.deepStrictEqual(idx.chunks[0].vec, [1, 0]);

  // second run: nothing changed -> all skipped, no embed calls
  const callsBefore = embedCalls;
  const r2 = await refreshEmbedIndex({ vault: root, budget: 40, embedFn });
  assert.strictEqual(r2.embedded, 0);
  assert.strictEqual(r2.skipped, 3);
  assert.strictEqual(embedCalls, callsBefore, 'cache hit — no new embed calls');

  // changed file re-embeds; budget of 1 leaves others pending
  write('brain/memory/reference/a.md', '---\ntype: memory\n---\n\n# A\nalpha content CHANGED.\n');
  write('brain/memory/reference/c.md', '# C\nbrand new note.\n');
  const r3 = await refreshEmbedIndex({ vault: root, budget: 1, embedFn });
  assert.strictEqual(r3.embedded, 1);
  assert.strictEqual(r3.pending, 1, 'second dirty file deferred by budget');

  // embed the pending file before r4
  const r3b = await refreshEmbedIndex({ vault: root, budget: 1, embedFn });
  assert.strictEqual(r3b.embedded, 1, 'c was embedded');
  assert.strictEqual(r3b.pending, 0);

  // poison-file case: one embedFn call throws, others still process
  // First, set up files that will be embedded normally
  write('brain/memory/reference/d.md', '# D\ngood content.\n');
  write('brain/memory/reference/e.md', '# E\nthis works fine.\n');
  const r4_setup = await refreshEmbedIndex({ vault: root, budget: 5, embedFn });
  assert.strictEqual(r4_setup.embedded, 2, 'd and e embedded initially');

  // Now change d.md to poison content and try to re-embed with throwing embedFn
  write('brain/memory/reference/d.md', '# D\nthis will fail.\n');
  const throwingEmbedFn = async (texts) => {
    // Throw if any text contains 'this will fail'
    if (texts.some((t) => t.includes('this will fail'))) throw new Error('poison content detected');
    return texts.map(() => [1, 0]);
  };
  const r4 = await refreshEmbedIndex({ vault: root, budget: 5, embedFn: throwingEmbedFn });
  // r4: d (poison, will fail and keep old chunks), e is skipped
  assert.strictEqual(r4.failed, 1, 'one file failed');
  assert.strictEqual(r4.embedded, 0, 'no new files embedded');
  const idx4 = JSON.parse(fs.readFileSync(path.join(root, 'brain/_index/embed-index.json'), 'utf8'));
  assert.ok(!idx4.files['brain/memory/reference/d.md'], 'poison file hash NOT recorded (will retry)');
  // Verify d.md old chunks are preserved even though embed failed
  const dChunksAfterFail = idx4.chunks.filter((c) => c.path === 'brain/memory/reference/d.md');
  assert.strictEqual(dChunksAfterFail.length, 1, 'failed file keeps its previous chunks');

  // Test case: pending file (deferred past budget) keeps its previous chunks
  // Reset embedFn to normal, change b.md so it's dirty, use budget=0 to defer it
  // Note: d.md is still dirty from the failed embed in r4, so it will also be pending
  write('brain/memory/reference/b.md', '---\ntype: memory\n---\n\n# B\nbeta content CHANGED.\n');
  write('brain/memory/reference/f.md', '# F\nfresh file.\n');
  const r5 = await refreshEmbedIndex({ vault: root, budget: 0, embedFn });
  // With budget=0, no files embed, so b, d (still dirty from fail), and f are pending
  assert.strictEqual(r5.embedded, 0, 'budget=0 embeds nothing');
  assert.strictEqual(r5.pending, 3, 'b, d, and f are pending');
  const idx5 = JSON.parse(fs.readFileSync(path.join(root, 'brain/_index/embed-index.json'), 'utf8'));
  // b.md was embedded before (in r1), should still have its old chunks even though pending
  const bChunksPending = idx5.chunks.filter((c) => c.path === 'brain/memory/reference/b.md');
  assert.ok(bChunksPending.length >= 1, 'pending changed file keeps previous chunks');
  assert.ok(!idx5.files['brain/memory/reference/b.md'], 'pending file hash not recorded (still dirty)');
  // d.md failed in r4, should keep its chunks from before the fail
  const dChunksPending = idx5.chunks.filter((c) => c.path === 'brain/memory/reference/d.md');
  assert.strictEqual(dChunksPending.length, 1, 'failed file keeps its previous chunks');
  // f.md never embedded, should have no chunks
  const fChunksPending = idx5.chunks.filter((c) => c.path === 'brain/memory/reference/f.md');
  assert.strictEqual(fChunksPending.length, 0, 'never-embedded file has no chunks');

  // embedder model change invalidates the cache: switching BRAIN_EMBEDDER must
  // force a full rebuild, never mix vectors from two different embedder models
  const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-embed-model-'));
  function writeIn(base, rel, content) {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  writeIn(modelRoot, 'brain/memory/reference/x.md', '# X\nfirst file for embedder-swap test.\n');
  writeIn(modelRoot, 'brain/memory/reference/y.md', '# Y\nsecond file for embedder-swap test.\n');

  let modelEmbedCalls = 0;
  const modelEmbedFn = async (texts) => { modelEmbedCalls++; return texts.map(() => [1, 0]); };

  delete process.env.BRAIN_EMBEDDER;
  const rBefore = await refreshEmbedIndex({ vault: modelRoot, budget: 40, embedFn: modelEmbedFn });
  assert.strictEqual(rBefore.embedded, 2, 'both files embedded under the default embedder');
  const idxBefore = JSON.parse(fs.readFileSync(path.join(modelRoot, 'brain/_index/embed-index.json'), 'utf8'));
  assert.strictEqual(idxBefore.model, 'qwen3-embedding:0.6b', 'index records the default embedder tag');

  process.env.BRAIN_EMBEDDER = 'other-model:1b';
  const callsBeforeSwap = modelEmbedCalls;
  const rAfter = await refreshEmbedIndex({ vault: modelRoot, budget: 40, embedFn: modelEmbedFn });
  assert.strictEqual(rAfter.embedded, 2, 'embedder change forces ALL files to re-embed, no cache hits');
  assert.strictEqual(modelEmbedCalls, callsBeforeSwap + 2, 'two fresh embed calls, none skipped');
  const idxAfter = JSON.parse(fs.readFileSync(path.join(modelRoot, 'brain/_index/embed-index.json'), 'utf8'));
  assert.strictEqual(idxAfter.model, 'other-model:1b', 'new index records the new embedder tag');
  delete process.env.BRAIN_EMBEDDER;

  console.log('test-embed-vault: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
