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

// Directories where we should stat-only to stay fast (and avoid reading JS)
const STAT_ONLY_DEEP = new Set(['.obsidian']);

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
    });
  }
  return rows;
}

module.exports = { collectFolderAtlas, FOLDERS, CONFIG_DIR_FOLDERS };
