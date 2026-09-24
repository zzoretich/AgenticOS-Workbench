#!/usr/bin/env node
'use strict';
/**
 * skills-sync.js — SessionEnd hook on both hosts (spec 2026-09-23-universal-skills D5): mirror each host's user skills
 * into the other host's user folder and refresh brain/_index/skills.json, so a skill made in this session is on the other
 * host by that host's next session. The work runs in a detached child (Codex caps SessionEnd at 3 s). Filesystem only,
 * no model call. Exits 0 with empty stdout on every path; AOS_DEBUG=1 explains a failure on stderr.
 */
const { PATHS, readUserConfig } = require('./lib/hook-entry.js').hookEntry();
const { respawnDetached } = require('./lib/detach.js');

if (respawnDetached()) process.exit(0);

try {
  require('./lib/skills.js').sync({ vault: PATHS.VAULT, userCfg: readUserConfig() });
} catch (e) {
  if (process.env.AOS_DEBUG === '1') process.stderr.write(`[agenticos] skills-sync: ${e && e.message}\n`);
}
process.exit(0);
