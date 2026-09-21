'use strict';
// Unit tests for brain/scripts/sdk/lib/models.js — the role table and its precedence rules.
// Moved out of test/live/: nothing here needs Ollama.
const test = require('node:test');
const assert = require('node:assert/strict');
const { role, thinkFor, providerFor, EFFORTS } = require('../sdk/lib/models.js');

const ENV = ['BRAIN_MODEL', 'BRAIN_REASONER', 'BRAIN_EMBEDDER', 'AOS_CLAUDE_MODEL'];
function clearEnv() { for (const k of ENV) delete process.env[k]; }
const NO_CFG = {}; // passing a cfg skips the vault lookup, so defaults are exactly DEFAULTS

test('defaults: 9b workhorse, Opus 5 reasoner on claude, 0.6b embedder', () => {
  clearEnv();
  assert.equal(role('workhorse', NO_CFG).tag, 'qwen3.5:9b');
  assert.equal(role('workhorse', NO_CFG).keepAlive, -1);
  assert.equal(role('workhorse', NO_CFG).numCtxCap, 32768);
  assert.equal(role('reasoner', NO_CFG).tag, 'claude-opus-5');
  assert.equal(role('reasoner', NO_CFG).keepAlive, null);
  assert.equal(role('reasoner', NO_CFG).numCtxCap, null);
  assert.equal(role('embedder', NO_CFG).tag, 'qwen3-embedding:0.6b');
  assert.equal(role('embedder', NO_CFG).keepAlive, -1);
  assert.equal(role('claude', NO_CFG).tag, 'haiku');
});

test('providerFor: the reasoner and the hook fallback are claude, the rest ollama', () => {
  assert.equal(providerFor('workhorse'), 'ollama');
  assert.equal(providerFor('embedder'), 'ollama');
  assert.equal(providerFor('reasoner'), 'claude');
  assert.equal(providerFor('claude'), 'claude');
  assert.equal(role('reasoner', NO_CFG).provider, 'claude');
  assert.throws(() => providerFor('nope'), /unknown model role/);
  assert.throws(() => role('nope'), /unknown model role/);
});

test('precedence: env beats config beats default, read lazily', () => {
  clearEnv();
  const cfg = { reasoner: { model: 'sonnet' }, claude: { model: 'opus' } };
  assert.equal(role('reasoner', cfg).tag, 'sonnet');
  assert.equal(role('claude', cfg).tag, 'opus');
  process.env.BRAIN_REASONER = 'claude-sonnet-5';
  assert.equal(role('reasoner', cfg).tag, 'claude-sonnet-5');
  process.env.BRAIN_MODEL = 'qwen3.5:27b';
  assert.equal(role('workhorse', cfg).tag, 'qwen3.5:27b');
  clearEnv();
  assert.equal(role('reasoner', cfg).tag, 'sonnet');
  assert.equal(role('reasoner', { reasoner: { model: '  ' } }).tag, 'claude-opus-5', 'blank config value falls through');
});

test('thinkFor: workhorse is always false; reasoner takes the dial, config default, then medium', () => {
  clearEnv();
  assert.equal(thinkFor('workhorse'), false);
  assert.equal(thinkFor('workhorse', 'high'), false);
  assert.equal(thinkFor('embedder', 'high', NO_CFG), false);
  assert.equal(thinkFor('claude', 'high', NO_CFG), false);
  assert.equal(thinkFor('reasoner', undefined, NO_CFG), 'medium');
  assert.equal(thinkFor('reasoner', 'high', NO_CFG), 'high');
  assert.equal(thinkFor('reasoner', 'bogus', NO_CFG), 'medium', 'an unknown level falls back');
  assert.equal(thinkFor('reasoner', undefined, { reasoner: { effort: 'LOW' } }), 'low');
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high']);
});
