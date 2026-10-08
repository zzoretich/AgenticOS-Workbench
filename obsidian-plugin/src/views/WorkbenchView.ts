import { ItemView, TAbstractFile, WorkspaceLeaf, setIcon } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { PulseTab } from "./PulseTab";
import { SpacesTab } from "./SpacesTab";
import { MemoryTab } from "./MemoryTab";
import { FilesTab } from "./FilesTab";
import { RunsTab } from "./RunsTab";
import { RoutinesTab } from "./RoutinesTab";
import { SkillsTab } from "./SkillsTab";
import { AgentsTab } from "./AgentsTab";
import { SessionsTab } from "./SessionsTab";
import { TermTab } from "./TermTab";
import { ProposalsTab } from "./ProposalsTab";
import { TodoTab } from "./TodoTab";
import { SettingsTab } from "./SettingsTab";
import { NotificationsTab } from "./NotificationsTab";
import { AgentTeamsTab } from "./AgentTeamsTab";
import { PROPOSALS_DIR } from "../data/proposals";
import { NOTIFICATIONS_DIR, STATE_PATH, notificationId, parseNotification, parseState, unreadBadge, Level } from "../data/notifications";
import { badgeText, proposalBadge, todoBadge, touchesBadges } from "../data/badges";
import { TODO_PATH, localDay } from "../data/todos";
import { readTeams, diskAdapter, gateBadge } from "../data/teams";
import { CaptureModal } from "../ui/CaptureModal";
import { HOST_APP_SETTINGS, HOST_TOGGLE_THEME, runHostCommand } from "../ui/hostCommands";
import { currentTheme, onThemeChange } from "../ui/theme";
import type { NewTerminalActions } from "../ui/NewTerminalMenu";
import { TERM_HOST_LABEL, isContextPlace, placeOf, workspacePlace, type Place, type TermHost } from "../data/terminalLaunch";

export const VIEW_TYPE_WORKBENCH = "agentic-os-workbench";

/** A rail button: its tab id, its lucide icon, and the name its tooltip and screen readers give. */
interface RailTab { id: string; icon: string; label: string }

/** The rail (UniDeX D3): Sessions first, as the Home tab when a provider is set up (D5), then every other tab. Sessions
 *  keeps the id "chat" it had as the Chat tab, so links and commands that name it still open it. */
const RAIL: RailTab[] = [
  { id: "chat", icon: "message-square", label: "Sessions" },
  { id: "pulse", icon: "activity", label: "Pulse" },
  { id: "files", icon: "file-text", label: "Files" },
  { id: "todo", icon: "square-check", label: "To-Do" },
  { id: "proposals", icon: "inbox", label: "Proposals" },
  { id: "notifications", icon: "bell", label: "Notifications" },
  { id: "spaces", icon: "folder", label: "Spaces" },
  { id: "memory", icon: "brain", label: "Memory" },
  { id: "runs", icon: "list", label: "Runs" },
  { id: "routines", icon: "repeat", label: "Routines" },
  { id: "skills", icon: "sparkles", label: "Skills" },
  { id: "agents", icon: "bot", label: "Agents" },
  { id: "agent-teams", icon: "users", label: "Agent Teams" },
  { id: "term", icon: "terminal", label: "Term" },
];
/** Pinned to the rail's foot, below the scrolling tab list (spec 2026-09-24-settings-tab D1). */
const SETTINGS_TAB: RailTab = { id: "settings", icon: "settings", label: "Settings" };

/** The Line UDX mark (UniDeX D10): one stroke weight with round ends, drawn in the text colour. */
const MARK_PATH = "M6 6V26a14 14 0 0 0 28 0V6 M48 6V40H60a17 17 0 0 0 0-34H48Z M92 6L124 40 M124 6L92 40";
/** Every tab id setTab() can build: what an agenticos://workbench?tab=<id> link may name (statusline spec D10). */
export const WORKBENCH_TAB_IDS: readonly string[] = [...RAIL.map((t) => t.id), SETTINGS_TAB.id];

export class WorkbenchView extends ItemView {
  private plugin: AgenticOSPlugin;
  private contentHost!: HTMLElement;
  private drawerHost!: HTMLElement;
  private railEl!: HTMLElement;
  private badgeEls: Record<string, HTMLElement> = {};
  private badgeTimer: number | null = null;
  private teamsReads = 0;
  private teamsShown = 0;
  private tabs: Partial<Record<string, { mount(h: HTMLElement): void; refresh(): Promise<void>; unmount(): void }>> = {};
  private activeTab = "pulse";
  private unwatchTheme: (() => void) | null = null;

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
    head.createSpan({ text: title, cls: "aos-wb-drawertitle" });
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

    // body: rail | content | drawer. No top bar (UniDeX D3): the mark, search and capture head the rail.
    const body = root.createDiv({ cls: "aos-wb-body" });
    this.railEl = body.createDiv({ cls: "aos-wb-rail" });
    const head = this.railEl.createDiv({ cls: "aos-wb-railhead" });
    this.railMark(head);
    this.railAction(head, { action: "search", icon: "search", label: "Search (⌘K)" }, () => { void this.plugin.openOmni(); });
    this.railAction(head, { action: "capture", icon: "plus", label: "Quick Capture" }, () => { new CaptureModal(this.app).open(); });
    // The tab buttons scroll inside .aos-wb-railtabs so a short pane never pushes the ⚙ footer out of reach (D1).
    const tabsEl = this.railEl.createDiv({ cls: "aos-wb-railtabs" });
    for (const tab of RAIL) {
      if (tab.id === "chat" && !this.plugin.chatAvailable()) continue; // no provider → no Sessions tab (hint lives in ChatTab.render)
      this.railButton(tabsEl, tab);
    }
    const foot = this.railEl.createDiv({ cls: "aos-wb-railfoot" });
    const theme = this.railAction(foot, { action: "theme", icon: "moon", label: "Switch to dark" }, () => { runHostCommand(this.app, HOST_TOGGLE_THEME); });
    const showTheme = (): void => {
      const dark = currentTheme(theme.ownerDocument) === "dark";
      setIcon(theme, dark ? "sun" : "moon");
      const label = dark ? "Switch to light" : "Switch to dark";
      theme.setAttr("aria-label", label);
      theme.setAttr("title", label);
    };
    showTheme();
    this.unwatchTheme = onThemeChange(showTheme, theme.ownerDocument);
    this.railAction(foot, { action: "app-settings", icon: "monitor-cog", label: "App settings" }, () => { runHostCommand(this.app, HOST_APP_SETTINGS); });
    this.railButton(foot, SETTINGS_TAB);
    this.contentHost = body.createDiv({ cls: "aos-wb-content" });
    this.drawerHost = body.createDiv({ cls: "aos-wb-drawer" });

    this.setTab(this.homeTab());

    // rail badges (spec 2026-09-22-todo-and-proposals-tabs D7): recomputed on any vault event under a watched
    // path, whichever tab is active — tabs are built lazily, so they cannot own this.
    const onPath = (f: TAbstractFile, oldPath?: string) => {
      if (touchesBadges(f.path) || (oldPath !== undefined && touchesBadges(oldPath))) this.scheduleBadges();
    };
    this.registerEvent(this.app.vault.on("create", (f) => onPath(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => onPath(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => onPath(f)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => onPath(f, oldPath)));
    // A vault root outside Obsidian sends no vault events, so the gate badge is also recounted once a minute.
    this.registerInterval(window.setInterval(() => void this.refreshTeamsBadge(), 60_000));
    void this.refreshBadges();
  }

  /** Home (UniDeX D5): Sessions when a provider is set up, else Pulse. */
  homeTab(): string { return this.plugin.chatAvailable() ? "chat" : "pulse"; }

  /** The mark at the rail's head: it opens Home. */
  private railMark(parent: HTMLElement): void {
    const b = parent.createDiv({ cls: "aos-wb-mark", attr: { "aria-label": "Home", title: "Home", role: "button", tabindex: "0" } });
    const NS = "http://www.w3.org/2000/svg";
    const svg = b.ownerDocument.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 130 46");
    svg.setAttribute("aria-hidden", "true");
    const path = b.ownerDocument.createElementNS(NS, "path");
    path.setAttribute("d", MARK_PATH);
    svg.appendChild(path);
    b.appendChild(svg);
    const go = (): void => this.setTab(this.homeTab());
    b.addEventListener("click", go);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }

  /** A rail button that runs something rather than opening a tab. */
  private railAction(parent: HTMLElement, a: { action: string; icon: string; label: string }, run: () => void): HTMLElement {
    const b = parent.createDiv({ cls: "aos-wb-railact", attr: { "data-action": a.action, "aria-label": a.label, title: a.label, role: "button", tabindex: "0" } });
    setIcon(b, a.icon);
    b.addEventListener("click", run);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
    return b;
  }

  private railButton(parent: HTMLElement, tab: RailTab): void {
    const b = parent.createDiv({ cls: "aos-wb-railbtn", attr: { "data-tab": tab.id, "aria-label": tab.label, title: tab.label, role: "button", tabindex: "0" } });
    const icon = b.createDiv({ cls: "aos-wb-railicon" });
    setIcon(icon, tab.icon);
    b.createDiv({ text: tab.label, cls: "aos-wb-raillabel" });
    this.badgeEls[tab.id] = b.createDiv({ cls: "aos-wb-railbadge is-empty" });
    b.addEventListener("click", () => this.onRailClick(tab));
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onRailClick(tab); } });
  }

  /** Shows `n` on a rail button; 0 hides the badge. `urgent` paints it rose (an unread breaking notification). */
  setBadge(id: string, n: number, urgent = false): void {
    const el = this.badgeEls[id];
    if (!el) return;
    el.textContent = badgeText(n);
    el.toggleClass("is-empty", el.textContent === "");
    el.toggleClass("is-urgent", urgent && el.textContent !== "");
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
    const n = await this.notificationBadge();
    this.setBadge("notifications", n.count, n.breaking);
    await this.refreshTeamsBadge();
  }

  /** Gates waiting on the user across every team (spec 2026-09-28-agent-teams-design D12), read from boards only, in the
   *  vault `aos team` writes: the plugin's vault root, which need not be the open Obsidian vault. */
  private async refreshTeamsBadge(): Promise<void> {
    const seq = this.nextTeamsRead();
    try { this.setTeamsBadge(gateBadge(await readTeams(diskAdapter(this.plugin.vaultRoot()), { boardOnly: true })), seq); } catch { /* unreadable: no badge */ }
  }

  /** Team reads (this view's and the tab's) overlap: each takes a number when it starts, and a count from a read that
   *  started before the one already shown is dropped, so the badge never goes back to an older count. */
  nextTeamsRead(): number { return ++this.teamsReads; }
  setTeamsBadge(n: number, seq: number): void {
    if (seq < this.teamsShown) return;
    this.teamsShown = seq;
    this.setBadge("agent-teams", n);
  }

  /** Unread notifications (spec 2026-09-24-notifications-design §4.3). Reads state.json and only the unread item files,
   *  newest first and at most 200, for the breaking flag; the count itself needs file names alone. */
  private async notificationBadge(): Promise<{ count: number; breaking: boolean }> {
    const a = this.app.vault.adapter;
    try {
      const state = parseState((await a.exists(STATE_PATH)) ? await a.read(STATE_PATH) : null);
      const years = (await a.list(NOTIFICATIONS_DIR)).folders.filter((f) => /\/\d{4}$/.test(f));
      const unread: string[] = [];
      for (const y of years) {
        for (const f of (await a.list(y)).files) {
          const id = notificationId(f);
          if (id && !state[id]?.read && !state[id]?.archived) unread.push(f);
        }
      }
      unread.sort().reverse();
      const rows: { level: Level; read: boolean; archived: boolean }[] = [];
      for (const f of unread.slice(0, 200)) {
        try { const n = parseNotification(f, await a.read(f)); if (n) rows.push({ level: n.level, read: false, archived: false }); } catch { /* gone */ }
      }
      const b = unreadBadge(rows);
      return { count: b.count + Math.max(0, unread.length - 200), breaking: b.breaking };
    } catch { return { count: 0, breaking: false }; }   // no brain/notifications yet
  }

  /** Runs `command` in a new Term session in the vault and shows it (Skills, Agents, Proposals, Notifications, Agent
   *  Teams, Settings). `host` is the agent the command starts, for its dot in the list; `origin` is the row's subtitle.
   *  False when no session could start (the Term tab then shows its install hint), so a caller whose command must not
   *  be lost can say so. */
  runInTerm(command: string, o: { host?: TermHost; origin?: string } = {}): boolean {
    let id: string | null = null;
    try {
      const vault = this.plugin.vaultRoot();
      const sess = this.plugin.terminalPool.create({
        cwd: vault,
        meta: { host: o.host ?? "shell", origin: o.origin ?? null, place: placeOf(vault, this.plugin.termLauncher.world()), label: o.host && o.host !== "shell" ? null : command },
      });
      sess.write(`${command}\r`);
      id = sess.id;
      this.plugin.terminalPool.select(id);
    } catch { /* no terminal support: the Term tab renders its install hint */ }
    this.setTab("term");
    if (id) (this.tabs.term as TermTab | undefined)?.showSession(id);
    return id !== null;
  }

  // ── starting terminals from the deck (spec 2026-10-08-term-agent-deck T2–T6) ──

  /** What the New button, its menu and the shortcuts start through. */
  termActions(): NewTerminalActions {
    return {
      start: (req) => this.launchTerminal(req.host, { picked: req.picked ?? null, resume: req.resume ?? null }),
      create: (name, host, gitInit) => this.createWorkspaceAndLaunch(name, host, gitInit),
      context: () => this.termContext(),
    };
  }

  /** What you are looking at, for a launch (T4): the selected terminal's workspace or Scratch while Term is shown, or
   *  the workspace open in Spaces. Anything else (the vault, home, another folder, another tab) is no context. */
  termContext(): Place | null {
    const launcher = this.plugin.termLauncher;
    if (this.activeTab === "term") {
      const pool = this.plugin.terminalPool;
      const s = pool.get(pool.selectedId() ?? "");
      if (!s) return null;
      const p = s.meta.place ?? placeOf(s.cwd, launcher.world());
      return isContextPlace(p) ? p : null;
    }
    if (this.activeTab === "spaces") {
      const name = (this.tabs.spaces as SpacesTab | undefined)?.selectedWorkspace() ?? null;
      const w = launcher.world();
      return name && w.workspaces.includes(name) ? workspacePlace(name, w) : null;
    }
    return null;
  }

  /** Starts `host` ("quick": the one ⌘T starts) and shows it. A host that is not ready opens the menu with why. */
  async launchTerminal(host: TermHost | "quick", o: { picked?: Place | null; resume?: "last" | null } = {}): Promise<void> {
    const launcher = this.plugin.termLauncher;
    const context = this.termContext();
    let h: TermHost;
    if (host === "quick") {
      const q = launcher.quickHost();
      if (!q.host) { this.openTermMenu("menu", q.reason); return; }
      h = q.host;
    } else h = host;
    const choice = launcher.choices().find((c) => c.host === h);
    if (!choice || choice.hidden) throw new Error(`${TERM_HOST_LABEL[h]} is off on this Mac: run aos init --host ${h}`);
    if (!choice.ready) { this.openTermMenu("menu", choice.reason); return; }
    await launcher.launch({ host: h, picked: o.picked ?? null, context, resume: o.resume ?? null });
    if (this.activeTab !== "term") this.setTab("term");
  }

  /** Makes a workspace and starts `host` there (T6), then shows it. */
  async createWorkspaceAndLaunch(name: string, host: TermHost, gitInit: boolean): Promise<void> {
    await this.plugin.termLauncher.createAndLaunch(name, host, gitInit);
    if (this.activeTab !== "term") this.setTab("term");
  }

  /** Shows Term and opens its New menu (⇧⌘T), or the New workspace sheet (⇧⌘N). */
  openTermMenu(mode: "menu" | "create", reason: string | null = null): void {
    if (this.activeTab !== "term") this.setTab("term");
    (this.tabs.term as TermTab | undefined)?.openNewMenu(mode, reason);
  }

  private onRailClick(tab: RailTab): void {
    this.setTab(tab.id);
  }

  private makeTab(id: string) {
    if (id === "pulse") return new PulseTab(this.plugin, this);
    if (id === "files") return new FilesTab(this.plugin, this);
    if (id === "todo") return new TodoTab(this.plugin, this);
    if (id === "proposals") return new ProposalsTab(this.plugin, this);
    if (id === "notifications") return new NotificationsTab(this.plugin, this);
    if (id === "spaces") return new SpacesTab(this.plugin, this);
    if (id === "memory") return new MemoryTab(this.plugin, this);
    if (id === "runs") return new RunsTab(this.plugin, this);
    if (id === "routines") return new RoutinesTab(this.plugin, this);
    if (id === "skills") return new SkillsTab(this.plugin, this);
    if (id === "agents") return new AgentsTab(this.plugin, this);
    if (id === "agent-teams") return new AgentTeamsTab(this.plugin, this);
    if (id === "chat") return new SessionsTab(this.plugin, this);
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
    this.unwatchTheme?.();
    this.unwatchTheme = null;
    if (this.badgeTimer !== null) window.clearTimeout(this.badgeTimer);
    for (const tab of Object.values(this.tabs)) tab?.unmount();
    this.tabs = {};
  }
}
