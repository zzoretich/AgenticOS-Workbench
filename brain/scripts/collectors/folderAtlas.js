const path = require('path');
const { VAULT, safeStat, listDir, walkSize, iso } = require('./util');

// Every top-level folder worth monitoring. Order matters for display.
const FOLDERS = [
  'agents', 'brain', 'backups', 'cache', 'commands', 'downloads',
  'file-history', 'get-shit-done', 'hooks', 'ide', 'plans', 'plugins',
  'projects', 'session-env', 'sessions', 'shell-snapshots',
  'skills', 'tasks', 'templates', '.obsidian',
];

// Directories where we should stat-only to stay fast (and avoid reading JS)
const STAT_ONLY_DEEP = new Set(['.obsidian']);

function collectFolderAtlas() {
  const rows = [];
  for (const name of FOLDERS) {
    const p = path.join(VAULT, name);
    const s = safeStat(p);
    if (!s) {
      rows.push({ name, present: false });
      continue;
    }
    const entries = listDir(p).length;
    const sizeInfo = walkSize(p, {
      maxDepth: STAT_ONLY_DEEP.has(name) ? 2 : 10,
    });
    rows.push({
      name,
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

module.exports = { collectFolderAtlas, FOLDERS };
