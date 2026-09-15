import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, seedToggleDefaults } from "./settingsDefaults";

test("the contract §5 settings exist with their defaults", () => {
  assert.equal(DEFAULT_SETTINGS.vaultRoot, "");
  assert.equal(DEFAULT_SETTINGS.claudeConfigDir, "");
  assert.equal(DEFAULT_SETTINGS.nodePath, "");
  assert.equal(DEFAULT_SETTINGS.costEnabled, false);
  assert.equal(DEFAULT_SETTINGS.telemetryEnabled, true);
});

test("the nine pre-existing settings are unchanged", () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).slice(0, 9), [
    "statusBarEnabled", "autoOpenSidebarOnStart", "liveTailPollMs",
    "terminalEmbedded", "terminalEmbedHeight", "terminalShell", "terminalCwd", "terminalFontSize", "terminalScrollback",
  ]);
  assert.equal(DEFAULT_SETTINGS.liveTailPollMs, 300);
  assert.equal(DEFAULT_SETTINGS.terminalEmbedHeight, 280);
});

test("toggles never persisted follow cost.enabled / telemetry.enabled from the vault config; persisted ones stand", () => {
  const on = { cost: { enabled: true, monthlyBudget: 100 }, telemetry: { enabled: false, redact: true, retentionDays: 30 } };
  const off = { cost: { enabled: false, monthlyBudget: null }, telemetry: { enabled: true, redact: true, retentionDays: 30 } };
  // Fresh data.json (no toggle keys): `aos cost enable` shows COST, telemetry.enabled=false stops the sweep.
  const fresh = seedToggleDefaults({ ...DEFAULT_SETTINGS }, {}, on);
  assert.equal(fresh.costEnabled, true);
  assert.equal(fresh.telemetryEnabled, false);
  // Fresh data.json against the config defaults: same values as DEFAULT_SETTINGS.
  const bare = seedToggleDefaults({ ...DEFAULT_SETTINGS }, {}, off);
  assert.equal(bare.costEnabled, false);
  assert.equal(bare.telemetryEnabled, true);
  // Once the user saved the toggles, the stored value wins over the config.
  const kept = seedToggleDefaults({ ...DEFAULT_SETTINGS, costEnabled: false, telemetryEnabled: true }, { costEnabled: false, telemetryEnabled: true }, on);
  assert.equal(kept.costEnabled, false);
  assert.equal(kept.telemetryEnabled, true);
});
