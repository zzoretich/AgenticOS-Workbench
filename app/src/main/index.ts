// Main process: the Workbench window, the menubar item, the app menu, agenticos:// links and the vault watcher. The app
// attaches to the vault an existing AgenticOS install uses (agenticos.json). Main writes nothing outside its own
// userData but one file, the app's record in the vault's runtime cache (hud-host.ts); the HUD's writes to the vault are
// the renderer's, within the write surfaces (write-policy.ts).

import { app, BrowserWindow, ipcMain, Menu, screen, shell, type IpcMainEvent, type Rectangle } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_ORIGIN, CH, POPOVER, type BootInfo, type CommandInfo, type ProtocolRequest } from "../shared/ipc";
import { registerAppScheme, serveAppScheme } from "./app-scheme";
import { writeHudHostMarker } from "./hud-host";
import { buildAppMenu } from "./menu";
import { SCHEME, parseAgenticosUrl, urlFromArgv } from "./protocol";
import { STATUSLINE_PATH, StatusTray } from "./tray";
import { VaultWatcher } from "./watcher";
import { loadWindowState, trackWindowState } from "./window-state";
import { loadWriteSettings } from "./write-settings";

export type { BootInfo };

/** Links the HUD may hand to the OS: web pages over https, and "Open in Obsidian". */
const EXTERNAL_ALLOW = [/^https:\/\//i, /^obsidian:\/\//i];

function openExternalSafe(url: string): void {
  if (EXTERNAL_ALLOW.some((re) => re.test(url))) void shell.openExternal(url);
  else console.warn(`[main] refused to open ${url}`);
}

/** The vault an existing install points at: $AOS_APP_VAULT, else agenticos.json's `vault` (the launcher's lookup). */
function resolveVault(): { root: string | null; source: string } {
  if (process.env.AOS_APP_VAULT) return { root: process.env.AOS_APP_VAULT, source: "AOS_APP_VAULT" };
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const cfg = process.env.AOS_CONFIG || path.join(configDir, "agenticos.json");
  try {
    const vault = (JSON.parse(fs.readFileSync(cfg, "utf8")) as { vault?: string }).vault;
    if (vault && fs.existsSync(vault)) return { root: vault, source: cfg };
  } catch { /* no install */ }
  return { root: null, source: cfg };
}

const dev = !app.isPackaged;
// The app's name is package.json's productName (D9: AgenticOS Workbench). A dev run keeps its data apart from the
// packaged app's, so the two can run side by side; tests point it at a temp folder.
app.setPath("userData", process.env.AOS_APP_USER_DATA || path.join(app.getPath("appData"), dev ? "AgenticOS Workbench (dev)" : "AgenticOS Workbench"));
// The app's page comes from app://hud (app-scheme.ts), which must be registered before `ready`.
registerAppScheme();

const vault = resolveVault();
const writes = loadWriteSettings();
const boot: BootInfo = {
  vaultRoot: vault.root,
  vaultSource: vault.source,
  userData: app.getPath("userData"),
  writeSurfaces: writes.surfaces,
  writeSource: writes.source,
  mainWatcher: !!vault.root,
  appVersion: app.getVersion(),
  electron: process.versions.electron,
};

let win: BrowserWindow | null = null;
let tray: StatusTray | null = null;
let watcher: VaultWatcher | null = null;
let quitting = false;
let rendererReady = false;
let commands: CommandInfo[] = [];
const pendingLinks: ProtocolRequest[] = [];

/** Only our own page, in our own window's main frame, may talk to main. */
function trusted(e: IpcMainEvent): boolean {
  return !!win && e.sender === win.webContents && e.senderFrame === e.sender.mainFrame;
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── the tray popover ─────────────────────────────────────────────────

const POPOVER_SIZE = { width: 380, height: 640 };
const POPOVER_OPTIONS: Electron.BrowserWindowConstructorOptions = {
  ...POPOVER_SIZE, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
  fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#0a0e14", title: "AgenticOS",
};
let popover: BrowserWindow | null = null;

/** Shows the popover under the tray icon (or hides it). False when there is none yet: the tray shows its menu. */
function togglePopover(anchor: Rectangle): boolean {
  if (!popover || popover.isDestroyed()) return false;
  if (popover.isVisible()) { popover.hide(); return true; }
  const area = screen.getDisplayMatching(anchor).workArea;
  const x = Math.round(Math.min(Math.max(anchor.x + anchor.width / 2 - POPOVER_SIZE.width / 2, area.x + 4), area.x + area.width - POPOVER_SIZE.width - 4));
  // Under a menubar icon; above one in a bottom bar.
  const below = anchor.y < area.y + area.height / 2;
  const y = Math.round(below ? Math.max(anchor.y + anchor.height + 4, area.y) : anchor.y - POPOVER_SIZE.height - 4);
  popover.setPosition(x, y);
  popover.show();
  popover.focus();
  return true;
}

function show(): void {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function runCommand(id: string): void {
  show();
  send(CH.command, id);
}

function openLink(url: string): void {
  const req = parseAgenticosUrl(url);
  if (!req) { console.warn(`[main] ignored link ${url}`); return; }
  show();
  if (rendererReady) send(CH.protocol, req);
  else pendingLinks.push(req);
}

function setMenu(): void {
  Menu.setApplicationMenu(buildAppMenu(commands, runCommand, { dev }));
}

function validCommands(raw: unknown): CommandInfo[] {
  const list = (raw as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is CommandInfo => !!c && typeof c.id === "string" && typeof c.name === "string" && c.id.length < 120 && c.name.length < 200)
    .slice(0, 500)
    .map((c) => ({
      id: c.id,
      name: c.name,
      hotkeys: Array.isArray(c.hotkeys)
        ? c.hotkeys.filter((h) => h && Array.isArray(h.modifiers) && typeof h.key === "string").map((h) => ({ modifiers: h.modifiers.map(String), key: h.key }))
        : undefined,
    }));
}

ipcMain.on(CH.boot, (e) => { e.returnValue = trusted(e) ? boot : null; });

ipcMain.on(CH.ready, (e, info: unknown) => {
  if (!trusted(e)) return;
  rendererReady = true;
  commands = validCommands(info);
  setMenu();
  for (const req of pendingLinks.splice(0)) send(CH.protocol, req);
});

function createWindow(): void {
  const state = loadWindowState(app.getPath("userData"));
  rendererReady = false;
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0a0e14",
    title: "AgenticOS",
    show: false,
    webPreferences: {
      // Stage 1 (PLAN.md §4): the re-hosted HUD reads the vault and spawns the runtime from the renderer, as it does
      // inside Obsidian. The mitigations are the CSP in index.html, DOMPurify on all Markdown, blocked navigation and
      // new windows, the https allow-list above, and the renderer's write guards. Phase 4 moves this I/O behind a
      // sandboxed, typed bridge.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      // The tray popover's SidebarHUD runs in this renderer (renderer/popover.ts): keep it drawing while hidden.
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();
  trackWindowState(win, app.getPath("userData"));
  // One child window is allowed: the tray popover, opened blank by the renderer, which fills it itself. Anything else
  // a page tries to open goes to the OS (https only) or nowhere.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === POPOVER && url === "about:blank") return { action: "allow", overrideBrowserWindowOptions: POPOVER_OPTIONS };
    openExternalSafe(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child, { frameName }) => {
    if (frameName !== POPOVER) { child.destroy(); return; }
    popover = child;
    child.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: "deny" }; });
    child.webContents.on("will-navigate", (e, url) => { e.preventDefault(); openExternalSafe(url); });
    child.on("blur", () => { if (!child.webContents.isDevToolsOpened()) child.hide(); });
    child.on("close", (e) => { if (!quitting) { e.preventDefault(); child.hide(); } });
    child.on("closed", () => { if (popover === child) popover = null; });
  });
  win.webContents.on("will-navigate", (e, url) => { e.preventDefault(); openExternalSafe(url); });
  // Deny every permission except writing to the clipboard (the HUD's ⧉ copy buttons), which Obsidian allows too.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
  win.webContents.on("render-process-gone", (_e, d) => console.error(`[main] renderer gone: ${d.reason}`));
  // Closing the window hides it, as closing Obsidian's window would not stop a HUD you left running; ⌘Q quits.
  win.on("close", (e) => { if (!quitting && process.platform === "darwin") { e.preventDefault(); win?.hide(); } });
  win.on("closed", () => { win = null; rendererReady = false; });
  win.once("ready-to-show", () => win?.show());
  void win.loadURL(`${APP_ORIGIN}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Registered before `ready`: macOS delivers a link that launched the app through this event.
  app.on("open-url", (e, url) => { e.preventDefault(); openLink(url); });
  app.on("second-instance", (_e, argv) => { const url = urlFromArgv(argv); if (url) openLink(url); else show(); });
  app.on("activate", () => show());
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("will-quit", () => { watcher?.stop(); tray?.destroy(); });

  void app.whenReady().then(() => {
    // Only a packaged, signed app claims the scheme; a dev run must not re-point the system's agenticos:// handler.
    if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME);
    serveAppScheme(path.join(__dirname, "../renderer"));
    setMenu();
    createWindow();
    if (vault.root) {
      const root = vault.root;
      // D11: tell the runtime which app this vault is used with (doctor's `workbench app` row, the update check). A
      // vault the app cannot write to still opens: the record is informational.
      try { writeHudHostMarker(root, { name: app.getName(), version: app.getVersion() }); }
      catch (err) { console.warn(`[main] could not record the app in ${root}: ${err instanceof Error ? err.message : String(err)}`); }
      tray = new StatusTray(root, {
        openTab: (tab) => runCommand(tab === "pulse" ? "agentic-os:open-workbench" : `agentic-os:open-workbench-${tab}`),
        openFile: (rel) => openLink(`${SCHEME}://note?file=${encodeURIComponent(rel)}`),
        command: runCommand,
        show,
        togglePopover,
      });
      watcher = new VaultWatcher(root, (paths) => {
        send(CH.vaultChanges, { paths });
        if (paths.includes(STATUSLINE_PATH)) tray?.refresh();
      });
      watcher.start();
    }
    const cold = urlFromArgv(process.argv);
    if (cold) openLink(cold);
  });
}

// For tests and the spike driver (reached through Playwright's electronApp.evaluate, never from the renderer).
(globalThis as Record<string, unknown>).__aosMain = {
  openLink, runCommand, tray: () => tray?.state() ?? null,
  togglePopover: () => togglePopover({ x: 0, y: 0, width: 0, height: 0 }),
  popoverVisible: () => !!popover && !popover.isDestroyed() && popover.isVisible(),
};
