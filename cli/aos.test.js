'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AOS = path.join(ROOT, 'cli', 'aos.js');
const FAKE_CLAUDE = path.join(ROOT, 'cli', 'fixtures', 'fake-claude.sh');
const FAKE_NPM = path.join(ROOT, 'cli', 'fixtures', 'fake-npm.sh');

/** Isolated sandbox: temp HOME + CLAUDE_CONFIG_DIR, fakes for claude and npm. Nothing touches ~/.claude. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cli-'));
  const home = path.join(dir, 'home');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    AOS_CLAUDE_BIN: FAKE_CLAUDE,
    AOS_NPM_BIN: FAKE_NPM,
    FAKE_CLAUDE_LOG: path.join(dir, 'claude.log'),
    FAKE_NPM_LOG: path.join(dir, 'npm.log'),
    FAKE_NPM_NODE_MODULES: path.join(ROOT, 'node_modules'),
    // No test may contact Ollama: doctor/init probe an endpoint nothing listens on (config.ollama > env > default).
    OLLAMA_PORT: '1',
  };
  delete env.AOS_VAULT; delete env.BRAIN_VAULT; delete env.AOS_CONFIG; delete env.CLAUDE_PROJECT_DIR;
  return { dir, home, cfg, vault: path.join(dir, 'vault'), env, log: (f) => { try { return fs.readFileSync(env[f], 'utf8'); } catch { return ''; } } };
}
function aos(sb, args, extraEnv = {}) {
  return spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', env: { ...sb.env, ...extraEnv }, cwd: ROOT });
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('no command prints usage and exits 2; unknown command exits 2', () => {
  const sb = sandbox();
  const none = aos(sb, []);
  assert.equal(none.status, 2);
  assert.match(none.stdout + none.stderr, /aos init/);
  assert.equal(aos(sb, ['frobnicate']).status, 2);
});

test('doctor without agenticos.json fails that check and exits 1', () => {
  const sb = sandbox();
  const r = aos(sb, ['doctor']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+agenticos\.json/);
  assert.match(r.stdout, /ok\s+node >= 20/);
  assert.match(r.stdout, /ok\s+claude login/);
});

test('status and provider need a config; provider validates its argument', () => {
  const sb = sandbox();
  assert.equal(aos(sb, ['status']).status, 1);
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({
    vault: sb.vault, node: process.execPath, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 },
  }, null, 2));
  fs.mkdirSync(path.join(sb.vault, 'brain', '_index'), { recursive: true });
  const day = new Date();
  const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).toISOString();
  // Contract §3: `duty:<name>` rows are the persona's (persona.perDayUsd), every other row is a hook call
  // (claude.perDayUsd). The $2 duty row must not land on the hook line.
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'provider-spend.jsonl'),
    `${JSON.stringify({ ts, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 0.01 })}\n` +
    `${JSON.stringify({ ts, feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 2 })}\n` +
    `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', feature: 'x', provider: 'claude', model: 'haiku', usd: 5 })}\n`);
  // Real ledger shape (lib/pipeline-report.js): { version, pipelines: { name: { lastRun, history } } }.
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'pipelines.json'), JSON.stringify({
    version: 1,
    pipelines: {
      'scan-vault': { lastRun: { startedAt: '2026-09-04T09:59:58.000Z', endedAt: '2026-09-04T10:00:00.000Z', durationMs: 2000, status: 'ok', error: null, wrote: [], counts: {}, pid: 1, provider: 'none', reason: null }, history: [] },
      'auto-cost': { lastRun: { startedAt: '2026-09-04T10:00:01.000Z', endedAt: '2026-09-04T10:00:01.000Z', durationMs: 0, status: 'disabled', error: null, wrote: [], counts: {}, pid: 1, provider: null, reason: 'cost disabled' }, history: [] },
      'auto-wrap': { lastRun: null, history: [] },
    },
  }));
  const st = aos(sb, ['status']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /provider\s+mode=auto resolved=never resolved/);
  assert.match(st.stdout, /spend\s+today \(hooks\) \$0\.0100 \/ cap \$0\.5/);
  assert.match(st.stdout, /spend\s+today \(duties\) \$2\.0000 \/ cap \$6/);
  assert.ok(!/today \(hooks\) \$2\./.test(st.stdout), 'duty spend never counts against the hook cap');
  assert.match(st.stdout, /scan-vault\s+ok\s+none\s+2026-09-04T10:00:00/);
  assert.match(st.stdout, /auto-cost\s+disabled\s+-.*cost disabled/);
  assert.match(st.stdout, /auto-wrap\s+never/);
  assert.ok(!/^\s+(version|pipelines)\s/m.test(st.stdout), 'ledger envelope keys are not printed as rows');
  assert.match(st.stdout, /^claude\s+bin=.*login=unprobed$/m);

  assert.equal(aos(sb, ['provider', 'bogus']).status, 2);
  const set = aos(sb, ['provider', 'ollama']);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).provider, 'ollama');
  assert.equal(aos(sb, ['provider']).stdout.trim(), 'ollama');
});

test('parseArgs handles value flags, --no-flags, booleans and positionals', () => {
  const { parseArgs } = require('./aos.js');
  const a = parseArgs(['init', '--vault', '/tmp/v', '--no-obsidian', '--yes', '--persona-json', 'p.json', 'extra']);
  assert.equal(a.cmd, 'init');
  assert.deepEqual(a.sub, ['extra']);
  assert.deepEqual(a.flags, { vault: '/tmp/v', obsidian: false, yes: true, personaJson: 'p.json' });
  assert.throws(() => parseArgs(['init', '--vault']), /needs a value/);
});
