'use strict';
/**
 * host.js — which agent CLI hosts the session. Orthogonal to the model provider
 * (sdk/lib/provider.js): the host fires the hooks and owns the transcript; the
 * provider answers background questions.
 *
 * Hosts: 'claude' (Claude Code) and 'codex' (OpenAI Codex CLI). AOS_HOST is authoritative:
 * the Codex hook entries and MCP registration written by `aos init --host codex` set it
 * explicitly (`env AOS_HOST=codex sh <launcher> <name>`). Where nothing sets it — the MCP
 * server of an older registration, an `aos` verb run inside a session, a Codex-only
 * machine — resolveHost() falls back through a fixed chain (codex-parity D1):
 *   1. AOS_HOST                                  → that host          (via 'aos-host')
 *   2. CLAUDE_PROJECT_DIR / CLAUDECODE in env    → claude             (via 'claude-env')
 *   3. the hook payload's transcript_path         → codex when it is a rollout-*.jsonl or lives
 *                                                  under the codex sessions dirs; claude when it
 *                                                  lives under <claude config dir>/projects
 *                                                                     (via 'transcript')
 *   4. agenticos.json hosts with exactly ONE enabled host → that host  (via 'config')
 *   5. claude                                                          (via 'default')
 * Every input is injectable, so tests and CODEX_HOME / CLAUDE_CONFIG_DIR overrides behave.
 * AOS_DEBUG=1 prints the chosen host and how it was chosen on stderr, once per process.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOSTS = ['claude', 'codex'];

function isHost(h) { return HOSTS.includes(h); }

function claudeConfigDir(env = process.env) {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

function codexHome(env = process.env, userConfig = null) {
  const fromCfg = userConfig && userConfig.hosts && userConfig.hosts.codex && userConfig.hosts.codex.home;
  return path.resolve(fromCfg || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

/** agenticos.json when a vault resolves; null otherwise (plain-node tests, CLI runs before init). */
function defaultUserConfig() {
  try { return require('./paths.js').readUserConfig(); } catch { return null; }
}

/** Where a host keeps its config and its session transcripts. */
function hostDirs(host, { env = process.env, userConfig } = {}) {
  const cfg = userConfig === undefined ? defaultUserConfig() : userConfig;
  if (host === 'codex') {
    const home = codexHome(env, cfg);
    return {
      host: 'codex',
      configDir: home,
      sessions: path.join(home, 'sessions'),
      archived: path.join(home, 'archived_sessions'),
      history: path.join(home, 'history.jsonl'),
    };
  }
  const configDir = path.resolve((cfg && cfg.claudeConfigDir) || claudeConfigDir(env));
  return { host: 'claude', configDir, sessions: path.join(configDir, 'projects') };
}

function inside(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Hosts whose `hosts.<name>.enabled` is not false. A config without `hosts` (pre-0.5.0) names none. */
function enabledHosts(userConfig) {
  const hosts = userConfig && userConfig.hosts && typeof userConfig.hosts === 'object' ? userConfig.hosts : null;
  if (!hosts) return [];
  return HOSTS.filter((h) => hosts[h] && typeof hosts[h] === 'object' && hosts[h].enabled !== false);
}

/**
 * The detection chain (module comment). `payload` is the parsed hook stdin (or any object with
 * transcript_path / transcriptPath); `userConfig` undefined means "read agenticos.json if there is one".
 * Returns { host, via }.
 */
function resolveHost({ env = process.env, payload = null, userConfig } = {}) {
  if (isHost(env.AOS_HOST)) return { host: env.AOS_HOST, via: 'aos-host' };
  if (env.CLAUDE_PROJECT_DIR || env.CLAUDECODE) return { host: 'claude', via: 'claude-env' };
  const cfg = userConfig === undefined ? defaultUserConfig() : userConfig;
  const tp = payload && (payload.transcript_path || payload.transcriptPath);
  if (typeof tp === 'string' && tp) {
    if (/^rollout-.*\.jsonl$/.test(path.basename(tp))) return { host: 'codex', via: 'transcript' };
    const cx = hostDirs('codex', { env, userConfig: cfg });
    if (inside(tp, cx.sessions) || inside(tp, cx.archived)) return { host: 'codex', via: 'transcript' };
    if (inside(tp, hostDirs('claude', { env, userConfig: cfg }).sessions)) return { host: 'claude', via: 'transcript' };
  }
  const enabled = enabledHosts(cfg);
  if (enabled.length === 1) return { host: enabled[0], via: 'config' };
  return { host: 'claude', via: 'default' };
}

let debugged = false;
/** The host of this process: resolveHost() with the real env; pass the hook payload when you have it. */
function currentHost(env = process.env, payload = null) {
  const r = resolveHost({ env, payload });
  if (env.AOS_DEBUG === '1' && !debugged) {
    debugged = true;
    process.stderr.write(`[agenticos] host=${r.host} via=${r.via}\n`);
  }
  return r.host;
}

/** True inside a hook invocation of either host. Claude Code exports CLAUDE_PROJECT_DIR only to hook commands. */
function isHookInvocation(env = process.env) {
  return !!(env.AOS_HOST || env.CLAUDE_PROJECT_DIR);
}

function walkForSuffix(dir, suffix, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix)) return full;
    if (e.isDirectory() && depth > 0) {
      const hit = walkForSuffix(full, suffix, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The transcript file for a session id.
 *   codex:  <home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl, then <home>/archived_sessions/
 *   claude: <configDir>/projects/<slug>/<id>.jsonl under any slug (mirrors auto-cost.js findTranscript)
 */
function findTranscript(host, sessionId, dirs) {
  if (!sessionId) return null;
  const d = dirs || hostDirs(host);
  if (host === 'codex') {
    const suffix = `-${sessionId}.jsonl`;
    return walkForSuffix(d.sessions, suffix, 3) || walkForSuffix(d.archived, suffix, 0);
  }
  let slugs = [];
  try { slugs = fs.readdirSync(d.sessions); } catch { return null; }
  for (const s of slugs) {
    const candidate = path.join(d.sessions, s, `${sessionId}.jsonl`);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

module.exports = { HOSTS, resolveHost, enabledHosts, currentHost, isHookInvocation, hostDirs, findTranscript, codexHome, claudeConfigDir };
