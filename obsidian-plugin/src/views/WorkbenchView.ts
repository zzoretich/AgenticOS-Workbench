import { ItemView, WorkspaceLeaf } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { PulseTab } from "./PulseTab";
import { SpacesTab } from "./SpacesTab";
import { MemoryTab } from "./MemoryTab";
import { RunsTab } from "./RunsTab";
import { RoutinesTab } from "./RoutinesTab";
import { ChatTab } from "./ChatTab";
import { TermTab } from "./TermTab";

export const VIEW_TYPE_WORKBENCH = "agentic-os-workbench";

interface RailTab { id: string; icon: string; label: string }

const RAIL: RailTab[] = [
  { id: "pulse", icon: "◉", label: "Pulse" },
  { id: "spaces", icon: "▣", label: "Spaces" },
  { id: "memory", icon: "◈", label: "Memory" },
  { id: "runs", icon: "≣", label: "Runs" },
  { id: "routines", icon: "⟳", label: "Routines" },
  { id: "chat", icon: "✎", label: "Chat" },
  { id: "term", icon: "❯_", label: "Term" },
];

export class WorkbenchView extends ItemView {
  private plugin: AgenticOSPlugin;
  private contentHost!: HTMLElement;
  private drawerHost!: HTMLElement;
  private railEl!: HTMLElement;
  private clockTimer: number | null = null;
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
    this.railEl = body.createDiv({ cls: "aos-wb-rail" });
    for (const tab of RAIL) {
      if (tab.id === "chat" && !this.plugin.chatAvailable()) continue; // no provider → no Chat tab (hint lives in ChatTab.render)
      const b = this.railEl.createDiv({ cls: "aos-wb-railbtn", attr: { "data-tab": tab.id, "aria-label": tab.label } });
      b.createDiv({ text: tab.icon, cls: "aos-wb-railicon" });
      b.createDiv({ text: tab.label, cls: "aos-wb-raillabel" });
      b.addEventListener("click", () => this.onRailClick(tab));
    }
    this.contentHost = body.createDiv({ cls: "aos-wb-content" });
    this.drawerHost = body.createDiv({ cls: "aos-wb-drawer" });

    this.setTab("pulse");
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
    if (id === "spaces") return new SpacesTab(this.plugin, this);
    if (id === "memory") return new MemoryTab(this.plugin, this);
    if (id === "runs") return new RunsTab(this.plugin, this);
    if (id === "routines") return new RoutinesTab(this.plugin, this);
    if (id === "chat") return new ChatTab(this.plugin, this);
    if (id === "term") return new TermTab(this.plugin, this);
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
    for (const tab of Object.values(this.tabs)) tab?.unmount();
    this.tabs = {};
  }
}
