'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPrompt, parseInsightReply, generateInsight } = require('../collectors/workspaceInsights');

test('buildPrompt includes name, status, objectives, subproject names', () => {
  const entry = {
    name: 'SN Claude Skills', status: 'active', summary: 'skill factory',
    objectives: [{ text: 'Ship sales-coach' }],
    subprojects: [{ name: 'factory', status: 'active' }],
    next: { text: null }, lastEvent: { ageDays: 2 },
  };
  const p = buildPrompt(entry);
  assert.match(p, /SN Claude Skills/);
  assert.match(p, /active/);
  assert.match(p, /Ship sales-coach/);
  assert.match(p, /factory/);
});

test('parseInsightReply extracts INSIGHT and NEXT, NONE -> null', () => {
  const r = parseInsightReply('INSIGHT: Momentum is good.\nNEXT: Unblock QA.');
  assert.equal(r.insight, 'Momentum is good.');
  assert.equal(r.next, 'Unblock QA.');
  const r2 = parseInsightReply('INSIGHT: Steady.\nNEXT: NONE');
  assert.equal(r2.next, null);
});

test('generateInsight returns unavailable when the chat fn throws (offline)', async () => {
  const entry = { name: 'X', status: 'active', summary: '', objectives: [], subprojects: [], next: { text: null }, lastEvent: { ageDays: 0 } };
  const res = await generateInsight(entry, { chatFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(res.insight.status, 'unavailable');
  assert.equal(res.insight.text, null);
});

test('generateInsight fills insight + next from a stubbed chat fn', async () => {
  const entry = { name: 'X', status: 'active', summary: '', objectives: [], subprojects: [], next: { text: null, source: 'derived' }, lastEvent: { ageDays: 0 } };
  const res = await generateInsight(entry, {
    chatFn: async () => 'INSIGHT: All good.\nNEXT: Ship it.',
    model: 'qwen3.5:4b',
  });
  assert.equal(res.insight.status, 'ok');
  assert.equal(res.insight.text, 'All good.');
  assert.equal(res.insight.model, 'qwen3.5:4b');
  assert.equal(res.next.text, 'Ship it.');
  assert.equal(res.next.source, 'ai');
});
