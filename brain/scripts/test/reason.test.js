'use strict';
// Unit tests for reason() in brain/scripts/sdk/lib/qwen.js — the reasoner role's call shape and its
// workhorse fallback. Moved out of test/live/: every chat is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reason } = require('../sdk/lib/qwen.js');

for (const k of ['BRAIN_MODEL', 'BRAIN_REASONER', 'BRAIN_EMBEDDER']) delete process.env[k];
const ok = (calls, reply = 'answer') => async (args) => { calls.push(args); return reply; };

test('routes to the reasoner: Claude model id, the effort dial as think, the feature label, no Ollama residency knobs', async () => {
  const calls = [];
  assert.equal(await reason('q1', { chatFn: ok(calls), effort: 'high', feature: 'reason:ask' }), 'answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'claude-opus-5');
  assert.equal(calls[0].think, 'high');
  assert.equal(calls[0].feature, 'reason:ask');
  assert.equal(calls[0].numPredict, 2048);
  assert.equal(calls[0].timeoutMs, 300000);
  assert.ok(!('keepAlive' in calls[0]) && !('numCtx' in calls[0]), 'keepAlive/numCtx are Ollama concepts');
});

test('default effort is medium; format and numPredict pass through', async () => {
  const calls = [];
  await reason('q2', { chatFn: ok(calls), format: 'json', numPredict: 512 });
  assert.equal(calls[0].think, 'medium');
  assert.equal(calls[0].format, 'json');
  assert.equal(calls[0].numPredict, 512);
  assert.equal(calls[0].feature, 'reason:unknown');
});

test('fallback: the reasoner throws → the fallback chat gets a complete workhorse request', async () => {
  const seq = [];
  const flaky = async (args) => { seq.push(args.model); throw new Error('daily reasoner cap of 5 USD reached'); };
  const wh = [];
  const out = await reason('q3', { chatFn: flaky, fallbackChatFn: ok(wh, 'fallback answer'), effort: 'high' });
  assert.equal(out, 'fallback answer');
  // callWithRetry only re-calls on EMPTY replies; a thrown error propagates at once — one reasoner attempt.
  assert.deepEqual(seq, ['claude-opus-5']);
  assert.equal(wh.length, 1);
  assert.equal(wh[0].model, 'qwen3.5:9b');
  assert.equal(wh[0].think, false, 'never a stale think level from the reasoner attempt');
  assert.equal(wh[0].keepAlive, -1);
  assert.equal(wh[0].numCtx, undefined, 'auto-sized context');
  assert.equal(wh[0].prompt, 'q3');
});

test('noFallback propagates the reasoner error; without a local fallback the error propagates too', async () => {
  const boom = async () => { throw new Error('nope'); };
  await assert.rejects(() => reason('q', { chatFn: boom, fallbackChatFn: ok([]), noFallback: true }), /nope/);
  // The test vault pins provider none, so the default fallback (the global provider) is not Ollama.
  await assert.rejects(() => reason('q', { chatFn: boom }), /nope/);
});

test('providerName ollama: the chat is an Ollama provider (reasoner degraded) → workhorse request straight away', async () => {
  const calls = [];
  await reason('q4', { chatFn: ok(calls), providerName: 'ollama', effort: 'high' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'qwen3.5:9b');
  assert.equal(calls[0].think, false);
});

test('with no chatFn and provider none, reason() rejects with PROVIDER_NONE instead of dialing anything', async () => {
  await assert.rejects(() => reason('q'), (e) => e.code === 'PROVIDER_NONE');
});
