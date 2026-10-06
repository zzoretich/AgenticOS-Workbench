// Page entry: builds the Obsidian-compatible App over the vault, then constructs and loads the real Workbench plugin
// from ../obsidian-plugin, exactly as Obsidian would. The page is sandboxed with no Node (phase 4): it reaches main only
// through window.aos (src/preload), and the HUD's own I/O goes through the bridge host installed here before the plugin
// loads. Main feeds it vault changes, menu commands and agenticos:// links.

import { App, Notice, guardState, setBridge, setIcon, setMarkdownHost, setWriteGuard, type PluginManifest } from "obsidian";
import AgenticOSPlugin from "@workbench/hud";
import { version as hudVersion } from "@workbench/hud-package";
import { setHudHost } from "../../../obsidian-plugin/src/host";
import { HOST_COMMANDS, type AosBridge, type ProtocolRequest, type ReadyInfo, type WriteSource } from "../shared/ipc";
import { AppSettingTab } from "./appSettingTab";
import { createBridgeHost } from "./bridgeHost";
import { PagePolicy } from "./pagePolicy";
import { attachUi } from "./setup/attach";
import { runSetup } from "./setup/wizard";
import { openPopover } from "./popover";
import { CommandPalette } from "./palette";
import * as path from "./shims/path";

/**
 * The HUD as a plugin, the manifest Obsidian read from its plugin folder. The id keys the HUD's settings
 * (<userData>/plugins/agentic-os.json, first copied from an Obsidian-era <vault>/.obsidian/plugins/agentic-os/data.json),
 * its command ids and its CSS class, so it never changes; the name is its tab in the settings window.
 */
const HUD: PluginManifest = { id: "agentic-os", name: "Agentic OS", version: hudVersion };

/**
 * The status bar's first item, shown only while $AOS_APP_WRITE narrows the writes (tests, one-off runs): READ-ONLY, or
 * which surfaces may write, with what each one writes on hover. By default every surface writes and the item is hidden.
 */
function showWriteMode(el: HTMLElement, policy: PagePolicy, source: WriteSource): void {
  el.toggleClass("is-hidden", source === "default");
  const on = policy.surfaces;
  el.toggleClass("is-writing", on.length > 0);
  el.setText(on.length ? `WRITES: ${on.map((s) => s.label).join(", ")}` : "READ-ONLY");
  const what = (s: PagePolicy["surfaces"][number]): string =>
    [...new Set([...s.writes, ...s.spawns.map((r) => r.script ?? r.bin)])].join(", ") + (s.except?.length ? ` (not ${s.except.join(", ")})` : "");
  el.setAttr("title", on.length
    ? `${on.map((s) => `${s.label}: ${what(s)}`).join("\n")}\nEverything else is refused for this run (AOS_APP_WRITE); the runtime's own background refreshes still run.`
    : "Content writes are refused for this run (AOS_APP_WRITE); the runtime's own background refreshes still run.");
}

async function boot(): Promise<void> {
  const aos = (window as unknown as { aos?: AosBridge }).aos;
  if (!aos) throw new Error("The app's bridge to the main process is missing (the preload did not run).");
  const info = aos.boot();
  const root = document.getElementById("app")!;
  if (!info) throw new Error("The main process did not answer the boot request.");
  // Before the plugin loads: the compat layer's and the HUD's every file, process and OS call go to main from here on.
  setBridge(aos);
  const bridgeHost = createBridgeHost(aos, info);
  setHudHost(bridgeHost.host);
  const policy = new PagePolicy(info.vaultRoot, info.writeSurfaces);
  setWriteGuard(policy);

  // No vault: the first-run wizard (phase 5), which ends by asking main to attach the vault it installed.
  if (!info.vaultRoot) {
    runSetup(root, aos, info);
    return;
  }

  const shellEl = root.createDiv({ cls: "aos-host" });
  const ribbonEl = shellEl.createDiv({ cls: "aos-host-ribbon" });
  const workspaceEl = shellEl.createDiv();
  const statusBarEl = root.createDiv({ cls: "aos-host-status status-bar" });
  const modeEl = statusBarEl.createDiv({ cls: "status-bar-item aos-host-mode" });
  showWriteMode(modeEl, policy, info.writeSource);

  const app = new App({
    vaultRoot: info.vaultRoot,
    workspaceEl,
    ribbonEl,
    statusBarEl,
  });
  setMarkdownHost(app);

  // The HUD keeps its own files (Obsidian's plugin folder) under <vault>/<manifest.dir>: the app's data folder instead.
  const pluginDir = path.join(info.userData, "plugins", HUD.id);
  const manifest: PluginManifest = { ...HUD, dir: path.relative(info.vaultRoot, pluginDir) };
  const plugin = new AgenticOSPlugin(app, manifest);
  await plugin.load();
  app.workspace.markLayoutReady();

  // The settings window: the app's own tab beside the one the plugin registered. It opens from ⚙ at the ribbon's
  // foot (where Obsidian has it), AgenticOS Workbench ▸ App Settings… (⌘⇧,) and the palette; ⌘, stays the
  // Workbench's Settings tab.
  app.setting.addSettingTab(new AppSettingTab(app, {
    vaultRoot: info.vaultRoot, vaultSource: info.vaultSource, userData: info.userData, appVersion: info.appVersion,
    hudVersion: manifest.version, electron: info.electron, policy: () => policy, writeSource: () => info.writeSource, aos,
  }));
  const openSettings = (): void => { if (!app.setting.isOpen) app.setting.open(); };
  app.commands.add({ id: HOST_COMMANDS.settings, name: "Open app settings", callback: openSettings });
  const gear = ribbonEl.createDiv({ cls: "side-dock-ribbon-action clickable-icon aos-host-settings", attr: { "aria-label": "App settings", title: "App settings", role: "button", tabindex: "0" } });
  setIcon(gear, "settings");
  gear.addEventListener("click", openSettings);
  gear.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSettings(); } });

  app.vault.startWatching(info.mainWatcher ? (onPaths) => bridgeHost.onVaultChanges(onPaths) : undefined);

  // One keypress could reach both the page's listener below and a menu accelerator. The same command arriving by the
  // other route within 250 ms is that same keypress and is dropped; repeats by one route always run.
  let last: { id: string; via: "key" | "menu" | "app"; at: number } = { id: "", via: "app", at: 0 };
  const runCommand = (id: string, via: "key" | "menu" | "app" = "app"): void => {
    const now = performance.now();
    const echo = id === last.id && via !== "app" && last.via !== "app" && via !== last.via && now - last.at < 250;
    last = { id, via, at: now };
    if (echo) return;
    if (id === HOST_COMMANDS.palette) new CommandPalette(app, (next) => runCommand(next)).open();
    else if (id === HOST_COMMANDS.closeTab) app.workspace.activeLeaf?.detach();
    else if (!app.commands.executeCommandById(id)) new Notice(`Unknown command: ${id}`);
  };

  const routeLink = (req: ProtocolRequest): void => {
    if (req.action === "workbench") app.handleProtocol("agenticos", req.params);
    else if (req.action === "note" && req.params.file) void app.workspace.openLinkText(req.params.file, "", true);
    else if (!app.handleProtocol(req.action, req.params)) new Notice(`Unknown link: agenticos://${req.action}`);
  };

  // Chromium offers ⌘-key presses to the page before the app menu; a handled one (preventDefault) never reaches the
  // menu, so the plugin's hotkeys, ⌘K and ⌘P fire once whether the key comes from the keyboard or from a test driver.
  // Everything else (⌘1–⌘9, ⌘W, ⌘,) falls through to the menu's accelerators.
  const hotkeys: Array<{ id: string; mod: boolean; shift: boolean; alt: boolean; key: string }> = [
    { id: "agentic-os:open-omnisearch", mod: true, shift: false, alt: false, key: "k" },
    { id: HOST_COMMANDS.palette, mod: true, shift: false, alt: false, key: "p" },
    ...app.commands.list().flatMap((c) => (c.hotkeys ?? []).map((h) => ({
      id: c.id, mod: h.modifiers.includes("Mod"), shift: h.modifiers.includes("Shift"), alt: h.modifiers.includes("Alt"), key: h.key.toLowerCase(),
    }))),
  ];
  window.addEventListener("keydown", (e) => {
    const hit = hotkeys.find((h) => h.mod === e.metaKey && h.shift === e.shiftKey && h.alt === e.altKey && !e.ctrlKey && e.key.toLowerCase() === h.key);
    if (!hit) return;
    e.preventDefault();
    runCommand(hit.id, "key");
  });

  aos.onCommand((id) => runCommand(id, "menu"));
  aos.onProtocol((req) => routeLink(req));

  runCommand("agentic-os:open-workbench");

  const ready: ReadyInfo = {
    commands: app.commands.list().map((c) => ({ id: c.id, name: c.name, hotkeys: c.hotkeys?.map((h) => ({ modifiers: [...h.modifiers], key: h.key })) })),
  };
  aos.ready(ready);

  // Attach mode (phase 5): the one-time "What changed" note, the runtime update when this app carries a newer one, and
  // the app's own update in the status bar.
  attachUi(app, aos, info.attach, statusBarEl);

  // The tray popover (hidden until the menubar icon is clicked): the plugin's SidebarHUD in a window of its own.
  void openPopover(app).catch((err: unknown) => console.warn("[host] tray popover unavailable", err));

  // A handle for the Playwright suites and for poking at the host from DevTools.
  (window as unknown as { aosHost: unknown }).aosHost = { app, plugin, info, guard: guardState(), runCommand, routeLink };
  console.info(`[host] AgenticOS HUD ${manifest.version} loaded on Electron ${info.electron}; writes ${policy.ids.join(",") || "none"} (${info.writeSource}); main watcher ${info.mainWatcher}`);
}

boot().catch((err: unknown) => {
  console.error("[host] boot failed", err);
  const pre = document.body.createEl("pre", { cls: "aos-host-fatal" });
  pre.setText(err instanceof Error ? err.stack ?? err.message : String(err));
});
