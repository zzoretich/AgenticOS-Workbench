'use strict';
/**
 * markers.js — per-session / per-day marker files (.injected-<sid>, .last-summary-<date>).
 * They are process bookkeeping, not vault data, so they live under the OS temp dir,
 * keyed by a hash of the vault path so two vaults on one machine never collide.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PATHS } = require('./paths.js');

const VAULT_KEY = crypto.createHash('sha1').update(PATHS.VAULT).digest('hex').slice(0, 8);
const MARKER_DIR = path.join(os.tmpdir(), 'agenticos', VAULT_KEY);

function markerPath(name) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
  } catch {
    /* unwritable tmpdir: return the path anyway; the caller's own marker read/write fails soft inside its guards */
  }
  return path.join(MARKER_DIR, safe);
}

module.exports = { markerPath, MARKER_DIR };
