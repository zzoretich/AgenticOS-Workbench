const path = require('path');
const { VAULT, PATHS, safeStat, listDir, exists, iso } = require('./util');

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

function hoursSince(ms) {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60));
}

/** Every directory here is Claude Code's own runtime housekeeping, so it lives under the Claude config dir. */
function collectRuntime(opts = {}) {
  const configDir = opts.claudeConfigDir || PATHS.CLAUDE_CONFIG_DIR;
  const out = {};

  // backups/ — .claude.json.backup.* files
  const backupsDir = path.join(configDir, 'backups');
  const backupFiles = listDir(backupsDir)
    .filter(n => n.startsWith('.claude.json.backup.'))
    .map(n => {
      const s = safeStat(path.join(backupsDir, n));
      return s ? { name: n, size: s.size, mtime: s.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime);
  const totalBackupBytes = backupFiles.reduce((a, f) => a + f.size, 0);
  out.backups = {
    count: backupFiles.length,
    totalBytes: totalBackupBytes,
    oldest: backupFiles[0]
      ? { name: backupFiles[0].name, mtime: iso(backupFiles[0].mtime), ageDays: daysSince(backupFiles[0].mtime) }
      : null,
    newest: backupFiles[backupFiles.length - 1]
      ? { name: backupFiles[backupFiles.length - 1].name, mtime: iso(backupFiles[backupFiles.length - 1].mtime), ageHours: hoursSince(backupFiles[backupFiles.length - 1].mtime) }
      : null,
    warnLarge: backupFiles.length > 50 || totalBackupBytes > 50 * 1024 * 1024,
  };

  // shell-snapshots/
  const shellDir = path.join(configDir, 'shell-snapshots');
  const shellFiles = listDir(shellDir)
    .map(n => {
      const s = safeStat(path.join(shellDir, n));
      return s ? { name: n, size: s.size, mtime: s.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime);
  out.shellSnapshots = {
    count: shellFiles.length,
    totalBytes: shellFiles.reduce((a, f) => a + f.size, 0),
    oldest: shellFiles[0]
      ? { name: shellFiles[0].name, ageDays: daysSince(shellFiles[0].mtime) }
      : null,
    warnLarge: shellFiles.length > 100,
  };

  // cache/
  const cacheDir = path.join(configDir, 'cache');
  const cacheFiles = listDir(cacheDir)
    .map(n => {
      const s = safeStat(path.join(cacheDir, n));
      return s ? { name: n, size: s.size, ageDays: daysSince(s.mtimeMs) } : null;
    })
    .filter(Boolean);
  out.cache = {
    files: cacheFiles,
    totalBytes: cacheFiles.reduce((a, f) => a + f.size, 0),
  };

  // downloads/
  const dlDir = path.join(configDir, 'downloads');
  let dlBytes = 0, dlCount = 0;
  for (const n of listDir(dlDir)) {
    const s = safeStat(path.join(dlDir, n));
    if (s && s.isFile()) { dlBytes += s.size; dlCount++; }
  }
  out.downloads = {
    count: dlCount,
    totalBytes: dlBytes,
    warnLarge: dlBytes > 100 * 1024 * 1024,
  };

  // ide/ — lock files suggest an active IDE connection
  const ideDir = path.join(configDir, 'ide');
  const lockFiles = listDir(ideDir).filter(n => n.endsWith('.lock'));
  out.ide = {
    lockFiles,
    active: lockFiles.length > 0,
  };

  // sessions/ — runtime session files (PID.json, not the brain/sessions logs)
  const sessDir = path.join(configDir, 'sessions');
  const sessFiles = listDir(sessDir)
    .map(n => {
      const s = safeStat(path.join(sessDir, n));
      return s ? { name: n, size: s.size, mtime: iso(s.mtimeMs) } : null;
    })
    .filter(Boolean);
  out.runtimeSessions = {
    count: sessFiles.length,
    files: sessFiles,
  };

  return out;
}

module.exports = { collectRuntime };
