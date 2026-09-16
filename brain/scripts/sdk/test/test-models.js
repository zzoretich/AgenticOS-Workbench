#!/usr/bin/env node
// Unit tests for brain/scripts/sdk/lib/models.js — plain node, no framework.
// Run: node brain/scripts/test/live/test-models.js
const assert = require('assert');
const { role, thinkFor } = require('../lib/models.js');

// defaults
delete process.env.BRAIN_MODEL; delete process.env.BRAIN_REASONER; delete process.env.BRAIN_EMBEDDER;
assert.strictEqual(role('workhorse').tag, 'qwen3.5:4b');
assert.strictEqual(role('workhorse').keepAlive, -1);
assert.strictEqual(role('reasoner').tag, 'gpt-oss:20b');
assert.strictEqual(role('reasoner').keepAlive, '10m');
assert.strictEqual(role('reasoner').numCtxCap, 16384);
assert.strictEqual(role('embedder').tag, 'qwen3-embedding:0.6b');
assert.strictEqual(role('embedder').keepAlive, -1);

// env overrides are read lazily
process.env.BRAIN_REASONER = 'gemma4:12b';
assert.strictEqual(role('reasoner').tag, 'gemma4:12b');
delete process.env.BRAIN_REASONER;

// unknown role throws
assert.throws(() => role('nope'), /unknown model role/);

// think mapping: workhorse is ALWAYS false (feedback rule)
assert.strictEqual(thinkFor('workhorse'), false);
assert.strictEqual(thinkFor('workhorse', 'high'), false);
// reasoner with effort support maps effort strings, default medium
assert.strictEqual(thinkFor('reasoner'), 'medium');
assert.strictEqual(thinkFor('reasoner', 'high'), 'high');
// a reasoner tag without effort support (Stack C fallback) degrades to false
process.env.BRAIN_REASONER = 'gemma4:12b';
process.env.BRAIN_REASONER_EFFORT = '0';
assert.strictEqual(thinkFor('reasoner', 'high'), false);
delete process.env.BRAIN_REASONER; delete process.env.BRAIN_REASONER_EFFORT;

console.log('test-models: all assertions passed');
