// The contract between main, the preload and the page: channel names and payload types only, no imports (the preload
// bundles this file, and a sandboxed preload can load nothing else). The page reaches main only through the named
// functions of AosBridge (window.aos, src/preload/index.ts); main checks every call's sender and arguments
// (src/main/ipc/) and answers with a Result. Phase 4: docs/superpowers/plans/2026-10-05-sandbox-renderer.md.

export const CH = {
  /** sync: everything the page needs to boot. */
  boot: "host:boot",
  /** page → main: the plugin has loaded; carries its commands so main can build the menu. */
  ready: "host:ready",
  /** main → page: vault-relative paths that changed, batched. */
  vaultChanges: "vault:changes",
  /** main → page: run a plugin command (`agentic-os:*`) or a host command (`host:*`). */
  command: "host:command",
  /** main → page: an agenticos:// link to route. */
  protocol: "host:protocol",

  // Files. Reads and writes are sync: the HUD reads inside render paths, as it did with Node's fs. Trash is async.
  fsExists: "fs:exists",
  fsStat: "fs:stat",
  fsReadText: "fs:read-text",
  fsReadBytes: "fs:read-bytes",
  fsReaddir: "fs:readdir",
  fsWalk: "fs:walk",
  fsWriteText: "fs:write-text",
  fsAppendText: "fs:append-text",
  fsMkdir: "fs:mkdir",
  fsRemove: "fs:remove",
  fsRename: "fs:rename",
  fsCopy: "fs:copy",
  fsTrash: "fs:trash",

  // Processes: the page names each child; output and exit come back as events.
  procSpawn: "proc:spawn",
  procKill: "proc:kill",
  procExecSync: "proc:exec-sync",
  procEvent: "proc:event",

  // Terminals, hosted by main's node-pty.
  ptyAvailable: "pty:available",
  ptySpawn: "pty:spawn",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyEvent: "pty:event",

  // The OS.
  shellOpenExternal: "shell:open-external",
  shellOpenPath: "shell:open-path",
  shellShowItem: "shell:show-item",

  // A plugin's own settings (Obsidian's loadData/saveData), in the app's data folder.
  pluginLoadData: "plugin:load-data",
  pluginSaveData: "plugin:save-data",
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
  /** The write surfaces on at boot (src/shared/surfaces.ts); empty means read-only. */
  writeSurfaces: string[];
  writeSource: WriteSource;
  /** Whether main runs the vault watcher (the page then listens on CH.vaultChanges instead of watching). */
  mainWatcher: boolean;
  appVersion: string;
  electron: string;
  /** The host facts the HUD reads (HudHost.env): the home folder, the platform, and the variables it looks at. */
  home: string;
  platform: string;
  env: Record<string, string>;
  /** Where the app's resources are (the packaged smoke checks it is the bundle's). */
  resourcesPath: string;
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

// ── calls ─────────────────────────────────────────────────────────────

/**
 * Every call's answer. `code` is Node's (ENOENT, EEXIST …), EROFS when the policy refused it, EINVAL for arguments that
 * do not parse, EPERM for a sender that is not the app's page. `error` is a short reason, never a stack.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export interface StatInfo { size: number; mtimeMs: number; ctimeMs: number; file: boolean; dir: boolean; link: boolean }

export interface DirEntryInfo { name: string; file: boolean; dir: boolean; link: boolean }

/** One file of a vault walk: its vault-relative path and stats. */
export interface WalkEntry { rel: string; size: number; mtimeMs: number; ctimeMs: number }

/** "hud": the HUD's and the compat layer's writes (the HUD surfaces). "editor": the note editor's saves (Notes). */
export type WriteVia = "hud" | "editor";

export interface SpawnRequest {
  /** The page's name for this child: [a-z0-9-], unique while it runs. */
  id: string;
  cmd: string;
  args: string[];
  cwd?: string;
  /** Variables set on top of main's environment (each one checked: src/main/policy/programs.ts). */
  env?: Record<string, string>;
  unsetEnv?: string[];
  stdio?: "pipe" | "ignore";
  detached?: boolean;
}

export type ProcEvent =
  | { id: string; type: "stdout" | "stderr"; data: string }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "exit"; code: number | null; signal: string | null };

export interface ExecRequest { file: string; args: string[]; timeoutMs: number }

export interface PtySpawnRequest {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  name: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export type PtyEvent =
  | { id: string; type: "data"; data: string }
  | { id: string; type: "exit"; exitCode: number; signal?: number };

/** window.aos: everything the page may ask of main. Named functions only (no channel names, no event objects). */
export interface AosBridge {
  boot(): BootInfo | null;
  ready(info: ReadyInfo): void;
  onCommand(cb: (id: string) => void): () => void;
  onProtocol(cb: (req: ProtocolRequest) => void): () => void;
  onVaultChanges(cb: (paths: string[]) => void): () => void;
  fs: {
    exists(p: string): Result<boolean>;
    stat(p: string): Result<StatInfo>;
    readText(p: string): Result<string>;
    readBytes(p: string, position: number, length: number): Result<Uint8Array>;
    readdir(p: string): Result<DirEntryInfo[]>;
    /** Every file under the vault (the index), skipping what the vault index skips. */
    walk(): Result<WalkEntry[]>;
    writeText(p: string, data: string, via: WriteVia): Result<null>;
    appendText(p: string, data: string): Result<null>;
    mkdir(p: string, recursive: boolean): Result<null>;
    remove(p: string, recursive: boolean): Result<null>;
    rename(from: string, to: string): Result<null>;
    copy(from: string, to: string): Result<null>;
    trash(p: string): Promise<Result<null>>;
  };
  proc: {
    spawn(req: SpawnRequest): Result<{ pid: number | null }>;
    kill(id: string, signal?: string): void;
    execSync(req: ExecRequest): Result<string>;
    onEvent(cb: (ev: ProcEvent) => void): () => void;
  };
  pty: {
    available(): Result<null>;
    spawn(req: PtySpawnRequest): Result<{ pid: number }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string, signal?: string): void;
    onEvent(cb: (ev: PtyEvent) => void): () => void;
  };
  shell: {
    openExternal(url: string): void;
    openPath(p: string): Promise<string>;
    showItemInFolder(p: string): void;
  };
  plugin: {
    loadData(id: string): Result<unknown>;
    saveData(id: string, json: string): Result<null>;
  };
}
