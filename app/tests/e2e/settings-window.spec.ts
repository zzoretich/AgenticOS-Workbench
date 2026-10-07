// The settings window: Obsidian's settings, in the app (`app.setting`). The app's own App tab under Options, the tab
// the Workbench plugin registers under Community plugins. Opened from App settings at the rail's foot, from AgenticOS Workbench ▸
// App Settings… (the host:settings command) and from the palette. It runs read-only: a plugin row saves to the app's own
// data folder, and the system switches, which run `aos config set`, are refused with the Settings surface off.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, HUD_VERSION, command, content, expectNoErrors, openTab, useApp } from "./harness";

const app = useApp();

const USER_DATA = path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)");
const PLUGIN_DATA = path.join(USER_DATA, "plugins", "agentic-os.json");

const modal = (win: Page) => win.locator(".modal.mod-settings");
const nav = (win: Page, name: string) => modal(win).locator(".vertical-tab-nav-item", { hasText: new RegExp(`^${name}$`) });
const pane = (win: Page) => modal(win).locator(".vertical-tab-content-container .vertical-tab-content");
const row = (scope: ReturnType<Page["locator"]>, name: string) => scope.locator(".setting-item", { has: scope.page().locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }) });
const names = async (scope: ReturnType<Page["locator"]>) => (await scope.locator(".setting-item-name").allTextContents()).map((t) => t.trim());

async function close(win: Page): Promise<void> {
  if (await modal(win).count()) await win.keyboard.press("Escape");
  await expect(modal(win)).toHaveCount(0);
}

test.afterEach(async () => {
  const h = app();
  await close(h.win);
  expectNoErrors(h);
});

test("App settings at the rail's foot opens the window on the plugin's tab: Options ▸ App, Community plugins ▸ Agentic OS", async () => {
  const { win } = app();
  const gear = win.locator('.aos-wb-railfoot .aos-wb-railact[data-action="app-settings"]');
  await expect(gear).toHaveAttribute("aria-label", "App settings");
  // The app's ribbon is hidden (UniDeX D3): the rail carries its actions.
  await expect(win.locator(".aos-host-ribbon")).toBeHidden();
  await gear.click();
  await expect(modal(win)).toBeVisible();
  await expect(modal(win).locator(".vertical-tab-header-group-title")).toHaveText(["Options", "Community plugins"]);
  await expect(modal(win).locator(".vertical-tab-nav-item")).toHaveText(["App", "Agentic OS"]);
  await expect(nav(win, "Agentic OS")).toHaveClass(/is-active/);
  await expect(pane(win).locator("h2")).toHaveText("Agentic OS");
  await win.keyboard.press("Escape");
  await expect(modal(win)).toHaveCount(0);
  // The keyboard reaches it too.
  await gear.focus();
  await win.keyboard.press("Enter");
  await expect(modal(win)).toBeVisible();
});

test("the palette's Open app settings opens it again on the tab last looked at", async () => {
  const { win } = app();
  expect(await command(win, "host:settings")).toBe(true);
  await nav(win, "App").click();
  await expect(nav(win, "App")).toHaveClass(/is-active/);
  await close(win);
  await win.evaluate(() => (window as unknown as { aosHost: { runCommand(id: string): void } }).aosHost.runCommand("host:palette"));
  await win.locator(".prompt-input").fill("open app settings");
  await expect(win.locator(".suggestion-item").first()).toContainText("Open app settings");
  await win.keyboard.press("Enter");
  await expect(modal(win)).toBeVisible();
  await expect(nav(win, "App")).toHaveClass(/is-active/);
  await expect(pane(win).locator("h2")).toHaveText("AgenticOS app");
});

test("the App tab: the vault and the app's data folder (handed to Finder), write access, and the versions", async () => {
  const h = app();
  const { win } = h;
  expect(await command(win, "host:settings")).toBe(true);
  await nav(win, "App").click();
  await expect(await names(pane(win))).toEqual(["Appearance", "Vault", "App data", "Write access", "Versions"]);
  await expect(row(pane(win), "Vault").locator(".aos-app-path")).toHaveText(FX.vault);
  await expect(row(pane(win), "Vault").locator(".setting-item-description")).toContainText("(AOS_APP_VAULT)");
  await expect(row(pane(win), "App data").locator(".aos-app-path")).toHaveText(USER_DATA);
  await expect(row(pane(win), "Write access").locator(".aos-app-writes")).toHaveText("Read-only");
  await expect(row(pane(win), "Write access").locator(".setting-item-description")).toHaveText("Set for this run by AOS_APP_WRITE.");
  await expect(row(pane(win), "Versions").locator(".aos-app-versions")).toHaveText(new RegExp(`^app \\S+ · HUD ${HUD_VERSION.replace(/\./g, "\\.")} · Electron \\d+\\.\\d+\\.\\d+$`));
  await row(pane(win), "Vault").locator("button", { hasText: "Show in Finder" }).click();
  await row(pane(win), "App data").locator("button", { hasText: "Show in Finder" }).click();
  await expect.poll(async () => (await h.opened()).map((o) => `${o.fn} ${o.arg}`)).toEqual(expect.arrayContaining([
    `showItemInFolder ${FX.vault}`, `showItemInFolder ${USER_DATA}`,
  ]));
});

test("the plugin's tab: the WORKBENCH section's rows and the provider row (I3, S11); Open Workbench settings closes it and opens the Settings tab (S1)", async () => {
  const { win } = app();
  await openTab(win, "settings");
  const workbench = await names(content(win).locator(".aos-st-plugin"));
  await openTab(win, "pulse");
  expect(await command(win, "host:settings")).toBe(true);
  await nav(win, "Agentic OS").click();
  const inWindow = await names(pane(win));
  expect(inWindow).toEqual(expect.arrayContaining(workbench));
  expect(inWindow.slice(0, 5)).toEqual(["Workbench settings", "System", "Provider", "Session costing", "Telemetry"]);
  await expect(row(pane(win), "Provider").locator(".setting-item-description")).toHaveText(/^none \(forced\) — checked \d{4}-\d{2}-\d{2}T/);
  await expect(row(pane(win), "Provider").locator(".extra-setting-button")).toHaveCount(1);
  await row(pane(win), "Workbench settings").locator("button", { hasText: "Open Workbench settings" }).click();
  await expect(modal(win)).toHaveCount(0);
  await expect(win.locator('.aos-wb-railbtn[data-tab="settings"]')).toHaveClass(/is-active/);
});

test("a change in the window shows in the WORKBENCH section, and one made there shows in the window (S11)", async () => {
  const { win } = app();
  const saved = () => (fs.existsSync(PLUGIN_DATA) ? (JSON.parse(fs.readFileSync(PLUGIN_DATA, "utf8")) as { autoOpenSidebarOnStart?: boolean }).autoOpenSidebarOnStart : undefined);
  // A row that takes effect only at the next start: the app's own setting, saved in its data folder.
  const toggle = (scope: ReturnType<Page["locator"]>) => row(scope, "Auto-open sidebar on start").locator(".checkbox-container");
  expect(await command(win, "host:settings")).toBe(true);
  await nav(win, "Agentic OS").click();
  await expect(toggle(pane(win))).not.toHaveClass(/is-enabled/);
  await toggle(pane(win)).click();
  await expect.poll(saved).toBe(true);
  await close(win);

  await openTab(win, "settings");
  const section = content(win).locator(".aos-st-plugin");
  await expect(toggle(section)).toHaveClass(/is-enabled/);
  await toggle(section).click();
  await expect.poll(saved).toBe(false);

  expect(await command(win, "host:settings")).toBe(true);
  await expect(toggle(pane(win))).not.toHaveClass(/is-enabled/);
});

test("with the Settings surface off, the window's system switches are refused like the tab's, and neither file changes", async () => {
  const h = app();
  const files = [path.join(FX.claude, "agenticos.json"), FX.v("brain/config.json")];
  const before = files.map((f) => fs.readFileSync(f, "utf8"));
  expect(await command(h.win, "host:settings")).toBe(true);
  await nav(h.win, "Agentic OS").click();
  await row(pane(h.win), "Telemetry").locator(".checkbox-container").click();
  await expect(h.win.locator(".notice-container")).toContainText(/refused; no write surface that allows it is on/);
  expect(files.map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
  await expect(row(pane(h.win), "Telemetry").locator(".checkbox-container")).toHaveClass(/is-enabled/);
  expect((await h.guard()).filter((e) => / config set telemetry\.enabled /.test(e.what))).toHaveLength(1);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
