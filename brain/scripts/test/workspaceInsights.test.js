'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPrompt, parseInsightReply, generateInsight } = require('../collectors/workspaceInsights');

test('buildPrompt includes name, status, objectives, subproject names', () => {
  const entry = {
    name: 'SN Claude Skills', status: 'active', summary: 'skill factory',
    objectives: [{ text: 'Ship onboarding' }],
    subprojects: [{ name: 'factory', status: 'active' }],
    next: { text: null }, lastEvent: { ageDays: 2 },
  };
  const p = buildPrompt(entry);
  assert.match(p, /SN Claude Skills/);
  assert.match(p, /active/);
  assert.match(p, /Ship onboarding/);
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
    model: 'qwen3.5:9b',
  });
  assert.equal(res.insight.status, 'ok');
  assert.equal(res.insight.text, 'All good.');
  assert.equal(res.insight.model, 'qwen3.5:9b');
  assert.equal(res.next.text, 'Ship it.');
  assert.equal(res.next.source, 'ai');
});

const NONE = { name: 'none', reason: 'forced', capabilities: { chat: false, embed: false, structured: false }, chat: async () => { throw new Error('must not be called'); } };
const ENTRY = { name: 'X', status: 'idle', summary: '', objectives: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], subprojects: [], next: { text: null, source: 'derived' }, lastEvent: { ageDays: 12 }, inputHash: 'h1' };

test('provider none → heuristic insight, status ok, model heuristic', async () => {
  const res = await generateInsight(ENTRY, { provider: NONE });
  assert.equal(res.insight.status, 'ok');
  assert.equal(res.insight.model, 'heuristic');
  assert.equal(res.insight.text, 'Stalled 12d · 3 objectives open · next step unset');
  assert.equal(res.insight.inputHash, 'h1');
  assert.deepEqual(res.next, ENTRY.next);
});

test('provider claude → heuristic unless scan.insightsUnderClaude is on', async () => {
  const fs = require('fs'); const path = require('path');
  const { PATHS } = require('../lib/paths.js');
  let calls = 0;
  const CLAUDE = { name: 'claude', reason: 'forced', capabilities: { chat: true, embed: false, structured: true }, chat: async () => { calls++; return 'INSIGHT: Claude says.\nNEXT: NONE'; } };
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none' }));
  const off = await generateInsight(ENTRY, { provider: CLAUDE });
  assert.equal(off.insight.model, 'heuristic');
  assert.equal(calls, 0);
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none', scan: { insightsUnderClaude: true } }));
  const on = await generateInsight(ENTRY, { provider: CLAUDE });
  assert.equal(calls, 1);
  assert.equal(on.insight.text, 'Claude says.');
  assert.equal(on.insight.model, 'haiku');
  fs.writeFileSync(PATHS.CONFIG_JSON, JSON.stringify({ provider: 'none' }));
});

test('provider ollama → chats with the workhorse tag and the feature label', async () => {
  let seen;
  const OLLAMA = { name: 'ollama', reason: 'forced', capabilities: { chat: true, embed: true, structured: true }, chat: async (o) => { seen = o; return 'INSIGHT: Fine.\nNEXT: Ship.'; } };
  const res = await generateInsight(ENTRY, { provider: OLLAMA });
  assert.equal(res.insight.text, 'Fine.');
  assert.equal(seen.feature, 'workspace-insights');
  assert.equal(res.insight.model, require('../sdk/lib/models.js').role('workhorse').tag);
});
