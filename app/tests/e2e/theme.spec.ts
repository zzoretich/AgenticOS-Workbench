// Light and dark (UniDeX D6): the page draws in what main resolves the choice to; the rail's toggle, the palette,
// App settings and View ▸ Appearance change it; the windows' backgrounds and the tokens follow; and the choice outlives a
// restart (<userData>/app-settings.json). A spec cannot switch macOS's own appearance, so "Match macOS" is checked as
// agreeing with what nativeTheme reports.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { USER_DATA, command, expectNoErrors, launchApp, restoreFixture, type AppHandle } from "./harness";

const SETTINGS = path.join(USER_DATA, "app-settings.json");

type Theme = { source: string; dark: boolean };
const mainTheme = (h: AppHandle) => h.app.evaluate(() => (globalThis as unknown as { __aosMain: { theme(): Theme } }).__aosMain.theme());
const setMainTheme = (h: AppHandle, source: string) =>
  h.app.evaluate((_e, s) => { (globalThis as unknown as { __aosMain: { setTheme(s: string): Theme } }).__aosMain.setTheme(s); }, source);
const bodyTheme = (win: Page) => win.evaluate(() => {
  const c = document.body.classList;
  return c.contains("theme-dark") && !c.contains("theme-light") ? "dark" : c.contains("theme-light") && !c.contains("theme-dark") ? "light" : "both-or-none";
});
const token = (win: Page, name: string) => win.evaluate((n) => getComputedStyle(document.body).getPropertyValue(n).trim(), name);
const windowBg = (h: AppHandle) => h.app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.getBackgroundColor());
const appearance = (h: AppHandle) => h.app.evaluate(({ Menu }) => {
  const view = Menu.getApplicationMenu()?.items.find((i) => i.label === "View");
  const item = view?.submenu?.items.find((i) => i.label === "Appearance");
  return item?.submenu?.items.map((i) => `${i.label}${i.checked ? " ✓" : ""}`) ?? [];
});
const saved = (): unknown => (fs.existsSync(SETTINGS) ? (JSON.parse(fs.readFileSync(SETTINGS, "utf8")) as { theme?: unknown }).theme : undefined);

test.describe.serial("light and dark", () => {
  let h: AppHandle | null = null;
  const app = (): AppHandle => { if (!h) throw new Error("the app is not running"); return h; };

  test.beforeAll(async () => {
    restoreFixture();
    fs.rmSync(SETTINGS, { force: true });
    h = await launchApp();
  });
  test.afterAll(async () => {
    await h?.close();
    h = null;
    fs.rmSync(SETTINGS, { force: true });
  });
  test.afterEach(() => { if (h) expectNoErrors(h); });

  test("with no choice saved, the page draws in the appearance macOS reports", async () => {
    const t = await mainTheme(app());
    expect(t.source).toBe("system");
    expect(await bodyTheme(app().win)).toBe(t.dark ? "dark" : "light");
    expect(await app().win.evaluate(() => document.documentElement.style.colorScheme)).toBe(t.dark ? "dark" : "light");
    expect(await appearance(app())).toEqual(["Match macOS ✓", "Light", "Dark"]);
  });

  test("the rail's toggle switches to the opposite, saves it, and the tokens and window follow", async () => {
    const { win } = app();
    const before = await bodyTheme(win);
    const next = before === "dark" ? "light" : "dark";
    const toggle = win.locator('.aos-wb-railfoot .aos-wb-railact[data-action="theme"]');
    await expect(toggle).toHaveAttribute("aria-label", `Switch to ${next}`);
    await toggle.click();
    await expect.poll(() => bodyTheme(win)).toBe(next);
    expect(await mainTheme(app())).toEqual({ source: next, dark: next === "dark" });
    expect(saved()).toBe(next);
    expect(await token(win, "--udx-bg")).toBe(next === "dark" ? "#0b0b0b" : "#ffffff");
    expect(await win.locator(".aos-root").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(next === "dark" ? "rgb(11, 11, 11)" : "rgb(255, 255, 255)");
    expect((await windowBg(app()))?.toLowerCase()).toBe(next === "dark" ? "#0b0b0b" : "#ffffff");
    await expect(toggle).toHaveAttribute("aria-label", `Switch to ${before}`);
  });

  test("the palette's command flips it back, and the menu shows the choice", async () => {
    const { win } = app();
    const before = await bodyTheme(win);
    expect(await command(win, "host:toggle-theme")).toBe(true);
    const next = before === "dark" ? "light" : "dark";
    await expect.poll(() => bodyTheme(win)).toBe(next);
    expect(await appearance(app())).toEqual(["Match macOS", next === "light" ? "Light ✓" : "Light", next === "dark" ? "Dark ✓" : "Dark"]);
  });

  test("App settings ▸ Appearance goes back to Match macOS", async () => {
    const { win } = app();
    expect(await command(win, "host:settings")).toBe(true);
    const modal = win.locator(".modal.mod-settings");
    await modal.locator(".vertical-tab-nav-item", { hasText: /^App$/ }).click();
    const row = modal.locator(".setting-item", { has: win.locator(".setting-item-name", { hasText: /^Appearance$/ }) });
    await row.locator("select").selectOption("system");
    await expect.poll(async () => (await mainTheme(app())).source).toBe("system");
    expect(saved()).toBe("system");
    const t = await mainTheme(app());
    await expect.poll(() => bodyTheme(win)).toBe(t.dark ? "dark" : "light");
    await win.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });

  test("the choice outlives a restart: the first frame is drawn in it", async () => {
    await setMainTheme(app(), "dark");
    expect(saved()).toBe("dark");
    await app().close();
    h = await launchApp();
    expect(await mainTheme(app())).toEqual({ source: "dark", dark: true });
    expect(await bodyTheme(app().win)).toBe("dark");
    expect((await windowBg(app()))?.toLowerCase()).toBe("#0b0b0b");
    await setMainTheme(app(), "light");
    await expect.poll(() => bodyTheme(app().win)).toBe("light");
    expect(await token(app().win, "--udx-text")).toBe("#0d0d0d");
  });
});
