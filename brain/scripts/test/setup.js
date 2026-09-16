'use strict';
// Preloaded via NODE_OPTIONS for every test process: gives paths.js a vault to
// resolve when a test file does not set one itself. Sets the LEGACY alias so a
// test's own `process.env.BRAIN_VAULT = …` still wins (AOS_VAULT would beat it).
const fs = require('fs');
const os = require('os');
const path = require('path');
if (!process.env.AOS_VAULT && !process.env.BRAIN_VAULT) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-vault-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  process.env.BRAIN_VAULT = v;
}
if (!process.env.AOS_CONFIG) process.env.AOS_CONFIG = path.join(os.tmpdir(), 'aos-test-no-config.json');
