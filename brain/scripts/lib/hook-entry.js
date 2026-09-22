'use strict';
/**
 * hook-entry.js — common prologue for every hook script, whichever host fires it.
 * Must be the FIRST require in a hook file (before anything that pulls in paths.js).
 *   - AOS_HEADLESS=1  → exit 0: we are inside a headless AgenticOS worker; never re-enter the hooks.
 *   - no vault        → exit 0 with one stderr line: a hook must never fail a session.
 * finishStop() is the matching epilogue for Stop hooks: Codex requires JSON on stdout there
 * (plain text is rejected), Claude Code accepts silence, so it prints `{}` only under Codex.
 */
function finishStop(payload = null) {
  if (require('./host.js').currentHost(process.env, payload) === 'codex') process.stdout.write('{}');
}

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
module.exports = { hookEntry, finishStop };
