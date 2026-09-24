#!/usr/bin/env node
'use strict';
/**
 * skills-sync.js — SessionEnd hook on both hosts (spec 2026-09-23-universal-skills D5): mirror each host's user skills
 * into the other host's user folder and refresh brain/_index/skills.json, so a skill made in this session is on the other
 * host by that host's next session. It then does the same for user agents (spec 2026-09-23-universal-agents D5:
 * brain/_index/agents.json), riding this hook so no new hook entry needs trusting. Each sync is guarded on its own, so a
 * failure in one never skips the other. The work runs in a detached child (Codex caps SessionEnd at 3 s). Filesystem
 * only, no model call. Exits 0 with empty stdout on every path; AOS_DEBUG=1 explains a failure on stderr.
 */
const { PATHS, readUserConfig } = require('./lib/hook-entry.js').hookEntry();
const { respawnDetached } = require('./lib/detach.js');

if (respawnDetached()) process.exit(0);

const userCfg = readUserConfig();
for (const [name, lib] of [['skills', './lib/skills.js'], ['agents', './lib/agents.js']]) {
  try {
    require(lib).sync({ vault: PATHS.VAULT, userCfg });
  } catch (e) {
    if (process.env.AOS_DEBUG === '1') process.stderr.write(`[agenticos] skills-sync (${name}): ${e && e.message}\n`);
  }
}
process.exit(0);
