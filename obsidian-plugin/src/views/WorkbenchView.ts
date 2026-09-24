import { ItemView, TAbstractFile, WorkspaceLeaf } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { PulseTab } from "./PulseTab";
import { SpacesTab } from "./SpacesTab";
import { MemoryTab } from "./MemoryTab";
import { RunsTab } from "./RunsTab";
import { RoutinesTab } from "./RoutinesTab";
import { SkillsTab } from "./SkillsTab";
import { AgentsTab } from "./AgentsTab";
import { ChatTab } from "./ChatTab";
import { TermTab } from "./TermTab";
import { ProposalsTab } from "./ProposalsTab";
import { TodoTab } from "./TodoTab";
import { SettingsTab } from "./SettingsTab";
import { PROPOSALS_DIR } from "../data/proposals";
import { badgeText, proposalBadge, todoBadge, touchesBadges } from "../data/badges";
import { TODO_PATH, localDay } from "../data/todos";

export const VIEW_TYPE_WORKBENCH = "agentic-os-workbench";

interface RailTab { id: string; icon: string; label: string }

const RAIL: RailTab[] = [
  { id: "pulse", icon: "◉", label: "Pulse" },
  { id: "todo", icon: "☐", label: "To-Do" },
  { id: "proposals", icon: "⚖", label: "Proposals" },
  { id: "spaces", icon: "▣", label: "Spaces" },
  { id: "memory", icon: "◈", label: "Memory" },
  { id: "runs", icon: "≣", label: "Runs" },
  { id: "routines", icon: "⟳", label: "Routines" },
  { id: "skills", icon: "✦", label: "Skills" },
  { id: "agents", icon: "♟", label: "Agents" },
  { id: "chat", icon: "✎", label: "Chat" },
  { id: "term", icon: "❯_", label: "Term" },
];
/** Pinned to the rail's foot, below the scrolling tab list (spec 2026-09-24-settings-tab D1). */
const SETTINGS_TAB: RailTab = { id: "settings", icon: "⚙", label: "Settings" };

export class WorkbenchView extends ItemView {
  private plugin: AgenticOSPlugin;
  private contentHost!: HTMLElement;
  private drawerHost!: HTMLElement;
  private railEl!: HTMLElement;
  private clockTimer: number | null = null;
  private badgeEls: Record<string, HTMLElement> = {};
  private badgeTimer: number | null = null;
  private tabs: Partial<Record<string, { mount(h: HTMLElement): void; refresh(): Promise<void>; unmount(): void }>> = {};
  private activeTab = "pulse";

  constructor(leaf: WorkspaceLeaf, plugin: AgenticOSPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return VIEW_TYPE_WORKBENCH; }
  getDisplayText(): string { return "Workbench"; }
  getIcon(): string { return "layout-dashboard"; }

  getContentHost(): HTMLElement { return this.contentHost; }
  getDrawerHost(): HTMLElement { return this.drawerHost; }
  isTabActive(id: string): boolean { return this.activeTab === id; }
  getTab(id: string) { return this.tabs[id] ?? null; }

  openDrawer(title: string, build: (host: HTMLElement) => void, popOut?: () => void): void {
    this.drawerHost.empty();
    this.drawerHost.addClass("is-open");
    const head = this.drawerHost.createDiv({ cls: "aos-wb-drawerhead" });
    head.createSpan({ text: `⌜ ${title} ⌝`, cls: "aos-wb-drawertitle" });
    const actions = head.createDiv({ cls: "aos-wb-draweractions" });
    if (popOut) {
      const pop = actions.createEl("a", { text: "⧉", cls: "aos-link", href: "#", attr: { "aria-label": "Open in split" } });
      pop.addEventListener("click", (e) => { e.preventDefault(); popOut(); this.closeDrawer(); });
    }
    const close = actions.createEl("a", { text: "✕", cls: "aos-link", href: "#" });
    close.addEventListener("click", (e) => { e.preventDefault(); this.closeDrawer(); });
    build(this.drawerHost.createDiv({ cls: "aos-wb-drawerbody" }));
  }
  closeDrawer(): void { this.drawerHost.removeClass("is-open"); this.drawerHost.empty(); }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aos-root", "aos-wb");

    // top bar
    const top = root.createDiv({ cls: "aos-wb-topbar" });
    const brand = top.createSpan({ cls: "aos-wb-brand" });
    brand.createSpan({ text: "AGENTIC OS", cls: "aos-text-cyan" });
    brand.createSpan({ text: " WORKBENCH", cls: "aos-dim" });
    this.registerDomListenerClock(top.createSpan({ cls: "aos-wb-clock" }));
    const omniBtn = top.createEl("button", { cls: "aos-wb-omnibtn", text: "⌕", attr: { "aria-label": "Omnisearch" } });
    omniBtn.addEventListener("click", () => { void this.plugin.openOmni(); });

    // body: rail | content | drawer
    const body = root.createDiv({ cls: "aos-wb-body" });
    // The tab buttons scroll inside .aos-wb-railtabs so a short pane never pushes the ⚙ footer out of reach (D1).
    this.railEl = body.createDiv({ cls: "aos-wb-rail" });
    const tabsEl = this.railEl.createDiv({ cls: "aos-wb-railtabs" });
    for (const tab of RAIL) {
      if (tab.id === "chat" && !this.plugin.chatAvailable()) continue; // no provider → no Chat tab (hint lives in ChatTab.render)
      this.railButton(tabsEl, tab);
    }
    this.railButton(this.railEl.createDiv({ cls: "aos-wb-railfoot" }), SETTINGS_TAB);
    this.contentHost = body.createDiv({ cls: "aos-wb-content" });
    this.drawerHost = body.createDiv({ cls: "aos-wb-drawer" });

    this.setTab("pulse");

    // rail badges (spec 2026-09-22-todo-and-proposals-tabs D7): recomputed on any vault event under a watched
    // path, whichever tab is active — tabs are built lazily, so they cannot own this.
    const onPath = (f: TAbstractFile, oldPath?: string) => {
      if (touchesBadges(f.path) || (oldPath !== undefined && touchesBadges(oldPath))) this.scheduleBadges();
    };
    this.registerEvent(this.app.vault.on("create", (f) => onPath(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => onPath(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => onPath(f)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => onPath(f, oldPath)));
    void this.refreshBadges();
  }

  private railButton(parent: HTMLElement, tab: RailTab): void {
    const b = parent.createDiv({ cls: "aos-wb-railbtn", attr: { "data-tab": tab.id, "aria-label": tab.label, role: "button", tabindex: "0" } });
    b.createDiv({ text: tab.icon, cls: "aos-wb-railicon" });
    b.createDiv({ text: tab.label, cls: "aos-wb-raillabel" });
    this.badgeEls[tab.id] = b.createDiv({ cls: "aos-wb-railbadge is-empty" });
    b.addEventListener("click", () => this.onRailClick(tab));
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onRailClick(tab); } });
  }

  /** Shows `n` on a rail button; 0 hides the badge. */
  setBadge(id: string, n: number): void {
    const el = this.badgeEls[id];
    if (!el) return;
    el.textContent = badgeText(n);
    el.toggleClass("is-empty", el.textContent === "");
  }

  private scheduleBadges(): void {
    if (this.badgeTimer !== null) window.clearTimeout(this.badgeTimer);
    this.badgeTimer = window.setTimeout(() => { this.badgeTimer = null; void this.refreshBadges(); }, 250);
  }

  async refreshBadges(): Promise<void> {
    let files: string[] = [];
    try { files = (await this.app.vault.adapter.list(PROPOSALS_DIR)).files; } catch { /* no persona/ yet */ }
    this.setBadge("proposals", proposalBadge(files));
    let todo: string | null = null;
    try { if (await this.app.vault.adapter.exists(TODO_PATH)) todo = await this.app.vault.adapter.read(TODO_PATH); } catch { /* unreadable: no badge */ }
    this.setBadge("todo", todoBadge(todo, localDay(new Date())));
  }

  /** Opens a fresh Term session in the vault running `command`, and shows it (the Proposals tab's Review button). */
  runInTerm(command: string): void {
    let id: string | null = null;
    try {
      const sess = this.plugin.terminalPool.create({ cwd: this.plugin.vaultRoot() });
      sess.write(`${command}\r`);
      id = sess.id;
    } catch { /* no terminal support: the Term tab renders its install hint */ }
    this.setTab("term");
    if (id) (this.tabs.term as TermTab | undefined)?.showSession(id);
  }

  private registerDomListenerClock(el: HTMLElement): void {
    const tick = () => { el.textContent = new Date().toLocaleTimeString(undefined, { hour12: false }); };
    tick();
    this.clockTimer = window.setInterval(tick, 1000);
  }

  private onRailClick(tab: RailTab): void {
    this.setTab(tab.id);
  }

  private makeTab(id: string) {
    if (id === "pulse") return new PulseTab(this.plugin, this);
    if (id === "todo") return new TodoTab(this.plugin, this);
    if (id === "proposals") return new ProposalsTab(this.plugin, this);
    if (id === "spaces") return new SpacesTab(this.plugin, this);
    if (id === "memory") return new MemoryTab(this.plugin, this);
    if (id === "runs") return new RunsTab(this.plugin, this);
    if (id === "routines") return new RoutinesTab(this.plugin, this);
    if (id === "skills") return new SkillsTab(this.plugin, this);
    if (id === "agents") return new AgentsTab(this.plugin, this);
    if (id === "chat") return new ChatTab(this.plugin, this);
    if (id === "term") return new TermTab(this.plugin, this);
    if (id === "settings") return new SettingsTab(this.plugin, this);
    return null;
  }

  setTab(id: string): void {
    this.activeTab = id;
    this.railEl?.querySelectorAll(".aos-wb-railbtn").forEach((el) => {
      el.toggleClass("is-active", (el as HTMLElement).dataset.tab === id);
    });
    const tab = (this.tabs[id] ??= this.makeTab(id) ?? undefined);
    if (!tab) return;
    this.contentHost.empty();
    tab.mount(this.contentHost);
    void tab.refresh();
  }

  async onClose(): Promise<void> {
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    if (this.badgeTimer !== null) window.clearTimeout(this.badgeTimer);
    for (const tab of Object.values(this.tabs)) tab?.unmount();
    this.tabs = {};
  }
}
