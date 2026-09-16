const path = require('path');
const { VAULT, safeStat, listDir, exists, readJson, readText } = require('./util');

function collectGsd() {
  const gsdDir = path.join(VAULT, 'get-shit-done');
  const out = {
    installed: exists(gsdDir),
    version: null,
    counts: {},
    manifest: { present: false, fileCount: 0, missing: [], drift: 0 },
  };
  if (!out.installed) return out;

  const versionFile = path.join(gsdDir, 'VERSION');
  const v = readText(versionFile);
  if (v) out.version = v.trim();

  const subdirs = ['bin', 'contexts', 'references', 'templates', 'workflows'];
  for (const sd of subdirs) {
    const p = path.join(gsdDir, sd);
    if (!exists(p)) { out.counts[sd] = null; continue; }
    let count = 0;
    const walk = (d) => {
      for (const n of listDir(d)) {
        const full = path.join(d, n);
        const s = safeStat(full);
        if (!s) continue;
        if (s.isDirectory()) walk(full);
        else count++;
      }
    };
    walk(p);
    out.counts[sd] = count;
  }

  // Manifest drift
  const manifestPath = path.join(VAULT, 'gsd-file-manifest.json');
  const mf = readJson(manifestPath);
  if (mf && mf.files && typeof mf.files === 'object') {
    const entries = Object.keys(mf.files);
    const missing = [];
    for (const rel of entries) {
      const full = path.join(VAULT, rel);
      if (!exists(full)) missing.push(rel);
    }
    out.manifest = {
      present: true,
      fileCount: entries.length,
      manifestVersion: mf.version || null,
      manifestTimestamp: mf.timestamp || null,
      missing,
      drift: missing.length,
    };
  }

  // GSD-provided skills + agents + commands referenced from manifest
  // vs what's actually in .claude/skills, agents, commands
  return out;
}

module.exports = { collectGsd };
