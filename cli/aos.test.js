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
    // …and once init has written agenticos.json (config outranks env) the probe is skipped outright.
    AOS_SKIP_OLLAMA_PROBE: '1',
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
  assert.match(r.stdout, /info\s+ollama reachable\s+127\.0\.0\.1:1 not probed \(AOS_SKIP_OLLAMA_PROBE=1\)/);
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
  const eq = parseArgs(['init', '--vault=/tmp/v', '--provider=none', '--dry-run']);
  assert.deepEqual(eq.flags, { vault: '/tmp/v', provider: 'none', dryRun: true });
  assert.throws(() => parseArgs(['init', '--vault=']), /needs a value/);
  assert.throws(() => parseArgs(['init', '--dry-rnu']), /unknown flag --dry-rnu/);
  assert.throws(() => parseArgs(['init', '--no-cost']), /unknown flag --no-cost/);
});

test('mcpProbe rejects at once on an initialize error and on an early server exit (no timeout wait)', async () => {
  const { mcpProbe } = require('./aos.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mcpprobe-'));
  const vault = path.join(dir, 'vault');
  const binDir = path.join(vault, 'brain', 'scripts', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'aos');
  const prevConfig = process.env.AOS_CONFIG;
  process.env.AOS_CONFIG = path.join(dir, 'no-such-config.json');
  try {
    fs.writeFileSync(scriptPath,
      '#!/bin/sh\nread line\necho \'{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"boom"}}\'\nexit 0\n');
    fs.chmodSync(scriptPath, 0o755);
    let t0 = Date.now();
    await assert.rejects(mcpProbe({ vault, timeoutMs: 5000 }), /initialize: boom/);
    assert.ok(Date.now() - t0 < 4000, 'initialize error should reject immediately, not wait out the timeout');

    fs.writeFileSync(scriptPath,
      '#!/bin/sh\nread line\necho \'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"agenticos","version":"0"}}}\'\nexit 0\n');
    fs.chmodSync(scriptPath, 0o755);
    t0 = Date.now();
    await assert.rejects(mcpProbe({ vault, tool: 'recall', args: {}, timeoutMs: 5000 }), /exited 0 before answering/);
    assert.ok(Date.now() - t0 < 4000, 'early exit should reject immediately, not wait out the timeout');
  } finally {
    if (prevConfig === undefined) delete process.env.AOS_CONFIG; else process.env.AOS_CONFIG = prevConfig;
  }
});

test('init --dry-run prints the numbered plan and writes nothing', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--dry-run', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('[dry-run] '));
  assert.deepEqual(lines.map((l) => l.replace(/^\[dry-run\] (\d+)\. (\S+).*/, '$1 $2')),
    ['1 copy', '2 vendor', '3 write', '4 register', '5 run', '6 first']);
  assert.ok(!fs.existsSync(sb.vault));
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'agenticos.json')));
  assert.equal(sb.log('FAKE_NPM_LOG'), '');
});

test('init refuses the config dir, a dir with settings.json, and the home dir', () => {
  const sb = sandbox();
  for (const bad of [sb.cfg, path.join(sb.cfg, 'vault'), sb.home]) {
    const r = aos(sb, ['init', '--vault', bad, '--no-obsidian', '--provider', 'none', '--yes']);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /refusing/);
  }
  const withSettings = path.join(sb.dir, 'other');
  fs.mkdirSync(withSettings, { recursive: true });
  fs.writeFileSync(path.join(withSettings, 'settings.json'), '{}');
  assert.match(aos(sb, ['init', '--vault', withSettings, '--no-obsidian', '--provider', 'none', '--yes']).stderr, /settings\.json/);
});

test('init into a temp vault: seed set, vendored runtime, agenticos.json, plugin calls, launcher link', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const v = sb.vault;
  for (const rel of ['MEMORY.md', 'AGENTICOS.md', '.gitignore', 'brain/config.json', 'brain/_index/SESSION.md', 'brain/_index/BRAIN.md',
    'brain/_index/MOC-reference.md', 'brain/_index/MOC-projects.md', 'brain/_index/MOC-patterns.md', 'brain/_index/scanner-config.json',
    'brain/memory/user/profile.md', 'brain/memory/feedback/README.md', 'brain/memory/projects/README.md', 'brain/memory/reference/README.md',
    'brain/patterns/README.md', 'templates/daily-note.md', 'templates/meeting-note.md', 'templates/decision-record.md', 'templates/project-note.md',
    '.obsidian/app.json', '.obsidian/community-plugins.json', '.obsidian/daily-notes.json',
    'brain/scripts/package.json', 'brain/scripts/config.default.json', 'brain/scripts/lib/paths.js', 'brain/scripts/sdk/mcp-server.js',
    'brain/scripts/cli/aos.js', 'brain/scripts/bin/aos', 'brain/scripts/node_modules']) {
    assert.ok(fs.existsSync(path.join(v, rel)), `missing ${rel}`);
  }
  assert.ok(!fs.existsSync(path.join(v, '_gitignore')));
  assert.ok(!fs.existsSync(path.join(v, 'brain', 'scripts', 'test')), 'tests are not vendored');
  assert.ok(!fs.existsSync(path.join(v, 'brain', 'scripts', 'package-lock.json')), 'no lockfile is vendored (contract §4.3)');
  assert.ok(fs.statSync(path.join(v, 'brain', 'scripts', 'bin', 'aos')).mode & 0o100, 'launcher is executable');
  assert.match(fs.readFileSync(path.join(v, 'brain', '_index', 'SESSION.md'), 'utf8'), new RegExp(`^updated: ${new Date().getFullYear()}-`, 'm'));
  assert.equal(readJson(path.join(v, 'brain', 'config.json')).dailyNote.layout, '{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md');
  assert.deepEqual(readJson(path.join(v, '.obsidian', 'daily-notes.json')), { folder: String(new Date().getFullYear()), format: 'YYYY-MM-DD' });

  const cfg = readJson(path.join(sb.cfg, 'agenticos.json'));
  assert.deepEqual(Object.keys(cfg), ['version', 'vault', 'node', 'claudeConfigDir', 'provider', 'claude', 'ollama', 'telemetry', 'cost', 'persona']);
  assert.equal(cfg.vault, v);
  assert.equal(cfg.node, process.execPath);
  assert.equal(cfg.claudeConfigDir, sb.cfg);
  assert.equal(cfg.provider, 'none');
  assert.deepEqual(cfg.claude, { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 });
  assert.deepEqual(cfg.cost, { enabled: false });
  assert.deepEqual(cfg.persona, { enabled: true });

  // Contract §4.3: exactly one `npm install --omit=dev` in the vendored runtime; no lockfile step, no `npm ci`.
  const npmLog = sb.log('FAKE_NPM_LOG');
  assert.deepEqual(npmLog.trim().split('\n'), ['install --omit=dev --no-audit --no-fund'], 'one npm install, no ci/lockfile step');
  const claudeLog = sb.log('FAKE_CLAUDE_LOG');
  assert.match(claudeLog, /^plugin marketplace add zzoretich\/AgenticOS-Workbench$/m);
  assert.match(claudeLog, /^plugin install agenticos@agenticos-workbench$/m);
  assert.equal(fs.readlinkSync(path.join(sb.home, '.local', 'bin', 'aos')), path.join(v, 'brain', 'scripts', 'bin', 'aos'));
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-index.json')), 'recall --warm ran');
  assert.match(fs.readFileSync(path.join(v, 'brain', '_index', 'BRAIN.md'), 'utf8'), /^## Who$/m);
  assert.match(r.stdout, new RegExp(`@${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/AGENTICOS\\.md`));
  assert.match(r.stdout, /persona interview not installed in this phase|skipping the interview/);

  // Idempotent: a second init keeps user files and does not duplicate the seed.
  fs.appendFileSync(path.join(v, 'MEMORY.md'), '- [Kept](brain/memory/reference/kept.md) — user line\n');
  const again = aos(sb, ['init', '--vault', v, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(fs.readFileSync(path.join(v, 'MEMORY.md'), 'utf8'), /Kept/);

  // A re-run without --provider keeps the mode already set (e.g. by `aos provider ollama`), rather than resetting to auto.
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const setOllama = readJson(cfgPath);
  setOllama.provider = 'ollama';
  fs.writeFileSync(cfgPath, JSON.stringify(setOllama, null, 2) + '\n');
  const keepProvider = aos(sb, ['init', '--vault', v, '--no-obsidian', '--yes']);
  assert.equal(keepProvider.status, 0, keepProvider.stderr);
  assert.equal(readJson(cfgPath).provider, 'ollama');
});

test('init with --from-local uses the local path as the marketplace source', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(sb.log('FAKE_CLAUDE_LOG'), new RegExp(`^plugin marketplace add ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('init keeps going and prints the checklist when the plugin install fails', () => {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes'], { FAKE_CLAUDE_FAIL_INSTALL: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /plugin install failed/);
  const v = sb.vault;
  assert.match(r.stdout, new RegExp(`@${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/AGENTICOS\\.md`));
  assert.ok(fs.existsSync(path.join(v, 'brain', '_index', 'recall-index.json')), 'recall --warm ran');
});

test('download rejects on a mid-stream response error, removes the partial file, and does not crash', async () => {
  const { download } = require('./aos.js');
  const { PassThrough } = require('stream');
  const { EventEmitter } = require('events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-download-'));
  const dest = path.join(dir, 'main.js');
  const fakeGet = (url, opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    setImmediate(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      res.write('partial');
      setImmediate(() => res.emit('error', new Error('boom')));
    });
    return req;
  };
  await assert.rejects(download('https://example.invalid/main.js', dest, 0, fakeGet), /boom/);
  assert.ok(!fs.existsSync(dest));
});

function initialized() {
  const sb = sandbox();
  const r = aos(sb, ['init', '--vault', sb.vault, '--no-obsidian', '--provider', 'none', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(sb.env.FAKE_CLAUDE_LOG, '');
  return sb;
}

test('doctor passes on an initialized vault when the plugin is installed (MCP probe over stdio)', () => {
  const sb = initialized();
  const r = aos(sb, ['doctor'], { FAKE_PLUGIN_PATH: path.join(ROOT, 'plugin') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+MCP server answers\s+serverInfo\.name=agenticos/);
  assert.match(r.stdout, /warn\s+obsidian plugin/);
  assert.match(r.stdout, /all checks passed/);
});

test('upgrade re-vendors the runtime, migrates config, keeps memory', () => {
  const sb = initialized();
  const memory = path.join(sb.vault, 'brain', 'memory', 'reference', 'keep-me.md');
  fs.writeFileSync(memory, '# Keep me\n');
  const vendored = path.join(sb.vault, 'brain', 'scripts', 'lib', 'paths.js');
  fs.writeFileSync(vendored, '// stale copy\n');
  const dry = aos(sb, ['upgrade', '--dry-run', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(dry.status, 2, dry.stderr);
  assert.match(dry.stderr, /--dry-run is only supported by `aos init`/);
  assert.ok(fs.readFileSync(vendored, 'utf8').includes('stale copy'), 'a rejected --dry-run runs nothing');
  const cfgPath = path.join(sb.cfg, 'agenticos.json');
  const cfg = readJson(cfgPath);
  delete cfg.telemetry;
  cfg.version = '0.0.1';
  cfg.provider = 'ollama';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const vaultCfg = path.join(sb.vault, 'brain', 'config.json');
  fs.writeFileSync(vaultCfg, JSON.stringify({ scan: { fileMapBudget: 7 } }));

  const r = aos(sb, ['upgrade', '--no-obsidian', '--from-local', ROOT]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.readFileSync(vendored, 'utf8').includes('stale copy'), 'runtime re-vendored');
  assert.ok(fs.existsSync(memory), 'memory untouched');
  const after = readJson(cfgPath);
  assert.equal(after.version, readJson(path.join(ROOT, 'package.json')).version);
  assert.equal(after.provider, 'ollama', 'user value kept');
  assert.deepEqual(after.telemetry, { enabled: true, redact: true, retentionDays: 30 }, 'missing key migrated');
  const vc = readJson(vaultCfg);
  assert.equal(vc.scan.fileMapBudget, 7);
  assert.equal(vc.scan.embedBudget, 40);
  assert.match(r.stdout, /Memory, notes and persona were not touched/);
});

test('uninstall --keep-vault removes config, plugin, launcher link, duty schedules; keeps the vault and the Ollama supervisor', () => {
  const sb = initialized();
  // Schedules live under $HOME (sandboxed): two of Plan 5's duty labels plus Plan 2's Ollama supervisor label.
  const agents = path.join(sb.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  for (const f of ['com.agenticos.monitor.plist', 'com.agenticos.sitrep.plist', 'com.agenticos.ollama.plist']) fs.writeFileSync(path.join(agents, f), '<plist/>\n');
  const r = aos(sb, ['uninstall', '--keep-vault', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'agenticos.json')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.local', 'bin', 'aos')));
  assert.ok(fs.existsSync(path.join(sb.vault, 'MEMORY.md')));
  assert.ok(!fs.existsSync(path.join(agents, 'com.agenticos.monitor.plist')), 'duty schedule removed');
  assert.ok(!fs.existsSync(path.join(agents, 'com.agenticos.sitrep.plist')), 'duty schedule removed');
  assert.ok(fs.existsSync(path.join(agents, 'com.agenticos.ollama.plist')), 'Ollama supervisor (Plan 2, extras/ollama) is not ours to remove');
  const log = sb.log('FAKE_CLAUDE_LOG');
  assert.match(log, /^plugin uninstall agenticos@agenticos-workbench$/m);
  assert.match(log, /^plugin marketplace remove agenticos-workbench$/m);
  assert.deepEqual(fs.readdirSync(sb.cfg), []);
});

test('uninstall deletes the vault only with the typed confirmation', () => {
  const sb = initialized();
  const kept = aos(sb, ['uninstall', '--yes']);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(fs.existsSync(sb.vault), 'no confirmation → kept');
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.vault, node: process.execPath }));
  const gone = aos(sb, ['uninstall', '--yes'], { AOS_CONFIRM_DELETE: sb.vault });
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!fs.existsSync(sb.vault));
});

test('persona on/off toggle the kill switch; interview and cost report "not installed in this phase"', () => {
  const sb = initialized();
  assert.equal(aos(sb, ['persona', 'off']).status, 0);
  assert.ok(fs.existsSync(path.join(sb.vault, 'persona', 'DISABLED')));
  assert.equal(aos(sb, ['persona', 'on']).status, 0);
  assert.ok(!fs.existsSync(path.join(sb.vault, 'persona', 'DISABLED')));
  const interview = aos(sb, ['persona']);
  assert.equal(interview.status, 1);
  assert.match(interview.stdout, /persona interview not installed in this phase/);
  const rename = aos(sb, ['persona', 'rename', 'Atlas']);
  assert.equal(rename.status, 1);
  const cost = aos(sb, ['cost', 'enable'], { AOS_REPO_HINT: ROOT });
  if (fs.existsSync(path.join(ROOT, 'extras', 'cost', 'analyze_transcript.py'))) {
    assert.equal(cost.status, 0, cost.stderr);
  } else {
    assert.equal(cost.status, 1);
    assert.match(cost.stdout, /cost module not installed in this phase/);
  }
  assert.equal(aos(sb, ['cost', 'disable']).status, 0);
  assert.equal(readJson(path.join(sb.cfg, 'agenticos.json')).cost.enabled, false);
  assert.match(aos(sb, ['cost']).stdout, /cost disabled/);
  assert.equal(aos(sb, ['terminal']).status, 2);
  const term = aos(sb, ['terminal', 'install']);
  assert.equal(term.status, 1);
  assert.match(term.stderr, /no package\.json/);
});

test('uninstall warns when the claude CLI cannot remove the plugin, and refuses to delete a structurally invalid vault', () => {
  const sb = initialized();
  const warned = aos(sb, ['uninstall', '--keep-vault', '--yes'], { AOS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /claude plugin uninstall agenticos@agenticos-workbench failed/);
  assert.match(warned.stderr, /claude plugin marketplace remove agenticos-workbench failed/);
  assert.ok(fs.existsSync(path.join(sb.vault, 'MEMORY.md')), 'vault kept');
  // A config that names the home directory must never be deleted, even with the automation confirmation set.
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.home, node: process.execPath }));
  const refused = aos(sb, ['uninstall', '--yes'], { AOS_CONFIRM_DELETE: sb.home });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing the home directory/);
  assert.ok(fs.existsSync(path.join(sb.home, '.local')), 'home directory intact');
});
