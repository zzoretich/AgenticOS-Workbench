// Phase 0 driver: launches the built app against the vault, visits every Workbench tab plus the sidebar HUD, the ⌘K
// palette and a note, and records screenshots, renderer errors and every write or spawn the read-only guard refused.
// Output lands in spike-output/ (gitignored: it holds vault content).

import { _electron as electron } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.SPIKE_OUT || path.join(root, "spike-output");
mkdirSync(out, { recursive: true });

const TABS = ["pulse", "todo", "proposals", "notifications", "spaces", "memory", "runs", "routines", "skills", "agents", "agent-teams", "chat", "term", "settings"];
const events = [];
const note = (kind, text) => events.push({ at: new Date().toISOString(), kind, text });

const app = await electron.launch({ args: [root], cwd: root, timeout: 60_000 });
const win = await app.firstWindow();
win.on("console", (m) => note(m.type(), m.text()));
win.on("pageerror", (e) => note("pageerror", `${e.message}\n${e.stack ?? ""}`));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.setContentSize(1480, 920));

const t0 = Date.now();
await win.waitForSelector(".aos-wb-railbtn", { timeout: 30_000 });
const bootMs = Date.now() - t0;
await win.waitForTimeout(1500);

const tabs = [];
for (const id of TABS) {
  const btn = win.locator(`.aos-wb-railbtn[data-tab="${id}"]`);
  if ((await btn.count()) === 0) { tabs.push({ id, present: false }); continue; }
  const before = events.filter((e) => e.kind === "pageerror" || e.kind === "error").length;
  await btn.click();
  await win.waitForTimeout(1800);
  await win.screenshot({ path: path.join(out, `tab-${id}.png`) });
  const textLen = await win.evaluate(() => document.querySelector(".aos-wb-content")?.textContent?.trim().length ?? 0);
  const errors = events.filter((e) => e.kind === "pageerror" || e.kind === "error").slice(before).map((e) => e.text.split("\n")[0]);
  tabs.push({ id, present: true, textLen, errors });
}

async function shot(name, fn, wait = 1500) {
  try { await fn(); await win.waitForTimeout(wait); await win.screenshot({ path: path.join(out, `${name}.png`) }); return "ok"; }
  catch (err) { return `failed: ${String(err).split("\n")[0]}`; }
}

const extras = {};
extras.sidebar = await shot("sidebar-hud", () => win.evaluate(() => window.aosHost.app.commands.executeCommandById("agentic-os:open-sidebar-hud")));
extras.omni = await shot("omnisearch", async () => { await win.evaluate(() => window.aosHost.app.commands.executeCommandById("agentic-os:open-omnisearch")); await win.waitForTimeout(800); await win.keyboard.type("memory"); });
await win.keyboard.press("Escape");
extras.note = await shot("note-view", () => win.evaluate(() => window.aosHost.app.workspace.openLinkText("MEMORY", "", true)));
// A plain Markdown link in a note opens the linked vault file in the same tab, as in Obsidian.
extras.noteLink = await shot("note-link", () => win.click(".aos-note-body a.internal-link >> nth=0"));
extras.noteLinkTab = await win.evaluate(() => document.querySelector(".aos-host-tab.is-active .aos-host-tab-title")?.textContent ?? null);

// Phase 1 host features: palette, agenticos:// links, tray, menu, and vault events from the main-process watcher.
extras.palette = await shot("command-palette", async () => { await win.evaluate(() => window.aosHost.runCommand("host:palette")); await win.waitForTimeout(500); await win.keyboard.type("routines"); });
await win.keyboard.press("Escape");
await win.evaluate(() => { window.__aosEvents = { modify: 0, create: 0, delete: 0 }; for (const k of ["modify", "create", "delete"]) window.aosHost.app.vault.on(k, () => { window.__aosEvents[k] += 1; }); });
extras.link = await shot("link-proposals", () => app.evaluate(() => globalThis.__aosMain.openLink("agenticos://workbench?tab=proposals")));
extras.linkTab = await win.evaluate(() => document.querySelector(".aos-wb-railbtn.is-active, .aos-wb-railbtn.active")?.getAttribute("data-tab") ?? document.querySelector(".aos-wb-railbtn[aria-selected='true']")?.getAttribute("data-tab") ?? null);
extras.tray = await app.evaluate(() => globalThis.__aosMain.tray());
extras.menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => `${i.label}: ${i.submenu?.items.filter((s) => s.label).length ?? 0}`) ?? []);
// Let the runtime's own refreshes (now allowed) run and write their caches; their events arrive through main.
await win.waitForTimeout(8000);
extras.vaultEvents = await win.evaluate(() => window.__aosEvents);

const guard = await win.evaluate(() => window.aosHost.guard.log);
const statusBar = await win.evaluate(() => document.querySelector(".aos-host-status")?.textContent?.trim() ?? "");
const commands = await win.evaluate(() => window.aosHost.app.commands.list().map((c) => c.id));
await app.close();

const report = { bootMs, tabs, extras, statusBar, commands, guard, events };
writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`boot ${bootMs} ms`);
for (const t of tabs) console.log(`${t.id.padEnd(14)} ${t.present ? `text ${String(t.textLen).padStart(6)}  errors ${t.errors.length}${t.errors.length ? `  ${t.errors[0]}` : ""}` : "not in rail"}`);
console.log("extras", JSON.stringify(extras));
console.log(`guard refused ${guard.length}: ${[...new Set(guard.map((g) => `${g.kind} ${g.what.split(" ").slice(0, 3).join(" ")}`))].join(" | ")}`);
console.log(`console errors ${events.filter((e) => e.kind === "error" || e.kind === "pageerror").length}, warnings ${events.filter((e) => e.kind === "warning").length}`);
console.log(`report: ${path.join(out, "report.json")}`);
