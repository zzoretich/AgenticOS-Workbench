const path = require('path');
const { VAULT, PATHS, safeStat, exists, readJson, readText, countLines, iso } = require('./util');

function collectConfig(opts = {}) {
  const vault = opts.vault || VAULT;
  const configDir = opts.claudeConfigDir || PATHS.CLAUDE_CONFIG_DIR;
  const out = {};

  const settingsPath = path.join(configDir, 'settings.json');
  const settings = readJson(settingsPath);
  if (settings) {
    const hooks = settings.hooks || {};
    let hookCount = 0;
    for (const event of Object.keys(hooks)) {
      for (const m of (hooks[event] || [])) {
        hookCount += (m.hooks || []).length;
      }
    }
    out.settings = {
      path: settingsPath,
      model: settings.model || null,
      theme: settings.theme || null,
      effortLevel: settings.effortLevel || null,
      statusLine: settings.statusLine?.command || null,
      permissionsAllow: (settings.permissions?.allow || []).length,
      permissionsDefaultMode: settings.permissions?.defaultMode || null,
      dangerousMode: settings.skipDangerousModePermissionPrompt === true,
      hookEvents: Object.keys(hooks),
      hookCount,
      autoUpdatesChannel: settings.autoUpdatesChannel || null,
    };
  } else {
    out.settings = { path: settingsPath, missing: true };
  }

  const claudeMd = path.join(configDir, 'CLAUDE.md');
  const cs = safeStat(claudeMd);
  out.claudeMd = cs
    ? { size: cs.size, mtime: iso(cs.mtimeMs), lines: countLines(claudeMd) }
    : { missing: true };

  const memoryMd = path.join(vault, 'MEMORY.md');
  const mtext = readText(memoryMd);
  if (mtext) {
    const pointers = (mtext.match(/^- \[.+\]\(.+\)/gm) || []).length;
    const ms = safeStat(memoryMd);
    out.memoryMd = { size: ms.size, mtime: iso(ms.mtimeMs), pointers };
  } else {
    out.memoryMd = { missing: true };
  }

  const gsdManifest = path.join(vault, 'gsd-file-manifest.json');
  const mf = readJson(gsdManifest);
  if (mf) {
    const fileCount = mf.files && typeof mf.files === 'object'
      ? Object.keys(mf.files).length
      : 0;
    out.gsdManifest = { present: true, fileCount, version: mf.version || null, timestamp: mf.timestamp || null };
  } else {
    out.gsdManifest = { present: exists(gsdManifest) };
  }

  const historyJsonl = path.join(configDir, 'history.jsonl');
  const hs = safeStat(historyJsonl);
  out.historyJsonl = hs
    ? { size: hs.size, mtime: iso(hs.mtimeMs), lines: countLines(historyJsonl) }
    : { missing: true };

  out.topLevelFiles = {
    packageJson: exists(path.join(vault, 'package.json')),
    gitignore: exists(path.join(vault, '.gitignore')),
    credentials: exists(path.join(configDir, '.credentials.json')),
  };

  const stray = [];
  if (exists(path.join(vault, 'nul'))) stray.push('nul');
  out.stray = stray;

  return out;
}

module.exports = { collectConfig };
