// ⌘P: every command the plugin registered, searchable, with its shortcut. Obsidian's own command palette, in the app.

import { FuzzySuggestModal, type App, type Command, type FuzzyMatch } from "obsidian";

const MOD_LABEL: Record<string, string> = { Mod: "⌘", Meta: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" };

export function hotkeyLabel(cmd: Command): string {
  const h = cmd.hotkeys?.[0];
  return h ? `${h.modifiers.map((m) => MOD_LABEL[m] ?? m).join("")}${h.key.toUpperCase()}` : "";
}

export class CommandPalette extends FuzzySuggestModal<Command> {
  constructor(app: App, private readonly run: (id: string) => void) {
    super(app);
    this.setPlaceholder("Run a command…");
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to run" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }

  getItems(): Command[] { return [...this.app.commands.list()].sort((a, b) => a.name.localeCompare(b.name)); }

  getItemText(cmd: Command): string { return cmd.name; }

  renderSuggestion(match: FuzzyMatch<Command>, el: HTMLElement): void {
    el.addClass("aos-palette-item");
    el.createSpan({ cls: "aos-palette-name", text: match.item.name });
    const hk = hotkeyLabel(match.item);
    if (hk) el.createSpan({ cls: "aos-palette-hotkey", text: hk });
  }

  onChooseItem(cmd: Command): void { this.run(cmd.id); }
}
