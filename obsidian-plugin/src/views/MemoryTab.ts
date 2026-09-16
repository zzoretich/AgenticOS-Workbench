import { TFile, Notice, Component, MarkdownRenderer } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { buildGraph, Graph, GraphNode, NodeKind } from "../data/graph";
import { tick, settle } from "../data/forceSim";
import { listMemories, parseMemoryMeta, filterMemories, MemoryMeta, MEMORY_ROOT } from "../data/memories";
import { setPendingMemory, VIEW_TYPE_MEMORY_INSPECTOR } from "./MemoryInspectorView";
import { TOKENS } from "../ui/tokens";

// same palette the old Cortex view used for its filter chips + node fills
const KIND_COLOR: Record<NodeKind, string> = {
  memory:  TOKENS.cyan,
  pattern: TOKENS.amber,
  session: TOKENS.green,
  agent:   TOKENS.rose,
};
const SVG_NS = "http://www.w3.org/2000/svg";

const TYPE_OPTIONS: Array<{ label: string; value: string | null }> = [
  { label: "all", value: null },
  { label: "user", value: "user" },
  { label: "feedback", value: "feedback" },
  { label: "projects", value: "projects" },
  { label: "reference", value: "reference" },
];

export class MemoryTab {
  // ── tab-surface state ──
  private host: HTMLElement | null = null;
  private mode: "browse" | "graph" = "browse";
  private memories: MemoryMeta[] = [];
  private query = "";
  private typeFilter: string | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  // backs the drawer inspector's rendered-markdown body (renderInspector); unloaded and
  // replaced on every open so Components don't accumulate for the plugin-session lifetime.
  private inspectorHost: Component | null = null;

  // ── graph-mode state — PORT of the old Cortex view's fields ──
  private graph: Graph | null = null;
  private svg!: SVGSVGElement;
  private gWorld!: SVGGElement;
  private gEdges!: SVGGElement;
  private gNodes!: SVGGElement;
  private gLabels!: SVGGElement;
  private animTimer: number | null = null;
  private viewX = 0;
  private viewY = 0;
  private viewScale = 1.0;
  private draggingNode: GraphNode | null = null;
  private dragOffset = { x: 0, y: 0 };
  private isPanning = false;
  private panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };
  private filters: Record<NodeKind, boolean> = { memory: true, pattern: true, session: true, agent: true };
  private hoveredId: string | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const onVaultChange = (f: TAbstractFile) => {
        if (f.path.startsWith(MEMORY_ROOT + "/")) this.schedule();
      };
      this.view.registerEvent(this.plugin.app.vault.on("create", onVaultChange));
      this.view.registerEvent(this.plugin.app.vault.on("modify", onVaultChange));
      this.view.registerEvent(this.plugin.app.vault.on("delete", onVaultChange));
      // One-time window-level pan/zoom listeners. attachPanZoom() below (re)binds only
      // the svg-scoped wheel/mousedown listeners on every graph render, since a fresh
      // <svg> is built each time host.empty() runs; window itself is never recreated,
      // so these two must be bound exactly once per tab instance or they'd pile up.
      window.addEventListener("mousemove", this.onMouseMove);
      window.addEventListener("mouseup", this.onMouseUp);
    }
    void this.refresh();
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    this.memories = await listMemories(this.plugin.app);
    if (this.mode === "graph") {
      this.graph = await buildGraph(this.plugin.app);
      settle(this.graph, 180);
    }
    this.render();
  }

  // ── render ──────────────────────────────────────────────────────────

  private render(): void {
    if (!this.view.isTabActive("memory")) return;
    const host = this.host;
    if (!host) return;
    host.empty();

    const head = host.createDiv({ cls: "aos-mem-head" });
    for (const opt of TYPE_OPTIONS) {
      const chip = head.createSpan({ cls: "aos-mem-chip", text: opt.label });
      chip.toggleClass("is-active", this.typeFilter === opt.value);
      chip.addEventListener("click", () => { this.typeFilter = opt.value; this.render(); });
    }
    const search = head.createEl("input", { cls: "aos-mem-search", attr: { type: "text", placeholder: "search memories…", value: this.query } });
    // assigned below when browse mode builds its rows container; closed over by the
    // input handler so typing updates just the rows, not the input itself (which would
    // otherwise lose focus on every keystroke — see SpacesTab's map-search precedent).
    let rowsHost: HTMLElement | null = null;
    search.addEventListener("input", () => {
      this.query = search.value;
      if (rowsHost) this.renderRows(rowsHost);
    });
    const modeBtn = head.createSpan({ cls: "aos-mem-chip", text: "◈ graph" });
    modeBtn.toggleClass("is-active", this.mode === "graph");
    modeBtn.addEventListener("click", () => {
      this.mode = this.mode === "browse" ? "graph" : "browse";
      if (this.mode === "graph") {
        this.render();       // immediate shell (canvas + "loading…" stats)
        void this.refresh(); // async: builds the graph, re-renders when ready
      } else {
        this.stopGentleSim();
        this.render();
      }
    });

    if (this.mode === "browse") {
      rowsHost = host.createDiv({ cls: "aos-mem-rows" });
      this.renderRows(rowsHost);
    } else {
      this.renderGraphMode(host);
    }
  }

  private renderRows(host: HTMLElement): void {
    host.empty();
    const filtered = filterMemories(this.memories, this.query, this.typeFilter);
    if (!filtered.length) {
      host.createDiv({ cls: "aos-dim", text: this.memories.length === 0 ? "no memories yet" : "no matches" });
      return;
    }
    for (const m of filtered) {
      const row = host.createDiv({ cls: "aos-mem-row" });
      row.createSpan({ text: m.title });
      row.createSpan({ cls: "aos-mem-chip", text: m.type });
      row.createSpan({ cls: "aos-dim", text: m.updated ?? "—" });
      // always create the 4th cell to keep the 4-column grid aligned across rows
      // (see SpacesTab's aos-sp-badge for the same trick); empty + classless when reviewed.
      row.createSpan(m.reviewed === false ? { cls: "aos-mem-unreviewed", text: "unreviewed" } : { text: "" });
      row.addEventListener("click", () => {
        this.view.openDrawer(
          m.title,
          (drawerHost) => this.renderInspector(drawerHost, m),
          () => {
            setPendingMemory(m.path);
            void this.plugin.activate(VIEW_TYPE_MEMORY_INSPECTOR, "split");
          }
        );
      });
    }
  }

  // ── graph mode — PORT of the old Cortex view (draw ~213, updatePositions ~300,
  //    applyHoverStyling ~334, resettle ~122, openFile ~370), plus the
  //    canvas/pan-zoom/sim plumbing those methods depend on. ──

  private renderGraphMode(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "aos-mem-graphhost aos-cortex" });

    const header = container.createDiv({ cls: "aos-cortex-header" });
    header.createSpan({ cls: "aos-title", text: "[ CORTEX // KNOWLEDGE GRAPH ]" });
    const chips = header.createDiv({ cls: "aos-cortex-chips" });
    (["memory", "pattern", "session", "agent"] as NodeKind[]).forEach((k) => {
      const chip = chips.createEl("button", { cls: "aos-cortex-chip", text: k });
      chip.style.borderColor = KIND_COLOR[k];
      chip.style.color = KIND_COLOR[k];
      chip.toggleClass("aos-cortex-chip-off", !this.filters[k]);
      chip.addEventListener("click", () => {
        this.filters[k] = !this.filters[k];
        chip.toggleClass("aos-cortex-chip-off", !this.filters[k]);
        this.draw();
      });
    });
    const reBtn = header.createEl("button", { cls: "aos-cortex-chip", text: "↻ resettle" });
    reBtn.addEventListener("click", () => void this.resettle());

    const stats = container.createDiv({ cls: "aos-cortex-stats aos-dim" });
    stats.textContent = this.graph ? `${this.graph.nodes.length} nodes · ${this.graph.edges.length} edges` : "loading…";

    const canvas = container.createDiv({ cls: "aos-cortex-canvas" });
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.classList.add("aos-cortex-svg");
    canvas.appendChild(this.svg);

    this.gWorld = document.createElementNS(SVG_NS, "g");
    this.gEdges = document.createElementNS(SVG_NS, "g");
    this.gNodes = document.createElementNS(SVG_NS, "g");
    this.gLabels = document.createElementNS(SVG_NS, "g");
    this.gWorld.appendChild(this.gEdges);
    this.gWorld.appendChild(this.gNodes);
    this.gWorld.appendChild(this.gLabels);
    this.svg.appendChild(this.gWorld);

    this.attachPanZoom();

    if (this.graph) {
      this.fitToView();
      this.draw();
      this.startGentleSim();
    }
  }

  private startGentleSim(): void {
    if (this.animTimer !== null) return;
    this.animTimer = window.setInterval(() => {
      // guard against ticking a detached canvas: the tab may have been switched away
      // from (contentHost now belongs to another tab) or flipped back to browse mode
      // without this timer having been stopped yet.
      if (!this.graph || this.mode !== "graph" || !this.view.isTabActive("memory")) return;
      tick(this.graph, {
        repulsion: 1600,
        spring: 0.045,
        restLength: 90,
        centerGravity: 0.0015,
        damping: 0.92,
      });
      this.updatePositions();
    }, 40);
  }

  private stopGentleSim(): void {
    if (this.animTimer !== null) { window.clearInterval(this.animTimer); this.animTimer = null; }
  }

  // PORT of the old Cortex view's resettle (~122)
  private async resettle(): Promise<void> {
    if (!this.graph) return;
    for (const n of this.graph.nodes) {
      n.fixed = false;
      n.vx = 0; n.vy = 0;
      n.x = (Math.random() - 0.5) * 400;
      n.y = (Math.random() - 0.5) * 400;
    }
    settle(this.graph, 180);
    this.fitToView();
    this.draw();
  }

  // PORT of the old Cortex view's fitToView
  private fitToView(): void {
    if (!this.graph || this.graph.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.graph.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const w = this.svg.clientWidth || 800;
    const h = this.svg.clientHeight || 600;
    const gw = (maxX - minX) || 1;
    const gh = (maxY - minY) || 1;
    const padding = 60;
    const scale = Math.min((w - padding * 2) / gw, (h - padding * 2) / gh, 1.4);
    this.viewScale = scale;
    this.viewX = (w / 2) - ((minX + maxX) / 2) * scale;
    this.viewY = (h / 2) - ((minY + maxY) / 2) * scale;
    this.applyTransform();
  }

  // PORT of the old Cortex view's applyTransform
  private applyTransform(): void {
    this.gWorld.setAttribute("transform", `translate(${this.viewX} ${this.viewY}) scale(${this.viewScale})`);
  }

  // PORT of the old Cortex view's attachPanZoom — svg-scoped listeners only; these are reattached
  // on every graph render since a fresh <svg> is created each time. The window-level
  // mousemove/mouseup (also part of the original method) are bound once in mount() instead.
  private attachPanZoom(): void {
    this.svg.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldX = (mx - this.viewX) / this.viewScale;
      const worldY = (my - this.viewY) / this.viewScale;
      this.viewScale = Math.max(0.2, Math.min(4, this.viewScale * factor));
      this.viewX = mx - worldX * this.viewScale;
      this.viewY = my - worldY * this.viewScale;
      this.applyTransform();
    }, { passive: false });

    this.svg.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (this.draggingNode) return;
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY, viewX: this.viewX, viewY: this.viewY };
    });
  }

  // PORT of the old Cortex view's onMouseMove
  private onMouseMove = (e: MouseEvent): void => {
    if (this.draggingNode) {
      const rect = this.svg.getBoundingClientRect();
      const wx = (e.clientX - rect.left - this.viewX) / this.viewScale;
      const wy = (e.clientY - rect.top - this.viewY) / this.viewScale;
      this.draggingNode.x = wx - this.dragOffset.x;
      this.draggingNode.y = wy - this.dragOffset.y;
      this.draggingNode.vx = 0;
      this.draggingNode.vy = 0;
      this.updatePositions();
    } else if (this.isPanning) {
      this.viewX = this.panStart.viewX + (e.clientX - this.panStart.x);
      this.viewY = this.panStart.viewY + (e.clientY - this.panStart.y);
      this.applyTransform();
    }
  };

  // PORT of the old Cortex view's onMouseUp
  private onMouseUp = (): void => {
    if (this.draggingNode) {
      this.draggingNode.fixed = true;
      this.draggingNode = null;
    }
    this.isPanning = false;
  };

  // PORT of the old Cortex view's draw (~213). Adaptation: the node click handler branches on
  // node kind — memory nodes open the drawer inspector, everything else keeps the
  // ported openFile() behavior (brief's explicit requirement).
  private draw(): void {
    if (!this.graph) return;
    while (this.gEdges.firstChild) this.gEdges.removeChild(this.gEdges.firstChild);
    while (this.gNodes.firstChild) this.gNodes.removeChild(this.gNodes.firstChild);
    while (this.gLabels.firstChild) this.gLabels.removeChild(this.gLabels.firstChild);

    const visible = (n: GraphNode) => this.filters[n.kind];

    for (const e of this.graph.edges) {
      const a = this.graph.byId.get(e.from);
      const b = this.graph.byId.get(e.to);
      if (!a || !b || !visible(a) || !visible(b)) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", "rgba(0,212,255,0.18)");
      line.setAttribute("stroke-width", "0.8");
      line.dataset.from = a.id;
      line.dataset.to = b.id;
      this.gEdges.appendChild(line);
    }

    for (const n of this.graph.nodes) {
      if (!visible(n)) continue;
      const g = document.createElementNS(SVG_NS, "g");
      g.dataset.id = n.id;
      g.setAttribute("transform", `translate(${n.x} ${n.y})`);
      g.classList.add("aos-cortex-node");

      const circle = document.createElementNS(SVG_NS, "circle");
      const r = 4 + Math.min(4, this.degreeOf(n.id) * 0.6);
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", KIND_COLOR[n.kind]);
      circle.setAttribute("stroke", "rgba(255,255,255,0.15)");
      circle.setAttribute("stroke-width", "0.5");
      circle.style.filter = `drop-shadow(0 0 4px ${KIND_COLOR[n.kind]}55)`;
      g.appendChild(circle);

      g.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
        const rect = this.svg.getBoundingClientRect();
        const wx = (e.clientX - rect.left - this.viewX) / this.viewScale;
        const wy = (e.clientY - rect.top - this.viewY) / this.viewScale;
        this.dragOffset = { x: wx - n.x, y: wy - n.y };
        this.draggingNode = n;
        n.fixed = true;
      });

      g.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
          n.fixed = false;
          return;
        }
        if (n.kind === "memory") {
          void this.openMemoryNode(n);
        } else {
          void this.openFile(n.path);
        }
      });

      g.addEventListener("mouseenter", () => {
        this.hoveredId = n.id;
        this.applyHoverStyling();
      });
      g.addEventListener("mouseleave", () => {
        this.hoveredId = null;
        this.applyHoverStyling();
      });

      this.gNodes.appendChild(g);

      if (this.degreeOf(n.id) >= 2 || this.hoveredId === n.id) {
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("x", String(n.x + r + 3));
        text.setAttribute("y", String(n.y + 3));
        text.setAttribute("fill", `var(--aos-text, ${TOKENS.text})`);
        text.setAttribute("font-size", "9");
        text.setAttribute("pointer-events", "none");
        text.textContent = n.label;
        text.dataset.id = n.id;
        this.gLabels.appendChild(text);
      }
    }

    this.applyHoverStyling();
  }

  // PORT of the old Cortex view's updatePositions (~300)
  private updatePositions(): void {
    if (!this.graph) return;
    const nodeEls = this.gNodes.querySelectorAll<SVGGElement>("g.aos-cortex-node");
    nodeEls.forEach((g) => {
      const id = g.dataset.id;
      if (!id) return;
      const n = this.graph!.byId.get(id);
      if (!n) return;
      g.setAttribute("transform", `translate(${n.x} ${n.y})`);
    });
    const lineEls = this.gEdges.querySelectorAll<SVGLineElement>("line");
    lineEls.forEach((line) => {
      const a = this.graph!.byId.get(line.dataset.from!);
      const b = this.graph!.byId.get(line.dataset.to!);
      if (!a || !b) return;
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
    });
    const labelEls = this.gLabels.querySelectorAll<SVGTextElement>("text");
    labelEls.forEach((t) => {
      const id = t.dataset.id;
      if (!id) return;
      const n = this.graph!.byId.get(id);
      if (!n) return;
      t.setAttribute("x", String(n.x + 7));
      t.setAttribute("y", String(n.y + 3));
    });
  }

  // PORT of the old Cortex view's applyHoverStyling (~334)
  private applyHoverStyling(): void {
    const hover = this.hoveredId;
    if (!hover || !this.graph) {
      this.gEdges.querySelectorAll<SVGLineElement>("line").forEach((l) => {
        l.setAttribute("stroke", "rgba(0,212,255,0.18)");
        l.setAttribute("stroke-width", "0.8");
      });
      this.gNodes.querySelectorAll<SVGGElement>("g.aos-cortex-node").forEach((g) => {
        g.style.opacity = "1";
      });
      return;
    }
    const neighbors = new Set<string>([hover]);
    for (const e of this.graph.edges) {
      if (e.from === hover) neighbors.add(e.to);
      if (e.to === hover) neighbors.add(e.from);
    }
    this.gEdges.querySelectorAll<SVGLineElement>("line").forEach((l) => {
      const touches = l.dataset.from === hover || l.dataset.to === hover;
      l.setAttribute("stroke", touches ? "rgba(0,212,255,0.6)" : "rgba(0,212,255,0.06)");
      l.setAttribute("stroke-width", touches ? "1.4" : "0.6");
    });
    this.gNodes.querySelectorAll<SVGGElement>("g.aos-cortex-node").forEach((g) => {
      g.style.opacity = neighbors.has(g.dataset.id || "") ? "1" : "0.25";
    });
  }

  // PORT of the old Cortex view's degreeOf
  private degreeOf(id: string): number {
    if (!this.graph) return 0;
    let c = 0;
    for (const e of this.graph.edges) {
      if (e.from === id || e.to === id) c++;
    }
    return c;
  }

  // Adaptation: graph nodes carry only id/path/label/kind — not the richer MemoryMeta
  // (title/type/created/updated/reviewed) the drawer inspector wants. Resolve it from
  // the already-loaded browse list by path, falling back to a live parse for the rare
  // case a memory node isn't in that list yet (e.g. graph built before a refresh landed).
  private async openMemoryNode(n: GraphNode): Promise<void> {
    let m = this.memories.find((x) => x.path === n.path);
    if (!m) {
      try {
        const raw = await this.plugin.app.vault.adapter.read(n.path);
        m = parseMemoryMeta(n.path, raw);
      } catch {
        new Notice(`Not found: ${n.path}`);
        return;
      }
    }
    const meta = m;
    this.view.openDrawer(
      meta.title,
      (drawerHost) => this.renderInspector(drawerHost, meta),
      () => {
        setPendingMemory(meta.path);
        void this.plugin.activate(VIEW_TYPE_MEMORY_INSPECTOR, "split");
      }
    );
  }

  // PORT of the old Cortex view's openFile (~370)
  private async openFile(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.plugin.app.workspace.getLeaf("split", "vertical").openFile(file);
    } else {
      new Notice(`Not found: ${path}`);
    }
  }

  // ── drawer inspector ────────────────────────────────────────────────
  // Frontmatter table is new (MemoryTab has parsed MemoryMeta the standalone
  // inspector never had). Body preview + backlinks are PORTs of
  // MemoryInspectorView.render's body content and findBacklinks (~41).

  private async renderInspector(host: HTMLElement, m: MemoryMeta): Promise<void> {
    host.addClass("aos-memscope");

    // unload the previous drawer's renderHost before building a new one — see
    // the inspectorHost field comment.
    if (this.inspectorHost) { this.inspectorHost.unload(); this.inspectorHost = null; }

    const file = this.plugin.app.vault.getAbstractFileByPath(m.path);
    if (!(file instanceof TFile)) {
      host.createDiv({ cls: "aos-text-rose", text: `not found: ${m.path}` });
      return;
    }

    const fm = host.createDiv({ cls: "aos-mem-fm" });
    const addRow = (label: string, value: string) => {
      const row = fm.createDiv({ cls: "aos-mem-fmrow" });
      row.createSpan({ cls: "aos-dim", text: label });
      row.createSpan({ text: value });
    };
    addRow("path", m.path);
    addRow("type", m.type);
    addRow("created", m.created ?? "—");
    addRow("updated", m.updated ?? "—");
    addRow("reviewed", m.reviewed === null ? "—" : m.reviewed ? "yes" : "unreviewed");

    // PORT of MemoryInspectorView.render — rendered markdown body
    const body = host.createDiv({ cls: "aos-memscope-body" });
    const raw = await this.plugin.app.vault.cachedRead(file);
    this.inspectorHost = new Component();
    this.inspectorHost.load();
    await MarkdownRenderer.renderMarkdown(raw, body, m.path, this.inspectorHost);

    // PORT of MemoryInspectorView.render — backlinks
    const backWrap = host.createDiv({ cls: "aos-memscope-backlinks" });
    backWrap.createDiv({ cls: "aos-panel-head" }).createSpan({ cls: "aos-panel-title", text: "BACKLINKS" });
    const backs = await this.findBacklinks(file);
    if (backs.length === 0) {
      backWrap.createDiv({ cls: "aos-dim", text: "none" });
    } else {
      const list = backWrap.createDiv({ cls: "aos-memscope-backlist" });
      for (const b of backs) {
        const row = list.createEl("a", { cls: "aos-memscope-backrow aos-link", href: "#" });
        row.textContent = b;
        row.addEventListener("click", async (e) => {
          e.preventDefault();
          const f = this.plugin.app.vault.getAbstractFileByPath(b);
          if (f instanceof TFile) await this.plugin.app.workspace.getLeaf("split", "vertical").openFile(f);
        });
      }
    }

    // footer — new, per brief
    const footer = host.createDiv({ cls: "aos-mem-footer" });
    const openLink = footer.createEl("a", { cls: "aos-link", text: "▸ open as file", href: "#" });
    openLink.addEventListener("click", async (e) => {
      e.preventDefault();
      await this.plugin.app.workspace.openLinkText(m.path, "", true);
    });
  }

  // PORT of MemoryInspectorView.findBacklinks (~96)
  private async findBacklinks(target: TFile): Promise<string[]> {
    const basename = target.basename.toLowerCase();
    const targetPath = target.path;
    const out: string[] = [];
    const all = this.plugin.app.vault.getMarkdownFiles();
    for (const f of all) {
      if (f.path === targetPath) continue;
      try {
        const body = await this.plugin.app.vault.cachedRead(f);
        const lower = body.toLowerCase();
        if (lower.includes(`[[${basename}]]`) ||
            lower.includes(`[[${basename}|`) ||
            lower.includes(`](${targetPath.toLowerCase()})`)) {
          out.push(f.path);
        }
      } catch { /* skip */ }
      if (out.length >= 100) break;
    }
    return out.sort();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.stopGentleSim();
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    if (this.inspectorHost) { this.inspectorHost.unload(); this.inspectorHost = null; }
    this.host?.empty();
    this.host = null;
  }
}
