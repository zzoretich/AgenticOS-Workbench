'use strict';
/**
 * models.js — single source of truth for the local three-role model stack.
 * Roles: workhorse (background hooks/jobs), reasoner (deep Q&A / coding),
 * embedder (vector recall). Callers ask for a role, never a tag.
 *
 * Env overrides (read lazily on every call):
 *   BRAIN_MODEL           workhorse tag   (default qwen3.5:4b)
 *   BRAIN_REASONER        reasoner tag    (default gpt-oss:20b)
 *   BRAIN_REASONER_EFFORT '0' disables the effort dial (set when the reasoner
 *                         is a model without think-level support, e.g. gemma4:12b)
 *   BRAIN_EMBEDDER        embedder tag    (default qwen3-embedding:0.6b)
 *
 * Stack C fallback = BRAIN_REASONER=gemma4:12b BRAIN_REASONER_EFFORT=0, or
 * change the DEFAULTS.reasoner entry below.
 */

const DEFAULTS = {
  workhorse: { tag: 'qwen3.5:4b', env: 'BRAIN_MODEL', keepAlive: -1, effort: false, numCtxCap: 32768 },
  reasoner:  { tag: 'gpt-oss:20b', env: 'BRAIN_REASONER', keepAlive: '10m', effort: true, numCtxCap: 16384 },
  embedder:  { tag: 'qwen3-embedding:0.6b', env: 'BRAIN_EMBEDDER', keepAlive: -1, effort: false, numCtxCap: null },
};

function role(name) {
  const d = DEFAULTS[name];
  if (!d) throw new Error('unknown model role: ' + name);
  const effort = name === 'reasoner' && process.env.BRAIN_REASONER_EFFORT === '0' ? false : d.effort;
  return { role: name, tag: process.env[d.env] || d.tag, keepAlive: d.keepAlive, effort, numCtxCap: d.numCtxCap };
}

// think value for a chat call: workhorse is hard-false (hybrid thinking model
// burns its budget otherwise — standing feedback rule); effort-capable
// reasoners take 'low'|'medium'|'high' (default medium); everything else false.
function thinkFor(name, effort) {
  if (name === 'workhorse') return false;
  const r = role(name);
  return r.effort ? (effort || 'medium') : false;
}

module.exports = { role, thinkFor };
