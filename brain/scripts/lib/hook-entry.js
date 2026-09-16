'use strict';
/**
 * hook-entry.js — common prologue for every Claude Code hook script.
 * Must be the FIRST require in a hook file (before anything that pulls in paths.js).
 *   - AOS_HEADLESS=1  → exit 0: we are inside a headless AgenticOS worker; never re-enter the hooks.
 *   - no vault        → exit 0 with one stderr line: a hook must never fail a Claude session.
 */
function hookEntry() {
  if (process.env.AOS_HEADLESS === '1') process.exit(0);
  try {
    return require('./paths.js');
  } catch (e) {
    if (e && e.code === 'VAULT_NOT_FOUND') {
      process.stderr.write(`[agenticos] ${e.message}\n`);
      process.exit(0);
    }
    throw e;
  }
}
module.exports = { hookEntry };
