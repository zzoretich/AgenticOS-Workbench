// The app menu. Built from the plugin's own commands once the renderer reports them, so a Workbench release that adds
// a tab or a command shows up here without a change to the app.

import { Menu, shell, type MenuItemConstructorOptions } from "electron";
import { HOST_COMMANDS, type CommandInfo } from "../shared/ipc";

const WORKBENCH = "agentic-os:open-workbench";
/** ⌘1 opens the Workbench; ⌘2–⌘9 the first rail tabs, in rail order. */
const NUMBERED_TABS = ["todo", "proposals", "notifications", "spaces", "memory", "runs", "routines", "skills"];

/** Obsidian hotkey → Electron accelerator ("Mod" is ⌘ on macOS). */
export function accelerator(cmd: CommandInfo): string | undefined {
  const h = cmd.hotkeys?.[0];
  if (!h) return undefined;
  const mods = h.modifiers.map((m) => ({ Mod: "CmdOrCtrl", Ctrl: "Ctrl", Meta: "Cmd", Shift: "Shift", Alt: "Alt" } as Record<string, string>)[m]).filter(Boolean);
  return [...mods, h.key.length === 1 ? h.key.toUpperCase() : h.key].join("+");
}

function tabAccelerator(id: string): string | undefined {
  if (id === WORKBENCH) return "CmdOrCtrl+1";
  if (id === `${WORKBENCH}-settings`) return "CmdOrCtrl+,";
  const i = NUMBERED_TABS.findIndex((t) => id === `${WORKBENCH}-${t}`);
  return i >= 0 ? `CmdOrCtrl+${i + 2}` : undefined;
}

export function buildAppMenu(commands: CommandInfo[], run: (id: string) => void, opts: { dev: boolean }): Menu {
  const item = (id: string, label?: string, accel?: string): MenuItemConstructorOptions => {
    const cmd = commands.find((c) => c.id === id);
    return { label: label ?? cmd?.name ?? id, accelerator: accel ?? (cmd ? accelerator(cmd) : undefined), enabled: !!cmd || id.startsWith("host:"), click: () => run(id) };
  };
  const tabs = commands.filter((c) => c.id === WORKBENCH || c.id.startsWith(`${WORKBENCH}-`))
    .map((c) => item(c.id, c.id === WORKBENCH ? "Workbench" : c.name.replace(/^Open Workbench:\s*/, ""), tabAccelerator(c.id)));
  const others = commands.filter((c) => !c.id.startsWith(WORKBENCH))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => item(c.id));

  const template: MenuItemConstructorOptions[] = [
    {
      label: "AgenticOS",
      submenu: [
        { role: "about" },
        { type: "separator" },
        item(`${WORKBENCH}-settings`, "Settings…", "CmdOrCtrl+,"),
        item(HOST_COMMANDS.settings, "App Settings…", "CmdOrCtrl+Shift+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        item("agentic-os:open-file", "Open File…", "CmdOrCtrl+O"),
        item("agentic-os:search-vault", "Search Vault…", "CmdOrCtrl+Shift+F"),
        { type: "separator" },
        item("agentic-os:quick-capture"),
        item("agentic-os:new-terminal"),
        { type: "separator" },
        item(HOST_COMMANDS.closeTab, "Close Tab", "CmdOrCtrl+W"),
      ],
    },
    // The edit roles are what make ⌘C/⌘V/⌘A work in text fields and the terminal on macOS.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        item(HOST_COMMANDS.palette, "Command Palette…", "CmdOrCtrl+P"),
        item("agentic-os:open-omnisearch", "Search…", "CmdOrCtrl+K"),
        { type: "separator" },
        ...(tabs.length ? tabs : [{ label: "Workbench", enabled: false } as MenuItemConstructorOptions]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(opts.dev ? [{ type: "separator" } as MenuItemConstructorOptions, { role: "reload" } as MenuItemConstructorOptions, { role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
      ],
    },
    { label: "Commands", submenu: others.length ? others : [{ label: "Loading…", enabled: false }] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "AgenticOS Workbench on GitHub", click: () => void shell.openExternal("https://github.com/zzoretich/AgenticOS-Workbench") }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
