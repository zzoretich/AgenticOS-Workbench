'use strict';
/**
 * pin-root.js — under AOS_HEADLESS=1 (every duty, routine and background agent), the persona scripts a duty may call
 * refuse a path override that leaves the vault (spec 2026-09-23-duty-write-scope-design D3). A duty's allowlist names
 * the script, not its flags, so `ledger.js append … --file <anywhere>` or `tick.js beat --root <anywhere>` would
 * otherwise write, or start a runner, outside the vault on the model's say-so. Interactive runs and tests keep every
 * flag. The vault is resolved lazily: lib/paths.js throws at require time when there is none.
 */
const fs = require('fs');
const path = require('path');

/** realpath of p; for a path that does not exist yet, the realpath of its nearest existing ancestor plus the rest. */
function real(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(real(parent), path.basename(abs));
  }
}

/** True when p is dir itself or below it (both already absolute). */
function inside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Throws when a headless run points `root` anywhere but the vault, `file` anywhere but `<vault>/<fileRel>`, or one of
 * `within` outside `<vault>/<withinRel>`. A no-op without AOS_HEADLESS=1. Symlinks are resolved on both sides.
 */
function assertPinned({ root = null, file = null, fileRel = null, within = [], withinRel = null } = {}, { env = process.env, vault = null } = {}) {
  if (env.AOS_HEADLESS !== '1') return;
  const v = real(vault || require('./paths.js').VAULT);
  if (root !== null && root !== undefined && real(root) !== v) {
    throw new Error(`--root ${root} is not the vault: a headless run cannot redirect it`);
  }
  if (file !== null && file !== undefined && real(file) !== real(path.join(v, fileRel))) {
    throw new Error(`--file ${file} is not ${fileRel}: a headless run cannot redirect it`);
  }
  if (within.length) {
    const dir = real(path.join(v, withinRel));
    const bad = within.find((f) => !inside(dir, real(f)));
    if (bad) throw new Error(`${bad} is outside ${withinRel}: a headless run cannot write it`);
  }
}

module.exports = { assertPinned, real, inside };
