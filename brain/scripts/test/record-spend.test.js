'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeJson, rowFrom, check, dutySpendFrom } = require('../persona/record-spend.js');

const RESULT = '{"type":"result","result":"done","total_cost_usd":0.0123,"usage":{"input_tokens":1505,"output_tokens":185},"duration_api_ms":2911}';

test('parseClaudeJson takes the last JSON object line and ignores noise', () => {
  assert.equal(parseClaudeJson(`warming up\n${RESULT}\n`).total_cost_usd, 0.0123);
  assert.equal(parseClaudeJson('{"a":1}\nnot json\n{"b":2}').b, 2);
  assert.equal(parseClaudeJson('nothing here'), null);
  assert.equal(parseClaudeJson(''), null);
});

test('rowFrom maps claude -p json output onto the provider ledger row shape', () => {
  const row = rowFrom(JSON.parse(RESULT), { feature: 'duty:monitor', model: 'haiku' });
  assert.equal(row.feature, 'duty:monitor');
  assert.equal(row.provider, 'claude');
  assert.equal(row.model, 'haiku');
  assert.equal(row.usd, 0.0123);
  assert.equal(row.inputTokens, 1505);
  assert.equal(row.outputTokens, 185);
  assert.equal(row.ms, 2911);
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
  const empty = rowFrom(null, { feature: 'x', model: 'm' });
  assert.deepEqual([empty.usd, empty.inputTokens, empty.outputTokens, empty.ms], [0, 0, 0, 0]);
});

test('check allows below the daily cap and refuses at or above it', () => {
  assert.deepEqual(check({ spendToday: () => 2, perDayUsd: 6 }), { allowed: true, spentToday: 2, perDayUsd: 6 });
  assert.equal(check({ spendToday: () => 6, perDayUsd: 6 }).allowed, false);
  assert.equal(check({ spendToday: () => 9, perDayUsd: 6 }).allowed, false);
});

test('dutySpendFrom sums only today\'s duty:* rows and skips bad lines', () => {
  const now = new Date().toISOString();
  const text = [
    JSON.stringify({ ts: now, feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 0.5 }),
    JSON.stringify({ ts: now, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 3 }),   // hook spend: not a duty
    JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', feature: 'duty:sitrep', usd: 9 }),                     // another day
    JSON.stringify({ ts: now, feature: 'duty:reflect', usd: '0.25' }),
    'not json',
    '',
  ].join('\n');
  assert.equal(dutySpendFrom(text), 0.75);
  assert.equal(dutySpendFrom(''), 0);
});
