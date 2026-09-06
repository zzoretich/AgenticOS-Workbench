'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = TMP;
process.env.AOS_CONFIG = path.join(TMP, 'no-agenticos.json');
const provider = require('../sdk/lib/provider.js');
const { STATE_PATH, resolveProvider, getProvider, resetProviderCache, recordSpend, spendToday, ProviderUnavailable, SPEND_PATH } = provider;
const { role, providerFor } = require('../sdk/lib/models.js');

const CONFIG = path.join(TMP, 'brain', 'config.json');
const never = async () => { throw new Error('must not be called'); };
const spent = () => recordSpend({ feature: 't', provider: 'claude', model: 'haiku', usd: 0.5, inputTokens: 1, outputTokens: 1, ms: 1 });

beforeEach(() => {
  resetProviderCache();
  for (const f of [STATE_PATH, SPEND_PATH]) { try { fs.unlinkSync(f); } catch {} }
  fs.writeFileSync(CONFIG, '{}');
});

test('auto: reachable Ollama wins and the state file records the ping', async () => {
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => true, resolveClaudeBin: never, loginProbe: never } });
  assert.equal(p.name, 'ollama');
  assert.equal(p.reason, 'ollama-reachable');
  assert.deepEqual(p.capabilities, { chat: true, embed: true, structured: true });
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.name, 'ollama');
  assert.equal(st.ollama.reachable, true);
  assert.ok(Date.parse(st.ollama.checkedAt) > 0);
  assert.ok(Date.parse(st.checkedAt) > 0);
});

test('auto: no Ollama, no claude binary → none / no-provider; chat, embed, ping all say no', async () => {
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => null, loginProbe: never } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'no-provider');
  assert.deepEqual(p.capabilities, { chat: false, embed: false, structured: false });
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e instanceof ProviderUnavailable && e.code === 'PROVIDER_NONE' && e.provider === 'none');
  await assert.rejects(() => p.embed(['x']), (e) => e.code === 'PROVIDER_NONE');
  assert.equal(await p.ping(), false);
});

test('auto: claude present but not logged in → none / claude-not-logged-in, and the probe is cached for 24h', async () => {
  let probeOpts;
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/home/alice/.local/bin/claude', loginProbe: async (o) => { probeOpts = o; return false; } } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'claude-not-logged-in');
  assert.equal(probeOpts.timeoutMs, 10000, 'hook-sized cap, not loginProbe\'s 60 s default');
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.claude.loggedIn, false);
  assert.equal(st.claude.bin, '/home/alice/.local/bin/claude');
  let probes = 0;
  const again = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => { probes++; return '/x'; }, loginProbe: async () => { probes++; return true; } } });
  assert.equal(probes, 0, 'fresh state → no probe');
  assert.equal(again.name, 'none');
});

test('auto: logged-in claude → claude provider; chat maps format json → schema and returns structured output as text', async () => {
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'plain', structured: { ok: 1 }, usd: 0.003, usage: {}, ms: 5 }; };
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => true, claudeCall: fakeCall } });
  assert.equal(p.name, 'claude');
  assert.equal(p.reason, 'claude-logged-in');
  assert.deepEqual(p.capabilities, { chat: true, embed: false, structured: true });
  assert.equal(await p.ping(), true);
  const out = await p.chat({ system: 'sys', prompt: 'hi', format: 'json', feature: 'auto-wrap', numPredict: 2048, model: 'ignored', think: false });
  assert.equal(out, '{"ok":1}');
  assert.deepEqual(calls[0].schema, { type: 'object' });
  assert.equal(calls[0].system, 'sys');
  assert.equal(calls[0].prompt, 'hi');
  assert.equal(calls[0].model, 'haiku');
  assert.equal(calls[0].maxBudgetUsd, 0.05);
  assert.equal(calls[0].feature, 'auto-wrap');
  const plain = await p.chat({ messages: [{ role: 'user', content: 'yo' }] });
  assert.equal(plain, 'plain');
  assert.equal(calls[1].prompt, 'user: yo');
  assert.equal(calls[1].schema, undefined);
  const explicit = await p.chat({ prompt: 'x', schema: { type: 'object', properties: { a: { type: 'string' } } } });
  assert.equal(explicit, '{"ok":1}');
  assert.deepEqual(calls[2].schema, { type: 'object', properties: { a: { type: 'string' } } });
  await assert.rejects(() => p.embed(['x']), (e) => e.code === 'PROVIDER_NONE' && e.provider === 'claude');
});

test('config.ollama host/port reaches the ping seam', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ ollama: { host: '10.0.0.9', port: 4242 } }));
  const pings = [];
  const p = await resolveProvider({
    mode: 'auto',
    deps: { ping: async (...args) => { pings.push(args); return false; }, resolveClaudeBin: () => null, loginProbe: never },
  });
  assert.equal(p.name, 'none');
  assert.deepEqual(pings, [[2000, { host: '10.0.0.9', port: 4242 }]]);
});

test('forced ollama / none skip every probe; forced claude still runs the login probe', async () => {
  let pings = 0, probes = 0;
  const deps = { ping: async () => { pings++; return false; }, resolveClaudeBin: () => '/x', loginProbe: async () => { probes++; return true; } };
  const o = await resolveProvider({ mode: 'ollama', deps });
  assert.equal(o.name, 'ollama'); assert.equal(o.reason, 'forced');
  const n = await resolveProvider({ mode: 'none', deps });
  assert.equal(n.name, 'none'); assert.equal(n.reason, 'forced');
  assert.equal(pings, 0); assert.equal(probes, 0);
  const c = await resolveProvider({ mode: 'claude', deps });
  assert.equal(c.name, 'claude'); assert.equal(c.reason, 'forced');
  assert.equal(probes, 1); assert.equal(pings, 0);
});

test('daily cap: spend at or over perDayUsd resolves claude to none / daily-cap', async () => {
  spent();
  assert.equal(spendToday(), 0.5);
  const p = await resolveProvider({ mode: 'claude', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => true } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'daily-cap');
});

test('a claude chat that would cross the cap mid-day throws PROVIDER_CAP without spawning', async () => {
  const p = await resolveProvider({ mode: 'claude', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => true, claudeCall: never } });
  spent();
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e instanceof ProviderUnavailable && e.code === 'PROVIDER_CAP');
});

test('duty:* ledger rows never trip the hook cap — persona spend is gated by persona.perDayUsd, not claude.perDayUsd', async () => {
  // Plan 5's run-duty.sh writes feature "duty:<name>" rows (up to $2 each) into the same ledger;
  // the first duty of the day must not turn every hook into none/daily-cap.
  recordSpend({ feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 1.9, inputTokens: 1, outputTokens: 1, ms: 1 });
  assert.equal(spendToday(), 0);
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'ok', structured: null, usd: 0.001, usage: {}, ms: 1 }; };
  const p = await resolveProvider({ mode: 'claude', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => true, claudeCall: fakeCall } });
  assert.equal(p.name, 'claude');
  assert.equal(p.reason, 'forced');
  assert.equal(await p.chat({ prompt: 'x', feature: 'session-summary' }), 'ok');
  assert.equal(calls.length, 1);
});

test('a fresh ollama state entry (< 60 s) is reused without pinging', async () => {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ollama: { reachable: true, checkedAt: new Date().toISOString() } }));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: never, resolveClaudeBin: never, loginProbe: never } });
  assert.equal(p.name, 'ollama');
});

test('a stale ollama state entry (> 60 s) is re-pinged', async () => {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ollama: { reachable: true, checkedAt: new Date(Date.now() - 61_000).toISOString() } }));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => null } });
  assert.equal(p.name, 'none');
});

test('getProvider memoizes per process and takes the mode from config', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const a = await getProvider('x');
  const b = await getProvider('y');
  assert.equal(a, b);
  assert.equal(a.name, 'none');
  assert.equal(a.reason, 'forced');
});

test('models.js knows the claude role and maps roles to providers', () => {
  assert.equal(role('claude').tag, 'haiku');
  assert.equal(providerFor('claude'), 'claude');
  assert.equal(providerFor('workhorse'), 'ollama');
  assert.equal(providerFor('embedder'), 'ollama');
});
