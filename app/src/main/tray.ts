// The menubar item. Its title is the HUD's own status-line model (barSegments over brain/_index/statusline.json, the
// same code the Workbench status bar runs), so it always agrees with the window, and it stays up with the window closed.

import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATUSLINE_PATH, barSegments, parseStatusline, type BarSegment } from "../../../obsidian-plugin/src/data/statusline";

export { STATUSLINE_PATH };

export interface TrayActions {
  openTab(tab: string): void;
  openFile(rel: string): void;
  command(id: string): void;
  show(): void;
  /** Toggles the SidebarHUD popover under the icon; false when there is none yet. */
  togglePopover?(anchor: Electron.Rectangle): boolean;
}

const MAX_SEGMENT = 26;

/** The menubar title: a mark, then the two most important segments. Dim ones (drafts) stay in the menu. */
export function trayTitle(segments: readonly BarSegment[]): string {
  const top = segments.filter((s) => s.tone !== "dim").slice(0, 2)
    .map((s) => (s.text.length > MAX_SEGMENT ? `${s.text.slice(0, MAX_SEGMENT - 1)}…` : s.text));
  return top.length ? `◉ ${top.join(" · ")}` : "◉";
}

export class StatusTray {
  private readonly tray: Tray;
  private segments: BarSegment[] = [];
  private title = "◉";
  private contextMenu: Menu | null = null;

  constructor(private readonly vaultRoot: string, private readonly actions: TrayActions) {
    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setToolTip("AgenticOS");
    // A click opens the SidebarHUD popover; a right-click (or a click before the popover exists) the menu. The menu is
    // popped up by hand: set as the context menu, macOS would open it on every click.
    this.tray.on("click", (_e, bounds) => { if (!this.actions.togglePopover?.(bounds)) this.popUpMenu(); });
    this.tray.on("right-click", () => this.popUpMenu());
    this.refresh();
  }

  private popUpMenu(): void { if (this.contextMenu) this.tray.popUpContextMenu(this.contextMenu); }

  refresh(): void {
    let raw: string | null = null;
    try { raw = fs.readFileSync(path.join(this.vaultRoot, STATUSLINE_PATH), "utf8"); } catch { raw = null; }
    const model = parseStatusline(raw);
    this.segments = model ? barSegments(model) : [];
    this.title = trayTitle(this.segments);
    this.tray.setTitle(this.title, { fontType: "monospacedDigit" });
    this.contextMenu = Menu.buildFromTemplate(this.menu());
  }

  /** What the tray shows, for tests. */
  state(): { title: string; segments: string[] } {
    return { title: this.title, segments: this.segments.map((s) => s.text) };
  }

  destroy(): void { this.tray.destroy(); }

  private menu(): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = this.segments.length
      ? this.segments.map((s) => ({
          label: s.text,
          toolTip: s.title,
          click: () => (s.tab ? this.actions.openTab(s.tab) : s.file ? this.actions.openFile(s.file) : this.actions.show()),
        }))
      : [{ label: "All clear", enabled: false }];
    return [
      { label: "AgenticOS", enabled: false },
      ...items,
      { type: "separator" },
      { label: "Open Workbench", click: () => this.actions.command("agentic-os:open-workbench") },
      { label: "Quick Capture…", click: () => this.actions.command("agentic-os:quick-capture") },
      { label: "Sidebar HUD", click: () => this.actions.command("agentic-os:open-sidebar-hud") },
      { type: "separator" },
      { label: `Quit ${app.name}`, role: "quit" },
    ];
  }
}
