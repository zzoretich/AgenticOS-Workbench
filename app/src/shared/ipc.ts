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

  // Setup (phase 5): the first-run wizard and attach mode. The page names a check, a fix or a step; main runs it.
  setupPreflight: "setup:preflight",
  setupFix: "setup:fix",
  setupInput: "setup:input",
  setupResize: "setup:resize",
  setupCancel: "setup:cancel",
  setupChooseVault: "setup:choose-vault",
  setupInstall: "setup:install",
  setupClaudeMd: "setup:claude-md",
  setupApplyClaudeMd: "setup:apply-claude-md",
  setupFinish: "setup:finish",
  setupUpgrade: "setup:upgrade",
  setupNoted: "setup:noted",
  /** main → page: a setup job's output and exit. */
  setupEvent: "setup:event",

  // The app's own updates (electron-updater).
  updateState: "update:state",
  updateCheck: "update:check",
  updateInstall: "update:install",
  /** main → page: the updater's state changed. */
  updateEvent: "update:event",
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
  /** With no vault: why, and what the wizard starts from. null when a vault is attached. */
  setup: SetupBoot | null;
  /** With a vault: what attach mode shows. null when there is none. */
  attach: AttachInfo | null;
  update: UpdateState;
}

// ── setup and updates (phase 5) ──────────────────────────────────────

/** The runtime this app carries (Contents/Resources/payload), a release tree `aos init` and `aos upgrade` run from. */
export interface PayloadInfo { version: string; runtimeDeps: boolean }

export interface SetupBoot {
  /** no-config: no agenticos.json. no-vault: it names a vault that is not there. */
  reason: "no-config" | "no-vault";
  payload: PayloadInfo | null;
  /** The vault agenticos.json names (no-vault), else null. */
  configuredVault: string | null;
  /** Where a new vault goes unless the user picks another folder: ~/AgenticOS. */
  defaultVault: string;
  agenticosFile: string;
}

export interface AttachInfo {
  /** The first time this app opens this vault: the "What changed" note is due. */
  firstTime: boolean;
  /** agenticos.json's `version`: the runtime the vault has. */
  runtimeVersion: string | null;
  payloadVersion: string | null;
  /** The vault's runtime is older than the one this app carries: offer `aos upgrade`. */
  behind: boolean;
  hosts: { claude: boolean; codex: boolean };
}

export type SetupCheckId = "homebrew" | "node" | "claude" | "claude-login" | "codex" | "codex-login" | "ollama" | "ollama-models" | "python" | "uv";
export type SetupFixId = "homebrew" | "node" | "python" | "uv" | "ollama" | "ollama-models" | "claude" | "codex" | "claude-login" | "codex-login";

export interface SetupCheck {
  id: SetupCheckId;
  label: string;
  /** warn: something to fix that `aos init` does not need (Ollama's models), so it never holds up Continue. */
  state: "ok" | "warn" | "missing";
  /** A version, a path, or what is wrong. */
  detail: string;
  /** Whether `aos init` needs it (the host rows count through `hosts`). */
  required: boolean;
  fix: SetupFixId | null;
  /** The fix's label and the command it runs, as the user will see it typed. */
  fixLabel: string | null;
  fixCommand: string | null;
  /** Why the fix cannot run yet (it needs Homebrew, or Node), else null. */
  fixBlocked: string | null;
}

export interface PreflightReport {
  checks: SetupCheck[];
  /** The hosts that are installed and logged in. */
  hosts: { claude: boolean; codex: boolean };
  /** Every required check passes and at least one host is ready. */
  ready: boolean;
}

/** The Chief of Staff interview (brain/scripts/persona/interview.js), as a form. */
export interface PersonaAnswers {
  name: string;
  addressAs: string;
  voice: string;
  priorities: string[];
  dutyModel: string;
  dutyCodexModel: string;
  dutyEffort: "low" | "medium" | "high";
  schedule: boolean;
}

export interface InstallRequest {
  host: "claude" | "codex" | "both";
  /** Absolute, or starting with ~/. */
  vault: string;
  /** null: no interview now (`aos persona` later). */
  persona: PersonaAnswers | null;
}

export type SetupJob = "fix" | "install" | "upgrade";

export type SetupEvent =
  | { job: SetupJob; type: "data"; data: string }
  | { job: SetupJob; type: "exit"; code: number | null; signal: string | null };

/** The line `aos init` asks Claude Code users to add, as a diff against their CLAUDE.md. */
export interface ClaudeMdPreview {
  path: string;
  line: string;
  present: boolean;
  /** The file's last lines as context, then the added line. */
  diff: Array<{ kind: "context" | "add"; text: string }>;
}

export type UpdateStatus = "off" | "idle" | "checking" | "none" | "available" | "downloading" | "downloaded" | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** Why updates are off (a dev run, the smoke build, `updates.check: false` …). */
  reason: string | null;
  /** The version on offer, once known. */
  version: string | null;
  percent: number | null;
  error: string | null;
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
  /** The first-run wizard and attach mode. One job (a fix, the install, an upgrade) runs at a time. */
  setup: {
    preflight(): Promise<Result<PreflightReport>>;
    /** Runs a fix-it in a terminal main opens (output on onEvent, job "fix"). */
    fix(id: SetupFixId, cols: number, rows: number): Result<null>;
    /** Keys typed into the running fix's terminal (a password, a prompt's answer). */
    input(data: string): void;
    resize(cols: number, rows: number): void;
    cancel(): void;
    /** A folder picker; null when cancelled. */
    chooseVault(): Promise<string | null>;
    install(req: InstallRequest): Result<null>;
    claudeMd(): Result<ClaudeMdPreview>;
    applyClaudeMd(): Result<ClaudeMdPreview>;
    /** Attaches the vault `aos init` just recorded; main then reloads the page into the Workbench. */
    finish(): Result<null>;
    /** `aos upgrade` from the payload (attach mode, when the vault's runtime is behind). */
    upgrade(): Result<null>;
    /** The "What changed" note was read. */
    noted(): void;
    onEvent(cb: (ev: SetupEvent) => void): () => void;
  };
  update: {
    state(): UpdateState;
    check(): void;
    /** Quits and installs a downloaded update. */
    install(): void;
    onState(cb: (s: UpdateState) => void): () => void;
  };
}
