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
 * Test seams (env): AOS_CONFIG, AOS_CLAUDE_BIN, AOS_NPM_BIN, AOS_SKIP_NPM=1, AOS_CONFIRM_DELETE=<vault path>,
 * AOS_SKIP_OLLAMA_PROBE=1.
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
/** True when the informational Ollama probe must not run (tests and offline rehearsals set AOS_SKIP_OLLAMA_PROBE=1). */
function ollamaProbeSkipped() { return process.env.AOS_SKIP_OLLAMA_PROBE === '1'; }
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
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`MCP probe timed out after ${timeoutMs} ms${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)), timeoutMs);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    child.on('error', (e) => finish(e));
    // A server that answers `initialize` and exits immediately leaves stdin's pipe already broken by the
    // time notifications/initialized (or tools/call) is written; without this the EPIPE crashes the process.
    child.stdin.on('error', () => {});
    child.on('exit', (code) => { finish(new Error(`mcp-server exited ${code} before answering${stderr ? ': ' + stderr.trim().slice(-300) : ''}`)); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = safeParse(line);
        if (!msg) continue;
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(`initialize: ${msg.error.message}`));
          if (!msg.result) continue;
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
  if (ollamaProbeSkipped()) add('ollama reachable', false, `${host}:${port} not probed (AOS_SKIP_OLLAMA_PROBE=1)`, 'info');
  else add('ollama reachable', await httpProbe(`http://${host}:${port}/api/tags`), `${host}:${port} (informational)`, 'info');
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

// ── init ──────────────────────────────────────────────────────────────────────
// Never vendored: installed deps, the test suite, and any lockfile (contract §4.3: the vendored runtime is
// installed with a plain `npm install --omit=dev`; its two deps are pinned by `^` ranges in package.json).
const VENDOR_EXCLUDE = /(^|\/)(node_modules|test|package-lock\.json)(\/|$)/;
const BUNDLE_FILES = ['main.js', 'manifest.json', 'styles.css', 'package.json'];

function isRepoRoot(d) {
  return !!d && exists(path.join(d, '.claude-plugin', 'marketplace.json')) &&
    exists(path.join(d, 'brain', 'scripts', 'package.json')) && isDir(path.join(d, 'vault-template'));
}
/** The checkout to vendor from: --from-local, this file's parent (repo run), or the marketplace clone. */
function repoRoot(flags) {
  const candidates = [flags.fromLocal, path.resolve(__dirname, '..'), path.join(configDir(), 'plugins', 'marketplaces', MARKETPLACE)];
  for (const c of candidates) if (isRepoRoot(c)) return path.resolve(c);
  throw new UsageError('cannot locate the AgenticOS-Workbench checkout (needs .claude-plugin/marketplace.json, brain/scripts, vault-template) — pass --from-local <repo-dir>');
}
function productVersion(repo) { return (readJson(path.join(repo, 'package.json')) || {}).version || '0.0.0'; }

/** Recursive copy. Existing destination files are kept unless force. `rename` maps a source rel path to a dest rel path. */
function copyTree(srcRoot, destRoot, { exclude = null, force = false, rename = {}, written = [] } = {}) {
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude.test(childRel)) continue;
      if (e.isDirectory()) { walk(childRel); continue; }
      if (!e.isFile()) continue;
      const destRel = rename[childRel] || childRel;
      const target = path.join(destRoot, destRel);
      if (exists(target) && !force) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(srcRoot, childRel), target);
      written.push(destRel);
    }
  };
  walk('');
  return written;
}

function assertVaultOk(vault) {
  if (insideDir(vault, configDir())) throw new CheckFailed(`refusing ${vault}: it is inside the Claude config dir ${configDir()}`);
  if (exists(path.join(vault, 'settings.json'))) throw new CheckFailed(`refusing ${vault}: it contains settings.json (looks like a Claude config dir)`);
  if (path.resolve(vault) === path.resolve(os.homedir())) throw new CheckFailed('refusing the home directory as a vault; pick a subdirectory such as ~/AgenticOS');
}

/** Obsidian can express only a flat folder + file format; the year folder of the layout is the closest match (documented). */
function dailyNotesJson(layout) {
  const first = String(layout).split('/')[0];
  return { folder: first.replace(/\{yyyy\}/g, String(new Date().getFullYear())), format: 'YYYY-MM-DD' };
}

function buildUserConfig(existing, { vault, provider, version, cost }) {
  const base = {
    version, vault, node: process.execPath, claudeConfigDir: configDir(), provider: 'auto',
    claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 },
    ollama: { host: '127.0.0.1', port: 11434 },
    telemetry: { enabled: true, redact: true, retentionDays: 30 },
    cost: { enabled: false },
    persona: { enabled: true },
  };
  const merged = deepMerge(base, existing || {});
  merged.version = version;
  merged.vault = vault;
  merged.node = process.execPath;
  merged.claudeConfigDir = configDir();
  if (provider) merged.provider = provider;
  if (cost) merged.cost = { ...merged.cost, enabled: true };
  const ordered = {};
  for (const k of Object.keys(base)) ordered[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k];
  return ordered;
}

/** ~/.local/bin/aos → <vault>/brain/scripts/bin/aos, so `aos doctor` works from any shell. */
function linkLauncher(vault) {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const link = path.join(binDir, 'aos');
  const target = scriptPath(vault, 'bin/aos');
  try {
    fs.mkdirSync(binDir, { recursive: true });
    let current = null;
    try { current = fs.readlinkSync(link); } catch { /* absent, or a regular file */ }
    if (current === target) return link;
    if (current && current.endsWith('/brain/scripts/bin/aos')) fs.unlinkSync(link);
    else if (exists(link)) { out.warn(`${link} exists and is not an AgenticOS launcher; leaving it alone`); return null; }
    fs.symlinkSync(target, link);
    return link;
  } catch (e) { out.warn(`could not link ${link}: ${e.message}`); return null; }
}

function vendorRuntime(ctx, { force = true } = {}) {
  const { repo, vault, written } = ctx;
  const dest = scriptPath(vault, '');
  copyTree(path.join(repo, 'brain', 'scripts'), dest, { exclude: VENDOR_EXCLUDE, force, written: [] });
  fs.mkdirSync(path.join(dest, 'cli'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'cli', 'aos.js'), path.join(dest, 'cli', 'aos.js'));
  fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'plugin', 'bin', 'aos'), path.join(dest, 'bin', 'aos'));
  fs.chmodSync(path.join(dest, 'bin', 'aos'), 0o755);
  written.push('brain/scripts/ (runtime)', 'brain/scripts/cli/aos.js', 'brain/scripts/bin/aos');
  if (process.env.AOS_SKIP_NPM !== '1') {
    // Spec §9.2 step 4 / contract §4.3: a plain `npm install --omit=dev` in the vendored dir. No lockfile is
    // vendored (VENDOR_EXCLUDE drops one even when the checkout has it; the root workspace lockfile describes
    // the workspaces, not this package alone), so `npm ci` is not an option here and is deliberately not used.
    // On a re-run (init again, upgrade) npm prunes and refreshes node_modules in place.
    run(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dest });
  }
  const link = linkLauncher(vault);
  if (link) written.push(link);
}

function installPlugin(ctx, bin) {
  const source = ctx.flags.fromLocal ? path.resolve(ctx.flags.fromLocal) : REPO_SLUG;
  const already = installedPlugin(bin);
  if (already) { out.log(`   plugin already installed: ${already.id}`); return; }
  const add = run(bin, ['plugin', 'marketplace', 'add', source], { allowFail: true, capture: true });
  if (add.status !== 0 && !/already/i.test(add.stdout + add.stderr)) out.warn(`marketplace add: ${(add.stderr || add.stdout).trim()}`);
  const inst = run(bin, ['plugin', 'install', PLUGIN_ID], { allowFail: true, capture: true });
  if (inst.status !== 0) out.warn(`plugin install failed (${(inst.stderr || inst.stdout).trim() || 'exit ' + inst.status}); finish the rest of init, then run: claude plugin install ${PLUGIN_ID}`);
  else if (inst.stdout.trim()) out.log(inst.stdout.trim());
}

/** GET url → dest (follows ≤5 redirects). `getFn` is injectable so tests can drive stream failures without the network. */
function download(url, dest, hops = 0, getFn = (u, o, cb) => https.get(u, o, cb)) {
  return new Promise((resolve, reject) => {
    let file = null;
    let settled = false;
    // Remove whatever reached disk, then reject. The write stream opens asynchronously, so the unlink waits for its
    // 'close' (destroy() during the open still creates the file, then closes it) — an early unlink would let the
    // open re-create dest afterwards (execution finding 2026-09-14: flaky under parallel test load).
    const fail = (e) => {
      if (settled) return;
      settled = true;
      const done = () => { try { fs.unlinkSync(dest); } catch { /* nothing written */ } reject(e); };
      if (!file || file.closed) return done();
      file.once('close', done);
      if (!file.destroyed) file.destroy();
    };
    const succeed = () => { if (settled) return; settled = true; resolve(); };
    const req = getFn(url, { headers: { 'user-agent': 'agenticos-installer' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        return resolve(download(res.headers.location, dest, hops + 1, getFn));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      file = fs.createWriteStream(dest);
      res.on('error', fail);
      file.on('error', fail);
      file.on('finish', () => file.close((e) => (e ? fail(e) : succeed())));
      res.pipe(file);
    });
    req.on('error', fail);
    if (typeof req.setTimeout === 'function') req.setTimeout(30000, () => req.destroy(new Error(`timeout after 30 s for ${url}`)));
  });
}

async function obsidianBundle(ctx) {
  const src = path.join(ctx.repo, 'obsidian-plugin');
  const dest = path.join(ctx.vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID);
  await ctx.act(`install the Obsidian plugin bundle into ${dest}`, async () => {
    if (!exists(path.join(src, 'main.js')) && isDir(path.join(ctx.repo, 'node_modules'))) {
      run(npmBin(), ['run', 'build', '-w', 'obsidian-plugin'], { cwd: ctx.repo, allowFail: true });
    }
    fs.mkdirSync(dest, { recursive: true });
    if (exists(path.join(src, 'main.js'))) {
      for (const f of BUNDLE_FILES) {
        if (!exists(path.join(src, f))) continue;
        fs.copyFileSync(path.join(src, f), path.join(dest, f));
        ctx.written.push(`.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/${f}`);
      }
      return;
    }
    const version = (readJson(path.join(src, 'manifest.json')) || {}).version;
    if (!version) { out.warn('no Obsidian bundle and no manifest to name a release; run `npm ci && npm run build -w obsidian-plugin` then `aos upgrade`'); return; }
    for (const f of ['main.js', 'manifest.json', 'styles.css']) {
      try {
        await download(`https://github.com/${REPO_SLUG}/releases/download/v${version}/${f}`, path.join(dest, f));
        ctx.written.push(`.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}/${f}`);
      } catch (e) {
        out.warn(`could not fetch ${f} for v${version}: ${e.message} — build locally (npm ci && npm run build -w obsidian-plugin) then run aos upgrade`);
        return;
      }
    }
    if (exists(path.join(src, 'package.json'))) fs.copyFileSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
  });
}

function terminalInstall(vault) {
  if (process.platform === 'win32') throw new CheckFailed('Windows is not supported in v1');
  const dir = path.join(vault, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID);
  if (!exists(path.join(dir, 'package.json'))) throw new CheckFailed(`no package.json in ${dir}; install the Obsidian bundle first (aos upgrade)`);
  run(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir });
  const prebuilds = path.join(dir, 'node_modules', 'node-pty', 'prebuilds');
  for (const d of (isDir(prebuilds) ? fs.readdirSync(prebuilds) : [])) {
    const helper = path.join(prebuilds, d, 'spawn-helper');
    if (exists(helper)) fs.chmodSync(helper, 0o755);
  }
  out.log(`terminal support installed in ${dir}; restart Obsidian to load it`);
}

function personaInterview(ctx) {
  const cfg = readJson(configPath()) || {};
  if (cfg.persona && cfg.persona.enabled === false) { out.log('   persona disabled in config; skipping the interview'); return; }
  const script = scriptPath(ctx.vault, 'persona/interview.js');
  if (!exists(script)) { out.log('   persona interview not installed in this phase — run `aos persona` after a later upgrade'); return; }
  const args = [script];
  if (ctx.flags.personaJson) args.push('--answers', path.resolve(ctx.flags.personaJson));
  else if (ctx.yes || !process.stdin.isTTY) { out.log('   no --persona-json and no terminal; skipping the interview (run `aos persona` later)'); return; }
  run(process.execPath, args, { cwd: ctx.vault, env: { AOS_VAULT: ctx.vault, AOS_CONFIG: configPath() }, allowFail: true });
}

function checklist(ctx) {
  const { vault, written, dry } = ctx;
  out.log('');
  if (dry) out.log('dry-run complete — nothing was written.');
  else {
    out.log('done. Files written:');
    for (const w of written) out.log(`  ${path.isAbsolute(w) ? w : path.join(vault, w)}`);
  }
  out.log('');
  out.log('Next steps:');
  out.log(`  1. Add this line to your CLAUDE.md (${path.join(configDir(), 'CLAUDE.md')}); the installer never edits it:`);
  out.log(`       @${path.join(vault, 'AGENTICOS.md')}`);
  out.log(`  2. Open the vault in Obsidian: "Open folder as vault" → ${vault}, then enable "Agentic OS" under Settings → Community plugins.`);
  out.log(`  3. Put ${path.join(os.homedir(), '.local', 'bin')} on your PATH, then run: aos doctor`);
  out.log('  4. Start a new `claude` session; the first prompt receives <brain-context>. Use /wrap at the end.');
}

async function init(flags) {
  const dry = !!flags.dryRun;
  const yes = !!flags.yes;
  const repo = repoRoot(flags);
  const version = productVersion(repo);
  // An explicit --provider wins; otherwise a re-run keeps the mode already in agenticos.json (e.g. after `aos provider ollama`).
  const provider = flags.provider || ((readJson(configPath()) || {}).provider) || 'auto';
  if (!PROVIDERS.includes(provider)) throw new UsageError(`--provider must be one of ${PROVIDERS.join('|')}`);
  const written = [];
  let n = 0;
  const act = async (what, fn) => { n += 1; out.log(`${dry ? '[dry-run] ' : ''}${n}. ${what}`); if (!dry) await fn(); };
  const ctx = { flags, repo, dry, yes, written, act, version };

  // 1. preflight
  if (nodeMajor() < 20) throw new CheckFailed(`Node 20 or newer is required (running v${process.versions.node})`);
  out.log(`preflight: node v${process.versions.node} · checkout ${repo} (v${version})`);
  const bin = claudeBin();
  if (!bin) {
    if (provider !== 'none') throw new CheckFailed('claude CLI not found — install Claude Code, or pass --provider none to skip the plugin steps');
    out.warn('claude CLI not found; the plugin will not be installed (re-run init after installing Claude Code)');
  } else if (!claudeLoggedIn(bin)) {
    if (provider !== 'none') throw new CheckFailed('claude is not logged in — run `claude auth login` first');
    out.warn('claude is not logged in; plugin install may fail');
  }
  out.log(`preflight: claude ${bin ? bin : 'absent'} · obsidian ${obsidianDetected() ? 'detected' : 'not detected (optional)'}`);
  if (flags.cost && !python3Ok(python3Version())) throw new CheckFailed('--cost needs python3 >= 3.9');
  const oll = ollamaEndpoint(readJson(configPath()));
  out.log(`preflight: ollama ${oll.host}:${oll.port} ${ollamaProbeSkipped() ? 'not probed (AOS_SKIP_OLLAMA_PROBE=1)' : (await httpProbe(`http://${oll.host}:${oll.port}/api/tags`)) ? 'reachable' : 'not reachable (auto falls back to claude, then none)'}`);

  // 2. vault path
  let vault = flags.vault ? path.resolve(flags.vault) : DEFAULT_VAULT;
  if (!flags.vault && !yes && !dry) vault = path.resolve(await ask(`Vault directory [${DEFAULT_VAULT}]: `, DEFAULT_VAULT));
  assertVaultOk(vault);
  ctx.vault = vault;
  out.log(`vault: ${vault}`);

  // 3. seed
  await act(`copy the seed vault into ${vault} (existing files are kept)`, () => {
    copyTree(path.join(repo, 'vault-template'), vault, { rename: { _gitignore: '.gitignore' }, written });
    const session = path.join(vault, 'brain', '_index', 'SESSION.md');
    fs.writeFileSync(session, fs.readFileSync(session, 'utf8').replace(/^updated: .*$/m, `updated: ${localDay()}`));
    const defaults = readJson(path.join(repo, 'brain', 'scripts', 'config.default.json'), {});
    const cfgJson = path.join(vault, 'brain', 'config.json');
    const current = readJson(cfgJson);
    if (!current || Object.keys(current).length === 0) { writeJson(cfgJson, defaults); written.push('brain/config.json'); }
    const layout = (((readJson(cfgJson) || {}).dailyNote || {}).layout) || defaults.dailyNote.layout;
    writeJson(path.join(vault, '.obsidian', 'daily-notes.json'), dailyNotesJson(layout));
    written.push('.obsidian/daily-notes.json');
  });

  // 4. vendor runtime
  await act(`vendor brain/scripts into ${scriptPath(vault, '')} and install its dependencies`, () => vendorRuntime(ctx));

  // 5. agenticos.json
  await act(`write ${configPath()}`, () => {
    writeJson(configPath(), buildUserConfig(readJson(configPath()), { vault, provider, version, cost: !!flags.cost }));
    written.push(configPath());
  });

  // 6. plugin
  if (bin) await act(`register the ${MARKETPLACE} marketplace and install ${PLUGIN_ID}`, () => installPlugin(ctx, bin));

  // 7. obsidian bundle (+ optional terminal deps)
  if (flags.obsidian !== false) await obsidianBundle(ctx);
  if (flags.terminal) await act('install terminal support (node-pty) in the Obsidian plugin folder', () => terminalInstall(vault));

  // 8. persona
  await act('run the Chief of Staff interview', () => personaInterview(ctx));

  // 9. first scan
  await act('first scan, compile BRAIN.md, warm the recall index', () => {
    runScript(vault, 'scan-vault', ['--quiet'], { allowFail: true });
    runScript(vault, 'build-brain-md', [], { allowFail: true });
    runScript(vault, 'recall', ['--warm'], { allowFail: true });
  });

  // 10. checklist
  checklist(ctx);
  return 0;
}

// ── upgrade / uninstall / terminal / persona / cost ───────────────────────────
async function upgrade(flags) {
  const cfg = loadConfigOrThrow();
  const vault = cfg.vault;
  const bin = claudeBin();
  const clone = path.join(configDir(), 'plugins', 'marketplaces', MARKETPLACE);
  if (!flags.fromLocal && bin && isDir(clone)) {
    run(bin, ['plugin', 'marketplace', 'update', MARKETPLACE], { allowFail: true });
    run(bin, ['plugin', 'update', PLUGIN_ID], { allowFail: true });
  }
  const repo = repoRoot(flags);
  const version = productVersion(repo);
  const written = [];
  const act = async (what, fn) => { out.log(`- ${what}`); await fn(); };
  const ctx = { flags, repo, vault, written, act, dry: false, yes: true, version };
  out.log(`upgrading ${vault} from ${repo} (v${version})`);
  await act('re-vendor brain/scripts (force) and reinstall its dependencies', () => vendorRuntime(ctx, { force: true }));
  await act(`migrate ${configPath()} keys (version → ${version})`, () => writeJson(configPath(), buildUserConfig(cfg, { vault, version })));
  await act('add any new default keys to brain/config.json (user values win)', () => {
    const defaults = readJson(path.join(repo, 'brain', 'scripts', 'config.default.json'), {});
    const p = path.join(vault, 'brain', 'config.json');
    writeJson(p, deepMerge(defaults, readJson(p, {}) || {}));
  });
  if (flags.obsidian !== false) await obsidianBundle(ctx);
  await act('rebuild indexes (scan-vault, build-brain-md, recall --warm)', () => {
    runScript(vault, 'scan-vault', ['--quiet'], { allowFail: true });
    runScript(vault, 'build-brain-md', [], { allowFail: true });
    runScript(vault, 'recall', ['--warm'], { allowFail: true });
  });
  out.log(`upgraded to v${version}. Memory, notes and persona were not touched.`);
  return 0;
}

// Plan 5's duty schedules (contract §6): exactly these three labels. The optional Ollama supervisor
// com.agenticos.ollama (Plan 2, extras/ollama) shares the prefix and is installed by hand, so it is
// never matched here — a prefix-wide `com.agenticos.*` sweep would silently remove it.
const DUTY_PLIST_RE = /^com\.agenticos\.(monitor|reflect|sitrep)\.plist$/;
const DUTY_CRON_RE = /# com\.agenticos\.(monitor|reflect|sitrep)(\s|$)/;
function removeSchedules() {
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  for (const f of (isDir(agents) ? fs.readdirSync(agents) : [])) {
    if (!DUTY_PLIST_RE.test(f)) continue;
    run('launchctl', ['unload', path.join(agents, f)], { allowFail: true, capture: true });
    fs.unlinkSync(path.join(agents, f));
    out.log(`removed ${path.join(agents, f)}`);
  }
  if (process.platform === 'linux' && which('crontab')) {
    const current = run('crontab', ['-l'], { allowFail: true, capture: true }).stdout;
    const lines = current.split('\n');
    const kept = lines.filter((l) => !DUTY_CRON_RE.test(l));
    if (kept.length !== lines.length) {
      run('crontab', ['-'], { input: kept.join('\n'), allowFail: true, capture: true });
      out.log(`removed ${lines.length - kept.length} crontab line(s)`);
    }
  }
}

async function uninstall(flags) {
  const cfg = readJson(configPath());
  const bin = claudeBin();
  if (bin) {
    // Warn and continue (a teardown must finish), but never report a removal that did not happen.
    for (const args of [['plugin', 'uninstall', PLUGIN_ID], ['plugin', 'marketplace', 'remove', MARKETPLACE]]) {
      const r = run(bin, args, { allowFail: true, capture: true });
      if (r.status !== 0) out.warn(`claude ${args.join(' ')} failed (${(r.stderr || r.stdout).trim() || 'exit ' + r.status}); run it yourself`);
      else if (r.stdout.trim()) out.log(r.stdout.trim());
    }
  } else {
    out.warn(`claude CLI not found; skipped: claude plugin uninstall ${PLUGIN_ID} && claude plugin marketplace remove ${MARKETPLACE}`);
  }
  removeSchedules();
  const link = path.join(os.homedir(), '.local', 'bin', 'aos');
  try { if (fs.readlinkSync(link).endsWith('/brain/scripts/bin/aos')) { fs.unlinkSync(link); out.log(`removed ${link}`); } } catch { /* absent */ }
  try { fs.unlinkSync(configPath()); out.log(`removed ${configPath()}`); } catch { /* absent */ }
  if (!cfg || !cfg.vault) { out.log('no vault recorded; done'); return 0; }
  if (flags.keepVault) { out.log(`kept vault ${cfg.vault}`); return 0; }
  const typed = process.env.AOS_CONFIRM_DELETE || await ask(`Type the vault path to DELETE it, anything else keeps it (${cfg.vault}): `, '');
  if (typed !== cfg.vault) { out.log(`kept vault ${cfg.vault} (delete it yourself if you want it gone)`); return 0; }
  assertVaultOk(cfg.vault); // structural guard (home dir, Claude config dir, settings.json) even under AOS_CONFIRM_DELETE
  fs.rmSync(cfg.vault, { recursive: true, force: true });
  out.log(`deleted ${cfg.vault}`);
  return 0;
}

function terminal(sub) {
  if (sub[0] !== 'install') throw new UsageError('usage: aos terminal install');
  terminalInstall(loadConfigOrThrow().vault);
  return 0;
}

function persona(sub, flags) {
  const cfg = loadConfigOrThrow();
  const dir = path.join(cfg.vault, 'persona');
  const kill = path.join(dir, 'DISABLED');
  if (sub[0] === 'off') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(kill, `disabled ${new Date().toISOString()}\n`);
    out.log('persona off (persona/DISABLED written; the injected block is suppressed)');
    return 0;
  }
  if (sub[0] === 'on') {
    try { fs.unlinkSync(kill); } catch { /* already on */ }
    out.log('persona on');
    return 0;
  }
  const script = scriptPath(cfg.vault, 'persona/interview.js');
  if (!exists(script)) { out.log('persona interview not installed in this phase'); return 1; }
  const args = [script];
  if (sub[0] === 'rename') {
    if (!sub[1]) throw new UsageError('usage: aos persona rename <name>');
    args.push('rename', sub[1]);
  } else if (sub[0]) {
    throw new UsageError('usage: aos persona [rename <name> | on | off]');
  } else if (flags.personaJson) {
    args.push('--answers', path.resolve(flags.personaJson));
  }
  const r = run(process.execPath, args, { cwd: cfg.vault, env: { AOS_VAULT: cfg.vault, AOS_CONFIG: configPath() }, allowFail: true });
  return r.status === 0 ? 0 : 1;
}

async function cost(sub, flags) {
  const cfg = loadConfigOrThrow();
  const enabled = !!(cfg.cost && cfg.cost.enabled);
  if (!sub[0]) { out.log(`cost ${enabled ? 'enabled' : 'disabled'}`); return 0; }
  if (sub[0] === 'disable') {
    cfg.cost = { ...(cfg.cost || {}), enabled: false };
    writeJson(configPath(), cfg);
    out.log('cost disabled (auto-cost reports "disabled" from the next session end)');
    return 0;
  }
  if (sub[0] !== 'enable') throw new UsageError('usage: aos cost [enable [--budget <usd>] | disable]');
  let repo = null;
  try { repo = repoRoot({ fromLocal: flags.fromLocal || process.env.AOS_REPO_HINT }); } catch { repo = null; }
  const src = repo ? path.join(repo, 'extras', 'cost') : null;
  if (!src || !exists(path.join(src, 'analyze_transcript.py'))) { out.log('cost module not installed in this phase'); return 1; }
  if (!python3Ok(python3Version())) throw new CheckFailed('python3 >= 3.9 is required for the cost module');
  copyTree(src, scriptPath(cfg.vault, 'cost'), { force: true, written: [] });
  cfg.cost = { ...(cfg.cost || {}), enabled: true };
  writeJson(configPath(), cfg);
  let budget = flags.budget !== undefined ? Number(flags.budget) : null;
  if (budget === null && !flags.yes) {
    const answer = await ask('Monthly budget in USD (blank to skip): ', '');
    budget = answer ? Number(answer) : null;
  }
  if (budget !== null && !Number.isNaN(budget)) {
    const p = path.join(cfg.vault, 'brain', 'config.json');
    const vc = readJson(p, {}) || {};
    vc.cost = { ...(vc.cost || {}), monthlyBudget: budget };
    writeJson(p, vc);
  }
  out.log(`cost enabled (analyzer at ${scriptPath(cfg.vault, 'cost')}${budget !== null && !Number.isNaN(budget) ? `, monthly budget ${budget}` : ''})`);
  return 0;
}

// ── args and main ─────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['vault', 'provider', 'persona-json', 'from-local', 'budget']);
const BOOL_FLAGS = new Set(['dry-run', 'yes', 'terminal', 'cost', 'keep-vault']);
const NEGATABLE_FLAGS = new Set(['obsidian']);
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
/** `--flag`, `--no-flag`, `--flag value`, `--flag=value`; unknown flags are a usage error (a typo must never start a real install). */
function parseArgs(argv) {
  const a = { cmd: argv[0] || '', sub: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a.sub.push(t); continue; }
    const eq = t.indexOf('=');
    const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
    const inline = eq === -1 ? undefined : t.slice(eq + 1);
    if (name.startsWith('no-')) {
      const base = name.slice(3);
      if (!NEGATABLE_FLAGS.has(base) || inline !== undefined) throw new UsageError(`unknown flag --${name}`);
      a.flags[camel(base)] = false;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v === '') throw new UsageError(`--${name} needs a value`);
      a.flags[camel(name)] = v;
      continue;
    }
    if (!BOOL_FLAGS.has(name) || inline !== undefined) throw new UsageError(`unknown flag --${name}`);
    a.flags[camel(name)] = true;
  }
  return a;
}

async function main(argv) {
  const { cmd, sub, flags } = parseArgs(argv);
  // --dry-run is an init-only preview (contract §4.3); on a mutating command it must be a loud error, never a silent no-op.
  if (flags.dryRun && cmd !== 'init') throw new UsageError('--dry-run is only supported by `aos init`');
  switch (cmd) {
    case 'init': return init(flags);
    case 'upgrade': return upgrade(flags);
    case 'uninstall': return uninstall(flags);
    case 'terminal': return terminal(sub);
    case 'persona': return persona(sub, flags);
    case 'cost': return cost(sub, flags);
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
  run, which, claudeBin, npmBin, claudeLoggedIn, installedPlugin, python3Version, python3Ok, obsidianDetected, httpProbe, ollamaEndpoint, ollamaProbeSkipped, ask,
  runScript, scriptPath, mcpProbe, spendRowsToday, spendToday, isDutyFeature, isHookFeature, loadConfigOrThrow,
  doctor, status, provider, main,
  init, repoRoot, productVersion, copyTree, assertVaultOk, dailyNotesJson, buildUserConfig, linkLauncher, vendorRuntime,
  installPlugin, download, obsidianBundle, terminalInstall, personaInterview, checklist,
  upgrade, uninstall, removeSchedules, terminal, persona, cost,
  PROVIDERS, PLUGIN_ID, MARKETPLACE, REPO_SLUG, OBSIDIAN_PLUGIN_ID, DEFAULT_VAULT, RUNTIME_SCRIPTS, USAGE,
  VALUE_FLAGS, BOOL_FLAGS, NEGATABLE_FLAGS,
  UsageError, CheckFailed, out,
};
