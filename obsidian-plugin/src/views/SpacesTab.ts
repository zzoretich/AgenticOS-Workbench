import { Component, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { RevealTarget, WorkbenchView } from "./WorkbenchView";
import { LinkRepoModal } from "../ui/LinkRepoModal";
import { loadSnapshot, type Snapshot, type WorkspaceEntry } from "../data/snapshot";
import { indexMap, loadWorkspaceMap, type MapIndex, type WorkspaceMap } from "../data/workspaceMaps";
import { listDir, readPreview, type DirEntry, type PreviewResult } from "../data/workspaceFiles";
import { TODO_PATH, parseTodos, type Todo } from "../data/todos";
import { PROPOSALS_DIR, isProposalFile, parseProposal, type Proposal } from "../data/proposals";
import { parseMemoryMeta, type MemoryMeta } from "../data/memories";
import { readProviderState } from "../data/aosConfig";
import {
  entryByName, groupOf, linkedCounts, linkedFor, liveByWorkspace, matchesQuery, spaceList, SESSIONS_OFF_TEXT,
  type Linked, type LinkedCounts, type LinkedSources, type LiveState, type LiveTerminalInput, type ResumeRef,
} from "../data/spacesModel";
import { launchLine, placeOf, quickHost, type PlaceWorld, type TermHost, type TermHostChoice } from "../data/terminalLaunch";
import { sanitizeTerminalChoice } from "../settingsDefaults";
import { listen } from "../data/listen";
import type { TerminalSession } from "../data/terminalSession";
import { env, sessionsHost, shell, type HostSessionThread } from "../host";
import {
  PROJECT_NOTES_DIR, entryAbs, entryPlace, freshUiState, keepPlace, panesFor, targetFor, threadSignature, watchFlags,
  type Flag, type MenuItem, type Pane, type SpacesActions, type SpacesCtx, type SpacesUiState,
} from "./spaces/ui";
import { openPopover, type PopoverHandle } from "./spaces/Popover";
import { renderList, renderOutside } from "./spaces/ListPane";
import { renderDossier, renderViewTabs } from "./spaces/DossierPane";
import { renderPickup } from "./spaces/PickupCard";
import { renderOverview } from "./spaces/OverviewPane";
import { openFolders, renderFiles } from "./spaces/FilesPane";
import { renderPreview } from "./spaces/PreviewPane";
import { renderHistory } from "./spaces/HistoryPane";
import { renderLinked, renderRightFooter } from "./spaces/LinkedPane";

const ALL_FLAGS: readonly Flag[] = ["snapshot", "threads", "linked", "live", "world", "map", "listing"];
const ALL_PANES: readonly Pane[] = ["list", "centre", "right"];
/** A Sessions event that can start or end a turn (D26's live dot); the text and tool events of a running turn are not. */
const TURN_EVENTS = new Set(["prompt", "session", "done", "error"]);
/** The most folders the Files tree reads at once (open ones and, under a filter, the ones holding a match). */
const MAX_LISTINGS = 400;
const DEBOUNCE_MS = 250;

/**
 * SPACES — where you pick a project back up (spec 2026-10-09-spaces-redesign, PR 2: D3–D10, D19). Three panes: the
 * list (spaces/ListPane), the dossier with its pick-up card and Overview · Files (DossierPane, PickupCard, OverviewPane,
 * FilesPane), and the right pane, HISTORY over LINKED (HistoryPane, LinkedPane) or the file preview while Files is open
 * (PreviewPane). This class is the orchestrator: it watches what the panes read (snapshot.json, the maps,
 * brain/_index/sessions/**, workspaces/x/workspace.md, TODO.md, persona/proposals/, brain/memory/projects/), the
 * terminal pool and the Sessions events, through one 250 ms debounce, reads only what changed, and redraws only the
 * panes that show it, keeping focus and scroll (the AgentTeamsTab pattern). It writes nothing itself: Resume, Terminal
 * and New session are Code terminals, map and regen are runtime scripts, Link code folder is today's write (D2).
 */
export class SpacesTab {
  private host: HTMLElement | null = null;
  private els: { root: HTMLElement; list: HTMLElement; main: HTMLElement; centre: HTMLElement; right: HTMLElement } | null = null;
  private snapshot: Snapshot | null = null;
  private loaded = false;
  private ui: SpacesUiState = freshUiState();
  private map: WorkspaceMap | null = null;
  private index: MapIndex = indexMap(null);
  private mapFor: string | null | undefined = undefined;
  private listings = new Map<string, DirEntry[] | null>();
  private listingsFor: string | null = null;
  private threads: HostSessionThread[] = [];
  private live = new Map<string, LiveState>();
  private sources: LinkedSources = {};
  private linkedBy = new Map<string, Linked>();
  private counts = new Map<string, LinkedCounts>();
  private envCache: { at: number; world: PlaceWorld; choices: TermHostChoice[]; provider: string; sessions: boolean } | null = null;
  private dirty = new Set<Flag>();
  private debounce: number | null = null;
  private loading = false;
  private listenersRegistered = false;
  private detach: Array<() => void> = [];
  private popover: PopoverHandle | null = null;
  private popoverAnchor: HTMLElement | null = null;
  private pendingPanes = new Set<Pane>();
  private pendingReveal: RevealTarget | null = null;
  /** After the next draw: bring the revealed thread, a right-pane section or the selected row into view; focus the
   *  element with this data-spc-key (leaving the outside list). */
  private after: { scroll: "target" | "history" | "linked" | null; row: boolean; top: boolean; focus: string | null } = { scroll: null, row: false, top: false, focus: null };
  /** What the right pane last drew (rightKey): while it is the preview, only a change of what it shows redraws it. */
  private rightDrawn: string | null = null;
  /** The last preview read, drawn at once by the next redraw of the same file (PreviewPane). */
  private previewCache: { abs: string; res: PreviewResult } | null = null;
  /** Owns what the preview's Markdown renderer attaches; loaded per mount. */
  private md: Component | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    // setTab() empties the content area without an unmount: a menu left open on the last visit is gone with it, and
    // must not hold back this mount's draws.
    this.pendingPanes.clear();
    this.els = null;
    this.rightDrawn = null;
    this.popover?.close(false);
    this.popover = null;
    this.md?.unload();
    this.md = new Component();
    this.md.load();
    this.registerVaultEvents();
    this.attachLive();
    host.empty();
    const root = host.createDiv({ cls: "aos-spc" });
    const list = root.createEl("aside", { cls: "aos-spc-list", attr: { "aria-label": "Workspaces" } });
    const main = root.createDiv({ cls: "aos-spc-main" });
    const centre = main.createEl("section", { cls: "aos-spc-centre", attr: { "aria-label": "Workspace", "data-spc-scroll": "centre" } });
    const right = main.createEl("aside", { cls: "aos-spc-right", attr: { "aria-label": "History and linked work", "data-spc-scroll": "right" } });
    this.els = { root, list, main, centre, right };
    this.draw(ALL_PANES);
  }

  unmount(): void {
    if (this.debounce !== null) { window.clearTimeout(this.debounce); this.debounce = null; }
    this.pendingPanes.clear();
    this.popover?.close(false);
    this.popover = null;
    this.md?.unload();
    this.md = null;
    for (const d of this.detach) d();
    this.detach = [];
    this.host?.empty();
    this.host = null;
    this.els = null;
  }

  /** Reads everything again (WorkbenchView.setTab calls this after mount). */
  async refresh(): Promise<void> {
    for (const f of ALL_FLAGS) this.dirty.add(f);
    this.envCache = null;
    await this.load();
  }

  /** The workspace whose dossier is open: what ⌘T starts next to while Spaces is shown (spec 2026-10-08-term-agent-deck T4). */
  selectedWorkspace(): string | null { return this.ui.selected; }

  /**
   * Spaces on a workspace (spaces-redesign D12: WorkbenchView.open and the agenticos://workbench link): selects
   * `workspace` (showing archived and _ folders when it is one), shows `pane` (overview or files in the centre; history
   * or linked in the right pane) and marks `thread` in History. Select only: it never resumes, opens a terminal,
   * drafts or runs a verb. A name the snapshot does not hold is ignored.
   */
  reveal(target: RevealTarget): void {
    this.pendingReveal = { ...target };
    this.kick(["select"]);
  }

  // ── events ──

  private registerVaultEvents(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;
    const vault = this.plugin.app.vault;
    const on = (f: TAbstractFile, modify: boolean, old?: string) => {
      const flags = [...this.flagsFor(f.path, modify), ...(old !== undefined ? this.flagsFor(old, modify) : [])];
      if (flags.length) this.schedule(flags);
    };
    this.view.registerEvent(vault.on("modify", (f) => on(f, true)));
    this.view.registerEvent(vault.on("create", (f) => on(f, false)));
    this.view.registerEvent(vault.on("delete", (f) => on(f, false)));
    this.view.registerEvent(vault.on("rename", (f, old) => on(f, false, old)));
  }

  private flagsFor(p: string, modify: boolean): Flag[] {
    return watchFlags(p, { selected: this.ui.selected, selectedPath: this.entry()?.path ?? null, modify });
  }

  /** The terminal pool and the Sessions events, owned by this mount and removed in unmount() (spec 2026-09-24 D1). */
  private attachLive(): void {
    for (const d of this.detach) d();
    this.detach = [];
    const pool = this.plugin.terminalPool;
    if (pool) {
      const live = () => this.schedule(["live"]);
      this.detach.push(listen(pool, {
        "session-add": live, "session-remove": live, "session-exit": live,
        "session-update": (s: unknown) => { if ((s as TerminalSession | undefined)?.isExited) live(); },
      }));
    }
    const sh = sessionsHost();
    if (sh) this.detach.push(sh.sessions.onEvent((ev) => { if (TURN_EVENTS.has(ev.event.kind)) this.schedule(["threads"]); }));
  }

  private schedule(flags: Flag[]): void {
    if (!this.host || !this.view.isTabActive("spaces")) return;   // setTab's refresh() reads everything on the way back
    for (const f of flags) this.dirty.add(f);
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.load(); }, DEBOUNCE_MS);
  }

  /** A user action: read what it needs now, without the debounce. */
  private kick(flags: Flag[]): void {
    for (const f of flags) this.dirty.add(f);
    void this.load();
  }

  /** Reads one batch of flags at a time, in order: a flag raised while a read is running is read right after it. */
  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      while (this.dirty.size) {
        const flags = this.dirty;
        this.dirty = new Set();
        const panes = await this.apply(flags);
        this.draw(panes);
      }
    } finally { this.loading = false; }
  }

  private async apply(flags: Set<Flag>): Promise<Set<Pane>> {
    /** The flags whose data really changed; panesFor turns them into panes at the end, once the reads are in. */
    const changed = new Set(flags);
    const panes = new Set<Pane>();
    if (flags.has("snapshot") || flags.has("world")) this.envCache = null;
    if (flags.has("snapshot")) {
      let next: Snapshot | null = null;
      try { next = await loadSnapshot(this.plugin.app); } catch { next = null; }
      // A read that fails (an upgrade swapping files, a partial copy) keeps the last good scan, and with it the
      // selection, the Files state and the preview; only a vault that never had one reads as none.
      if (next || !this.snapshot) this.snapshot = next;
      this.loaded = true;
    }
    if (flags.has("threads")) {
      // A re-list that reads the same (no thread came or went, none started or stopped) redraws nothing.
      const next = await this.listThreads();
      if (threadSignature(next) === threadSignature(this.threads)) changed.delete("threads");
      this.threads = next;
    }
    if (flags.has("linked")) this.sources = await this.loadSources();
    if (flags.has("snapshot") || flags.has("linked")) this.computeLinked();
    this.live = this.computeLive();

    const before = this.ui.selected;
    if (this.applyReveal()) for (const p of ALL_PANES) panes.add(p);
    this.ensureSelection();
    if (this.ui.selected !== before) {
      this.resetFiles();
      this.after.top = true;
      for (const p of ALL_PANES) panes.add(p);
      // A menu built for the last workspace would act on this one (a link or a rescan moved the selection): close it.
      this.closeMenu();
    }
    const sel = this.ui.selected;
    if (sel !== this.mapFor || flags.has("map")) {
      const map = sel ? await loadWorkspaceMap(this.plugin.app, sel) : null;
      // Another workspace was picked during the read: never draw it with this one's map; the next batch reads its own.
      if (sel !== this.ui.selected) { this.dirty.add("select"); return new Set(); }
      this.map = map;
      this.index = indexMap(this.map);
      this.mapFor = sel;
      panes.add("centre");
      panes.add("right");
    }
    if (sel !== this.listingsFor || flags.has("listing")) { this.listings = new Map(); this.listingsFor = sel; }
    if (this.ui.centre === "files") {
      await this.ensureListings();
      if (sel !== this.ui.selected) { this.dirty.add("select"); return new Set(); }
    }
    for (const p of panesFor(changed, { previewShown: this.ui.centre === "files", rightChanged: this.rightKey() !== this.rightDrawn })) panes.add(p);
    return panes;
  }

  /** What the right pane shows: the preview of a file of a workspace, or that workspace's History and Linked. */
  private rightKey(): string {
    const sel = this.ui.selected ?? "";
    return this.ui.centre === "files" ? `files:${sel}:${this.ui.files.preview ?? ""}` : `${this.ui.centre}:${sel}`;
  }

  // ── reads ──

  private async listThreads(): Promise<HostSessionThread[]> {
    try {
      const h = sessionsHost();
      const r = h ? await h.sessions.list() : null;
      return r?.ok ? r.data : [];
    } catch { return []; }   // no sessions host (plain Node)
  }

  /** What Linked reads (D27): TODO.md, the pending proposals and the project notes. */
  private async loadSources(): Promise<LinkedSources> {
    const a = this.plugin.app.vault.adapter;
    let todos: Todo[] = [];
    try { if (await a.exists(TODO_PATH)) todos = parseTodos(await a.read(TODO_PATH)); } catch { /* unreadable: none */ }
    const proposals: Proposal[] = [];
    try {
      const names = (await a.list(PROPOSALS_DIR)).files.map((f) => f.split("/").pop() ?? "").filter(isProposalFile);
      for (const n of names) { try { proposals.push(parseProposal(n, await a.read(`${PROPOSALS_DIR}/${n}`))); } catch { /* gone */ } }
    } catch { /* no persona/ yet */ }
    const memories: MemoryMeta[] = [];
    try {
      const files = (await a.list(PROJECT_NOTES_DIR)).files.filter((f) => f.endsWith(".md"));
      for (const f of files) { try { memories.push(parseMemoryMeta(f, await a.read(f))); } catch { /* gone */ } }
    } catch { /* no project notes yet */ }
    return { todos, proposals, memories };
  }

  private computeLinked(): void {
    this.linkedBy = new Map();
    this.counts = new Map();
    const opts = { vault: this.plugin.vaultRoot(), home: env.homedir() };
    for (const e of this.entries()) {
      const l = linkedFor(e, this.sources, opts);
      this.linkedBy.set(e.name, l);
      this.counts.set(e.name, linkedCounts(l));
    }
  }

  /** D26: Code terminals placed in a workspace and Sessions threads mid-turn. */
  private computeLive(): Map<string, LiveState> {
    let terminals: LiveTerminalInput[] = [];
    try {
      let world: PlaceWorld | null = null;
      terminals = this.plugin.terminalPool.list().map((s) => ({ place: s.meta.place ?? placeOf(s.cwd, (world ??= this.env().world)), exited: s.isExited }));
    } catch { /* no terminals */ }
    return liveByWorkspace(this.threads.map((t) => ({ workspace: t.workspace, running: t.running })), terminals);
  }

  /** Listings for the Files tree: the root, every open folder below an open one, and the folders holding a match. */
  private async ensureListings(): Promise<void> {
    const e = this.entry();
    if (!e) return;
    const name = e.name;
    const root = entryAbs(e, this.plugin.vaultRoot());
    const open = openFolders({ ui: this.ui, index: this.index });
    const queue = [""];
    let n = 0;
    while (queue.length && n++ < MAX_LISTINGS) {
      const rel = queue.shift()!;
      let entries = this.listings.get(rel);
      if (entries === undefined) {
        try { entries = await listDir(rel ? path.join(root, rel) : root); } catch { entries = null; }
        if (this.listingsFor !== name) return;   // another workspace was picked meanwhile
        this.listings.set(rel, entries);
      }
      for (const d of entries ?? []) {
        if (!d.isDir) continue;
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (open.has(child)) queue.push(child);
      }
    }
  }

  /** The world, the host choices and the provider: read from disk at most every two seconds, and again after a scan. */
  private env(): { world: PlaceWorld; choices: TermHostChoice[]; provider: string; sessions: boolean } {
    const c = this.envCache;
    if (c && Date.now() - c.at < 2000) return c;
    const launcher = this.plugin.termLauncher;
    let provider = "none";
    try { provider = readProviderState(this.plugin.vaultRoot())?.name ?? "none"; } catch { /* unreadable: none */ }
    const next = { at: Date.now(), world: launcher.world(), choices: launcher.choices(), provider, sessions: this.plugin.chatAvailable() };
    this.envCache = next;
    return next;
  }

  // ── selection ──

  private entries(): WorkspaceEntry[] {
    return (this.snapshot?.workspaces ?? []).filter((e): e is WorkspaceEntry => !!e && typeof e.name === "string" && !!e.name);
  }

  private entry(): WorkspaceEntry | null {
    const s = this.ui.selected;
    return s ? this.entries().find((e) => e.name === s) ?? null : null;
  }

  /** Keeps the selection while it is listed (a hidden one only while hidden ones show); else the first listed row. */
  private ensureSelection(): void {
    if (!this.loaded) return;
    const all = this.entries();
    const cur = all.find((e) => e.name === this.ui.selected);
    if (cur && (!cur.hidden || this.ui.showHidden)) return;
    const first = spaceList(all, { showHidden: this.ui.showHidden }).groups.flatMap((g) => g.entries)[0];
    this.ui.selected = first?.name ?? null;
  }

  private applyReveal(): boolean {
    const r = this.pendingReveal;
    if (!r || !this.loaded) return false;
    this.pendingReveal = null;
    const e = r.workspace ? entryByName(this.snapshot, r.workspace) : null;
    if (e) {
      if (e.hidden) this.ui.showHidden = true;
      // A typed filter that leaves the revealed workspace out would hide its row while its dossier shows: clear it.
      if (this.ui.query && !matchesQuery(e, this.ui.query)) this.ui.query = "";
      this.ui.groupOpen.set(groupOf(e), true);
      if (this.ui.selected !== e.name) { this.ui.selected = e.name; this.resetFiles(); this.after.top = true; }
      this.after.row = true;
    }
    if (r.pane === "overview" || r.pane === "files") this.ui.centre = r.pane;
    else if ((r.pane === "history" || r.pane === "linked" || r.thread) && this.ui.centre !== "overview") this.ui.centre = "overview";
    else if (e && this.ui.centre === "outside") this.ui.centre = "overview";
    this.ui.target.thread = r.thread ?? null;
    if (r.thread) { this.ui.history = "all"; this.after.scroll = "target"; }
    else if (r.pane === "history" || r.pane === "linked") this.after.scroll = r.pane;
    return true;
  }

  private resetFiles(): void {
    this.ui.files = { filter: "all", query: "", open: new Set(), preview: null };
  }

  // ── draw ──

  private ctx(): SpacesCtx {
    const en = this.env();
    const entry = this.entry();
    return {
      snapshot: this.snapshot, loaded: this.loaded, entries: this.entries(), entry, ui: this.ui, now: Date.now(),
      home: env.homedir(), vault: this.plugin.vaultRoot(), world: en.world, choices: en.choices, quick: this.quickAgent(en.choices),
      provider: en.provider, sessionsAvailable: en.sessions, live: this.live, counts: this.counts,
      linked: entry ? this.linkedBy.get(entry.name) ?? null : null,
      threads: this.threads, map: this.map, index: this.index, listings: this.listings,
      cachedPreview: (abs) => (this.previewCache?.abs === abs ? this.previewCache.res : null),
      renderMarkdown: (el, text, sourcePath) => {
        if (this.md) void MarkdownRenderer.renderMarkdown(text, el, sourcePath, this.md);
        else el.createEl("pre", { cls: "aos-spc-pre", text });
      },
      // The hint is the line a resume types (D7): the configured binary, and for Codex `-C <folder>`.
      resumeLine: (host, id, cwd) => {
        try { return launchLine(this.plugin.termLauncher.spec(host, { resume: { id }, cwd })); } catch { return null; }
      },
      setIcon: (el, id) => setIcon(el, id),
      act: this.actions(),
    };
  }

  /** The agent ⌘T would start (the one last launched from the deck, else the first ready one), for Start in Code. */
  private quickAgent(choices: TermHostChoice[]): "claude" | "codex" | null {
    const q = quickHost(sanitizeTerminalChoice(this.plugin.settings.terminalChoice).host, choices).host;
    return q === "claude" || q === "codex" ? q : null;
  }

  private draw(panes: Iterable<Pane>): void {
    const set = new Set(panes);
    if (!set.size || !this.els || !this.view.isTabActive("spaces")) return;
    // An open menu stays: what changed under it is drawn when it closes.
    if (this.popover) { for (const p of set) this.pendingPanes.add(p); return; }
    const els = this.els;
    const ctx = this.ctx();
    els.main.toggleClass("is-outside", this.ui.centre === "outside");
    els.main.toggleClass("is-files", this.ui.centre === "files");
    for (const p of ALL_PANES) {
      if (!set.has(p)) continue;
      const el = els[p];
      keepPlace(el, () => { el.empty(); this.renderPane(p, el, ctx); }, [els.main, els.root]);
    }
    if (set.has("right")) this.rightDrawn = this.rightKey();
    this.afterDraw();
  }

  private renderPane(p: Pane, el: HTMLElement, ctx: SpacesCtx): void {
    const e = ctx.entry;
    if (p === "list") { renderList(el, ctx); return; }
    if (p === "centre") {
      if (!ctx.loaded) { el.createDiv({ cls: "aos-spc-empty aos-spc-pad", text: "Reading the vault's scan…" }); return; }
      if (ctx.ui.centre === "outside") { renderOutside(el, ctx); return; }
      if (!e) {
        el.createDiv({ cls: "aos-spc-empty aos-spc-pad", text: ctx.entries.length ? "Pick a workspace on the left." : "No workspaces yet: + New makes one in Code." });
        return;
      }
      renderDossier(el, ctx, e);
      renderPickup(el, ctx, e);
      renderViewTabs(el, ctx);
      const files = ctx.ui.centre === "files";
      const panel = el.createDiv({ cls: `aos-spc-body${files ? " is-files" : ""}`, attr: { id: "aos-spc-viewpanel", role: "tabpanel", "aria-label": files ? "Files" : "Overview" } });
      if (files) renderFiles(panel, ctx, e);
      else renderOverview(panel, ctx, e);
      return;
    }
    if (!ctx.loaded || !e || ctx.ui.centre === "outside") return;
    if (ctx.ui.centre === "files") { renderPreview(el, ctx, e); return; }
    renderHistory(el, ctx, e);
    renderLinked(el, ctx);
    renderRightFooter(el, ctx, e);
  }

  private afterDraw(): void {
    const els = this.els;
    if (!els) return;
    const a = this.after;
    this.after = { scroll: null, row: false, top: false, focus: null };
    if (a.top) {
      // Whichever element scrolls in this layout: the panes (wide), the dossier column (≤ 1100 px), the tab (≤ 760 px,
      // where only the dossier's top is brought back into view, the list above it left as it was).
      els.centre.scrollTop = 0;
      els.right.scrollTop = 0;
      els.main.scrollTop = 0;
      if (els.root.scrollTop > els.main.offsetTop) els.root.scrollTop = els.main.offsetTop;
    }
    if (a.focus) els.root.querySelector<HTMLElement>(`[data-spc-key="${a.focus}"]`)?.focus({ preventScroll: true });
    if (a.row) els.list.querySelector<HTMLElement>(".aos-spc-row.is-selected")?.scrollIntoView({ block: "nearest" });
    if (a.scroll === "target") els.right.querySelector<HTMLElement>(".aos-spc-hrow.is-target")?.scrollIntoView({ block: "nearest" });
    else if (a.scroll) {
      const h = els.right.querySelector<HTMLElement>(`#aos-spc-${a.scroll}-h`);
      h?.scrollIntoView({ block: "start" });
      h?.focus({ preventScroll: true });
    }
  }

  // ── actions ──

  private actions(): SpacesActions {
    return {
      select: (name) => this.select(name),
      reselect: () => this.kick(["select"]),
      redraw: (panes) => this.draw(panes),
      tree: () => this.kick(["tree"]),
      showOutside: (on, name) => {
        // Leaving the list keeps the keyboard's place: a Matches link lands on the workspace's title, Back on the
        // footer's "Outside workspaces (n)" (the focused button is gone with the list).
        if (!on && name) { this.after.focus = "title"; this.select(name); return; }
        this.ui.centre = on ? "outside" : "overview";
        this.after.top = true;
        if (!on) this.after.focus = "outside";
        this.draw(ALL_PANES);
      },
      newWorkspace: () => this.view.openTermMenu("create"),
      resume: (ref) => void this.resume(ref),
      newSession: (host) => void this.launch(host),
      terminal: () => void this.launch("shell"),
      finder: () => { const e = this.entry(); if (e) this.openPath(entryAbs(e, this.plugin.vaultRoot())); },
      revealInFinder: (abs) => { try { shell.showItemInFolder(abs); } catch { new Notice(`Cannot reveal ${abs}`); } },
      openPath: (abs) => this.openPath(abs),
      copy: (text) => this.copy(text),
      linkCodeFolder: () => this.linkCodeFolder(),
      openSessions: (thread) => {
        const e = this.entry();
        if (!this.view.open({ tab: "chat", workspace: e?.name ?? null, thread: thread ?? null })) new Notice(SESSIONS_OFF_TEXT);
      },
      openCode: () => { const e = this.entry(); this.view.open({ tab: "term", workspace: e?.name ?? null }); },
      openTab: (tab) => { this.view.open({ tab }); },
      openFile: (p) => void this.openFile(p),
      regen: () => {
        const e = this.entry();
        if (!e) return;
        new Notice(`Regenerating insight for ${e.name}…`);
        this.plugin.regenWorkspaceInsight(e.name);
      },
      mapNow: () => {
        const e = this.entry();
        if (e) this.plugin.runBrainScript("brain/scripts/map-workspace.js", [e.name], () => this.schedule(["map"]));
      },
      describeFile: (rel) => {
        const e = this.entry();
        if (e) this.plugin.runBrainScript("brain/scripts/map-workspace.js", [e.name, "--file", rel], () => this.schedule(["map"]));
      },
      menu: (anchor, items, label) => this.menu(anchor, items, label),
      readPreview: (abs) => readPreview(abs).then(
        (res) => { this.previewCache = { abs, res }; return res; },
        (err: unknown) => { if (this.previewCache?.abs === abs) this.previewCache = null; throw err; },
      ),
    };
  }

  private select(name: string): void {
    if (name === this.ui.selected && this.ui.centre !== "outside") return;
    if (this.ui.centre === "outside") { this.ui.centre = "overview"; this.after.top = true; }
    if (name !== this.ui.selected) { this.ui.selected = name; this.resetFiles(); this.ui.target.thread = null; this.after.top = true; }
    this.kick(["select"]);
  }

  /** Resume (D7, D31, D32): a Code terminal in the workspace's group, or the thread in Sessions; never the other host. */
  private async resume(ref: ResumeRef): Promise<void> {
    const e = this.entry();
    if (!e || e.name !== ref.workspace) return;
    const en = this.env();
    const t = targetFor({ snapshot: this.snapshot, choices: en.choices, world: en.world, sessionsAvailable: en.sessions }, e, ref);
    if (t.kind === "disabled") { new Notice(t.reason); return; }
    if (t.kind === "sessions") {
      if (!this.view.open({ tab: "chat", workspace: t.workspace, thread: t.thread })) new Notice(SESSIONS_OFF_TEXT);
      return;
    }
    try {
      // The place keeps the workspace, so the terminal joins ws:<name> in Code and the live dot holds (D7, D26).
      await this.view.launchTerminal(t.host, { picked: t.place, resume: { id: t.id }, origin: "Spaces" });
    } catch (err) {
      new Notice(`Resume unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A new session of `host`, or a shell, in the workspace's place (its linked code folder when it has one). */
  private async launch(host: TermHost): Promise<void> {
    const e = this.entry();
    if (!e) return;
    const where = entryPlace(e, this.env().world);
    if (!where.place) { new Notice(where.reason); return; }
    try {
      await this.view.launchTerminal(host, { picked: where.place, origin: "Spaces" });
    } catch (err) {
      new Notice(`Terminal unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private linkCodeFolder(): void {
    const e = this.entry();
    if (!e) return;
    const name = e.name;
    const current = this.env().world.links[name] ?? null;
    new LinkRepoModal(this.plugin.app, name, current, (typed) => {
      const abs = this.plugin.termLauncher.linkRepo(name, typed);
      new Notice(abs ? `${name} is linked to ${abs}` : `${name} is no longer linked`);
      this.envCache = null;
      this.kick(["world"]);
      return abs;
    }).open();
  }

  private menu(anchor: HTMLElement, items: MenuItem[], label: string): void {
    if (this.popover) {
      const same = this.popoverAnchor === anchor;
      this.popover.close(false);
      if (same) return;
    }
    if (!this.els) return;
    this.popoverAnchor = anchor;
    this.popover = openPopover(anchor, this.els.root, items, {
      label,
      onClose: (how) => {
        this.popover = null;
        this.popoverAnchor = null;
        if (how === "pointer") this.flushAfterPointer();
        else this.flushPending();
      },
    });
  }

  /** Closes an open menu without drawing what it held back (the caller draws every pane next). */
  private closeMenu(): void {
    if (!this.popover) return;
    this.pendingPanes.clear();
    this.popover.close(false);
  }

  /** Draws what changed while a menu was open. */
  private flushPending(): void {
    if (!this.pendingPanes.size) return;
    const p = [...this.pendingPanes];
    this.pendingPanes.clear();
    this.draw(p);
  }

  /**
   * A press elsewhere closed the menu on pointerdown: draw what it held back once that press's click has landed (or
   * after 300 ms, for a press that makes no click), so the control under the pointer is not replaced between
   * pointerdown and pointerup and the click that closed the menu still reaches it.
   */
  private flushAfterPointer(): void {
    if (!this.pendingPanes.size || !this.els) return;
    const doc = this.els.root.ownerDocument;
    let timer = 0;
    const go = (): void => {
      doc.removeEventListener("click", go);
      window.clearTimeout(timer);
      this.flushPending();
    };
    doc.addEventListener("click", go);
    timer = window.setTimeout(go, 300);
  }

  private openPath(abs: string): void {
    try {
      void shell.openPath(abs).then((err: string) => { if (err) new Notice(`Cannot open ${abs}: ${err}`); });
    } catch { new Notice(`Cannot open ${abs}`); }
  }

  /** Copy path (D5): "copy failed" where the app denies the clipboard (COVERAGE compat gap 1). */
  private copy(text: string): void {
    const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clip) { new Notice("copy failed"); return; }
    clip.writeText(text).then(() => new Notice("copied"), () => new Notice("copy failed"));
  }

  /** A vault file in the app's editor; anything else (a folder, a file outside the vault) with the system's app. */
  private async openFile(vaultPath: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
    if (f instanceof TFile) { await this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    this.openPath(path.join(this.plugin.vaultRoot(), vaultPath));
  }
}
