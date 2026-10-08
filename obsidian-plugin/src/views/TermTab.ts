import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { TerminalPanel } from "../ui/TerminalPanel";

export class TermTab {
  private host: HTMLElement | null = null;
  private panel: TerminalPanel | null = null;
  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    // setTab() caches this instance (tabs[id] ??= ...) and calls mount() again
    // on every later visit to the Term tab, without ever calling our unmount()
    // in between — a panel surviving from a prior visit is left pointing at
    // contentHost DOM that WorkbenchView already wiped. Drop it before building
    // a fresh one instead of leaking its xterm/canvas instances and duplicating
    // the pool's session-add/remove/exit listeners.
    if (this.panel) { this.panel.unmount(); this.panel = null; }
    // Full pane, no drag handle; the New button launches through the view (spec 2026-10-08-term-agent-deck T3).
    this.panel = new TerminalPanel(this.plugin, { resizable: false, fullPane: true, launch: this.view.termActions() });
    this.panel.mount(host);
  }
  async refresh(): Promise<void> { this.panel?.focus(); }
  unmount(): void { this.panel?.unmount(); this.panel = null; this.host = null; }
  newSession(): void { void this.panel?.createNewSession(); }
  showSession(id: string): void { this.panel?.activate(id); }
  /** The New menu (⇧⌘T) or its New workspace sheet (⇧⌘N); `reason` says why ⌘T could not start at once. */
  openNewMenu(mode: "menu" | "create", reason: string | null = null): void { this.panel?.openNewMenu(mode, reason); }
}
