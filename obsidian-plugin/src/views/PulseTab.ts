import { TAbstractFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { loadSnapshot, Snapshot, SNAPSHOT_PATH } from "../data/snapshot";
import { loadPipelines, pipelineStatuses, PipelineStatus, PIPELINES_PATH } from "../data/pipelines";
import { buildFixQueue, FixAction } from "../data/fixQueue";
import { loadTrail, isPendingReview, keepMemory, editMemory, revertMemory, memoryFilePath, TrailEntry, TRAIL_PATH } from "../data/promoteTrail";
import { loadAllMaps, mapStats } from "../data/workspaceMaps";
import { buildBriefing, composeBriefing } from "../data/briefing";
import { computeDelta, SnapshotDelta } from "../data/delta";
import { buildMonthlyBudget, formatUSD, BudgetConfig } from "../data/cost";
import { loadRunsForMonth, AgentRun } from "../data/runs";
import { AnchorModal } from "../ui/AnchorModal";
import { personaName, readVaultConfig } from "../data/aosConfig";
import { TerminalPanel } from "../ui/TerminalPanel";
import { COMMAND_REGISTRY, executeCommand } from "../data/commandRegistry";
import { renderSystemDrawer } from "./SystemDrawer";

/** True when <claude-config-dir>/projects/<any slug>/<sid>.jsonl exists — mirrors auto-cost.js findTranscript(). */
function transcriptExists(sid: string, configDir: string): boolean {
  const root = path.join(configDir, "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return false; }
  return dirs.some((d) => fs.existsSync(path.join(root, d, `${sid}.jsonl`)));
}

export class PulseTab {
  private host: HTMLElement | null = null;
  private bodyHost: HTMLElement | null = null;
  private termHost: HTMLElement | null = null;
  private termPanel: TerminalPanel | null = null;
  private termCollapsed = false;
  private refreshDebounce: number | null = null;
  private snapshot: Snapshot | null = null;
  private statuses: PipelineStatus[] = [];
  private delta: SnapshotDelta | null = null;
  private queue: FixAction[] = [];
  private trailRows: { entry: TrailEntry; pendingReview: boolean }[] = [];
  private costLine = "";
  private costWarn = false;
  private costActive = false;
  private listenersRegistered = false;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    // refresh when the ledger or snapshot change on disk — register once;
    // setTab() re-attaches DOM by calling mount() again on later tab switches.
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.view.registerEvent(
        this.plugin.app.vault.on("modify", (f: TAbstractFile) => {
          if (f.path === PIPELINES_PATH || f.path === SNAPSHOT_PATH || f.path === TRAIL_PATH) this.schedule();
        })
      );
      this.view.registerEvent(
        this.plugin.app.vault.on("create", (f: TAbstractFile) => {
          if (f.path === PIPELINES_PATH || f.path === SNAPSHOT_PATH || f.path === TRAIL_PATH) this.schedule();
        })
      );
    }

    // Persistent bottom slot for the embedded terminal — created once per mount
    // cycle, kept outside render()'s host.empty() wipe so refresh cycles never
    // tear down the live xterm session (see renderTerminalSlot()). setTab() wipes
    // contentHost on every tab switch without calling our unmount(), so a panel
    // surviving from a prior visit is left pointing at now-detached DOM — drop it
    // here so renderTerminalSlot()'s `if (!this.termPanel)` guard rebuilds fresh
    // into the new termHost instead of silently reusing an orphaned panel.
    if (this.termPanel) { this.termPanel.unmount(); this.termPanel = null; }
    this.bodyHost = host.createDiv();
    this.termHost = host.createDiv({ cls: "aos-pulse-term" });

    void this.refresh();
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 200);
  }

  /** cost.ts exports no loader for the anchor file — the old Mission Control view read it
   *  itself (private loadBudgetConfig()). Mirrored here for the same reason. */
  private async loadBudgetConfig(): Promise<Partial<BudgetConfig> | undefined> {
    try {
      const raw = await this.plugin.app.vault.adapter.read("brain/_index/cost-budget.json");
      return JSON.parse(raw) as Partial<BudgetConfig>;
    } catch {
      return undefined;
    }
  }

  /**
   * Count runs the "Run auto-cost backfill" button can actually repair. Mirrors
   * auto-cost.js's backfill() gate exactly (same session-id fallback, same
   * transcript path, same existence check, same per-session dedup) — a run
   * lacking cost_usd whose transcript no longer exists on disk is NOT
   * backfillable, and counting it would make this Fix Queue card unclearable.
   */
  private countBackfillable(runs: AgentRun[]): number {
    try {
      const configDir = this.plugin.claudeConfigDir();
      const seen = new Set<string>();
      let count = 0;
      for (const r of runs) {
        if (typeof r.cost_usd === "number") continue; // already costed — a genuine $0.00 counts
        const sid = (r as AgentRun & { session_id?: string }).session_id || (r.id || "").replace(/^sess-/, "");
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        if (transcriptExists(sid, configDir)) count++;
      }
      return count;
    } catch (e) {
      console.warn("[agentic-os] countBackfillable failed, falling back to raw count:", e);
      return runs.filter((r) => typeof r.cost_usd !== "number").length;
    }
  }

  async refresh(): Promise<void> {
    const app = this.plugin.app;
    const now = Date.now();
    this.snapshot = await loadSnapshot(app);
    const led = await loadPipelines(app);
    this.statuses = pipelineStatuses(led, now);
    this.delta = this.snapshot ? await computeDelta(app, this.snapshot) : null;

    const trail = await loadTrail(app, 8);
    this.trailRows = await Promise.all(
      trail.map(async (entry) => ({
        entry,
        pendingReview: entry.action === "written" && (await isPendingReview(app, entry)),
      }))
    );

    const monthRuns = await loadRunsForMonth(app);
    const budgetConfig = await this.loadBudgetConfig();
    const monthlyBudget = readVaultConfig(this.plugin.vaultRoot(), this.plugin.claudeConfigDir()).cost.monthlyBudget;
    this.costActive = this.plugin.settings.costEnabled && typeof monthlyBudget === "number";
    const budget = buildMonthlyBudget(monthRuns, budgetConfig, new Date(), monthlyBudget);
    const now2 = new Date();
    const currentMonth = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}`;
    this.costLine = monthRuns.length === 0 && !budget.anchored
      ? "no cost data"
      : `${formatUSD(budget.monthToDate)} this month · ${(budget.pctOfBudget * 100).toFixed(1)}% of ${formatUSD(budget.budget)}`;
    this.costWarn = budget.stale || budget.calibration <= 0;
    const uncosted = this.countBackfillable(monthRuns);

    const issues = this.snapshot?.health?.issues ?? [];
    const healthErrors = issues.filter((i) => i.severity === "error").length;
    const staleArtifacts = issues.filter((i) => i.area === "artifacts").length;

    const wsNames = (this.snapshot?.workspaces ?? []).map((w) => w.name);
    const maps = await loadAllMaps(app, wsNames);
    const mapPending = wsNames
      .map((n) => ({ workspace: n, pending: maps[n] ? mapStats(maps[n]!).pending : 0 }))
      .filter((m) => m.pending > 0);

    this.queue = buildFixQueue({
      statuses: this.statuses,
      costMonth: budgetConfig?.month ?? null,
      currentMonth,
      calibration: budget.calibration,
      uncostedRuns: uncosted,
      healthErrors,
      staleArtifacts,
      mapPending,
      costEnabled: this.costActive,
    });
    this.render();
  }

  private render(): void {
    if (!this.view.isTabActive("pulse")) return;
    const host = this.bodyHost;
    if (!host) return;
    host.empty();

    // ── pulse strip ──
    const strip = host.createDiv({ cls: "aos-pulse-strip" });
    for (const s of this.statuses) {
      const chip = strip.createSpan({ cls: `aos-pulse-chip is-${s.health}`, attr: { "aria-label": s.detail, title: s.detail } });
      chip.createSpan({ cls: "aos-pulse-dot" });
      chip.createSpan({ text: s.label });
    }

    // ── command deck — PORT of the old Mission Control view's renderCommandDeck; brief places it below
    // the strip / above BRIEFING. Note for the record: in Mission Control's own render(), the
    // deck actually sits AFTER the BRIEFING+Δ banners (it's panelOrder[0], the first grid tile,
    // and the grid is built after both banners) — "above BRIEFING" doesn't literally match MC's
    // own visual order, but it's what the brief specifies explicitly, so that's what's here.
    this.renderCommandDeck(host);

    // ── BRIEFING ──
    const ageMs = this.snapshot?.scannedAt ? Date.now() - new Date(this.snapshot.scannedAt).getTime() : Infinity;
    const insights = buildBriefing(this.snapshot, { ageMs });
    const brief = composeBriefing(insights);
    if (brief.text) {
      // composeBriefing carries a numeric priority (0 critical .. 5 all-clear), not a
      // string level. Bucket it the same way the old Mission Control view's renderBriefing() does, so
      // this reuses the already-styled .aos-briefing-critical/alert/info modifiers.
      const level = brief.priority <= 1 ? "critical" : brief.priority === 2 ? "alert" : "info";
      const w = host.createDiv({ cls: `aos-pulse-briefing aos-briefing-${level}` });
      // spec §10: the Briefing section carries the persona's chosen name (persona/IDENTITY.md H1).
      w.createSpan({ text: (personaName(this.plugin.vaultRoot()) ?? "BRIEFING").toUpperCase(), cls: "aos-briefing-label" });
      w.createSpan({ text: brief.text, cls: "aos-briefing-text" });
    }

    // ── Δ since last snapshot ──
    if (this.delta && this.delta.hasPrevious && this.delta.items.length > 0) {
      const d = host.createDiv({ cls: "aos-pulse-delta" });
      d.createSpan({ text: `Δ since ${this.delta.previousDate}: `, cls: "aos-dim" });
      this.delta.items.forEach((it, idx) => {
        if (idx > 0) d.createSpan({ text: " · ", cls: "aos-dim" });
        const cls = it.severity === "good" ? "aos-text-cyan" : it.severity === "bad" ? "aos-text-rose" : "aos-text-amber";
        const sign = it.diff > 0 ? "+" : "";
        d.createSpan({ cls, text: `${sign}${it.diff} ${it.label}`, attr: { title: `${it.before} → ${it.after}` } });
      });
    }

    // ── cost + health rows ──
    const rows = host.createDiv({ cls: "aos-pulse-rows" });
    if (this.costActive) {
      const cost = rows.createDiv({ cls: "aos-pulse-row" });
      cost.createSpan({ text: "COST", cls: "aos-pulse-rowlabel" });
      cost.createSpan({ text: this.costLine, cls: this.costWarn ? "aos-text-amber" : undefined });
    }
    const issues = this.snapshot?.health?.issues ?? [];
    const errs = issues.filter((i) => i.severity === "error").length;
    const warns = issues.filter((i) => i.severity === "warn").length;
    const health = rows.createDiv({ cls: "aos-pulse-row" });
    health.createSpan({ text: "HEALTH", cls: "aos-pulse-rowlabel" });
    health.createSpan({
      text: errs || warns ? `${errs} err · ${warns} warn` : "all clear",
      cls: errs ? "aos-text-rose" : warns ? "aos-text-amber" : "aos-text-green",
    });

    const sys = rows.createDiv({ cls: "aos-pulse-row" });
    const sysLink = sys.createEl("a", { cls: "aos-pulse-rowlabel aos-link", text: "SYSTEM ▸", href: "#" });
    sysLink.addEventListener("click", (e) => {
      e.preventDefault();
      this.view.openDrawer("SYSTEM", (h) => { void renderSystemDrawer(this.plugin, h); });
    });

    // ── fix queue ──
    const fq = host.createDiv({ cls: "aos-pulse-fixq" });
    fq.createDiv({ text: `⌜ FIX QUEUE (${this.queue.length}) ⌝`, cls: "aos-pulse-fixq-title" });
    if (this.queue.length === 0) {
      fq.createDiv({ text: "nothing to fix — all pipelines reporting clean", cls: "aos-dim" });
    }
    for (const a of this.queue) {
      const card = fq.createDiv({ cls: `aos-pulse-fix is-${a.severity}` });
      card.createDiv({ text: a.title, cls: "aos-pulse-fix-title" });
      card.createDiv({ text: a.detail, cls: "aos-pulse-fix-detail" });
      const btn = card.createEl("a", { text: this.actionLabel(a), cls: "aos-link", href: "#" });
      btn.addEventListener("click", (e) => { e.preventDefault(); this.execute(a); });
    }

    // ── recently auto-promoted ──
    const trail = host.createDiv({ cls: "aos-trail" });
    trail.createDiv({ text: "⌜ RECENTLY AUTO-PROMOTED ⌝", cls: "aos-trail-title" });
    if (this.trailRows.length === 0) {
      trail.createDiv({ text: "nothing auto-promoted yet", cls: "aos-dim" });
    }
    for (const { entry, pendingReview } of this.trailRows) {
      const row = trail.createDiv({ cls: "aos-trail-row" });
      row.createSpan({ text: entry.action.toUpperCase(), cls: `aos-trail-chip is-${entry.action}` });
      row.createSpan({ text: entry.title, cls: "aos-trail-name" });
      row.createSpan({ text: entry.type, cls: "aos-trail-type" });
      if (entry.action === "written" && pendingReview) {
        const actions = row.createSpan({ cls: "aos-trail-actions" });
        const keep = actions.createEl("a", { text: "keep", cls: "aos-link", href: "#" });
        keep.addEventListener("click", async (e) => {
          e.preventDefault();
          await keepMemory(this.plugin.app, entry);
          this.schedule();
        });
        const edit = actions.createEl("a", { text: "edit", cls: "aos-link", href: "#" });
        edit.addEventListener("click", async (e) => {
          e.preventDefault();
          const edited = await editMemory(this.plugin.app, entry);
          if (edited) {
            await this.plugin.app.workspace.openLinkText(memoryFilePath(entry), "", true);
          } else {
            this.schedule(); // file already gone (stale row) — refresh so it drops away
          }
        });
        const revert = actions.createEl("a", { text: "revert", cls: "aos-link", href: "#" });
        revert.addEventListener("click", async (e) => {
          e.preventDefault();
          await revertMemory(this.plugin.app, entry);
          this.schedule();
        });
      }
    }

    // ── embedded terminal — lives in the persistent termHost slot created in
    // mount(), outside this method's host.empty() wipe (see mount()). ──
    this.renderTerminalSlot();
  }

  // PORT of the old Mission Control view's renderCommandDeck (~655-668; that view was retired in Task 9).
  // Adaptations: MC returns a detached HTMLElement its caller appends; render()'s own style
  // here builds directly into a passed-in host (matching renderTerminalSlot()'s convention
  // below), so this takes `parent` and appends in place instead of returning a node. MC's
  // `this.app` (Obsidian's ItemView.app) becomes `this.plugin.app` — PulseTab isn't an
  // ItemView. Same aos-deck-* classes, same COMMAND_REGISTRY iteration, same executeCommand()
  // call per click — no behavior change.
  private renderCommandDeck(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "aos-deck aos-pulse-deck" });
    wrap.createSpan({ cls: "aos-deck-label", text: "[ COMMAND DECK ]" });
    const list = wrap.createDiv({ cls: "aos-deck-list" });
    for (const cmd of COMMAND_REGISTRY) {
      const btn = list.createEl("button", { cls: "aos-deck-btn" });
      btn.textContent = cmd.name;
      btn.setAttr("title", `${cmd.kind} · ${cmd.desc}`);
      btn.addClass(`aos-deck-btn-${cmd.kind}`);
      btn.addEventListener("click", () => { void executeCommand(this.plugin.app, cmd); });
    }
  }

  // Ported from the old Mission Control view's buildTerminalSlot() (~670-695; that view
  // was retired in Task 9) — same gating on settings.terminalEmbedded, same collapsed-link
  // and TerminalPanel-options markup. Restructured per the brief: Mission Control tore
  // down and rebuilt the panel on every render() call; here it's constructed once
  // (guarded by `if (!this.termPanel)`) and left alone across the refresh()/render()
  // cycles triggered by unrelated Pulse data changing, so the live xterm session is
  // never disrupted by a background snapshot/pipeline refresh. Only an explicit
  // collapse/expand or the terminalEmbedded setting toggling off tears it down —
  // the same two triggers Mission Control tore down on.
  private renderTerminalSlot(): void {
    if (!this.termHost) return;

    if (!this.plugin.settings.terminalEmbedded) {
      if (this.termPanel) { this.termPanel.unmount(); this.termPanel = null; }
      this.termHost.empty();
      return;
    }

    if (this.termCollapsed) {
      if (this.termPanel) { this.termPanel.unmount(); this.termPanel = null; }
      this.termHost.empty();
      const collapsed = this.termHost.createDiv({ cls: "aos-term-collapsed" });
      const open = collapsed.createEl("a", { cls: "aos-link", text: "▸ open terminal", href: "#" });
      open.addEventListener("click", (e) => {
        e.preventDefault();
        this.termCollapsed = false;
        this.renderTerminalSlot();
      });
      return;
    }

    if (!this.termPanel) {
      this.termHost.empty();
      this.termPanel = new TerminalPanel(this.plugin, {
        resizable: true,
        initialHeight: this.plugin.settings.terminalEmbedHeight,
        onHeightChange: async (h) => {
          this.plugin.settings.terminalEmbedHeight = h;
          await this.plugin.saveSettings();
        },
        onClose: () => {
          this.termCollapsed = true;
          this.renderTerminalSlot();
        },
        showMaximize: true,
        onMaximize: async () => { await this.plugin.openWorkbenchTab("term"); },
      });
      this.termPanel.mount(this.termHost);
    }
  }

  private actionLabel(a: FixAction): string {
    if (a.kind === "spawn") return `▶ run ${a.script?.split("/").pop()} ${a.args?.join(" ") ?? ""}`.trim();
    if (a.kind === "anchor-modal") return "▶ re-anchor…";
    return "▸ open";
  }

  // Live fix-queue snapshot for ⌘K (openOmni) — copy, so callers can't mutate the queue.
  getFixActions(): FixAction[] {
    return [...this.queue];
  }

  // Public: also dispatched from ⌘K action items (openOmni), not just the Fix Queue buttons.
  execute(a: FixAction): void {
    if (a.kind === "spawn" && a.script) {
      this.plugin.runBrainScript(a.script, a.args ?? [], () => this.schedule());
    } else if (a.kind === "anchor-modal" && this.costActive) {
      new AnchorModal(this.plugin.app, (usd) => {
        this.plugin.runBrainScript("brain/scripts/cost-budget.js", ["--anchor", String(usd)], () => this.schedule());
      }).open();
    } else if (a.kind === "open-file" && a.path) {
      void this.plugin.app.workspace.openLinkText(a.path, "", true);
    }
  }

  unmount(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.termPanel?.unmount();
    this.termPanel = null;
    this.host?.empty();
    this.host = null;
    this.bodyHost = null;
    this.termHost = null;
  }
}
