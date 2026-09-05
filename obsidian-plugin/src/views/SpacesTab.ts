import { Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { formatRelative } from "../data/runs";
import { loadSnapshot, Snapshot, SNAPSHOT_PATH, WorkspaceEntry, WorkspaceSource } from "../data/snapshot";
import { listDir, readPreview } from "../data/workspaceFiles";
import { loadWorkspaceMap, mapStats, filterFiles, WorkspaceMap, MapFile, MAPS_DIR } from "../data/workspaceMaps";

const STATUS_DOT: Record<string, string> = {
  active: "🟢", idle: "🟡", planned: "🔵", blocked: "🔴", shipped: "✅", dormant: "⚪",
};

export class SpacesTab {
  private host: HTMLElement | null = null;
  private snapshot: Snapshot | null = null;
  private selected: string | null = null;                    // workspace name
  private detailTab: "overview" | "files" | "map" = "overview";
  private map: WorkspaceMap | null = null;
  private mapQuery = "";
  private refreshDebounce: number | null = null;
  private listenersRegistered = false;
  // ported from the old Workspaces view — state for the FILES sub-tab (paintTree/paintPreview)
  private expandedDirs: Set<string> = new Set();   // keyed by absolute path
  private previewAbs: string | null = null;        // absolute path of previewed file
  private previewRel: string | null = null;        // vault-relative path of previewed file
  private treeGen = 0;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    // refresh when the snapshot or any map file changes on disk
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      this.view.registerEvent(
        this.plugin.app.vault.on("modify", (f: TAbstractFile) => {
          if (f.path === SNAPSHOT_PATH || f.path.startsWith(MAPS_DIR + "/")) this.schedule();
        })
      );
    }
    void this.refresh();
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    this.snapshot = await loadSnapshot(this.plugin.app);
    const workspaces = this.snapshot?.workspaces ?? [];
    if (!this.selected && workspaces.length) this.selected = workspaces[0].name;
    this.map = this.selected ? await loadWorkspaceMap(this.plugin.app, this.selected) : null;
    this.render();
  }

  private render(): void {
    if (!this.view.isTabActive("spaces")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    const workspaces = this.snapshot?.workspaces ?? [];
    const body = host.createDiv({ cls: "aos-ws-body" });
    this.renderMaster(body.createDiv({ cls: "aos-ws-list" }), workspaces);
    const detailHost = body.createDiv({ cls: "aos-ws-detail" });
    const w = workspaces.find((x) => x.name === this.selected) ?? workspaces[0];
    if (!w) { detailHost.createDiv({ cls: "aos-dim", text: "select a workspace" }); return; }
    this.renderDetail(detailHost, w);
  }

  // PORT of the old Workspaces view's renderList
  private renderMaster(parent: HTMLElement, workspaces: WorkspaceEntry[]): void {
    if (!workspaces.length) { parent.createDiv({ cls: "aos-dim", text: "no workspaces" }); return; }
    for (const w of workspaces) {
      const row = parent.createDiv({ cls: `aos-ws-row${this.selected === w.name ? " aos-ws-row-active" : ""}` });
      row.createSpan({ cls: "aos-ws-dot", text: STATUS_DOT[w.status ?? ""] ?? "•" });
      const meta = row.createDiv({ cls: "aos-ws-rowmeta" });
      meta.createDiv({ cls: "aos-ws-name", text: w.name });
      meta.createDiv({ cls: "aos-ws-sub aos-dim", text: w.summary ?? "—" });
      row.addEventListener("click", () => {
        this.selected = w.name;
        this.expandedDirs.clear();
        this.previewAbs = null;
        this.previewRel = null;
        this.mapQuery = "";
        // unlike the old Workspaces view, the MAP sub-tab holds an async-loaded field
        // (this.map) keyed by selection — a plain render() would leave it
        // showing the previous workspace's map, so reload via refresh().
        void this.refresh();
      });
    }
  }

  // tab strip: overview | files | map(+pending badge)
  private renderDetail(parent: HTMLElement, w: WorkspaceEntry): void {
    const head = parent.createDiv({ cls: "aos-ws-detail-head" });
    head.createSpan({ cls: "aos-ws-detail-title", text: w.name });
    head.createSpan({ cls: "aos-pill aos-pill-dim", text: w.status ?? "unknown" });
    const openBtn = head.createEl("button", { cls: "aos-ws-action", text: "open folder" });
    openBtn.addEventListener("click", () => this.openFolder(w.path));
    const termBtn = head.createEl("button", { cls: "aos-ws-action", text: "terminal here" });
    termBtn.addEventListener("click", () => { void this.openTerminal(w.path); });

    const pending = this.map ? mapStats(this.map).pending : 0;
    const tabs = parent.createDiv({ cls: "aos-ws-tabs" });
    for (const t of ["overview", "files", "map"] as const) {
      const label = t === "map" && pending > 0 ? `map (${pending})` : t;
      const tb = tabs.createEl("button", {
        cls: `aos-ws-tab${this.detailTab === t ? " aos-ws-tab-active" : ""}`, text: label,
      });
      tb.addEventListener("click", () => { this.detailTab = t; this.render(); });
    }

    if (this.detailTab === "overview") this.renderOverview(parent, w);
    else if (this.detailTab === "files") this.renderFiles(parent, w);
    else this.renderMap(parent, w);
  }

  // PORT of the old Workspaces view's renderOverview
  private renderOverview(parent: HTMLElement, w: WorkspaceEntry): void {
    this.section(parent, "SUMMARY", w.summarySource).createDiv({ cls: "aos-ws-text", text: w.summary ?? "—" });

    const obj = this.section(parent, "OBJECTIVES", w.objectives[0]?.source);
    if (w.objectives.length) {
      const ul = obj.createEl("ul", { cls: "aos-ws-ul" });
      for (const o of w.objectives) ul.createEl("li", { text: o.text });
    } else obj.createDiv({ cls: "aos-dim", text: "none" });

    // REQUIRED DEVIATION: render subprojects whenever w.subprojects.length > 0
    // (manifest-provided subprojects set isCollection=false but still populate subprojects)
    if (w.subprojects.length) {
      const spSource: WorkspaceSource = w.isCollection ? "derived" : "manifest";
      const sp = this.section(parent, `SUBPROJECTS (${w.subprojects.length})`, spSource);
      for (const s of w.subprojects) {
        const r = sp.createDiv({ cls: "aos-ws-link aos-inv-row-clickable" });
        r.createSpan({ text: s.name });
        if (s.summary) r.createSpan({ cls: "aos-dim", text: ` — ${s.summary}` });
        r.addEventListener("click", () => this.openPath(s.path));
      }
    } else {
      const dc = this.section(parent, "KEY DOCUMENTS", "derived");
      if (w.docs.length) {
        for (const d of w.docs) {
          const r = dc.createDiv({ cls: "aos-ws-link aos-inv-row-clickable", text: d.name });
          r.addEventListener("click", () => this.openPath(d.path));
        }
      } else dc.createDiv({ cls: "aos-dim", text: "none" });
    }

    this.section(parent, "WHAT'S NEXT", w.next.source)
      .createDiv({ cls: "aos-ws-text", text: w.next.text ?? "—" });

    const ins = this.section(parent, "INSIGHTS", "ai");
    if (w.insight.status === "ok" && w.insight.text) {
      ins.createDiv({ cls: "aos-ws-text", text: w.insight.text });
      const foot = ins.createDiv({ cls: "aos-ws-insight-foot aos-dim" });
      foot.createSpan({ text: `${w.insight.model ?? "local"} · ${w.insight.generatedAt ? formatRelative(w.insight.generatedAt) : "—"}` });
    } else {
      ins.createDiv({ cls: "aos-dim", text: "insights unavailable" });
    }
    const regen = ins.createEl("button", { cls: "aos-ws-action", text: "↻ regen" });
    regen.addEventListener("click", () => { void this.regen(w.name); });
  }

  // PORT of the old Workspaces view's renderFiles (paintTree + paintPreview)
  private renderFiles(parent: HTMLElement, w: WorkspaceEntry): void {
    const grid = parent.createDiv({ cls: "aos-ws-files" });
    const treeEl = grid.createDiv({ cls: "aos-ws-tree" });
    const previewEl = grid.createDiv({ cls: "aos-ws-preview" });
    const gen = ++this.treeGen;
    // Drive the tree from the workspace's real absolute path (recorded by the
    // collector at scan time). Falls back to vaultBase()+path for older snapshots.
    const absRoot = w.absPath ?? this.absOf(w.path);
    void this.paintTree(treeEl, absRoot, w.path, 0, gen);
    void this.paintPreview(previewEl, gen);
  }

  // Tree nodes carry both an absolute fs path (`absDir`, used for listing/reading)
  // and a vault-relative path (`relDir`, used for copy-rel and identity). The two
  // diverge when Obsidian's vault root differs from where the workspaces live.
  private async paintTree(parent: HTMLElement, absDir: string, relDir: string, depth: number, gen: number): Promise<void> {
    let entries;
    try {
      entries = await listDir(absDir);
    } catch {
      if (gen !== this.treeGen) return;
      parent.createDiv({ cls: "aos-dim", text: "unreadable" });
      return;
    }
    if (gen !== this.treeGen) return; // bail on same-tab re-render; tab/workspace switches are made safe by root.empty() detaching the old container
    if (!entries.length && depth === 0) {
      parent.createDiv({ cls: "aos-dim", text: "empty" });
      return;
    }
    for (const e of entries) {
      const abs = `${absDir}/${e.name}`;
      const rel = `${relDir}/${e.name}`;
      const row = parent.createDiv({ cls: "aos-ws-tnode" });
      row.style.paddingLeft = `${depth * 14}px`;
      if (e.isDir) {
        const open = this.expandedDirs.has(abs);
        row.addClass("aos-ws-tnode-dir");
        row.createSpan({ cls: "aos-ws-twig", text: open ? "▾" : "▸" });
        row.createSpan({ text: e.name });
        row.addEventListener("click", () => {
          if (this.expandedDirs.has(abs)) this.expandedDirs.delete(abs);
          else this.expandedDirs.add(abs);
          this.render();
        });
        if (open) {
          const kids = parent.createDiv({ cls: "aos-ws-subtree" });
          await this.paintTree(kids, abs, rel, depth + 1, gen);
        }
      } else {
        row.addClass("aos-ws-tnode-file");
        if (this.previewAbs === abs) row.addClass("aos-ws-tnode-active");
        row.createSpan({ cls: "aos-ws-twig", text: "·" });
        row.createSpan({ text: e.name });
        row.addEventListener("click", () => { this.previewAbs = abs; this.previewRel = rel; this.render(); });
      }
    }
  }

  private async paintPreview(parent: HTMLElement, gen: number): Promise<void> {
    const abs = this.previewAbs;
    if (!abs) { parent.createDiv({ cls: "aos-dim", text: "select a file" }); return; }

    const head = parent.createDiv({ cls: "aos-ws-preview-head" });
    head.createSpan({ cls: "aos-ws-preview-name", text: abs.split("/").pop() ?? abs });
    const rel = this.previewRel ?? abs;
    const cpAbs = head.createEl("button", { cls: "aos-ws-action", text: "copy abs" });
    cpAbs.addEventListener("click", () => this.copy(abs));
    const cpRel = head.createEl("button", { cls: "aos-ws-action", text: "copy rel" });
    cpRel.addEventListener("click", () => this.copy(rel));
    const openB = head.createEl("button", { cls: "aos-ws-action", text: "open" });
    openB.addEventListener("click", () => this.reveal(abs));

    let res;
    try {
      res = await readPreview(abs);
    } catch {
      if (gen !== this.treeGen) return;
      parent.createDiv({ cls: "aos-dim", text: "cannot read file" });
      return;
    }
    if (gen !== this.treeGen) return; // a newer render() superseded this paint
    if (res.kind === "empty") { parent.createDiv({ cls: "aos-dim", text: "empty file" }); return; }
    if (res.kind === "binary") {
      parent.createDiv({ cls: "aos-dim", text: `binary file — ${this.kb(res.size)}` });
      return;
    }
    if (res.truncated) {
      parent.createDiv({ cls: "aos-ws-trunc aos-dim", text: `truncated — showing first part of ${this.kb(res.size)}` });
    }
    parent.createEl("pre", { cls: "aos-ws-pre", text: res.text ?? "" });
  }

  private renderMap(parent: HTMLElement, w: WorkspaceEntry): void {
    const map = this.map;
    if (!map) {
      const empty = parent.createDiv({ cls: "aos-sp-empty aos-dim" });
      empty.setText("no map yet — run a scan, or map this workspace now");
      const btn = empty.createEl("a", { text: "▶ map now", cls: "aos-link", href: "#" });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.plugin.runBrainScript("brain/scripts/map-workspace.js", [w.name], () => this.schedule());
      });
      return;
    }
    const stats = mapStats(map);
    const bar = parent.createDiv({ cls: "aos-sp-mapbar" });
    bar.createSpan({ text: `${stats.mapped}/${stats.total} mapped`, cls: "aos-dim" });
    if (stats.pending > 0) {
      const fix = bar.createEl("a", { text: `▶ ${stats.pending} unmapped — map now`, cls: "aos-link aos-text-amber", href: "#" });
      fix.addEventListener("click", (e) => {
        e.preventDefault();
        this.plugin.runBrainScript("brain/scripts/map-workspace.js", [w.name], () => this.schedule());
      });
    }
    const search = bar.createEl("input", { cls: "aos-sp-filter", attr: { type: "text", placeholder: "filter path or description…", value: this.mapQuery } });
    search.addEventListener("input", () => { this.mapQuery = search.value; this.renderMapRows(rowsHost, w); });

    const rowsHost = parent.createDiv({ cls: "aos-sp-maprows" });
    this.renderMapRows(rowsHost, w);
  }

  private renderMapRows(host: HTMLElement, w: WorkspaceEntry): void {
    host.empty();
    if (!this.map) return;
    // Folder rollup lines derived from children (spec §5.2): group by top-level segment.
    const files = filterFiles(this.map, this.mapQuery);
    const groups = new Map<string, MapFile[]>();
    for (const f of files) {
      const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : ".";
      (groups.get(top) ?? groups.set(top, []).get(top)!).push(f);
    }
    for (const [folder, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (folder !== ".") {
        const pend = members.filter((m) => m.desc === null || m.status !== "fresh").length;
        const roll = host.createDiv({ cls: "aos-sp-maproll" });
        roll.createSpan({ text: `▸ ${folder}/`, cls: "aos-sp-mappath" });
        roll.createSpan({ text: `${members.length} file(s)${pend ? ` · ${pend} pending` : ""}`, cls: "aos-dim" });
      }
      this.renderFileRows(host, w, members);
    }
  }

  private renderFileRows(host: HTMLElement, w: WorkspaceEntry, files: MapFile[]): void {
    for (const f of files) {
      const row = host.createDiv({ cls: `aos-sp-maprow is-${f.status}` });
      row.createSpan({ text: f.path, cls: "aos-sp-mappath" });
      // Always create the badge span — .aos-sp-maprow is a fixed 4-column grid, and
      // skipping it for "fresh" rows shifts desc/↻ one column left. Empty text on
      // fresh rows keeps the column without a visible pill (see aos-sp-badge:empty).
      row.createSpan({ text: f.status === "fresh" ? "" : (f.status === "new" ? "NEW" : "Δ"), cls: "aos-sp-badge" });
      row.createSpan({ text: f.desc ?? "— not yet described —", cls: f.desc ? "aos-sp-mapdesc" : "aos-sp-mapdesc aos-dim" });
      const re = row.createEl("a", { text: "↻", cls: "aos-link aos-sp-redesc", href: "#", attr: { "aria-label": `re-describe ${f.path}` } });
      re.addEventListener("click", (e) => {
        e.preventDefault();
        this.plugin.runBrainScript("brain/scripts/map-workspace.js", [w.name, "--file", f.path], () => this.schedule());
      });
    }
  }

  private section(parent: HTMLElement, title: string, source?: WorkspaceSource): HTMLElement {
    const panel = parent.createDiv({ cls: "aos-ws-section" });
    const h = panel.createDiv({ cls: "aos-ws-section-head" });
    h.createSpan({ cls: "aos-panel-title", text: title });
    if (source) h.createSpan({ cls: `aos-ws-badge aos-ws-badge-${source}`, text: source });
    return panel.createDiv({ cls: "aos-ws-section-body" });
  }

  private copy(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => new Notice("copied"),
      () => new Notice("copy failed"),
    );
  }

  private kb(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  // Open a previewed file by its absolute path. These files may live outside the
  // Obsidian vault root, so we open via the OS rather than the vault API.
  private reveal(abs: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = require("electron");
      void shell.openPath(abs);
    } catch (e) {
      new Notice(`Cannot open: ${abs}`);
    }
  }

  // ── path helpers ──────────────────────────────────────────────
  private absOf(rel: string): string { return `${this.vaultBase()}/${rel}`; }

  // ── actions ───────────────────────────────────────────────────
  private vaultBase(): string {
    const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
    return adapter.getBasePath ? adapter.getBasePath() : "";
  }

  private async openPath(rel: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(rel);
    if (f instanceof TFile) { await this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    this.openFolder(rel); // not a vault file → reveal in Finder
  }

  private openFolder(rel: string): void {
    try {
      const abs = `${this.vaultBase()}/${rel}`;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = require("electron");
      void shell.openPath(abs);
    } catch (e) {
      new Notice(`Cannot open: ${rel}`);
    }
  }

  private async openTerminal(rel: string): Promise<void> {
    try {
      const abs = `${this.vaultBase()}/${rel}`;
      this.plugin.terminalPool.create({ cwd: abs });
      await this.plugin.openWorkbenchTab("term");
    } catch (e) {
      new Notice(`Terminal unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async regen(name: string): Promise<void> {
    new Notice(`Regenerating insight for ${name}…`);
    this.plugin.regenWorkspaceInsight(name);
  }

  unmount(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.host?.empty();
    this.host = null;
  }
}
