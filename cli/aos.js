#!/usr/bin/env node
'use strict';
/**
 * aos.js — AgenticOS Workbench installer and maintenance CLI. Zero dependencies (node: builtins only).
 *
 *   aos init [--vault <dir>] [--provider auto|ollama|claude|none] [--no-obsidian] [--terminal] [--cost]
 *            [--persona-json <file>] [--from-local <repo-dir>] [--dry-run] [--yes]
 *   aos doctor · aos status · aos provider [auto|ollama|claude|none]
 *   aos upgrade [--from-local <repo-dir>] [--no-obsidian] · aos uninstall [--keep-vault] [--yes]
 *   aos persona [rename <name> | on | off] [--persona-json <file>] · aos cost [enable [--budget <usd>] | disable]
 *   aos terminal install
 *
 * Exit codes: 0 ok · 1 a check failed · 2 usage.
 * Runs from the repo checkout (`node cli/aos.js …`, `npm run setup`) and from its vendored copy at
 * <vault>/brain/scripts/cli/aos.js, which the `aos` launcher reaches for every subcommand except init.
 * Platforms: macOS and Linux. Windows is unsupported in v1.
 * Config file: $AOS_CONFIG when set (the launcher exports it), else <configDir>/agenticos.json — the same
 * rule as lib/paths.js configFile(), so every aos subcommand reads the file the hooks read.
 * Test seams (env): AOS_CONFIG, AOS_CLAUDE_BIN, AOS_NPM_BIN, AOS_SKIP_NPM=1, AOS_CONFIRM_DELETE=<vault path>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const REPO_SLUG = 'zzoretich/AgenticOS-Workbench';
const MARKETPLACE = 'agenticos-workbench';
const PLUGIN_ID = `agenticos@${MARKETPLACE}`;
const OBSIDIAN_PLUGIN_ID = 'agentic-os';
const DEFAULT_VAULT = path.join(os.homedir(), 'AgenticOS');
const PROVIDERS = ['auto', 'ollama', 'claude', 'none'];
const RUNTIME_SCRIPTS = { 'scan-vault': 'scan-vault.js', 'build-brain-md': 'build-brain-md.js', recall: 'sdk/recall-cli.js' };

const USAGE = `usage:
  aos init [--vault <dir>] [--provider auto|ollama|claude|none] [--no-obsidian] [--terminal] [--cost]
           [--persona-json <file>] [--from-local <repo-dir>] [--dry-run] [--yes]
  aos doctor | status | provider [auto|ollama|claude|none]
  aos upgrade [--from-local <repo-dir>] [--no-obsidian]
  aos uninstall [--keep-vault] [--yes]
  aos persona [rename <name> | on | off] [--persona-json <file>]
  aos cost [enable [--budget <usd>] | disable]
  aos terminal install`;

class UsageError extends Error {}
class CheckFailed extends Error {}

const out = {
  log: (m) => process.stdout.write(m + '\n'),
  warn: (m) => process.stderr.write('warning: ' + m + '\n'),
};

// ── files and config ──────────────────────────────────────────────────────────
function configDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function configPath() { return path.resolve(process.env.AOS_CONFIG || path.join(configDir(), 'agenticos.json')); }
function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function exists(p) { return fs.existsSync(p); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function insideDir(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  const o = { ...base };
  for (const [k, v] of Object.entries(over || {})) o[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return o;
}
function loadConfigOrThrow() {
  const c = readJson(configPath());
  if (!c || typeof c.vault !== 'string') throw new CheckFailed(`no ${configPath()} — run \`aos init\` (npm run setup) first`);
  return c;
}
function scriptPath(vault, rel) { return path.join(vault, 'brain', 'scripts', rel); }

// ── processes ─────────────────────────────────────────────────────────────────
function run(cmd, args, { cwd, env, capture = false, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : (input !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit'),
  });
  if (r.error) {
    if (allowFail) return { status: 127, stdout: '', stderr: String(r.error.message) };
    throw new CheckFailed(`${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new CheckFailed(`${cmd} ${args.join(' ')} exited ${r.status}${capture && r.stderr ? ': ' + r.stderr.trim() : ''}`);
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function which(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : null;
}
function claudeBin() {
  if (process.env.AOS_CLAUDE_BIN) return process.env.AOS_CLAUDE_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return which('claude') || (exists(local) ? local : null);
}
function npmBin() { return process.env.AOS_NPM_BIN || 'npm'; }
function claudeLoggedIn(bin) {
  const j = safeParse(run(bin, ['auth', 'status', '--json'], { capture: true, allowFail: true }).stdout);
  return !!(j && j.loggedIn);
}
function installedPlugin(bin) {
  const arr = safeParse(run(bin, ['plugin', 'list', '--json'], { capture: true, allowFail: true }).stdout);
  if (!Array.isArray(arr)) return null;
  return arr.find((p) => typeof p.id === 'string' && p.id.startsWith('agenticos@')) || null;
}
function nodeMajor() { return Number(process.versions.node.split('.')[0]); }
function python3Version() {
  const r = run('python3', ['--version'], { capture: true, allowFail: true });
  const m = /(\d+)\.(\d+)/.exec(r.stdout + r.stderr);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}
function python3Ok(v) { return !!v && (v.major > 3 || (v.major === 3 && v.minor >= 9)); }
function obsidianDetected() {
  if (process.platform === 'darwin') return exists('/Applications/Obsidian.app') || exists(path.join(os.homedir(), 'Applications', 'Obsidian.app'));
  return !!which('obsidian') || isDir(path.join(os.homedir(), '.var', 'app', 'md.obsidian.Obsidian')) || exists('/usr/bin/obsidian');
}
function httpProbe(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}
/** Ollama endpoint for informational probes: config.ollama > OLLAMA_HOST/OLLAMA_PORT > local default
 *  (the same precedence sdk/lib/ollama.js endpoint() gives provider-routed calls). */
function ollamaEndpoint(cfg) {
  const o = (cfg && cfg.ollama) || {};
  return { host: o.host || process.env.OLLAMA_HOST || '127.0.0.1', port: Number(o.port || process.env.OLLAMA_PORT || 11434) };
}
function ask(question, def) {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim() || def); }));
}
/** Runs a vendored runtime script inline (AOS_DETACHED=1 keeps hook scripts from forking). */
function runScript(vault, name, args = [], opts = {}) {
  if (!RUNTIME_SCRIPTS[name]) throw new UsageError(`unknown runtime script ${name}`);
  return run(process.execPath, [scriptPath(vault, RUNTIME_SCRIPTS[name]), ...args], {
    cwd: vault, ...opts,
    env: { AOS_VAULT: vault, AOS_CONFIG: configPath(), AOS_DETACHED: '1', ...(opts.env || {}) },
  });
}

// ── MCP probe: initialize (+ one tools/call) over stdio against the vault's server ──
function mcpProbe({ vault, tool = null, args = {}, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [scriptPath(vault, 'bin/aos'), 'mcp-server'], {
      env: { ...process.env, AOS_CONFIG: configPath(), CLAUDE_CONFIG_DIR: configDir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let serverName = null;
    let timer = null;
    const finish = (err, value) => {
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`MCP probe timed out after ${timeoutMs} ms${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)), timeoutMs);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => { if (serverName === null) finish(new Error(`mcp-server exited ${code} before answering${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = safeParse(line);
        if (!msg) continue;
        if (msg.id === 1 && msg.result) {
          serverName = (msg.result.serverInfo && msg.result.serverInfo.name) || '';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          if (!tool) return finish(null, { serverName, result: null });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(`tools/call ${tool}: ${msg.error.message}`));
          finish(null, { serverName, result: msg.result });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aos', version: '0' } } });
  });
}

// ── doctor ────────────────────────────────────────────────────────────────────
async function doctor() {
  const checks = [];
  const add = (name, ok, detail, level = 'fail') => checks.push({ name, ok, detail, level });
  add('node >= 20', nodeMajor() >= 20, `v${process.versions.node}`);
  const bin = claudeBin();
  add('claude CLI', !!bin, bin || 'not found on PATH or in ~/.local/bin');
  if (bin) add('claude login', claudeLoggedIn(bin), 'claude auth status --json');
  const cfg = readJson(configPath());
  add('agenticos.json', !!(cfg && cfg.vault && cfg.node), cfg ? configPath() : `${configPath()} missing — run aos init`);
  const vault = cfg && cfg.vault;
  if (vault) {
    const need = ['brain/_index', 'brain/memory', 'brain/scripts/package.json', 'brain/scripts/node_modules/@modelcontextprotocol/sdk',
      'brain/scripts/bin/aos', 'brain/scripts/cli/aos.js', 'MEMORY.md', 'AGENTICOS.md'];
    const missing = need.filter((r) => !exists(path.join(vault, r)));
    add('vault layout', missing.length === 0, missing.length ? `${vault} missing: ${missing.join(', ')}` : vault);
    add('node in config', exists(cfg.node), cfg.node);
  }
  const plugin = bin ? installedPlugin(bin) : null;
  add('plugin installed', !!plugin, plugin ? `${plugin.id} at ${plugin.installPath}` : `run: claude plugin install ${PLUGIN_ID}`);
  const mcpJson = plugin ? readJson(path.join(plugin.installPath, '.mcp.json')) : null;
  add('MCP declared', !!(mcpJson && mcpJson.agenticos), plugin ? path.join(plugin.installPath, '.mcp.json') : 'plugin not installed');
  if (vault && exists(scriptPath(vault, 'bin/aos'))) {
    try {
      const r = await mcpProbe({ vault });
      add('MCP server answers', r.serverName === 'agenticos', `serverInfo.name=${r.serverName || '(none)'}`);
    } catch (e) { add('MCP server answers', false, e.message); }
  }
  if (vault) add('obsidian plugin', exists(path.join(vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID, 'main.js')), `${vault}/.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/main.js`, 'warn');
  const { host, port } = ollamaEndpoint(cfg);
  add('ollama reachable', await httpProbe(`http://${host}:${port}/api/tags`), `${host}:${port} (informational)`, 'info');
  if (cfg && cfg.cost && cfg.cost.enabled) {
    const py = python3Version();
    add('python3 >= 3.9', python3Ok(py), py ? `${py.major}.${py.minor}` : 'python3 not found (needed because cost is enabled)');
  }
  for (const c of checks) {
    const tag = c.ok ? 'ok  ' : c.level === 'fail' ? 'FAIL' : c.level === 'warn' ? 'warn' : 'info';
    out.log(`${tag}  ${c.name.padEnd(20)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && c.level === 'fail');
  out.log(failed.length ? `${failed.length} check(s) failed` : 'all checks passed');
  return failed.length ? 1 : 0;
}

// ── status ────────────────────────────────────────────────────────────────────
// Contract §3 spendToday semantics: ledger rows whose `feature` starts with `duty:` belong to the persona
// (Plan 5's record-spend.js; gated by persona.perDayUsd); every other row is a background hook call
// (gated by claude.perDayUsd — Plan 2's spendToday excludes duty rows the same way). One line per cap.
const DUTY_FEATURE = /^duty:/;
const isDutyFeature = (feature) => DUTY_FEATURE.test(feature);
const isHookFeature = (feature) => !DUTY_FEATURE.test(feature);
/** Today's provider-spend.jsonl rows (local calendar day) that carry a numeric usd; [] when the ledger is absent. */
function spendRowsToday(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const day = localDay();
  const rows = [];
  for (const line of raw.split('\n')) {
    const r = safeParse(line);
    if (r && typeof r.usd === 'number' && localDay(new Date(r.ts)) === day) rows.push(r);
  }
  return rows;
}
/** USD sum of `rows` whose feature string satisfies `filter`. */
function sumUsd(rows, filter) { return rows.filter((r) => filter(String(r.feature || ''))).reduce((s, r) => s + r.usd, 0); }
/** Today's spend in USD; `filter(feature)` picks the rows (default: every row). */
function spendToday(file, filter = () => true) { return sumUsd(spendRowsToday(file), filter); }
function status() {
  const cfg = loadConfigOrThrow();
  const idx = path.join(cfg.vault, 'brain', '_index');
  const state = readJson(path.join(idx, 'provider-state.json'));
  // Caps follow loadConfig() precedence (contract §1): agenticos.json wins over brain/config.json, then the
  // config.default.json values (claude.perDayUsd 0.5, persona.perDayUsd 6.0).
  const vaultCfg = readJson(path.join(cfg.vault, 'brain', 'config.json'), {}) || {};
  const num = (obj, key) => (obj && typeof obj[key] === 'number' ? obj[key] : undefined);
  const hookCap = num(cfg.claude, 'perDayUsd') ?? num(vaultCfg.claude, 'perDayUsd') ?? 0.5;
  const dutyCap = num(cfg.persona, 'perDayUsd') ?? num(vaultCfg.persona, 'perDayUsd') ?? 6;
  const spend = spendRowsToday(path.join(idx, 'provider-spend.jsonl')); // the ledger is read once, summed twice
  out.log(`vault      ${cfg.vault}`);
  out.log(`provider   mode=${cfg.provider || 'auto'} resolved=${state ? `${state.name} (${state.reason}, ${state.checkedAt})` : 'never resolved'}`);
  const claudeState = (state && state.claude) || {};
  out.log(`claude     bin=${claudeState.bin || claudeBin() || 'not found'} login=${typeof claudeState.loggedIn === 'boolean' ? claudeState.loggedIn : 'unprobed'}`);
  out.log(`spend      today (hooks) $${sumUsd(spend, isHookFeature).toFixed(4)} / cap $${hookCap}`);
  out.log(`spend      today (duties) $${sumUsd(spend, isDutyFeature).toFixed(4)} / cap $${dutyCap}`);
  // Ledger shape (lib/pipeline-report.js): { version: 1, pipelines: { <name>: { lastRun: {…} | null, history: [] } } }.
  const ledger = readJson(path.join(idx, 'pipelines.json'), {}) || {};
  const rows = Object.entries(ledger.pipelines || {}).map(([name, st]) => [name, (st && st.lastRun) || null]);
  out.log(rows.length ? 'pipelines' : 'pipelines  (none yet — run aos scan-vault)');
  for (const [name, e] of rows) {
    if (!e) { out.log(`  ${name.padEnd(20)} never`); continue; }
    out.log(`  ${name.padEnd(20)} ${String(e.status || '?').padEnd(9)} ${String(e.provider || '-').padEnd(7)} ${e.endedAt || e.startedAt || ''}${e.reason ? '  ' + e.reason : ''}${e.status === 'error' && e.error ? '  ' + e.error : ''}`);
  }
  return 0;
}

// ── provider ──────────────────────────────────────────────────────────────────
function provider(mode) {
  const cfg = loadConfigOrThrow();
  if (!mode) { out.log(cfg.provider || 'auto'); return 0; }
  if (!PROVIDERS.includes(mode)) throw new UsageError(`provider must be one of ${PROVIDERS.join('|')}`);
  cfg.provider = mode;
  writeJson(configPath(), cfg);
  try { fs.unlinkSync(path.join(cfg.vault, 'brain', '_index', 'provider-state.json')); } catch { /* no cache yet */ }
  out.log(`provider set to ${mode} (cached probe cleared; the next hook re-resolves)`);
  return 0;
}

// ── args and main ─────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['vault', 'provider', 'persona-json', 'from-local', 'budget']);
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function parseArgs(argv) {
  const a = { cmd: argv[0] || '', sub: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a.sub.push(t); continue; }
    const name = t.slice(2);
    if (name.startsWith('no-')) { a.flags[camel(name.slice(3))] = false; continue; }
    if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      a.flags[camel(name)] = v;
      continue;
    }
    a.flags[camel(name)] = true;
  }
  return a;
}

async function main(argv) {
  const { cmd, sub, flags } = parseArgs(argv);
  switch (cmd) {
    case 'doctor': return doctor();
    case 'status': return status();
    case 'provider': return provider(sub[0]);
    case 'help': case '--help': case '-h': out.log(USAGE); return 0;
    case '': out.log(USAGE); return 2;
    default: throw new UsageError(`unknown command: ${cmd}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    if (e instanceof UsageError) { process.stderr.write(`aos: ${e.message}\n${USAGE}\n`); process.exit(2); }
    process.stderr.write(`aos: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, deepMerge, configDir, configPath, readJson, writeJson, exists, isDir, insideDir, localDay,
  run, which, claudeBin, npmBin, claudeLoggedIn, installedPlugin, python3Version, python3Ok, obsidianDetected, httpProbe, ollamaEndpoint, ask,
  runScript, scriptPath, mcpProbe, spendRowsToday, spendToday, isDutyFeature, isHookFeature, loadConfigOrThrow,
  doctor, status, provider, main,
  PROVIDERS, PLUGIN_ID, MARKETPLACE, REPO_SLUG, OBSIDIAN_PLUGIN_ID, DEFAULT_VAULT, RUNTIME_SCRIPTS, USAGE,
  UsageError, CheckFailed, out,
};
