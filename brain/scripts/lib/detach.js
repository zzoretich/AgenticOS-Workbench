'use strict';
/**
 * detach.js — lets a hook script return to Claude Code immediately while the
 * real work continues in a detached child. Replaces the old `bash -c '… &'`
 * hook wiring so hooks.json can call `sh bin/aos <name>` directly.
 *
 *   if (respawnDetached()) process.exit(0);   // parent, inside a hook: child spawned
 *   … real work runs here (inline, or in the child with AOS_DETACHED=1) …
 *
 * Hook detection: Claude Code exports CLAUDE_PROJECT_DIR only to hook commands
 * (not to the Bash tool, not to Obsidian-plugin spawns), so manual and plugin
 * runs stay inline and print their output. Installers/tests that must run a
 * hook script inline from a hook-like environment set AOS_DETACHED=1.
 */
const { spawn } = require('child_process');

function respawnDetached(argv = process.argv.slice(2), spawnFn = spawn) {
  if (process.env.AOS_DETACHED === '1') return false;
  if (!process.env.CLAUDE_PROJECT_DIR) return false;
  const child = spawnFn(process.execPath, [process.argv[1], ...argv], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AOS_DETACHED: '1' },
  });
  child.unref();
  return true;
}

module.exports = { respawnDetached };
