#!/usr/bin/env node
// Unit tests for reason() in brain/scripts/sdk/lib/qwen.js.
// Run: node brain/scripts/test/live/test-reason.js
const assert = require('assert');
const { reason } = require('../../sdk/lib/qwen.js');

delete process.env.BRAIN_MODEL; delete process.env.BRAIN_REASONER; delete process.env.BRAIN_REASONER_EFFORT;

(async () => {
  // routes to the reasoner role with effort + explicit numCtx + keepAlive
  const calls = [];
  const okFn = async (args) => { calls.push(args); return 'answer'; };
  const out = await reason('q1', { chatFn: okFn, effort: 'high' });
  assert.strictEqual(out, 'answer');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'gpt-oss:20b');
  assert.strictEqual(calls[0].think, 'high');
  assert.strictEqual(calls[0].numCtx, 16384);
  assert.strictEqual(calls[0].keepAlive, '10m');

  // default effort is medium
  calls.length = 0;
  await reason('q2', { chatFn: okFn });
  assert.strictEqual(calls[0].think, 'medium');

  // fallback: first call throws -> workhorse with think:false
  const seq = [];
  let workhorseArgs = null;
  const flakyFn = async (args) => {
    seq.push(args.model);
    if (args.model === 'gpt-oss:20b') throw new Error('connect ECONNREFUSED');
    workhorseArgs = args;
    return 'fallback answer';
  };
  const out2 = await reason('q3', { chatFn: flakyFn });
  assert.strictEqual(out2, 'fallback answer');
  // callWithRetry only re-calls on EMPTY replies; a thrown error propagates
  // immediately — so exactly one reasoner attempt, then one workhorse attempt.
  assert.deepStrictEqual(seq, ['gpt-oss:20b', 'qwen3.5:4b']);
  // the fallback call must fully reset to workhorse semantics, not just swap
  // the model tag — a stale think/keepAlive/numCtx from the reasoner attempt
  // would silently burn think budget or pin the wrong context window.
  assert.strictEqual(workhorseArgs.think, false);
  assert.strictEqual(workhorseArgs.keepAlive, -1);
  assert.strictEqual(workhorseArgs.numCtx, undefined);
  console.log('test-reason: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
