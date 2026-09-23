'use strict';
/**
 * headless.js — which agent CLI runs a headless agent job (a prompt routine, a persona duty), and the
 * argv for it (codex-parity D4/D5). Not the provider (sdk/lib/provider.js answers one-shot questions
 * without tools) and not the host (lib/host.js says who fired a hook): a runner is an agent with tools
 * and a working directory, spawned by run-routine.js and persona/run-duty.sh.
 *
 *   resolveRunner({ cfg, kind })  →  { host: 'claude' | 'codex' | null, bin, model, reason }
 *     kind is 'routines' or 'persona'; cfg.<kind>.runner ∈ auto | claude | codex (default auto; the env
 *     AOS_RUNNER overrides it). auto prefers claude when hosts.claude is enabled and a binary resolves,
 *     else codex on the same test. A config without `hosts` (pre-0.5.0) means claude only.
 *     Binaries: PERSONA_CLAUDE_BIN (persona only) / AOS_CODEX_BIN → the recorded hosts.<h>.bin (or the
 *     legacy claude.bin) → `command -v` → the usual install locations; AOS_NO_CLAUDE / AOS_NO_CODEX hide one.
 *     model: the model to pass — routine/duty model for claude; for codex cfg.<kind>.codexModel, else cfg.codex.model
 *     (null = the user's Codex default), because a routine's `model` is a Claude alias by contract.
 *   runnerArgs(host, { prompt, system, model, effort, tools, budget, outFile })  →  { argv, stdin }
 *     claude: the `claude -p` recipe every duty and prompt routine used before (budget enforced by the CLI).
 *     codex:  `codex exec -` with the prompt (system text first) on stdin, workspace-write sandbox, our
 *             hooks off, JSON events on stdout, the final message in outFile. Codex has no budget flag:
 *             the daily cap still gates the start and the spend is estimated afterwards (record-spend.js);
 *             the tools allowlist has no Codex form, the sandbox is the guard.
 *   crossArgs(host, { mode, schema, schemaFile, outFile, model, effort, budget, mcpOff })  →  { argv }
 *     one cross-review / handoff child (spec 2026-09-23-cross-review D4); the prompt always goes on stdin and the
 *     child is always ephemeral (D3). No child in any mode gets an MCP server, a plugin or a connector: claude an
 *     empty strict MCP config; codex every plugin off (that takes their MCP servers and connectors with it), each
 *     server its config.toml declares switched off by name (`mcpOff`, from codexMcpServers()), web search off, and
 *     our hooks plus its app/browser/computer/image tools off — measured live on codex-cli 0.156.1, where
 *     `-c mcp_servers={}` merges instead of emptying. mode 'review' and 'consult' are read-only: claude runs in safe
 *     mode (no CLAUDE.md, skills, plugins or hooks) with only Read/Glob/Grep, codex in the read-only sandbox; 'review'
 *     adds the structured reply (claude --json-schema <schema JSON>, codex --output-schema <schemaFile>). mode 'build'
 *     writes: claude acceptEdits with the user's own permissions, codex workspace-write. An effort the host's CLI does
 *     not take is left off here; the runner refuses it before it gets this far.
 *   codexMcpServers(home)  →  the names of the [mcp_servers.<name>] tables in <home>/config.toml ([] when unreadable).
 *   CLI: node lib/headless.js --resolve [--kind persona|routines]  prints `host<TAB>bin<TAB>model<TAB>codex home`,
 *        exit 3 (reason on stderr) when no runner resolves. run-duty.sh reads it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOSTS = ['claude', 'codex'];
const CLAUDE_CANDIDATES = [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
const CODEX_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex')];
const CLAUDE_EFFORTS = ['low', 'medium', 'high'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** What `claude --effort` takes (Claude Code 2.1.281); runnerArgs keeps its narrower routine list. */
const CROSS_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CROSS_MODES = ['review', 'consult', 'build'];
/** The only tools a read-only claude child gets. */
const READ_TOOLS = 'Read,Glob,Grep';
/** Codex features no cross-review child gets: each is a way to act outside the shell sandbox (plugins carry the
 *  connectors and their MCP servers). */
const CODEX_OFF = ['hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'image_generation'];
const EMPTY_MCP = '{"mcpServers":{}}';

function isExecutableFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}
function defaultLookup(name) {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

function hostEnabled(cfg, h) {
  const hosts = cfg && cfg.hosts && typeof cfg.hosts === 'object' ? cfg.hosts : null;
  if (!hosts) return h === 'claude';
  return !!(hosts[h] && typeof hosts[h] === 'object' && hosts[h].enabled !== false);
}

/** The binary for a host, or null. lookup(name) is injectable. */
function resolveBin(h, { cfg, env = process.env, kind, lookup = defaultLookup, candidates } = {}) {
  const cands = (list) => (candidates === false ? [] : Array.isArray(candidates) ? candidates : list);
  if (h === 'claude') {
    if (env.AOS_NO_CLAUDE === '1') return null;
    if (kind === 'persona' && env.PERSONA_CLAUDE_BIN) return isExecutableFile(env.PERSONA_CLAUDE_BIN) ? env.PERSONA_CLAUDE_BIN : null;
    const recorded = (cfg && cfg.hosts && cfg.hosts.claude && cfg.hosts.claude.bin) || (cfg && cfg.claude && cfg.claude.bin);
    if (recorded && isExecutableFile(recorded)) return recorded;
    return lookup('claude') || cands(CLAUDE_CANDIDATES).find(isExecutableFile) || null;
  }
  if (env.AOS_NO_CODEX === '1') return null;
  if (env.AOS_CODEX_BIN) return isExecutableFile(env.AOS_CODEX_BIN) ? env.AOS_CODEX_BIN : null;
  const recorded = (cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.bin) || (cfg && cfg.codex && cfg.codex.bin);
  if (recorded && isExecutableFile(recorded)) return recorded;
  return lookup('codex') || cands(CODEX_CANDIDATES).find(isExecutableFile) || null;
}

function defaultConfig() {
  try { return require('./config.js').loadConfig(); } catch { return {}; }
}

/** The Codex home `aos init` recorded (hosts.codex.home), or null: a headless codex run must use the same one. */
function codexHomeOf(cfg) {
  const h = cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.home;
  return typeof h === 'string' && h ? h : null;
}

/** See the module comment. `cfg` undefined → loadConfig(). */
function resolveRunner({ cfg, kind = 'routines', env = process.env, lookup, candidates } = {}) {
  const c = cfg === undefined ? defaultConfig() : (cfg || {});
  const section = c[kind] && typeof c[kind] === 'object' ? c[kind] : {};
  const pref = HOSTS.includes(env.AOS_RUNNER) ? env.AOS_RUNNER : HOSTS.includes(section.runner) ? section.runner : 'auto';
  const order = pref === 'auto' ? HOSTS : [pref];
  const why = [];
  for (const h of order) {
    if (pref === 'auto' && !hostEnabled(c, h)) { why.push(`${h} host disabled`); continue; }
    const bin = resolveBin(h, { cfg: c, env, kind, lookup, candidates });
    if (!bin) { why.push(`${h} CLI not found`); continue; }
    // A kind's own Codex model (persona.codexModel, routines.codexModel), else codex.model, else the user's Codex default.
    const str = (v) => (typeof v === 'string' && v ? v : null);
    const model = h === 'codex' ? (str(section.codexModel) || str(c.codex && c.codex.model)) : null;
    const home = h === 'codex' ? codexHomeOf(c) : null;
    return { host: h, bin, model, home, reason: pref === 'auto' ? 'auto' : `${kind}.runner=${pref}` };
  }
  return { host: null, bin: null, model: null, home: null, reason: why.join('; ') || 'no host enabled' };
}

/**
 * Which CLI answers the vault graph's semantic pass (spec 2026-09-23-codex-parity-gaps D3). graph.semantic.runner pins
 * one (claude | codex); otherwise an explicit provider claude or codex names it; otherwise Claude when it is an enabled
 * host with a binary, else Codex on the same test. → { host, bin } or null. `bins` replaces the lookups (tests).
 */
function graphRunner(cfg, { env = process.env, lookup, candidates, bins } = {}) {
  const c = cfg || {};
  const sem = (c.graph && c.graph.semantic) || {};
  const pinned = HOSTS.includes(sem.runner) ? sem.runner : HOSTS.includes(c.provider) ? c.provider : null;
  for (const h of pinned ? [pinned] : HOSTS) {
    if (!pinned && !hostEnabled(c, h)) continue;
    const bin = bins && Object.prototype.hasOwnProperty.call(bins, h) ? bins[h] : resolveBin(h, { cfg: c, env, lookup, candidates });
    if (bin) return { host: h, bin };
  }
  return null;
}

/** { argv, stdin } for one headless agent run on `host`. */
function runnerArgs(host, { prompt = '', system = '', model, effort = 'medium', tools = '', budget, outFile } = {}) {
  if (host === 'codex') {
    const argv = ['exec', '-', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-c', 'features.hooks=false', '--json'];
    if (outFile) argv.push('-o', String(outFile));
    if (model) argv.push('-m', String(model));
    if (CODEX_EFFORTS.includes(effort)) argv.push('-c', `model_reasoning_effort="${effort}"`);
    return { argv, stdin: system ? `${system}\n\n---\n\n${prompt}` : String(prompt) };
  }
  const argv = ['-p', String(prompt), '--model', String(model || 'haiku'), '--effort', CLAUDE_EFFORTS.includes(effort) ? effort : 'medium'];
  if (tools) argv.push('--allowedTools', String(tools));
  if (budget !== undefined && budget !== null && budget !== '') argv.push('--max-budget-usd', String(budget));
  argv.push('--output-format', 'json', '--strict-mcp-config', '--no-session-persistence');
  if (system) argv.push('--append-system-prompt', String(system));
  return { argv, stdin: null };
}

/** A config key segment for `-c`: bare when TOML allows it, quoted otherwise. */
function tomlKey(name) { return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name); }

/** The servers <home>/config.toml declares ([mcp_servers.<name>] tables, not their sub-tables such as .env). */
function codexMcpServers(home) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return []; }
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const name = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** { argv } for one cross-review child on `host` (module comment). Throws on an unknown mode. */
function crossArgs(host, { mode, schema, schemaFile, outFile, model, effort, budget, mcpOff = [] } = {}) {
  if (!CROSS_MODES.includes(mode)) throw new Error(`crossArgs: unknown mode ${mode}`);
  const readOnly = mode !== 'build';
  if (host === 'codex') {
    const argv = ['exec', '-', '--ephemeral', '--skip-git-repo-check', '-s', readOnly ? 'read-only' : 'workspace-write'];
    for (const f of CODEX_OFF) argv.push('-c', `features.${f}=false`);
    for (const name of mcpOff) argv.push('-c', `mcp_servers.${tomlKey(name)}.enabled=false`);
    argv.push('-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '--json');
    if (outFile) argv.push('-o', String(outFile));
    if (model) argv.push('-m', String(model));
    if (CODEX_EFFORTS.includes(effort)) argv.push('-c', `model_reasoning_effort="${effort}"`);
    if (mode === 'review' && schemaFile) argv.push('--output-schema', String(schemaFile));
    return { argv };
  }
  const argv = ['-p', '--output-format', 'json', '--no-session-persistence', '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP, '--no-chrome'];
  if (readOnly) {
    argv.push('--safe-mode', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS, '--permission-mode', 'dontAsk');
    if (mode === 'review' && schema) argv.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema));
  } else {
    // The user's normal permissions: a denied proof command is a reported failure, never a reason to bypass them.
    argv.push('--permission-mode', 'acceptEdits');
  }
  if (model) argv.push('--model', String(model));
  if (CROSS_CLAUDE_EFFORTS.includes(effort)) argv.push('--effort', effort);
  if (budget !== undefined && budget !== null && budget !== '') argv.push('--max-budget-usd', String(budget));
  return { argv };
}

/** The child's env: headless, never CLAUDECODE, and the recorded Codex home unless the environment names one already. */
function headlessEnv(base = process.env, { codexHome = null } = {}) {
  const env = { ...base, AOS_HEADLESS: '1' };
  delete env.CLAUDECODE;
  if (codexHome && !env.CODEX_HOME) env.CODEX_HOME = codexHome;
  return env;
}

function main(argv) {
  if (!argv.includes('--resolve')) { process.stderr.write('usage: headless.js --resolve [--kind persona|routines]\n'); return 2; }
  const i = argv.indexOf('--kind');
  const kind = i !== -1 && ['persona', 'routines'].includes(argv[i + 1]) ? argv[i + 1] : 'routines';
  const r = resolveRunner({ kind });
  if (!r.host) { process.stderr.write(`headless: no runner for ${kind} (${r.reason})\n`); return 3; }
  process.stdout.write(`${r.host}\t${r.bin}\t${r.model || ''}\t${r.home || ''}\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { resolveRunner, graphRunner, resolveBin, runnerArgs, crossArgs, codexMcpServers, headlessEnv, hostEnabled, codexHomeOf, HOSTS, CODEX_EFFORTS, CLAUDE_EFFORTS, CROSS_CLAUDE_EFFORTS, CROSS_MODES, CODEX_OFF };
