// Pure settings shape + defaults (no obsidian import) so node:test can load it and
// data modules (nodeResolver) can take the settings object without pulling the UI in.
import type { VaultConfig } from "./data/aosConfig";

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
  costEnabled: boolean;      // gates the COST row, AnchorModal, cost Fix Queue cards, COST DETAIL drawer section;
                             //   until first saved it follows agenticos.json/brain/config.json cost.enabled (seedToggleDefaults)
  telemetryEnabled: boolean; // gates the orphan sweep on load and LiveRunsWatcher's mkdir of agent-runs/live;
                             //   until first saved it follows telemetry.enabled the same way
}

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
  costEnabled: false,
  telemetryEnabled: true,
};

/**
 * First-load defaults for the two toggles that mirror config keys the scripts own
 * (`cost.enabled`, set by `aos cost enable|disable` in agenticos.json; `telemetry.enabled`,
 * honored by telemetry-hook.js). A toggle the user never persisted (key absent from data.json)
 * follows the merged vault config, so the plugin and `aos` agree without a second switch. A
 * persisted value always stands — the user's explicit choice outranks the config.
 * `persisted` is the raw loadData() object; `cfg` is readVaultConfig(vaultRoot).
 */
export function seedToggleDefaults(
  settings: AgenticOSSettings,
  persisted: Record<string, unknown>,
  cfg: Pick<VaultConfig, "cost" | "telemetry">,
): AgenticOSSettings {
  const stored = (k: keyof AgenticOSSettings) => Object.prototype.hasOwnProperty.call(persisted, k);
  if (!stored("costEnabled")) settings.costEnabled = cfg.cost.enabled === true;
  if (!stored("telemetryEnabled")) settings.telemetryEnabled = cfg.telemetry.enabled !== false;
  return settings;
}
