'use strict';
/**
 * node-path.js — the Node path AgenticOS records in agenticos.json and renders into the routine schedules
 * (spec 2026-10-05-workbench-app-design D12). Zero dependencies.
 *
 * Homebrew runs Node from a versioned folder, <prefix>/Cellar/<formula>/<version>/bin/node, which `brew upgrade` deletes,
 * so a recorded Cellar path breaks every hook and schedule on the next upgrade. Homebrew also keeps a stable link,
 * <prefix>/opt/<formula>/bin/node, that follows the installed version: record that one instead, but only when it
 * resolves to the very binary that is running, so the recorded Node is never a different version.
 */
const fs = require('fs');

const CELLAR_RE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/** The opt link for a Cellar node when it resolves to the same file; otherwise execPath unchanged. */
function stableNode(execPath, fsImpl = fs) {
  const m = CELLAR_RE.exec(String(execPath || ''));
  if (!m) return execPath;
  const opt = `${m[1]}/opt/${m[2]}/bin/node`;
  try {
    if (!fsImpl.existsSync(opt)) return execPath;
    return fsImpl.realpathSync(opt) === fsImpl.realpathSync(execPath) ? opt : execPath;
  } catch { return execPath; }
}

/** True for a path inside Homebrew's versioned Cellar: one `brew upgrade` away from missing. */
function isCellarPath(p) { return typeof p === 'string' && p.includes('/Cellar/'); }

module.exports = { stableNode, isCellarPath, CELLAR_RE };
