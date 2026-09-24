// Pure settings shape + defaults (no obsidian import) so node:test can load it and
// data modules (nodeResolver) can take the settings object without pulling the UI in.
// Cost and telemetry are not here: they are the system's own switches (cost.enabled, telemetry.enabled), read from the
// merged config by Plugin.costOn()/telemetryOn() and changed through `aos config` (spec 2026-09-24-settings-tab D10).

export interface AgenticOSSettings {
  statusBarEnabled: boolean;
  autoOpenSidebarOnStart: boolean;
  liveTailPollMs: number;
  // Terminal
  terminalEmbedded: boolean;
  terminalEmbedHeight: number;
  terminalShell: string;
  terminalCwd: string;
  terminalFontSize: number;
  terminalScrollback: number;
  // AgenticOS (contract §5)
  vaultRoot: string;         // "" → this Obsidian vault's base path
  claudeConfigDir: string;   // "" → agenticos.json.claudeConfigDir → $CLAUDE_CONFIG_DIR → ~/.claude
  nodePath: string;          // "" → auto (src/data/nodeResolver.ts); a login-shell probe result is saved here
}

/** Keys data.json may still hold from earlier versions; loadSettings prunes them (the two HUD-only toggles, D10). */
export const DEAD_SETTINGS_KEYS = ["snapshotPath", "runsPath", "sessionPath", "snapshotHistoryDir", "refreshDebounceMs", "costEnabled", "telemetryEnabled"];

export const DEFAULT_SETTINGS: AgenticOSSettings = {
  statusBarEnabled: true,
  autoOpenSidebarOnStart: false,
  liveTailPollMs: 300,
  // Terminal — shell + cwd auto-resolve at plugin load if blank
  terminalEmbedded: true,
  terminalEmbedHeight: 280,
  terminalShell: "",
  terminalCwd: "",
  terminalFontSize: 13,
  terminalScrollback: 5000,
  // AgenticOS
  vaultRoot: "",
  claudeConfigDir: "",
  nodePath: "",
};
