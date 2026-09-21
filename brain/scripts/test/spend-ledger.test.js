'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = TMP;
const { ProviderUnavailable, recordSpend, spendToday, reasonSpendToday, routineSpendToday, SPEND_PATH } = require('../sdk/lib/spend-ledger.js');

beforeEach(() => { try { fs.unlinkSync(SPEND_PATH); } catch {} });

test('ProviderUnavailable carries a code and a provider name', () => {
  const e = new ProviderUnavailable('PROVIDER_NONE', 'no model', 'none');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ProviderUnavailable');
  assert.equal(e.code, 'PROVIDER_NONE');
  assert.equal(e.provider, 'none');
  assert.equal(e.message, 'no model');
  assert.equal(new ProviderUnavailable('PROVIDER_CAP').message, 'PROVIDER_CAP');
});

test('recordSpend appends one JSON line per call under brain/_index', () => {
  const row = recordSpend({ feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 0.0034, inputTokens: 1505, outputTokens: 185, ms: 2911 });
  assert.equal(SPEND_PATH, path.join(TMP, 'brain', '_index', 'provider-spend.jsonl'));
  const lines = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.feature, 'session-summary');
  assert.equal(parsed.usd, 0.0034);
  assert.equal(parsed.inputTokens, 1505);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(parsed.ts));
  assert.equal(row.ts, parsed.ts);
});

test('spendToday sums only rows stamped on the local calendar day and ignores torn lines', () => {
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  fs.writeFileSync(SPEND_PATH,
    JSON.stringify({ ts: old, usd: 1 }) + '\n' +
    JSON.stringify({ ts: new Date().toISOString(), usd: 0.02 }) + '\n' +
    '{"ts":"broken\n' +
    JSON.stringify({ ts: new Date().toISOString(), usd: 0.01 }) + '\n');
  assert.equal(spendToday(), 0.03);
});

test('spendToday is 0 when the ledger does not exist', () => {
  assert.equal(spendToday(), 0);
});

test('spendToday skips duty:* rows (persona cap) but counts chat and hook rows (hook cap)', () => {
  // Plan 5's run-duty.sh ledgers up to $2 per duty as feature "duty:<name>"; those rows are gated by
  // persona.perDayUsd, so they must never push the $0.50 hook cap to daily-cap. Plan 4's Chat tab
  // ledgers feature "chat" and that DOES count (spec §3 invariant 1).
  const now = new Date().toISOString();
  fs.writeFileSync(SPEND_PATH,
    JSON.stringify({ ts: now, feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 1.75 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'chat', provider: 'claude', model: 'haiku', usd: 0.02 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 0.01 }) + '\n');
  assert.equal(spendToday(), 0.03, 'duty rows never count against claude.perDayUsd');
  assert.equal(spendToday(new Date(), { exclude: null }), 1.78, 'exclude:null sums every row');
  assert.equal(spendToday(new Date(), { exclude: /^(duty:|chat$)/ }), 0.01, 'a custom exclude pattern is honored');
});

test('reason:* rows are the reasoner cap\'s and never the hook cap\'s; reasonSpendToday sums only them', () => {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  fs.writeFileSync(SPEND_PATH,
    JSON.stringify({ ts: now, feature: 'reason:ask', provider: 'claude', model: 'claude-opus-5', usd: 0.4 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'reason:chat', provider: 'claude', model: 'claude-opus-5', usd: 0.25 }) + '\n' +
    JSON.stringify({ ts: yesterday, feature: 'reason:ask', provider: 'claude', model: 'claude-opus-5', usd: 3 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'duty:sitrep', provider: 'claude', model: 'haiku', usd: 1.1 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'auto-wrap', provider: 'claude', model: 'haiku', usd: 0.01 }) + '\n');
  assert.equal(spendToday(), 0.01, 'the hook cap sees neither reason:* nor duty:* rows');
  assert.equal(reasonSpendToday(), 0.65, 'today\'s reason:* rows only');
  assert.equal(spendToday(new Date(), { include: /^duty:/, exclude: null }), 1.1, 'include keeps one family');
  assert.equal(spendToday(new Date(), { exclude: null }), 1.76);
});

test('routine:* rows are the routines cap\'s and never the hook cap\'s; routineSpendToday sums only them', () => {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  fs.writeFileSync(SPEND_PATH,
    JSON.stringify({ ts: now, feature: 'routine:morning-brief', provider: 'claude', model: 'haiku', usd: 0.3 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'routine:digest', provider: 'claude', model: 'haiku', usd: 0.2 }) + '\n' +
    JSON.stringify({ ts: yesterday, feature: 'routine:digest', provider: 'claude', model: 'haiku', usd: 2 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'duty:sitrep', provider: 'claude', model: 'haiku', usd: 1.1 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'reason:ask', provider: 'claude', model: 'claude-opus-5', usd: 0.4 }) + '\n' +
    JSON.stringify({ ts: now, feature: 'auto-wrap', provider: 'claude', model: 'haiku', usd: 0.01 }) + '\n');
  assert.equal(spendToday(), 0.01, 'the hook cap sees none of the three metered families');
  assert.equal(routineSpendToday(), 0.5, 'today\'s routine:* rows only');
  assert.equal(reasonSpendToday(), 0.4, 'reason rows unaffected');
});
