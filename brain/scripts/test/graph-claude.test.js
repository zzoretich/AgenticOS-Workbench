'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The `claude` graphify runs during the semantic pass (spec 2026-09-23-graphify D6, D10, D12).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-claude-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ claude: { model: 'haiku' }, graph: { semantic: { perDayUsd: 0.5, perCallUsd: 0.1 } } }));
process.env.BRAIN_VAULT = TMP;
const shim = require('../graph-claude.js');
const { SPEND_PATH, graphSpendToday } = require('../sdk/lib/spend-ledger.js');

const ENVELOPE = JSON.stringify({ type: 'result', is_error: false, result: '{}', total_cost_usd: 0.012, duration_api_ms: 850, usage: { input_tokens: 2000, cache_read_input_tokens: 200, output_tokens: 900 } });
function sink() { const s = { text: '', write(x) { s.text += x; } }; return s; }
function fakeSpawn(reply, calls) {
  return (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 0, stdout: '', stderr: '', ...reply }; };
}
function run(argv, { reply = { stdout: ENVELOPE }, env = {}, input = 'the prompt' } = {}) {
  const calls = [];
  const out = sink();
  const err = sink();
  const code = shim.main(argv, { env: { PATH: '/bin', AOS_GRAPH_CLAUDE_BIN: '/x/claude', CLAUDECODE: '1', ...env }, spawn: fakeSpawn(reply, calls), readStdin: () => input, out, err });
  return { code, calls, out: out.text, err: err.text };
}
const GRAPHIFY_ARGV = ['-p', '--output-format', 'json', '--no-session-persistence', '--model', 'opus', '--json-schema', '{"type":"object"}'];

beforeEach(() => { try { fs.unlinkSync(SPEND_PATH); } catch {} });

test('a call runs the real CLI isolated, headless, without thinking, on the configured model and per-call cap', () => {
  const r = run(GRAPHIFY_ARGV);
  assert.equal(r.code, 0);
  assert.equal(r.calls[0].bin, '/x/claude');
  assert.deepEqual(r.calls[0].args, ['-p', '--output-format', 'json', '--no-session-persistence', '--json-schema', '{"type":"object"}',
    '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--system-prompt', shim.SYSTEM, '--model', 'haiku', '--max-budget-usd', '0.1']);
  const env = r.calls[0].opts.env;
  assert.equal(env.AOS_HEADLESS, '1');
  assert.equal(env.MAX_THINKING_TOKENS, '0');
  assert.ok(!('CLAUDECODE' in env));
  assert.ok(!('AOS_GRAPH_CLAUDE_BIN' in env));
  assert.equal(r.calls[0].opts.input, 'the prompt', 'the prompt on stdin, passed through');
  assert.equal(r.out, ENVELOPE, 'stdout passed through byte for byte');
});

test('each call is one graph:semantic ledger row from the envelope', () => {
  run(GRAPHIFY_ARGV);
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'graph:semantic');
  assert.equal(rows[0].model, 'haiku');
  assert.equal(rows[0].usd, 0.012);
  assert.equal(rows[0].inputTokens, 2200, 'input + cache reads');
  assert.equal(rows[0].outputTokens, 900);
  assert.equal(rows[0].ms, 850);
  assert.equal(graphSpendToday(), 0.012);
});

test('once today\'s graph spend reaches the cap the shim refuses without spawning', () => {
  fs.writeFileSync(SPEND_PATH, JSON.stringify({ ts: new Date().toISOString(), feature: 'graph:semantic', usd: 0.5 }) + '\n');
  const r = run(GRAPHIFY_ARGV);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.err, /today's graph budget is spent \(\$0\.5000 of \$0\.5\)/);
});

test('--help and --version pass straight through; a non-JSON answer or a failed call ledgers nothing', () => {
  const h = run(['--help'], { reply: { stdout: 'Usage: claude … --json-schema' } });
  assert.equal(h.code, 0);
  assert.deepEqual(h.calls[0].args, ['--help']);
  assert.match(h.out, /--json-schema/);
  const bad = run(GRAPHIFY_ARGV, { reply: { status: 1, stdout: 'not json', stderr: 'boom' } });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /boom/);
  assert.ok(!fs.existsSync(SPEND_PATH));
});

test('an API key graph-build.js kept away from graphify is handed back to the real CLI', () => {
  const r = run(GRAPHIFY_ARGV, { env: { AOS_GRAPH_ANTHROPIC_API_KEY: 'k' } });
  assert.equal(r.calls[0].opts.env.ANTHROPIC_API_KEY, 'k');
  assert.ok(!('AOS_GRAPH_ANTHROPIC_API_KEY' in r.calls[0].opts.env));
});

test('without AOS_GRAPH_CLAUDE_BIN the shim refuses (it must never find itself on PATH)', () => {
  const err = sink();
  assert.equal(shim.main(GRAPHIFY_ARGV, { env: { PATH: '/bin' }, spawn: () => { throw new Error('spawned'); }, readStdin: () => '', out: sink(), err }), 127);
  assert.match(err.text, /AOS_GRAPH_CLAUDE_BIN is not set/);
});

// ── the Codex leg (spec 2026-09-23-codex-parity-gaps D3/D4): same argv from graphify, the answer from codex exec.
function runCodex(argv, { call, env = {}, input = 'the prompt' } = {}) {
  const calls = [];
  const out = sink();
  const err = sink();
  const codexCall = call || (async (o) => { calls.push(o); return { text: '{"nodes":[]}', usage: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 60 }, usd: 0.004, ms: 900, model: 'gpt-5-mini' }; });
  return Promise.resolve(shim.main(argv, { env: { AOS_GRAPH_RUNNER: 'codex', AOS_GRAPH_CODEX_BIN: '/x/codex', ...env }, readStdin: () => input, out, err, codexCall, mkTemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcx-')) }))
    .then((code) => ({ code, calls, out: out.text, err: err.text }));
}

test('codex leg: one codex call per graphify call, answered as the claude result envelope graphify parses', async () => {
  const r = await runCodex(GRAPHIFY_ARGV);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].prompt, 'the prompt');
  assert.equal(r.calls[0].system, shim.SYSTEM);
  assert.equal(r.calls[0].effort, 'low');
  assert.equal(r.calls[0].feature, 'graph:semantic', 'codexCall ledgers the row under the graph family');
  assert.equal(r.calls[0].bin, '/x/codex');
  const env = JSON.parse(r.out);
  assert.equal(env.type, 'result');
  assert.equal(env.result, '{"nodes":[]}');
  assert.deepEqual(env.usage, { input_tokens: 600, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 60 });
  assert.deepEqual(Object.keys(env.modelUsage), ['gpt-5-mini']);
  assert.equal(env.stop_reason, 'end_turn');
});

test('codex leg: --help and --version answer locally; the cap refuses; a failed call or a missing binary fails the chunk', async () => {
  const help = await runCodex(['--help'], { call: async () => { throw new Error('must not be called'); } });
  assert.equal(help.code, 0);
  assert.match(help.out, /codex exec/);
  fs.writeFileSync(SPEND_PATH, JSON.stringify({ ts: new Date().toISOString(), feature: 'graph:semantic', provider: 'codex', usd: 0.5 }) + '\n');
  const capped = await runCodex(GRAPHIFY_ARGV, { call: async () => { throw new Error('must not be called'); } });
  assert.equal(capped.code, 1);
  assert.match(capped.err, /graph budget is spent/);
  fs.unlinkSync(SPEND_PATH);
  const failed = await runCodex(GRAPHIFY_ARGV, { call: async () => { throw new Error('codex exec exited 1: boom'); } });
  assert.equal(failed.code, 1);
  assert.equal(failed.out, '', 'nothing graphify could parse as an answer');
  const noBin = await runCodex(GRAPHIFY_ARGV, { env: { AOS_GRAPH_CODEX_BIN: '' } });
  assert.equal(noBin.code, 127);
});
