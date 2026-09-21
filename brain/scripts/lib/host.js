'use strict';
/**
 * host.js — which agent CLI hosts the session. Orthogonal to the model provider
 * (sdk/lib/provider.js): the host fires the hooks and owns the transcript; the
 * provider answers background questions.
 *
 * Hosts: 'claude' (Claude Code) and 'codex' (OpenAI Codex CLI). A hook learns its
 * host from AOS_HOST, which the Codex hook entries written by `aos init --host codex`
 * set explicitly (`env AOS_HOST=codex sh <launcher> <name>`); the Claude Code plugin
 * sets nothing and is the default. Nothing here sniffs transcript paths or vendor
 * environment variables, so tests and CODEX_HOME / CLAUDE_CONFIG_DIR overrides behave.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOSTS = ['claude', 'codex'];

function currentHost(env = process.env) {
  return env.AOS_HOST === 'codex' ? 'codex' : 'claude';
}

/** True inside a hook invocation of either host. Claude Code exports CLAUDE_PROJECT_DIR only to hook commands. */
function isHookInvocation(env = process.env) {
  return !!(env.AOS_HOST || env.CLAUDE_PROJECT_DIR);
}

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

module.exports = { HOSTS, currentHost, isHookInvocation, hostDirs, findTranscript, codexHome, claudeConfigDir };
