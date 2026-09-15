const path = require('path');
const { VAULT, PATHS, safeStat, listDir, walkSize, iso } = require('./util');

// Every top-level folder worth monitoring. Order matters for display.
const FOLDERS = [
  'agents', 'brain', 'backups', 'cache', 'commands', 'downloads',
  'file-history', 'get-shit-done', 'hooks', 'ide', 'plans', 'plugins',
  'projects', 'session-env', 'sessions', 'shell-snapshots',
  'skills', 'tasks', 'templates', '.obsidian',
];
// Folders Claude Code itself owns: they live under the Claude config dir, not the vault (identical in the owner's setup).
const CONFIG_DIR_FOLDERS = new Set([
  'agents', 'backups', 'cache', 'commands', 'downloads', 'file-history', 'hooks', 'ide', 'plugins',
  'projects', 'session-env', 'sessions', 'shell-snapshots', 'skills', 'tasks',
]);

// Two-level stat walk (depth 2 instead of 10) for .obsidian (plugin bundles) and Claude Code's churn trees, which can
// hold thousands of files and are scanned at every session end. Rows for these carry approx: true — files/bytes
// undercount anything deeper (projects/<slug>/<uuid>.jsonl is depth 2 and still counted).
const STAT_ONLY_DEEP = new Set(['.obsidian', 'projects', 'file-history', 'shell-snapshots', 'cache', 'session-env']);

function collectFolderAtlas(opts = {}) {
  const vault = opts.vault || VAULT;
  const configDir = opts.claudeConfigDir || PATHS.CLAUDE_CONFIG_DIR;
  const rows = [];
  for (const name of FOLDERS) {
    const scope = CONFIG_DIR_FOLDERS.has(name) ? 'config' : 'vault';
    const p = path.join(scope === 'config' ? configDir : vault, name);
    const s = safeStat(p);
    if (!s) {
      rows.push({ name, scope, present: false });
      continue;
    }
    const entries = listDir(p).length;
    const sizeInfo = walkSize(p, {
      maxDepth: STAT_ONLY_DEEP.has(name) ? 2 : 10,
    });
    rows.push({
      name,
      scope,
      present: true,
      entries,
      files: sizeInfo.files,
      bytes: sizeInfo.bytes,
      newestMtime: sizeInfo.newestMtime,
      mtime: iso(s.mtimeMs),
      ...(STAT_ONLY_DEEP.has(name) ? { approx: true } : {}),
    });
  }
  return rows;
}

module.exports = { collectFolderAtlas, FOLDERS, CONFIG_DIR_FOLDERS };
