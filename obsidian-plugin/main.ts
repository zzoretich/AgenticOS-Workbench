import { Plugin, WorkspaceLeaf, TAbstractFile, Events, Notice } from "obsidian";
import { SidebarHUDView, VIEW_TYPE_SIDEBAR_HUD } from "./src/views/SidebarHUD";
import { MemoryInspectorView, VIEW_TYPE_MEMORY_INSPECTOR, consumePendingMemory } from "./src/views/MemoryInspectorView";
import { RunInspectorView, VIEW_TYPE_RUN_INSPECTOR, consumePendingRunId } from "./src/views/RunInspectorView";
import { WorkbenchView, VIEW_TYPE_WORKBENCH } from "./src/views/WorkbenchView";
import type { TermTab } from "./src/views/TermTab";
import type { PulseTab } from "./src/views/PulseTab";
import type { RunsTab } from "./src/views/RunsTab";
import { TerminalPool } from "./src/data/terminalPool";
import { setPluginDir as setTerminalPluginDir } from "./src/data/terminalSession";
import { AgenticOSSettings, AgenticOSSettingTab, DEFAULT_SETTINGS } from "./src/settings";
import { loadSnapshot, SNAPSHOT_PATH } from "./src/data/snapshot";
import { loadRuns, RUNS_PATH, formatRelative } from "./src/data/runs";
import { CaptureModal } from "./src/ui/CaptureModal";
import { HeartbeatClient } from "./src/data/heartbeatClient";
import { LiveRunsWatcher } from "./src/data/liveRuns";
import { sweepOrphans } from "./src/data/orphanSweep";
import { COMMAND_REGISTRY, executeCommand, setSpawnContext } from "./src/data/commandRegistry";
import { resolveNodeBinary } from "./src/data/nodeResolver";
import { readAgenticosJson, readVaultConfig, claudeConfigDir as defaultClaudeConfigDir } from "./src/data/aosConfig";
import { seedToggleDefaults } from "./src/settingsDefaults";
import { loadAllMaps } from "./src/data/workspaceMaps";
import { listMemories } from "./src/data/memories";
import { loadStaff } from "./src/data/staff";
import { loadInventory } from "./src/data/inventory";
import type { FixAction } from "./src/data/fixQueue";
import { buildOmniItems } from "./src/data/omni";
import { OmniModal } from "./src/ui/OmniModal";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// How often to regenerate snapshot.json while Obsidian is open. The HUD nags
// once the snapshot is >30 min old (see briefing.ts); 15 min keeps it ahead of
// that threshold. The only other refresh trigger is the Claude SessionEnd hook.
const SNAPSHOT_REFRESH_MS = 15 * 60_000;
const SNAPSHOT_STALE_MS = 15 * 60_000;

export default class AgenticOSPlugin extends Plugin {
  settings!: AgenticOSSettings;
  private statusBarEl: HTMLElement | null = null;
  private statusBarTimer: number | null = null;
  private runsWatcher: fs.FSWatcher | null = null;
  private runsBytesSeen: number = 0;
  private snapshotRefreshing: boolean = false;

  hb!: HeartbeatClient;
  liveRuns: LiveRunsWatcher | null = null;
  bus: Events = new Events();    // intra-plugin event bus for live-run fan-out
  terminalPool!: TerminalPool;

  async onload(): Promise<void> {
    await this.loadSettings();
    setSpawnContext({ node: this.nodeBin(), vaultRoot: this.vaultRoot() });

    // heartbeat client — now a thin reflector over the local live watcher.
    // setSource() is called after the LiveRunsWatcher is constructed on onLayoutReady.
    this.hb = new HeartbeatClient();
    this.hb.on("change", () => { this.refreshStatusBar(); });
    this.hb.on("probe", () => { /* keep status bar's "ago" fresh */ });
    this.hb.start();

    // terminal pool — defaults resolved here
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const vaultPath = adapter.getBasePath ? adapter.getBasePath() : process.cwd();
    const defaultShell = this.settings.terminalShell || process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
    const defaultCwd = this.settings.terminalCwd || vaultPath;
    // tell the terminal session loader where to find node_modules/node-pty
    const pluginPath = require("path").join(vaultPath, ".obsidian", "plugins", "agentic-os");
    setTerminalPluginDir(pluginPath);
    this.terminalPool = new TerminalPool({ shell: defaultShell, cwd: defaultCwd });

    // views
    this.registerView(VIEW_TYPE_SIDEBAR_HUD, (leaf) => new SidebarHUDView(leaf, this));
    this.registerView(VIEW_TYPE_MEMORY_INSPECTOR, (leaf) => new MemoryInspectorView(leaf));
    this.registerView(VIEW_TYPE_RUN_INSPECTOR, (leaf) => new RunInspectorView(leaf));
    this.registerView(VIEW_TYPE_WORKBENCH, (leaf) => new WorkbenchView(leaf, this));

    // ribbon icons
    this.addRibbonIcon("layout-dashboard", "Workbench",      () => { void this.activate(VIEW_TYPE_WORKBENCH); });
    this.addRibbonIcon("plus", "Quick Capture", () => { new CaptureModal(this.app).open(); });

    // commands
    this.addCommand({ id: "open-workbench",       name: "Open Workbench",        callback: () => { void this.activate(VIEW_TYPE_WORKBENCH); } });
    for (const t of ["spaces", "memory", "runs", "chat", "term"] as const) {
      this.addCommand({ id: `open-workbench-${t}`, name: `Open Workbench: ${t[0].toUpperCase()}${t.slice(1)}`,
        callback: () => { void this.openWorkbenchTab(t); } });
    }
    this.addCommand({ id: "open-sidebar-hud",     name: "Open Sidebar HUD",     callback: () => { void this.activate(VIEW_TYPE_SIDEBAR_HUD, "right"); } });
    this.addCommand({ id: "open-memory-inspector", name: "Open Memory Inspector", callback: () => { void this.activate(VIEW_TYPE_MEMORY_INSPECTOR); } });
    this.addCommand({ id: "open-run-inspector",   name: "Open Run Inspector",    callback: () => { void this.activate(VIEW_TYPE_RUN_INSPECTOR); } });
    this.addCommand({ id: "new-terminal", name: "New terminal session", callback: () => {
      void this.openWorkbenchTab("term").then(() => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
        const view = leaf?.view;
        if (view instanceof WorkbenchView) (view.getTab("term") as TermTab | null)?.newSession();
      });
    }});
    this.addCommand({
      id: "quick-capture",
      name: "Quick Capture (new memory)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
      callback: () => { new CaptureModal(this.app).open(); },
    });
    this.addCommand({ id: "open-omnisearch", name: "Omnisearch (⌘K)", hotkeys: [{ modifiers: ["Mod"], key: "k" }],
      callback: () => { void this.openOmni(); } });

    this.addSettingTab(new AgenticOSSettingTab(this.app, this));

    this.rebuildStatusBar();

    this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
      if (file.path === SNAPSHOT_PATH || file.path === RUNS_PATH) this.refreshStatusBar();
    }));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.autoOpenSidebarOnStart) await this.activate(VIEW_TYPE_SIDEBAR_HUD, "right");
      this.refreshStatusBar();
      // Sweep crashed runs BEFORE the watcher starts so it doesn't latch onto dead ndjson files.
      try {
        const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
        const vaultPath = adapter.getBasePath ? adapter.getBasePath() : process.cwd();
        const result = sweepOrphans(vaultPath);
        if (result.swept.length > 0 || result.errors > 0) {
          console.log(`[agentic-os] orphan sweep: ${result.swept.length} crashed, ${result.skipped} skipped, ${result.errors} errors`);
        }
      } catch (e) {
        console.warn("[agentic-os] orphan sweep failed:", e);
      }
      this.startRunsTail();
      this.rebindLiveSources();

      // Keep snapshot.json fresh so the HUD doesn't go stale during a long
      // Obsidian session. Refresh now if already stale, then on a fixed timer.
      void this.refreshSnapshotIfStale();
      this.registerInterval(
        window.setInterval(() => { void this.refreshSnapshot("timer"); }, SNAPSHOT_REFRESH_MS),
      );
    });

    console.log("[agentic-os] loaded");
  }

  async onunload(): Promise<void> {
    if (this.statusBarTimer !== null) window.clearInterval(this.statusBarTimer);
    if (this.runsWatcher) { try { this.runsWatcher.close(); } catch { /* ignore */ } this.runsWatcher = null; }
    if (this.liveRuns) { this.liveRuns.stop(); this.liveRuns = null; }
    this.hb?.stop();
    this.terminalPool?.disposeAll();
    console.log("[agentic-os] unloaded");
  }

  async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    // Field-pick from DEFAULT_SETTINGS's own keys rather than Object.assign-ing
    // raw wholesale: Object.assign({}, DEFAULT_SETTINGS, raw) would copy EVERY
    // own property of raw onto this.settings, including unknown/dead ones —
    // TS interfaces aren't enforced at runtime. Picking only known keys means
    // this.settings structurally cannot carry a stray key forward, which is
    // what actually makes saveData(this.settings) below drop them.
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      merged[key] = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : defaults[key];
    }
    this.settings = merged as unknown as AgenticOSSettings;

    // Toggles that mirror keys the scripts own start from the vault config when data.json has
    // never stored them (fresh install, or a data.json from before these settings existed):
    // `aos cost enable` shows the COST row and telemetry.enabled=false stops the orphan sweep
    // with no second switch here. After the merge because readVaultConfig() needs
    // this.settings.vaultRoot. Once the user saves settings the stored value wins on every load.
    // claudeConfigDir() is passed so an Obsidian launched without $CLAUDE_CONFIG_DIR still finds
    // the agenticos.json the settings tab names (Ruling A6).
    seedToggleDefaults(this.settings, raw, readVaultConfig(this.vaultRoot(), this.claudeConfigDir()));

    // One-time prune of dead data.json keys from the pre-P0 era (no interface
    // fields since P0 removed them, but the stored keys lingered on disk).
    const deadKeys = ["snapshotPath", "runsPath", "sessionPath", "snapshotHistoryDir", "refreshDebounceMs"];
    const pruned = deadKeys.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
    if (pruned.length > 0) {
      await this.saveSettings();
      console.info(`[agentic-os] pruned dead settings keys: ${pruned.join(", ")}`);
    }
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  // ── AgenticOS accessors: every read of brain/_index and every spawn goes through these ──

  /** Vault the plugin renders and spawns in: settings.vaultRoot, else this Obsidian vault. */
  vaultRoot(): string {
    if (this.settings.vaultRoot) return this.settings.vaultRoot;
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    return adapter.getBasePath ? adapter.getBasePath() : process.cwd();
  }

  /**
   * Claude Code config dir: settings → agenticos.json → $CLAUDE_CONFIG_DIR → ~/.claude.
   * The tail delegates to aosConfig.claudeConfigDir() so this method and the data readers can
   * never disagree, and this method is the single source every plugin-side agenticos.json read
   * passes as `configDir` (loadSettings, PulseTab, SystemDrawer, ChatTab, claudeBin) — Ruling A6.
   */
  claudeConfigDir(): string {
    if (this.settings.claudeConfigDir) return this.settings.claudeConfigDir;
    // No argument on purpose: this call is what *resolves* the config dir, so it uses the env chain.
    return readAgenticosJson()?.claudeConfigDir || defaultClaudeConfigDir();
  }

  /** Node binary for spawns; a login-shell probe result lands in settings and is persisted here. */
  nodeBin(): string {
    const before = this.settings.nodePath;
    const bin = resolveNodeBinary(this.settings);
    if (this.settings.nodePath !== before) void this.saveSettings();
    return bin;
  }

  // ── activate any view by type ────────────────────────────────────────

  async activate(viewType: string, where: "tab" | "right" | "split" = "tab"): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType);
    let leaf: WorkspaceLeaf | null = null;
    if (existing.length > 0) {
      leaf = existing[0];
      // An inspector leaf of this type is already open — a fresh pop-out (setPendingMemory/
      // setPendingRunId called just before this activate()) would otherwise be silently
      // dropped, since only the setViewState branches below re-trigger onOpen()'s
      // consumePending*() read. Re-target the existing leaf directly via its own setter
      // instead of tearing it down; every other view type is untouched (instanceof is false).
      const view = leaf.view;
      if (view instanceof MemoryInspectorView) {
        const pending = consumePendingMemory();
        if (pending) await view.setMemoryPath(pending);
      } else if (view instanceof RunInspectorView) {
        const pending = consumePendingRunId();
        if (pending) await view.setRun(pending);
      }
    } else if (where === "right") {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: viewType, active: true });
    } else if (where === "split") {
      leaf = workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: viewType, active: true });
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: viewType, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  // ── Heartbeat / SSE binding ──────────────────────────────────────────

  /** Reconstruct the local live watcher (e.g. after poll-interval setting change). */
  rebindLiveSources(): void {
    if (this.liveRuns) { this.liveRuns.stop(); this.liveRuns = null; }
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const vaultPath = adapter.getBasePath ? adapter.getBasePath() : process.cwd();
    this.liveRuns = new LiveRunsWatcher({
      vault: vaultPath,
      bus: this.bus,
      pollMs: this.settings.liveTailPollMs,
      source: "local",
    });
    this.liveRuns.start();
    this.hb.setSource(this.liveRuns);
  }

  // ── Status Bar ───────────────────────────────────────────────────────

  rebuildStatusBar(): void {
    if (this.statusBarEl) { this.statusBarEl.remove(); this.statusBarEl = null; }
    if (this.statusBarTimer !== null) { window.clearInterval(this.statusBarTimer); this.statusBarTimer = null; }
    if (!this.settings.statusBarEnabled) return;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("aos-statusbar");
    this.statusBarEl.setAttr("aria-label", "Agentic OS");
    this.statusBarEl.addEventListener("click", () => { void this.activate(VIEW_TYPE_WORKBENCH); });
    void this.refreshStatusBar();
    this.statusBarTimer = window.setInterval(() => { void this.refreshStatusBar(); }, 30000);
  }

  async refreshStatusBar(): Promise<void> {
    if (!this.statusBarEl) return;
    const snap = await loadSnapshot(this.app);
    const runs = await loadRuns(this.app, 1);
    this.statusBarEl.empty();
    const wrap = this.statusBarEl.createSpan({ cls: "aos-sbar-wrap" });
    const up = this.hb.getStatus().up;
    wrap.createSpan({ text: "⚡", cls: up ? "aos-text-cyan" : "aos-dim" });
    wrap.createSpan({ text: up ? " live" : " idle", cls: up ? "aos-text-cyan" : "aos-dim" });
    if (!snap) {
      wrap.createSpan({ text: " · no snapshot", cls: "aos-text-amber" });
      return;
    }
    wrap.createSpan({ text: ` · ${snap.capabilities.agents.count}a · ${snap.capabilities.commands.count}c · ${snap.config.memoryMd?.pointers ?? 0}m · ${snap.capabilities.skills.count}s` });
    if (runs[0]) {
      const ok = runs[0].status === "ok";
      wrap.createSpan({ text: " · " });
      wrap.createSpan({ text: `last ${runs[0].script} ${formatRelative(runs[0].started_at)}`, cls: ok ? "aos-text-cyan" : "aos-text-rose" });
    }
    const issues = snap.health?.issues ?? [];
    const errs = issues.filter(i => i.severity === "error").length;
    const warns = issues.filter(i => i.severity === "warn").length;
    if (errs > 0) wrap.createSpan({ text: ` · ${errs}err`, cls: "aos-text-rose" });
    else if (warns > 0) wrap.createSpan({ text: ` · ${warns}warn`, cls: "aos-text-amber" });
  }

  // ── Live runs tail (Node fs.watch on absolute path) ──────────────────

  private startRunsTail(): void {
    try {
      const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
      if (typeof adapter.getBasePath !== "function") return;
      const base = adapter.getBasePath();
      const abs = path.join(base, RUNS_PATH);
      if (!fs.existsSync(abs)) return;
      this.runsBytesSeen = fs.statSync(abs).size;
      this.runsWatcher = fs.watch(abs, { persistent: false }, () => {
        try {
          const size = fs.statSync(abs).size;
          if (size > this.runsBytesSeen) {
            this.runsBytesSeen = size;
            void this.refreshStatusBar();
            const file = this.app.vault.getAbstractFileByPath(RUNS_PATH);
            if (file) this.app.vault.trigger("modify", file);
          }
        } catch { /* ignore */ }
      });
    } catch (err) {
      console.warn("[agentic-os] runs tail unavailable:", err);
    }
  }

  // ── Snapshot auto-refresh ────────────────────────────────────────────

  /** Refresh only if snapshot.json is missing or older than the stale threshold. */
  private async refreshSnapshotIfStale(): Promise<void> {
    try {
      const base = this.vaultRoot();
      const abs = path.join(base, SNAPSHOT_PATH);
      const ageMs = fs.existsSync(abs) ? Date.now() - fs.statSync(abs).mtimeMs : Infinity;
      if (ageMs > SNAPSHOT_STALE_MS) this.refreshSnapshot("stale-on-open");
    } catch {
      this.refreshSnapshot("stale-on-open");
    }
  }

  /** Spawn scan-vault.js detached to regenerate snapshot.json. Quiet, non-blocking. */
  private refreshSnapshot(reason: string): void {
    if (this.snapshotRefreshing) return;
    try {
      const root = this.vaultRoot();
      const script = path.join(root, "brain/scripts/scan-vault.js");
      if (!fs.existsSync(script)) { console.warn(`[agentic-os] scan-vault.js missing at ${script}`); return; }
      this.snapshotRefreshing = true;
      const child = spawn(this.nodeBin(), [script, "--quiet"], {
        cwd: root,
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.on("error", (e) => { console.warn("[agentic-os] snapshot refresh failed:", e); this.snapshotRefreshing = false; });
      child.on("close", () => { this.snapshotRefreshing = false; });
      // Safety: clear the in-flight flag even if the process never reports back.
      window.setTimeout(() => { this.snapshotRefreshing = false; }, 60_000);
      console.log(`[agentic-os] snapshot refresh (${reason})`);
    } catch (e) {
      this.snapshotRefreshing = false;
      console.warn("[agentic-os] snapshot refresh error:", e);
    }
  }

  /** Spawn the regen CLI for one workspace; snapshot.json modify triggers the view to refresh. */
  regenWorkspaceInsight(name: string): void {
    try {
      const root = this.vaultRoot();
      const script = path.join(root, "brain/scripts/regen-workspace-insight.js");
      if (!fs.existsSync(script)) { new Notice("regen script missing"); return; }
      const child = spawn(this.nodeBin(), [script, name], { cwd: root, stdio: "ignore", detached: true });
      child.unref();
      child.on("error", (e) => { console.warn("[agentic-os] regen failed:", e); });
    } catch (e) {
      console.warn("[agentic-os] regen error:", e);
    }
  }

  /** Spawn a brain script detached (Fix Queue / Pulse actions). Best-effort;
   *  UI feedback comes from the pipelines ledger, not the exit code. */
  runBrainScript(relScript: string, args: string[] = [], onDone?: () => void): void {
    try {
      const base = this.vaultRoot();
      const script = path.join(base, relScript);
      if (!fs.existsSync(script)) { new Notice(`script missing: ${relScript}`); return; }
      const child = spawn(this.nodeBin(), [script, ...args], { cwd: base, stdio: "ignore", detached: true });
      child.unref();
      child.on("error", (e) => { console.warn("[agentic-os] runBrainScript failed:", e); new Notice(`spawn failed: ${relScript}`); });
      if (onDone) child.on("close", onDone);
      new Notice(`▶ ${relScript.split("/").pop()} ${args.join(" ")}`.trim());
    } catch (e) {
      console.warn("[agentic-os] runBrainScript error:", e);
    }
  }

  async openWorkbenchTab(tab: string): Promise<void> {
    await this.activate(VIEW_TYPE_WORKBENCH);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    const view = leaf?.view;
    if (view instanceof WorkbenchView) view.setTab(tab);
  }

  /** Live RunsTab instance, if the Workbench view is currently open — same
   *  getLeavesOfType + instanceof pattern as the "new-terminal" command above. */
  private currentRunsTab(): RunsTab | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    const view = leaf?.view;
    return view instanceof WorkbenchView ? (view.getTab("runs") as RunsTab | null) : null;
  }

  // ── ⌘K omnisearch (Task 7) ────────────────────────────────────────────

  /**
   * Gathers every async source BEFORE opening the modal (OmniModal.getItems()
   * is synchronous per the brief — no async happens inside the modal itself),
   * builds the flat item list via buildOmniItems(), then opens OmniModal with
   * a dispatch callback for the three kinds it can't resolve with `app` alone
   * (run/agent/action — each needs plugin state: openWorkbenchTab, RunsTab,
   * FixAction/deck execution).
   */
  async openOmni(): Promise<void> {
    const app = this.app;
    const snap = await loadSnapshot(app);
    // Same workspace-name source P2 uses everywhere else (PulseTab.refresh(),
    // SpacesTab, and the old Workspaces view all read snapshot.workspaces, never settings) —
    // loadAllMaps() itself tolerates a missing/null map per name.
    const wsNames = (snap?.workspaces ?? []).map((w) => w.name);

    const [maps, memories, runs, staff, inv] = await Promise.all([
      loadAllMaps(app, wsNames),
      listMemories(app),
      loadRuns(app),
      loadStaff(app),
      loadInventory(app),
    ]);

    // InventorySkill.path is the skill's directory ("skills/<dir>"), not its
    // SKILL.md file — SystemDrawer.openInventoryFile appends "/SKILL.md" before
    // opening it. Mirrored here so the omni item's payload is directly openable
    // via workspace.openLinkText.
    const skills = (inv?.skills ?? []).map((s) => ({
      name: s.name,
      path: s.path ? `${s.path}/SKILL.md` : `skills/${s.name}/SKILL.md`,
    }));

    // Fix-queue actions come from the live PulseTab instance when the Workbench
    // has constructed one; before that (no Workbench open yet) there is no queue
    // to search. Deck commands are a static export and always gathered.
    const wbView = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0]?.view;
    const pulse = wbView instanceof WorkbenchView ? (wbView.getTab("pulse") as PulseTab | null) : null;
    const fixActions: FixAction[] = pulse?.getFixActions() ?? [];
    const deckActions = COMMAND_REGISTRY.map((c) => ({ id: c.name, title: `${c.name} — ${c.desc}` }));

    const items = buildOmniItems({
      maps,
      memories,
      runs: runs.map((r) => ({ id: r.id, label: r.script })),
      agents: staff.map((a) => ({ name: a.name })),
      skills,
      actions: [...fixActions.map((a) => ({ id: a.id, title: a.title })), ...deckActions],
    });

    new OmniModal(app, items, (item) => {
      if (item.kind === "run") {
        void this.openWorkbenchTab("runs").then(() => { void this.currentRunsTab()?.showRun(item.payload); });
      } else if (item.kind === "agent") {
        void this.openWorkbenchTab("runs").then(() => { this.currentRunsTab()?.showAgents(); });
      } else if (item.kind === "action") {
        const fa = fixActions.find((a) => a.id === item.payload);
        if (fa) {
          pulse?.execute(fa);
          return;
        }
        const cmd = COMMAND_REGISTRY.find((c) => c.name === item.payload);
        if (cmd) void executeCommand(this.app, cmd);
      }
    }).open();
  }
}
