#!/usr/bin/env node
// Unit tests for brain/scripts/sdk/lib/embed.js (injected postFn — no HTTP).
// Run: node brain/scripts/test/live/test-embed.js
const assert = require('assert');
const { embed, normalize } = require('../../sdk/lib/embed.js');

delete process.env.BRAIN_EMBEDDER;

(async () => {
  // normalize: unit length
  const n = normalize([3, 4]);
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9);
  assert.ok(Math.abs(n[0] - 0.6) < 1e-9);

  // batching: 20 inputs -> 2 calls of 16 + 4; payload shape checked
  const payloads = [];
  const postFn = async (payload) => {
    payloads.push(payload);
    return payload.input.map(() => [1, 1]); // un-normalized on purpose
  };
  const vecs = await embed(Array.from({ length: 20 }, (_, i) => 't' + i), { postFn });
  assert.strictEqual(vecs.length, 20);
  assert.strictEqual(payloads.length, 2);
  assert.strictEqual(payloads[0].input.length, 16);
  assert.strictEqual(payloads[1].input.length, 4);
  assert.strictEqual(payloads[0].model, 'qwen3-embedding:0.6b');
  assert.strictEqual(payloads[0].keep_alive, -1);
  assert.strictEqual(payloads[0].truncate, true);
  assert.strictEqual(payloads[0].dimensions, 256);
  // vectors come back normalized
  assert.ok(Math.abs(Math.hypot(...vecs[0]) - 1) < 1e-9);

  // string input wraps to one vector
  const one = await embed('solo', { postFn: async (p) => p.input.map(() => [0, 2]) });
  assert.strictEqual(one.length, 1);
  assert.deepStrictEqual(one[0], [0, 1]);

  console.log('test-embed: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
