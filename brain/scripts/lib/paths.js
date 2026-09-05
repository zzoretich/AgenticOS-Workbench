'use strict';
/**
 * paths.js — the ONLY vault resolver. Resolution order:
 *   1. AOS_VAULT env (BRAIN_VAULT accepted as a legacy alias)
 *   2. "vault" in <claudeConfigDir>/agenticos.json (AOS_CONFIG overrides that file's path)
 *   3. walk up from this file (at most 8 levels) until a dir has brain/_index, or CLAUDE.md + brain/
 *   4. throw VaultNotFound — hook scripts catch it (lib/hook-entry.js) and exit 0
 * There is no personal fallback. Depth-independent: works from brain/scripts/* and brain/scripts/sdk/lib/*.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

class VaultNotFound extends Error {
  constructor(msg) { super(msg); this.name = 'VaultNotFound'; this.code = 'VAULT_NOT_FOUND'; }
}

function claudeConfigDir() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}
function configFile() {
  return path.resolve(process.env.AOS_CONFIG || path.join(claudeConfigDir(), 'agenticos.json'));
}
function readUserConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return null; }
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function looksLikeVault(dir) {
  return isDir(path.join(dir, 'brain', '_index')) ||
    (fs.existsSync(path.join(dir, 'CLAUDE.md')) && isDir(path.join(dir, 'brain')));
}

function detectVault() {
  const env = process.env.AOS_VAULT || process.env.BRAIN_VAULT;
  if (env && isDir(env)) return path.resolve(env);
  const cfg = readUserConfig();
  if (cfg && typeof cfg.vault === 'string' && isDir(cfg.vault)) return path.resolve(cfg.vault);
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (looksLikeVault(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new VaultNotFound('no AgenticOS vault found: set AOS_VAULT, write agenticos.json, or run `aos init`');
}

const USER_CONFIG = readUserConfig() || {};
const VAULT = detectVault();
const CLAUDE_CONFIG_DIR = path.resolve(USER_CONFIG.claudeConfigDir || claudeConfigDir());

const PATHS = {
  VAULT,
  CLAUDE_CONFIG_DIR,
  PROJECTS: path.join(CLAUDE_CONFIG_DIR, 'projects'),
  BRAIN: path.join(VAULT, 'brain'),
  INDEX: path.join(VAULT, 'brain', '_index'),
  CONFIG_JSON: path.join(VAULT, 'brain', 'config.json'),
  MEMORY_DIR: path.join(VAULT, 'brain', 'memory'),
  PATTERNS: path.join(VAULT, 'brain', 'patterns'),
  REFLECTIONS: path.join(VAULT, 'brain', 'reflections'),
  SCRIPTS: path.join(VAULT, 'brain', 'scripts'),
  AGENT_RUNS: path.join(VAULT, 'brain', '_index', 'agent-runs'),
  BRAIN_MD: path.join(VAULT, 'brain', '_index', 'BRAIN.md'),
  SESSION_MD: path.join(VAULT, 'brain', '_index', 'SESSION.md'),
  SNAPSHOT_JSON: path.join(VAULT, 'brain', '_index', 'snapshot.json'),
  MEMORY_INDEX: path.join(VAULT, 'MEMORY.md'),
  PERSONA: path.join(VAULT, 'persona'),
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULT_LAYOUT = '{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md';

/** Daily-note layout from <vault>/brain/config.json (dailyNote.layout), else the default.
 *  The Obsidian plugin reads the same key from brain/config.json (its src/data/dailyNote.ts
 *  twin is replaced in a later phase) — one owner, no drift. */
function dailyNoteLayout() {
  try {
    const c = JSON.parse(fs.readFileSync(PATHS.CONFIG_JSON, 'utf8'));
    if (c && c.dailyNote && typeof c.dailyNote.layout === 'string') return c.dailyNote.layout;
  } catch { /* no config → default */ }
  return DEFAULT_LAYOUT;
}
function formatLayout(layout, d) {
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return layout.replace(/\{yyyy\}/g, yyyy).replace(/\{MMMM\}/g, MONTHS[d.getMonth()]).replace(/\{MM\}/g, MM).replace(/\{dd\}/g, dd);
}
function dailyNotePath(d = new Date()) {
  return path.join(VAULT, ...formatLayout(dailyNoteLayout(), d).split('/'));
}

/** Claude Code names a transcript folder after the working directory with every non-alphanumeric char → "-". */
function projectSlug(absDir) { return String(absDir).replace(/[^A-Za-z0-9]/g, '-'); }

module.exports = {
  VAULT, PATHS, dailyNotePath, dailyNoteLayout, formatLayout, MONTHS, DEFAULT_LAYOUT,
  projectSlug, detectVault, claudeConfigDir, configFile, VaultNotFound,
};
