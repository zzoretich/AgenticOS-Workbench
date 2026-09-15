/**
 * sweep-orphans.js — remove empty orphan side-folders left by dead sessions.
 *
 * Covers two parallel trees, both keyed by session UUID:
 *   - session-env/<uuid>/  (subagent/probe environment dirs)
 *   - file-history/<uuid>/ (per-session file-edit history)
 *
 * Safe by construction:
 *   1. Only acts on directories whose name matches a UUID.
 *   2. Empty dirs use fs.rmdirSync (fails if non-empty — never silently destroys data).
 *   3. Non-empty dirs are removed ONLY when every file is known-transient runtime
 *      residue (per transientResiduePatterns) — e.g. "sessionstart-hook-8.sh"
 *      env-export snippets. Any unrecognized file makes the dir skipped, untouched.
 *   4. Skips any UUID that has a matching <uuid>.jsonl under any project dir in <claudeConfigDir>/projects/ (no
 *      cwd-slug filter). If projects/ cannot be read, the allow-list is unknown: nothing is swept and the result
 *      carries reason 'projects-unreadable:<code>'.
 *   5. Skips any UUID whose dir is younger than orphanUuidMinAgeMinutes.
 *
 * Gated by scanner-config.json: `autoSweepOrphans: true`.
 *   - sweepTransientResidue (default true): enable rule 3 above.
 *   - transientResiduePatterns (default ['-hook-\\d+\\.(sh|ps1|bat|cmd)$']):
 *     regex sources; a non-empty orphan is swept only if EVERY file matches one.
 *
 * Returns: { enabled, reason?, swept: { sessionEnv, fileHistory },
 *            transientSwept: { sessionEnv, fileHistory },
 *            skipped: { nonEmpty, hasJsonl, tooYoung, error } }
 */

const fs = require('fs');
const path = require('path');
const { VAULT, PATHS, safeStat, listDir, readJson } = require('./collectors/util');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SWEEP_TARGETS = [
  { key: 'sessionEnv', dir: 'session-env' },
  { key: 'fileHistory', dir: 'file-history' },
];

// True only if the dir holds >=1 file and EVERY file (recursively) matches a
// transient-residue pattern. Any unrecognized file → false (dir is left alone).
function isTransientResidueOnly(dir, patterns) {
  const stack = [dir];
  let fileCount = 0;
  while (stack.length) {
    const cur = stack.pop();
    for (const name of listDir(cur)) {
      const full = path.join(cur, name);
      const st = safeStat(full);
      if (!st) return false;
      if (st.isDirectory()) { stack.push(full); continue; }
      fileCount++;
      if (!patterns.some((re) => re.test(name))) return false;
    }
  }
  return fileCount > 0;
}

function sweepTree(rootDir, jsonlUuids, minAgeMs, skipped, transient) {
  const swept = [];
  const transientSwept = [];
  const now = Date.now();
  for (const name of listDir(rootDir)) {
    if (!UUID_RE.test(name)) continue;
    const uuid = name.toLowerCase();
    if (jsonlUuids.has(uuid)) { skipped.hasJsonl++; continue; }

    const dir = path.join(rootDir, name);
    const st = safeStat(dir);
    if (!st || !st.isDirectory()) continue;
    if ((now - st.mtimeMs) < minAgeMs) { skipped.tooYoung++; continue; }

    // Re-check contents right before removal to avoid racing a concurrent writer.
    const contents = listDir(dir);
    if (contents.length === 0) {
      try { fs.rmdirSync(dir); swept.push(uuid); }
      catch { skipped.error++; }
      continue;
    }

    // Non-empty: remove only if every file is recognized transient residue.
    if (transient.enabled && isTransientResidueOnly(dir, transient.patterns)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); transientSwept.push(uuid); }
      catch { skipped.error++; }
      continue;
    }

    skipped.nonEmpty++;
  }
  return { swept, transientSwept };
}

/** opts.vault holds scanner-config.json; opts.claudeConfigDir holds projects/, session-env/ and file-history/ (Claude Code's
 *  own trees). Both default to the resolved paths. The projects/ allow-list and the sweep targets MUST share a base:
 *  an allow-list read from the wrong directory would be empty and a live session's side-folders would look orphaned. */
function sweepOrphans(opts = {}) {
  const vault = opts.vault || VAULT;
  const configDir = opts.claudeConfigDir || PATHS.CLAUDE_CONFIG_DIR;
  const cfg = readJson(path.join(vault, 'brain/_index/scanner-config.json')) || {};
  const result = {
    enabled: false,
    swept: { sessionEnv: [], fileHistory: [] },
    transientSwept: { sessionEnv: [], fileHistory: [] },
    skipped: { nonEmpty: 0, hasJsonl: 0, tooYoung: 0, error: 0 },
  };
  if (!cfg.autoSweepOrphans) return result;
  result.enabled = true;

  const transient = {
    enabled: cfg.sweepTransientResidue !== false,
    patterns: (cfg.transientResiduePatterns ?? ['-hook-\\d+\\.(sh|ps1|bat|cmd)$'])
      .map((src) => new RegExp(src, 'i')),
  };

  const minAgeMs = (cfg.orphanUuidMinAgeMinutes ?? 60) * 60 * 1000;
  const projectsDir = path.join(configDir, 'projects');

  // The allow-list (rule 4): every UUID that has a <uuid>.jsonl under ANY project dir — no cwd-slug filter, because an
  // allow-list smaller than reality lets a live session's side-folders look orphaned (a devcontainer cwd like
  // /workspaces/app has no /Users or /home prefix). If projects/ cannot be read at all (missing, EACCES, an unmounted
  // volume) the allow-list is unknown rather than empty: fail closed and sweep nothing. listDir() would have returned
  // [] for both cases and let the sweep run with no protection.
  let projectNames;
  try {
    projectNames = fs.readdirSync(projectsDir);
  } catch (e) {
    result.reason = `projects-unreadable:${(e && e.code) || 'error'}`;
    result.skipped.error++;
    return result;
  }
  const jsonlUuids = new Set();
  for (const name of projectNames) {
    const dir = path.join(projectsDir, name);
    for (const fn of listDir(dir)) {
      if (!fn.endsWith('.jsonl')) continue;
      jsonlUuids.add(fn.replace(/\.jsonl$/, '').toLowerCase());
    }
  }

  for (const { key, dir } of SWEEP_TARGETS) {
    const r = sweepTree(path.join(configDir, dir), jsonlUuids, minAgeMs, result.skipped, transient);
    result.swept[key] = r.swept;
    result.transientSwept[key] = r.transientSwept;
  }

  return result;
}

module.exports = { sweepOrphans };

if (require.main === module) {
  const r = sweepOrphans();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}
