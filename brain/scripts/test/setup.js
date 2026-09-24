'use strict';
// Preloaded via NODE_OPTIONS for every test process: gives paths.js a vault to
// resolve when a test file does not set one itself. Sets the LEGACY alias so a
// test's own `process.env.BRAIN_VAULT = …` still wins (AOS_VAULT would beat it).
// First, in the top-level runner only, drop every host variable the developer's shell exported (AOS_*, BRAIN_*,
// CLAUDE*, CODEX_*): the defaults below then always come from temp folders (tools/test-env.js; tests are never vendored).
require('../../../tools/test-env.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
if (!process.env.AOS_VAULT && !process.env.BRAIN_VAULT) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  // No test may resolve a real provider: the shared temp vault forces "none".
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  process.env.BRAIN_VAULT = v;
}
if (!process.env.AOS_CONFIG) process.env.AOS_CONFIG = path.join(os.tmpdir(), 'aos-test-no-config.json');
// lib/hook-entry.js exits the process on AOS_HEADLESS=1, and heartbeat-writer.js, auto-wrap.js and update-session.js
// run that prologue at module scope when a test requires them — an inherited AOS_HEADLESS=1 would make those test
// files exit 0 during require and report green with no tests run. A test that wants the headless path sets the
// variable inside its own child (test/auto-cost.test.js does).
delete process.env.AOS_HEADLESS;
// Never the developer's real ~/.claude: the collectors and the orphan sweep (which deletes) read PATHS.CLAUDE_CONFIG_DIR,
// so every brain test process gets a private, empty Claude config dir unless a test pins its own.
if (!process.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-cfg-'));
// The same for Codex: its config.toml names the default model that pricing reads, and its sessions are what the host
// collectors scan. A developer with Codex installed must see what CI sees.
if (!process.env.CODEX_HOME) process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-codex-'));
