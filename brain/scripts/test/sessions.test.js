'use strict';
// sessions.js: the command the app runs for each turn of a session (spec 2026-10-07-unidex-sessions S2, S6, S7).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../lib/sessions.js');

const SCRIPT = path.join(__dirname, '..', 'lib', 'sessions.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sessions-'));
const exe = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); return p; };
const CLAUDE = exe('claude');
const CODEX = exe('codex');
const both = { hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX, home: '/codex-home' } } };
const plan = (req, extra = {}) => S.plan({ cfg: both, req, env: { PATH: '/usr/bin:/bin' }, lookup: () => null, candidates: false, ...extra });

test('plan: a claude turn gets the per-turn cap as its budget, its binary and a headless env', () => {
  const p = plan({ host: 'claude', prompt: 'fix it', sessionId: 's1', allowCommands: true });
  assert.equal(p.ok, true);
  assert.equal(p.bin, CLAUDE);
  assert.equal(p.perTurnUsd, 1);
  assert.deepEqual(p.argv.slice(p.argv.indexOf('--max-budget-usd'), p.argv.indexOf('--max-budget-usd') + 2), ['--max-budget-usd', '1.00']);
  assert.ok(p.argv.includes('--allowedTools'));
  assert.deepEqual(p.env, { set: { AOS_HEADLESS: '1' }, unset: ['CLAUDECODE'] });
});

test('plan: a codex turn runs in its recorded Codex home, with no budget flag (estimated after the turn)', () => {
  const p = plan({ host: 'codex', prompt: 'fix it', resume: 't1' });
  assert.equal(p.ok, true);
  assert.equal(p.bin, CODEX);
  assert.deepEqual(p.env.set, { AOS_HEADLESS: '1', CODEX_HOME: '/codex-home' });
  assert.ok(!p.argv.includes('--max-budget-usd'));
  assert.equal(plan({ host: 'codex', prompt: 'x' }, { env: { PATH: '/usr/bin', CODEX_HOME: '/mine' } }).env.set.CODEX_HOME, undefined, 'a CODEX_HOME already set wins');
});

test('plan: refuses a host that is off or has no binary, a day at its cap, a cap of 0 and a turn with no prompt', () => {
  const off = { hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: false, bin: CODEX } } };
  assert.deepEqual(plan({ host: 'codex', prompt: 'x' }, { cfg: off }), { ok: false, reason: 'Codex is off on this machine' });
  assert.deepEqual(plan({ host: 'claude', prompt: 'x', sessionId: 's' }, { cfg: { hosts: { claude: { enabled: true } } } }), { ok: false, reason: 'no claude binary found' });
  assert.match(plan({ host: 'claude', prompt: 'x', sessionId: 's' }, { spentToday: 10 }).reason, /\$10\.00, reached the \$10 daily cap/);
  assert.equal(plan({ host: 'claude', prompt: 'x', sessionId: 's' }, { spentToday: 9.99 }).ok, true, 'under the cap a turn starts');
  assert.match(plan({ host: 'claude', prompt: 'x', sessionId: 's' }, { cfg: { ...both, sessions: { perDayUsd: 0 } } }).reason, /turns sessions off/);
  assert.deepEqual(plan({ host: 'claude', prompt: ' ', sessionId: 's' }), { ok: false, reason: 'a turn needs a prompt' });
  assert.deepEqual(plan({ host: 'nohost', prompt: 'x' }), { ok: false, reason: 'no such host: nohost' });
});

test('caps: the config wins; a turn cap that is not positive falls back to the default', () => {
  assert.deepEqual(S.caps({}), { perTurnUsd: 1, perDayUsd: 10 });
  assert.deepEqual(S.caps({ sessions: { perTurnUsd: 2.5, perDayUsd: 20 } }), { perTurnUsd: 2.5, perDayUsd: 20 });
  assert.deepEqual(S.caps({ sessions: { perTurnUsd: 0, perDayUsd: 'x' } }), { perTurnUsd: 1, perDayUsd: 10 });
});

// The commands, as the app runs them, against a throwaway vault.
function vault(cfg) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sessions-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), '# vault\n');
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify(cfg));
  const claudeDir = path.join(v, '.claude-config');
  fs.mkdirSync(claudeDir);
  return { v, env: { ...process.env, AOS_VAULT: v, CLAUDE_CONFIG_DIR: claudeDir } };
}
const cli = (args, env, input) => spawnSync(process.execPath, [SCRIPT, ...args], { env, input, encoding: 'utf8' });

test('CLI: args prints the plan; record ledgers the turn as session:<host>; the next args sees the spend against the cap', () => {
  const { v, env } = vault({ ...both, sessions: { perTurnUsd: 1, perDayUsd: 0.5 } });
  const first = cli(['args', JSON.stringify({ host: 'codex', prompt: 'fix it' })], env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).bin, CODEX);
  const rec = cli(['record', JSON.stringify({ host: 'codex', model: 'gpt-5-mini', usd: 0.6, inputTokens: 100, outputTokens: 10 })], env);
  assert.equal(rec.status, 0, rec.stderr);
  const row = JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'provider-spend.jsonl'), 'utf8').trim());
  assert.deepEqual([row.feature, row.provider, row.usd], ['session:codex', 'codex', 0.6]);
  const runs = () => fs.readFileSync(path.join(v, 'brain', '_index', 'agent-runs', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const run = runs()[0];
  assert.deepEqual([run.script, run.status, run.cost_usd, run.turns, run.host, run.model], ['session:codex', 'ok', 0.6, 1, 'codex', 'gpt-5-mini'], 'the turn is a row the Runs tab lists (S8)');
  assert.match(run.id, /^\d+-session-codex-[0-9a-f]{4}$/);
  // A turn that failed before the host reported a cost: a run row, and nothing in the ledger.
  assert.equal(cli(['record', JSON.stringify({ host: 'claude', usd: null, status: 'error', error: 'no binary', workspace: 'harbor-map', thread: 't1' })], env).status, 0);
  const failed = runs()[1];
  assert.deepEqual([failed.status, failed.cost_usd, failed.error, failed.workspace, failed.thread], ['error', null, 'no binary', 'harbor-map', 't1']);
  assert.equal(fs.readFileSync(path.join(v, 'brain', '_index', 'provider-spend.jsonl'), 'utf8').trim().split('\n').length, 1, 'no ledger row for a turn that cost nothing');
  const capped = cli(['args', JSON.stringify({ host: 'codex', prompt: 'more' })], env);
  assert.equal(capped.status, 3);
  assert.match(JSON.parse(capped.stdout).reason, /reached the \$0\.5 daily cap/);
  assert.equal(cli(['record', '{"host":"codex"}'], env).status, 2, 'a record with no usd is refused');
});

test('CLI: events turns a raw codex stream on stdin into normalised events on stdout', () => {
  const raw = [{ type: 'thread.started', thread_id: 't7' }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'hi' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const r = cli(['events', '--host', 'codex', '--model', 'gpt-5-mini'], process.env, raw);
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.kind), ['session', 'text', 'usage', 'done']);
  assert.equal(cli(['events', '--host', 'nohost'], process.env, '').status, 2);
  assert.equal(cli(['nope'], process.env).status, 2);
});

test('CLI: catalog asks no host that is off, saves the answer, then serves the cache while it is fresh', () => {
  const { v, env } = vault({ hosts: { claude: { enabled: false }, codex: { enabled: false } } });
  const r = cli(['catalog'], env);
  assert.equal(r.status, 0, r.stderr);
  const cat = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(cat.hosts).sort(), ['claude', 'codex']);
  assert.deepEqual([cat.hosts.claude.off, cat.hosts.codex.off], [true, true]);
  const file = path.join(v, 'brain', '_index', 'host-catalog.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), cat);
  // A fresh cache is read back as it is, so a marker written into it shows.
  fs.writeFileSync(file, JSON.stringify({ ...cat, marker: 'cached' }));
  assert.equal(JSON.parse(cli(['catalog'], env).stdout).marker, 'cached');
  assert.equal(JSON.parse(cli(['catalog', '--refresh'], env).stdout).marker, undefined, '--refresh asks again');
  assert.equal(cli(['catalog', '--host', 'nohost'], env).status, 2);
});
