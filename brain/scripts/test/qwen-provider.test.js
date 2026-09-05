'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenp-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
process.env.BRAIN_VAULT = TMP;
process.env.AOS_CONFIG = path.join(TMP, 'no-agenticos.json');
const { resetProviderCache } = require('../sdk/lib/provider.js');
const { summarize, extract, summarizeSystem } = require('../sdk/lib/qwen.js');
const { embed, postEmbed } = require('../sdk/lib/embed.js');

beforeEach(() => resetProviderCache());

test('with provider none, the default chat rejects with PROVIDER_NONE instead of dialing Ollama', async () => {
  await assert.rejects(() => summarize('some text'), (e) => e.code === 'PROVIDER_NONE');
});

test('with provider none, the default embed rejects with PROVIDER_NONE', async () => {
  await assert.rejects(() => embed(['a']), (e) => e.code === 'PROVIDER_NONE');
  assert.equal(typeof postEmbed, 'function');
});

test('extract forwards a real JSON Schema and the feature label to the chat call', async () => {
  let seen;
  const schema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'] };
  await extract('t', { chatFn: async (args) => { seen = args; return '{"facts":[]}'; }, jsonSchema: schema, feature: 'auto-wrap', schema: { facts: [] } });
  assert.deepEqual(seen.schema, schema);
  assert.equal(seen.feature, 'auto-wrap');
  assert.equal(seen.format, 'json');
  assert.match(seen.system, /"facts": \[\]/);
});

test('extract without jsonSchema sends no schema key', async () => {
  let seen;
  await extract('t', { chatFn: async (args) => { seen = args; return '{"ok":1}'; } });
  assert.ok(!('schema' in seen));
});

test('summarizeSystem is exported for the --context path', () => {
  assert.match(summarizeSystem({ style: 'prose', maxWords: 50, focus: 'errors' }), /tight prose paragraph.*Focus on: errors.*under 50 words/);
});
