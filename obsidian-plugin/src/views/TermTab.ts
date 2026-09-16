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
    // Mirrors the old standalone Terminal view's onOpen() construction verbatim (fullPane, no drag handle).
    this.panel = new TerminalPanel(this.plugin, { resizable: false, fullPane: true });
    this.panel.mount(host);
  }
  async refresh(): Promise<void> { this.panel?.focus(); }
  unmount(): void { this.panel?.unmount(); this.panel = null; this.host = null; }
  newSession(): void { this.panel?.createNewSession(); }
}
