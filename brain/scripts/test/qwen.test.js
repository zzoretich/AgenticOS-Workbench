'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { chunkText } = require('../sdk/lib/qwen.js');

test('chunkText returns [] for empty/whitespace input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  '), []);
});

test('chunkText returns single chunk when under maxChars', () => {
  assert.deepEqual(chunkText('hello world', 100), ['hello world']);
});

test('chunkText splits on paragraph boundaries and never exceeds maxChars', () => {
  const para = 'x'.repeat(40);
  const text = [para, para, para, para].join('\n\n'); // ~172 chars
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1, 'should split');
  for (const c of chunks) assert.ok(c.length <= 100, `chunk ${c.length} <= 100`);
  assert.equal(chunks.join('').replace(/\n/g, '').length, text.replace(/\n/g, '').length);
});

test('chunkText hard-cuts a single oversized block', () => {
  const huge = 'y'.repeat(250); // one block, no boundaries
  const chunks = chunkText(huge, 100);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 100);
});

const { summarize, QwenEmptyError } = require('../sdk/lib/qwen.js');

test('summarize calls chatFn once for small input', async () => {
  let calls = 0;
  const out = await summarize('short text', { chatFn: async () => { calls++; return 'SUMMARY'; } });
  assert.equal(calls, 1);
  assert.equal(out, 'SUMMARY');
});

test('summarize map-reduces large input (multiple map calls + final pass)', async () => {
  let calls = 0;
  const fake = async () => { calls++; return 'mini'; }; // each summary is tiny -> loop converges
  const big = ('p'.repeat(80) + '\n\n').repeat(40); // ~3280 chars
  const out = await summarize(big, { chatFn: fake, maxChars: 200 });
  assert.ok(calls > 2, `expected map calls + reduce, got ${calls}`);
  assert.equal(out, 'mini');
});

test('summarize retries once on empty then throws QwenEmptyError', async () => {
  let calls = 0;
  const fake = async () => { calls++; return ''; };
  await assert.rejects(
    () => summarize('text', { chatFn: fake }),
    (e) => e instanceof QwenEmptyError
  );
  assert.equal(calls, 2); // initial + one retry
});

test('summarize returns empty string for empty input without calling chatFn', async () => {
  let calls = 0;
  const out = await summarize('', { chatFn: async () => { calls++; return 'x'; } });
  assert.equal(out, '');
  assert.equal(calls, 0);
});

const { extract } = require('../sdk/lib/qwen.js');

test('extract parses clean JSON from chatFn', async () => {
  const fake = async () => '{"account":"Acme","actions":["call back"]}';
  const obj = await extract('notes...', { chatFn: fake, schema: { account: '', actions: [] } });
  assert.equal(obj.account, 'Acme');
  assert.deepEqual(obj.actions, ['call back']);
});

test('extract parses JSON wrapped in prose/fences', async () => {
  const fake = async () => 'Here you go:\n```json\n{"x":1}\n```\nThanks!';
  const obj = await extract('t', { chatFn: fake });
  assert.equal(obj.x, 1);
});

test('extract throws when no JSON present', async () => {
  const fake = async () => 'no json here at all';
  await assert.rejects(() => extract('t', { chatFn: fake }));
});

const { classify } = require('../sdk/lib/qwen.js');

test('classify returns the single matching label', async () => {
  const fake = async () => 'task';
  const out = await classify('do this thing', { labels: ['task', 'idea', 'note'], chatFn: fake });
  assert.equal(out, 'task');
});

test('classify drops invalid labels and returns null when nothing matches', async () => {
  const fake = async () => 'banana';
  const out = await classify('x', { labels: ['task', 'idea'], chatFn: fake });
  assert.equal(out, null);
});

test('classify multi returns array of matching labels', async () => {
  const fake = async () => 'task, note';
  const out = await classify('x', { labels: ['task', 'idea', 'note'], multi: true, chatFn: fake });
  assert.deepEqual(out, ['task', 'note']);
});

test('classify does not substring-false-match overlapping labels (single)', async () => {
  const fake = async () => 'debug';
  const out = await classify('x', { labels: ['bug', 'debug'], chatFn: fake });
  assert.equal(out, 'debug'); // must NOT be 'bug'
});

test('classify does not substring-false-match overlapping labels (multi)', async () => {
  const fake = async () => 'debug';
  const out = await classify('x', { labels: ['bug', 'debug'], multi: true, chatFn: fake });
  assert.deepEqual(out, ['debug']); // must NOT include 'bug'
});

test('extract requests JSON-constrained decoding and honors a numPredict override', async () => {
  let seen;
  const fake = async (args) => { seen = args; return '{"ok":true}'; };
  await extract('t', { chatFn: fake, numPredict: 2048 });
  assert.equal(seen.format, 'json');
  assert.equal(seen.numPredict, 2048);
});

test('extract keeps its 1024-token default when no numPredict is given', async () => {
  let seen;
  const fake = async (args) => { seen = args; return '{"ok":true}'; };
  await extract('t', { chatFn: fake });
  assert.equal(seen.numPredict, 1024);
});

test('extract parses replies with raw control chars inside JSON strings', async () => {
  const fake = async () => '{"note":"line one\nline two"}';
  const obj = await extract('t', { chatFn: fake });
  assert.equal(obj.note, 'line one\nline two');
});

test('extract error includes a snippet of the unparseable reply', async () => {
  const fake = async () => 'I could not find anything to extract from this transcript.';
  await assert.rejects(
    () => extract('t', { chatFn: fake }),
    (e) => /reply started/.test(e.message) && /could not find anything/.test(e.message)
  );
});
