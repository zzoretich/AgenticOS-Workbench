'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// A private vault, set before the first require: lib/paths.js resolves VAULT eagerly and AOS_VAULT
// outranks the shared BRAIN_VAULT that test/setup.js creates (the shape of collectors-brain.test.js).
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-config-updates-'));
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
process.env.AOS_VAULT = VAULT;
const { collectConfig } = require('../collectors/config.js');

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-config-updates-cfg-'));
const storeFile = path.join(VAULT, 'brain', '_index', 'update-check.json');
const write = (o) => fs.writeFileSync(storeFile, `${JSON.stringify(o, null, 2)}\n`);
const store = (over = {}) => ({
  schema: 1, checkedAt: '2026-09-15T00:00:00.000Z', installed: '0.1.0', vaultVersion: '0.1.0',
  pluginVersion: '0.1.0', latest: '0.2.0', behind: true, url: null, snooze: null,
  lastError: null, consecutiveFailures: 0, ...over,
});

test('collectConfig omits updates before the first check', () => {
  fs.rmSync(storeFile, { force: true });
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates, undefined);
});

test('collectConfig surfaces the update summary for the HUD', () => {
  write(store());
  assert.deepEqual(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates, {
    installed: '0.1.0', latest: '0.2.0', behind: true, checkedAt: '2026-09-15T00:00:00.000Z', snoozed: false,
  });
});

test('collectConfig reports an active snooze and ignores a foreign schema', () => {
  write(store({ snooze: { version: '0.2.0', until: '2099-01-01T00:00:00.000Z' } }));
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates.snoozed, true);
  write(store({ snooze: { version: '0.1.5', until: '2099-01-01T00:00:00.000Z' } }));
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates.snoozed, false,
    'a snooze for another version does not silence this one');
  write(store({ schema: 99 }));
  assert.equal(collectConfig({ vault: VAULT, claudeConfigDir: CONFIG_DIR }).updates, undefined,
    'a foreign schema is ignored, never rendered');
});
