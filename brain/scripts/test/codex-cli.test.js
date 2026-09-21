'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cxcli-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = TMP;
process.env.CLAUDECODE = '1';
const cli = require('../sdk/lib/codex-cli.js');
const { priceUsd, rateFor } = require('../sdk/lib/codex-pricing.js');
const { SPEND_PATH, ProviderUnavailable } = require('../sdk/lib/spend-ledger.js');

// Fake `codex exec`: records the spawn, collects what was written to stdin, then emits the JSONL
// events and closes with `code`. Codex writes the -o file itself in real life; the fake does not,
// so codexCall falls back to the last agent_message event.
function fakeSpawn(reply, calls) {
  return (bin, args, opts) => {
    const rec = { bin, args, opts, stdin: '', stdinEnded: false, killed: null };
    calls.push(rec);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (c) => { rec.stdin += c; });
    child.stdin.on('finish', () => { rec.stdinEnded = true; });
    child.kill = (sig) => { rec.killed = sig; };
    if (!reply.hang) {
      setImmediate(() => {
        child.stdout.end(reply.stdout || '');
        child.stderr.end(reply.stderr || '');
        setImmediate(() => child.emit('close', reply.code ?? 0));
      });
    }
    return child;
  };
}

const EVENTS = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"word":"pong"}' } },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 20 } },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

beforeEach(() => { try { fs.unlinkSync(SPEND_PATH); } catch {} });

test('buildArgs reproduces the measured recipe: ephemeral, read-only, hooks off, json, -o, prompt on stdin', () => {
  const a = cli.buildArgs({ model: 'gpt-5-mini', effort: 'low', schemaFile: '/t/s.json', outFile: '/t/out.txt' });
  assert.deepEqual(a, ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'features.hooks=false',
    '--json', '-o', '/t/out.txt', '-m', 'gpt-5-mini', '-c', 'model_reasoning_effort="low"', '--output-schema', '/t/s.json', '-']);
  const bare = cli.buildArgs({ model: null, outFile: '/t/out.txt' });
  assert.ok(!bare.includes('-m'), 'no model → the user\'s Codex default');
  assert.ok(!bare.includes('--output-schema'));
  assert.equal(bare[bare.length - 1], '-');
  assert.ok(!cli.buildArgs({ model: null, effort: 'max', outFile: '/t/o' }).some((x) => /model_reasoning_effort/.test(x)));
});

test('pricing: exact, longest-prefix and default rates; cached input at a tenth', () => {
  assert.equal(rateFor('gpt-5-mini').matched, 'exact');
  assert.equal(rateFor('gpt-5.6-sol').model, 'gpt-5');
  assert.equal(rateFor('gpt-5-codex-mini').model, 'gpt-5-codex');
  assert.equal(rateFor('something-new').matched, 'default');
  // (1000-400)*0.25 + 400*0.025 + 50*2 = 150 + 10 + 100 = 260 µUSD
  assert.equal(priceUsd('gpt-5-mini', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 }), 0.00026);
  assert.equal(priceUsd('gpt-5-mini', {}), 0);
});

test('codexCall: system + prompt go to stdin and stdin is closed; events give text, usage, usd; the spend is ledgered', async () => {
  const calls = [];
  const out = await cli.codexCall({
    system: 'S', prompt: 'ping', schema: { type: 'object' }, model: 'gpt-5-mini',
    feature: 'probe-test', bin: '/x/codex', spawnFn: fakeSpawn({ stdout: EVENTS }, calls),
  });
  assert.equal(out.text, '{"word":"pong"}');
  assert.deepEqual(out.structured, { word: 'pong' });
  assert.equal(out.usd, 0.00026);
  assert.equal(out.usage.inputTokens, 1000);
  assert.equal(out.model, 'gpt-5-mini');
  assert.equal(calls[0].bin, '/x/codex');
  assert.equal(calls[0].args[0], 'exec');
  assert.equal(calls[0].stdin, 'S\n\n---\n\nping');
  assert.equal(calls[0].stdinEnded, true, 'an open stdin would hang codex exec forever');
  assert.equal(calls[0].opts.cwd, TMP);
  assert.equal(calls[0].opts.env.AOS_HEADLESS, '1');
  assert.ok(!('CLAUDECODE' in calls[0].opts.env));
  assert.deepEqual(calls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
  const schemaArg = calls[0].args[calls[0].args.indexOf('--output-schema') + 1];
  assert.ok(!fs.existsSync(schemaArg), 'the temp schema file is removed afterwards');
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'codex');
  assert.equal(rows[0].feature, 'probe-test');
  assert.equal(rows[0].model, 'gpt-5-mini');
  assert.equal(rows[0].usd, 0.00026);
  assert.equal(rows[0].inputTokens, 1000);
  assert.equal(rows[0].outputTokens, 50);
});

test('codexCall without a schema returns plain text and null structured; no model → pricingModel or codex-default', async () => {
  const out = await cli.codexCall({ prompt: 'p', bin: '/x/codex', spawnFn: fakeSpawn({ stdout: EVENTS }, []), pricingModel: 'gpt-5' });
  assert.equal(out.structured, null);
  assert.equal(out.text, '{"word":"pong"}');
  assert.equal(out.model, 'gpt-5');
});

test('"not logged in" on a failed call → ProviderUnavailable PROVIDER_UNREACHABLE, nothing ledgered', async () => {
  await assert.rejects(
    () => cli.codexCall({ prompt: 'p', bin: '/x/codex', spawnFn: fakeSpawn({ stderr: 'Error: not logged in. Run `codex login`.', code: 1 }, []) }),
    (e) => e instanceof ProviderUnavailable && e.code === 'PROVIDER_UNREACHABLE' && e.provider === 'codex');
  assert.ok(!fs.existsSync(SPEND_PATH));
});

test('a non-zero exit carries the turn.failed message; a billed failure is still ledgered', async () => {
  const failed = EVENTS + JSON.stringify({ type: 'turn.failed', error: { message: 'model overloaded' } }) + '\n';
  await assert.rejects(
    () => cli.codexCall({ prompt: 'p', feature: 'billed-failure', bin: '/x/codex', spawnFn: fakeSpawn({ stdout: failed, code: 1 }, []) }),
    (e) => !(e instanceof ProviderUnavailable) && /exited 1/.test(e.message) && /model overloaded/.test(e.message));
  const rows = fs.readFileSync(SPEND_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, 'billed-failure');
});

test('timeout kills the child and rejects', async () => {
  const calls = [];
  await assert.rejects(
    () => cli.codexCall({ prompt: 'p', bin: '/x/codex', timeoutMs: 20, spawnFn: fakeSpawn({ hang: true }, calls) }),
    /timeout after 20ms/);
  assert.equal(calls[0].killed, 'SIGKILL');
});

test('loginProbe reads `codex login status` and never calls a model', async () => {
  const seen = [];
  const execOk = (bin, args, opts, cb) => { seen.push({ bin, args }); cb(null, 'Logged in using ChatGPT\n', ''); };
  const execNo = (bin, args, opts, cb) => cb(null, 'Not logged in\n', '');
  const execErr = (bin, args, opts, cb) => cb(new Error('spawn failed'), '', '');
  assert.equal(await cli.loginProbe({ bin: '/x/codex', execFn: execOk }), true);
  assert.deepEqual(seen[0].args, ['login', 'status']);
  assert.equal(await cli.loginProbe({ bin: '/x/codex', execFn: execNo }), false);
  assert.equal(await cli.loginProbe({ bin: '/x/codex', execFn: execErr }), false);
  assert.equal(await cli.loginProbe({ bin: null, lookup: () => null, candidates: [], execFn: execOk }), false);
});

test('resolveCodexBin: recorded hosts.codex.bin wins while executable, then PATH, then candidates', () => {
  const exe = path.join(TMP, 'codex');
  fs.writeFileSync(exe, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  assert.equal(cli.resolveCodexBin({ recorded: exe, lookup: () => '/from/path/codex' }), exe);
  assert.equal(cli.resolveCodexBin({ recorded: path.join(TMP, 'gone'), lookup: () => '/from/path/codex' }), '/from/path/codex');
  assert.equal(cli.resolveCodexBin({ recorded: null, lookup: () => null, candidates: [path.join(TMP, 'missing'), exe] }), exe);
  assert.equal(cli.resolveCodexBin({ recorded: null, lookup: () => null, candidates: [] }), null);
  const cfgFile = path.join(TMP, 'agenticos.json');
  const saved = process.env.AOS_CONFIG;
  process.env.AOS_CONFIG = cfgFile;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({ hosts: { codex: { enabled: true, bin: exe } } }));
    assert.equal(cli.resolveCodexBin({ lookup: () => '/from/path/codex' }), exe);
    fs.writeFileSync(cfgFile, JSON.stringify({ codex: { bin: exe } }));
    assert.equal(cli.resolveCodexBin({ lookup: () => '/from/path/codex' }), exe, 'legacy codex.bin still honoured');
  } finally { process.env.AOS_CONFIG = saved; }
});

test('defaultModelFromConfig reads only the top-level model line of config.toml', () => {
  const toml = path.join(TMP, 'config.toml');
  fs.writeFileSync(toml, '# comment\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n[profiles.x]\nmodel = "other"\n');
  assert.equal(cli.defaultModelFromConfig(toml), 'gpt-5.6-sol');
  fs.writeFileSync(toml, '[mcp_servers.a]\nmodel = "not-top-level"\n');
  assert.equal(cli.defaultModelFromConfig(toml), null);
  assert.equal(cli.defaultModelFromConfig(path.join(TMP, 'absent.toml')), null);
});

test('parseEvents tolerates junk lines and collects error items', () => {
  const r = cli.parseEvents('junk\n' + JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'warned' } }) + '\n' + EVENTS);
  assert.deepEqual(r.errors, ['warned']);
  assert.equal(r.lastMessage, '{"word":"pong"}');
  assert.equal(r.usage.cachedInputTokens, 400);
});
