// The contract between main and the renderer: channel names and payload types only, no imports.

export const CH = {
  /** renderer → main, sync: everything the renderer needs to boot. */
  boot: "host:boot",
  /** renderer → main: the plugin has loaded; carries its commands so main can build the menu. */
  ready: "host:ready",
  /** main → renderer: vault-relative paths that changed, batched. */
  vaultChanges: "vault:changes",
  /** main → renderer: run a plugin command (`agentic-os:*`) or a host command (`host:*`). */
  command: "host:command",
  /** main → renderer: an agenticos:// link to route. */
  protocol: "host:protocol",
} as const;

/** Where the app's own pages come from (main/app-scheme.ts): the main window loads `${APP_ORIGIN}/index.html`. */
export const APP_ORIGIN = "app://hud";

/** The tray popover's window name: the one window.open main allows (renderer/popover.ts opens it). */
export const POPOVER = "aos-sidebar-popover";

/** Who decided which write surfaces are on: the environment (tests, one-off runs) or the default (every verified one). */
export type WriteSource = "AOS_APP_WRITE" | "default";

export interface BootInfo {
  vaultRoot: string | null;
  vaultSource: string;
  userData: string;
  /** The write surfaces on at boot (src/shared/write-policy.ts); empty means read-only. */
  writeSurfaces: string[];
  writeSource: WriteSource;
  /** Whether main runs the vault watcher (the renderer then listens on CH.vaultChanges instead of watching). */
  mainWatcher: boolean;
  appVersion: string;
  electron: string;
}

export interface CommandInfo {
  id: string;
  name: string;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
}

export interface ReadyInfo { commands: CommandInfo[] }

export interface VaultChanges { paths: string[] }

export interface ProtocolRequest { action: string; params: Record<string, string> }

/** Commands the host itself answers, alongside the plugin's own. */
export const HOST_COMMANDS = {
  palette: "host:palette",
  closeTab: "host:close-tab",
  /** The settings window: the app's own tab and the plugin's (Obsidian's settings, in the app). */
  settings: "host:settings",
} as const;
