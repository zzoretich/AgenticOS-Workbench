'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sizeContextWindow, stripThink } = require('../sdk/lib/ollama.js');

test('small prompts keep the 4096 floor', () => {
  assert.equal(sizeContextWindow(500, 1024), 4096);
  assert.equal(sizeContextWindow(0, 64), 4096);
});

test('a 50KB transcript tail gets a window that fits prompt + generation', () => {
  const ctx = sizeContextWindow(50_000, 2048);
  // ~16.7K prompt tokens + 2048 generation — must comfortably exceed both
  assert.ok(ctx >= Math.ceil(50_000 / 3) + 2048, `ctx ${ctx} too small`);
  assert.ok(ctx <= 32768, `ctx ${ctx} exceeds cap`);
});

test('the window is capped at 32K no matter the prompt size', () => {
  assert.equal(sizeContextWindow(1_000_000, 4096), 32768);
});

test('window snaps to 4096 buckets so interleaved callers share model loads', () => {
  assert.equal(sizeContextWindow(20_000, 1024) % 4096, 0);
  // nearby prompt sizes must land in the SAME bucket
  assert.equal(sizeContextWindow(40_000, 2048), sizeContextWindow(43_000, 2048));
});

test('stripThink removes paired reasoning blocks only', () => {
  assert.equal(stripThink('<think>hmm</think>{"a":1}'), '{"a":1}');
  assert.equal(stripThink('{"a":1}'), '{"a":1}');
});
