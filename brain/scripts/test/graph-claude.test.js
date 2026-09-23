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
