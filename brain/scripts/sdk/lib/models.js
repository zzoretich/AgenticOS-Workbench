'use strict';
/**
 * models.js — single source of truth for the model roles.
 * Roles: workhorse (background hooks/jobs, Ollama), reasoner (deep Q&A / reflection,
 * headless Claude), embedder (vector recall, Ollama), claude (the hook fallback when
 * Ollama is away). Callers ask for a role, never a tag, and `providerFor(role)` says
 * which provider serves it — provider.js routes on that.
 *
 * Tag precedence per role: env override → config key → DEFAULTS below.
 *   workhorse  BRAIN_MODEL        (default qwen3.5:9b)
 *   reasoner   BRAIN_REASONER  →  reasoner.model in agenticos.json  (default claude-opus-5)
 *   embedder   BRAIN_EMBEDDER     (default qwen3-embedding:0.6b)
 *   claude     AOS_CLAUDE_MODEL → claude.model                      (default haiku)
 * Env is read lazily on every call.
 */

const DEFAULTS = {
  workhorse: { tag: 'qwen3.5:9b', env: 'BRAIN_MODEL', cfgKey: null, keepAlive: -1, effort: false, numCtxCap: 32768, provider: 'ollama' },
  // The reasoner is a Claude model id (pinned, not the floating `opus` alias). keepAlive and
  // numCtxCap are Ollama concepts and stay null; `effort` maps onto `claude -p --effort`.
  reasoner:  { tag: 'claude-opus-5', env: 'BRAIN_REASONER', cfgKey: 'reasoner', keepAlive: null, effort: true, numCtxCap: null, provider: 'claude' },
  embedder:  { tag: 'qwen3-embedding:0.6b', env: 'BRAIN_EMBEDDER', cfgKey: null, keepAlive: -1, effort: false, numCtxCap: null, provider: 'ollama' },
  claude:    { tag: 'haiku', env: 'AOS_CLAUDE_MODEL', cfgKey: 'claude', keepAlive: null, effort: false, numCtxCap: null, provider: 'claude' },
};

const EFFORTS = ['low', 'medium', 'high'];

/** Merged config, or {} when no vault resolves (plain-node tests, extras run outside a vault). */
function readConfig(cfg) {
  if (cfg) return cfg;
  try { return require('../../lib/config.js').loadConfig(); } catch { return {}; }
}

/** Which provider serves a role: 'ollama' for workhorse/embedder, 'claude' for reasoner/claude. */
function providerFor(name) {
  const d = DEFAULTS[name];
  if (!d) throw new Error('unknown model role: ' + name);
  return d.provider;
}

/**
 * role(name, cfg?) — { role, tag, keepAlive, effort, numCtxCap, provider }. `cfg` is the merged
 * config (loaded when omitted); only roles with a cfgKey consult it.
 */
function role(name, cfg) {
  const d = DEFAULTS[name];
  if (!d) throw new Error('unknown model role: ' + name);
  let tag = process.env[d.env];
  if (!tag && d.cfgKey) {
    const block = readConfig(cfg)[d.cfgKey];
    if (block && typeof block.model === 'string' && block.model.trim()) tag = block.model.trim();
  }
  return { role: name, tag: tag || d.tag, keepAlive: d.keepAlive, effort: d.effort, numCtxCap: d.numCtxCap, provider: d.provider };
}

// Effort for a call: the workhorse is hard-false (a hybrid thinking model burns its budget
// otherwise — standing feedback rule); the reasoner takes 'low'|'medium'|'high', defaulting
// to reasoner.effort in config, then 'medium'; everything else false.
function thinkFor(name, effort, cfg) {
  if (name === 'workhorse') return false;
  const r = role(name, cfg);
  if (!r.effort) return false;
  if (EFFORTS.includes(effort)) return effort;
  const block = readConfig(cfg).reasoner;
  const fromCfg = block && String(block.effort || '').toLowerCase();
  return EFFORTS.includes(fromCfg) ? fromCfg : 'medium';
}

module.exports = { role, thinkFor, providerFor, EFFORTS };
