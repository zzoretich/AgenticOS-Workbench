import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, DEAD_SETTINGS_KEYS } from "./settingsDefaults";

test("the contract §5 settings exist with their defaults", () => {
  assert.equal(DEFAULT_SETTINGS.vaultRoot, "");
  assert.equal(DEFAULT_SETTINGS.claudeConfigDir, "");
  assert.equal(DEFAULT_SETTINGS.nodePath, "");
});

test("the nine pre-existing settings are unchanged", () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).slice(0, 9), [
    "statusBarEnabled", "autoOpenSidebarOnStart", "liveTailPollMs",
    "terminalEmbedded", "terminalEmbedHeight", "terminalShell", "terminalCwd", "terminalFontSize", "terminalScrollback",
  ]);
  assert.equal(DEFAULT_SETTINGS.liveTailPollMs, 300);
  assert.equal(DEFAULT_SETTINGS.terminalEmbedHeight, 280);
});

test("cost and telemetry are the system's switches, not plugin settings (spec 2026-09-24-settings-tab D10)", () => {
  assert.equal("costEnabled" in DEFAULT_SETTINGS, false);
  assert.equal("telemetryEnabled" in DEFAULT_SETTINGS, false);
  assert.ok(DEAD_SETTINGS_KEYS.includes("costEnabled") && DEAD_SETTINGS_KEYS.includes("telemetryEnabled"), "a stored HUD-only value is pruned");
  for (const k of DEAD_SETTINGS_KEYS) assert.equal(k in DEFAULT_SETTINGS, false, k);
});
