#!/usr/bin/env node
// Unit tests for buildChatBody in brain/scripts/sdk/lib/ollama.js.
// Run: node brain/scripts/test/live/test-ollama-body.js
const assert = require('assert');
const { buildChatBody, sizeContextWindow } = require('../../sdk/lib/ollama.js');

// message assembly: system first, prompt last
const b1 = buildChatBody({ system: 'sys', prompt: 'hi', model: 'm', numPredict: 64 });
assert.deepStrictEqual(b1.messages.map(m => m.role), ['system', 'user']);
assert.strictEqual(b1.model, 'm');
assert.strictEqual(b1.stream, false);
assert.strictEqual(b1.think, false);                 // default stays false
assert.strictEqual(b1.options.num_predict, 64);
assert.strictEqual(b1.options.num_ctx, sizeContextWindow(5, 64));
assert.ok(!('keep_alive' in b1), 'keep_alive absent unless requested');
assert.ok(!('format' in b1), 'format absent unless requested');

// think passthrough accepts effort strings (gpt-oss dial)
const b2 = buildChatBody({ prompt: 'q', think: 'high' });
assert.strictEqual(b2.think, 'high');

// keep_alive + explicit numCtx + format
const b3 = buildChatBody({ prompt: 'q', keepAlive: '10m', numCtx: 16384, format: 'json' });
assert.strictEqual(b3.keep_alive, '10m');
assert.strictEqual(b3.options.num_ctx, 16384);
assert.strictEqual(b3.format, 'json');

console.log('test-ollama-body: all assertions passed');
