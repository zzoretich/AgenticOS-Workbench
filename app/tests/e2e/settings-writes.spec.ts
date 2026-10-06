// ⚙ Settings with its write surface on (AOS_APP_WRITE=settings), the rows of app-smoke: Settings and
// Install paths. Every change is `aos config set|unset <key> … --json`, run by the vault's own runtime, which writes the
// file that wins (agenticos.json for this machine, brain/config.json for this vault) and applies the key's side effects;
// a follow-up it prints becomes a button that runs it. The tests read both files after each change.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, badge, content, guardWrites, openTab, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "settings" } });

const MACHINE = path.join(FX.claude, "agenticos.json");
const VAULT_CFG = FX.v("brain/config.json");
type Json = Record<string, unknown>;
const read = (file: string): Json => JSON.parse(fs.readFileSync(file, "utf8")) as Json;
/** A dotted key in a config file, or undefined when the file does not set it. */
const at = (file: string, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), read(file));

const C = (win: Page) => content(win);
const row = (win: Page, key: string) => C(win).locator(".aos-st-row", { has: win.locator(".aos-st-key", { hasText: new RegExp(`^${key.replace(/\./g, "\\.")}$`) }) });
const sw = (win: Page, label: string) => C(win).locator(".aos-st-master .aos-st-switch", { hasText: label });
const modal = (win: Page) => win.locator(".modal");

/** The Settings tab, as the page holds it (the private members the tests read or wrap). */
type SettingsTabView = { loading?: boolean; refresh(): Promise<void>; plugin: { aosJson(args: string[], ms?: number): Promise<unknown> } };
type TabWindow = {
  aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): SettingsTabView | null } }> } } };
  aosHeld?: { read: boolean; asked: number; open(): void };
};

/** The tab's `loading` flag: true while an `aos config list` is in flight. */
const loadingNow = (win: Page) => win.evaluate(() => (window as unknown as TabWindow).aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0]?.view.getTab("settings")?.loading);

/**
 * Waits until the tab shows `check`. The files are the truth and each test asserts them first; the tab follows once a
 * list read after the change has rendered. It has no ⟳ to fall back on: a click there once hid that a refresh asked for
 * while another ran was dropped (S8), and waited out the toast that covers the button.
 */
async function shows(check: () => Promise<boolean>): Promise<void> {
  await expect.poll(check, { timeout: 20_000 }).toBe(true);
}
const hasClass = (l: ReturnType<Page["locator"]>, re: RegExp) => async () => re.test((await l.getAttribute("class")) ?? "");
const lacksClass = (l: ReturnType<Page["locator"]>, re: RegExp) => async () => !re.test((await l.getAttribute("class")) ?? "");
const buttons = (win: Page, key: string) => row(win, key).locator(".setting-item-control > .extra-setting-button");
/**
 * Waits until the tab has a list and no `aos config list` is in flight: each refresh redraws every control when it lands.
 * The tab's own `loading` flag is the only signal for it.
 */
async function loaded(win: Page): Promise<void> {
  await expect(C(win).locator(".aos-rt-count")).toHaveText(/changed from the defaults$/);
  await expect.poll(() => loadingNow(win)).toBe(false);
}

/**
 * Starts a refresh whose `aos config list` reads the files now but renders only on release(), like a refresh still in
 * flight when a change lands (a file event's, the open-time one). asked(n) waits until n more refreshes were asked for
 * meanwhile. release() lets the held one finish, and from then on a refresh asked for starts nothing, so only what the
 * tab queued itself can redraw it. restore() puts the tab's own methods back: call it in a `finally`, since a refresh
 * left held keeps `loading` on and every later test would wait on it.
 */
async function holdRefresh(win: Page): Promise<{ asked(n: number): Promise<void>; release(): Promise<void>; restore(): Promise<void> }> {
  await expect.poll(() => win.evaluate(() => {
    const w = window as unknown as TabWindow;
    const tab = w.aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0]?.view.getTab("settings");
    if (!tab || tab.loading) return false;
    let open = () => {};
    const gate = new Promise<void>((r) => { open = r; });
    const held = { read: false, asked: 0, open };
    w.aosHeld = held;
    const aosJson = tab.plugin.aosJson.bind(tab.plugin);
    const refresh = tab.refresh.bind(tab);
    tab.plugin.aosJson = async (args, ms) => {
      const r = await aosJson(args, ms);
      if (args[0] === "config" && args[1] === "list" && !held.read) { held.read = true; await gate; }
      return r;
    };
    tab.refresh = () => { held.asked++; return refresh(); };
    void refresh();
    return true;
  })).toBe(true);
  await expect.poll(() => win.evaluate(() => (window as unknown as TabWindow).aosHeld?.read)).toBe(true);
  return {
    async asked(n: number) {
      await expect.poll(() => win.evaluate(() => (window as unknown as TabWindow).aosHeld?.asked)).toBeGreaterThanOrEqual(n);
    },
    async release() {
      await win.evaluate(() => {
        const w = window as unknown as TabWindow;
        const tab = w.aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0]?.view.getTab("settings");
        const held = w.aosHeld;
        if (!tab || !held) return;
        tab.refresh = async () => { held.asked++; };
        held.open();
      });
    },
    async restore() {
      await win.evaluate(() => {
        const w = window as unknown as TabWindow;
        const tab = w.aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0]?.view.getTab("settings") as { refresh?: unknown; plugin: { aosJson?: unknown } };
        delete tab.refresh;
        delete tab.plugin.aosJson;
        w.aosHeld?.open();
        delete w.aosHeld;
      });
    },
  };
}

test.beforeEach(async () => {
  const { win } = app();
  await openTab(win, "settings");
  await loaded(win);
  await expect(modal(win)).toHaveCount(0);
});

test.afterEach(async () => {
  expect(await guardWrites(app())).toEqual([]);
  // Every spawn the tab made ran: nothing but the background refreshes may be refused.
  expect((await app().guard()).filter((e) => e.kind === "spawn" && / config (set|unset) | routines sync| statusline install/.test(e.what))).toEqual([]);
});

test("Settings is the one surface on: the status bar names it and what it may touch", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Settings");
  await expect(mode).toHaveAttribute("title", /^Settings: brain\/_index\/agent-runs\/runs\.jsonl, cli\/aos\.js, zsh, bash, sh, fish\n/);
});

test("a picker sets the key in the file that wins; its follow-up becomes a button and a ⚙ badge, and running it clears both (S7)", async () => {
  const { win } = app();
  expect(at(MACHINE, "claude.model")).toBe("haiku");
  const select = row(win, "claude.model").locator("select.dropdown");
  const next = await select.locator("option").evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value).find((v) => v && v !== "haiku"));
  expect(next).toBeTruthy();
  await select.selectOption(next!);
  await expect.poll(() => at(MACHINE, "claude.model")).toBe(next);
  await expect(win.locator(".notice-container")).toContainText("claude.model");
  await shows(async () => (await row(win, "claude.model").locator("select.dropdown").inputValue()) === next);
  const follow = C(win).locator(".aos-st-follow");
  await expect(follow).toContainText("⚠ 1 step left:");
  await expect(follow.locator("button")).toHaveText(["aos routines sync"]);
  await expect(badge(win, "settings")).toHaveText("1");
  await follow.locator("button", { hasText: "aos routines sync" }).click();
  await expect(win.locator(".notice-container")).toContainText("aos routines sync: done", { timeout: 30_000 });
  await expect(C(win).locator(".aos-st-follow")).toHaveCount(0);
  await expect(badge(win, "settings")).toBeHidden();
});

test("+ on a spend cap asks first and Raise writes the next preset; − goes back without asking (S4)", async () => {
  const { win } = app();
  const key = "scan.fileMapBudgetUnderClaude";
  expect(at(VAULT_CFG, key)).toBe(0);
  const label = await buttons(win, key).nth(1).getAttribute("aria-label");
  const raised = Number(/^Raise to (\d+)/.exec(label ?? "")?.[1]);
  expect(raised).toBeGreaterThan(0);
  await buttons(win, key).nth(1).click();
  await expect(modal(win).locator("h3")).toHaveText(/^Raise /);
  await modal(win).locator("button.mod-cta", { hasText: "Raise" }).click();
  await expect.poll(() => at(VAULT_CFG, key)).toBe(raised);
  await shows(async () => (await row(win, key).locator("select.dropdown").inputValue()) === String(raised));
  await buttons(win, key).nth(0).click();
  await expect.poll(() => at(VAULT_CFG, key)).toBe(0);
  await shows(async () => (await row(win, key).locator("select.dropdown").inputValue()) === "0");
  await expect(modal(win)).toHaveCount(0);
});

test("↺ goes back to the default: the key leaves the file and the pill says default (S8)", async () => {
  const { win } = app();
  const key = "cost.monthlyBudget";
  expect(at(VAULT_CFG, key)).toBe(175);
  // A refresh in flight across the change read the file before it (held open here; on main's CI one ran late on its
  // own). The change's own refresh was dropped meanwhile, so the pill said "this vault" until ⟳. Once the held one is
  // released no new refresh starts, so only a read the tab queued itself can show the change.
  const held = await holdRefresh(win);
  try {
    await row(win, key).locator(".extra-setting-button[aria-label*='default'], .extra-setting-button[title*='default']").first().click();
    await expect.poll(() => at(VAULT_CFG, key)).toBeUndefined();
    expect(at(MACHINE, key)).toBeUndefined();
    await expect(win.locator(".notice-container")).toContainText("cost.monthlyBudget");
    await held.asked(1);
    await held.release();
    await expect(row(win, key).locator(".aos-st-meta .aos-pill")).toHaveText("default");
  } finally {
    await held.restore();
  }
});

test("master switches write; Chief of Staff pauses duties through persona/DISABLED and asks before turning back on (S3)", async () => {
  const { win } = app();
  const disabled = FX.v("persona/DISABLED");
  expect(fs.existsSync(disabled)).toBe(false);
  await sw(win, "Chief of Staff").locator("input").click();
  await expect.poll(() => at(MACHINE, "persona.enabled")).toBe(false);
  await expect.poll(() => fs.existsSync(disabled)).toBe(true);
  expect(fs.readFileSync(disabled, "utf8")).toMatch(/^disabled \S+ by aos config\n$/);
  await shows(lacksClass(sw(win, "Chief of Staff"), /is-on/));
  // Turning an autonomy switch on asks first.
  await loaded(win);
  await sw(win, "Chief of Staff").locator("input").click();
  await expect(modal(win).locator("h3")).toHaveText("Turn on Chief of Staff?");
  await modal(win).locator("button.mod-cta", { hasText: "Turn on" }).click();
  await expect.poll(() => at(MACHINE, "persona.enabled")).toBe(true);
  await expect.poll(() => fs.existsSync(disabled)).toBe(false);
  await shows(hasClass(sw(win, "Chief of Staff"), /is-on/));
});

test("Background AI asks before paid calls, and Cancel changes nothing (S3)", async () => {
  const { win } = app();
  await sw(win, "Background AI").locator("input").click();
  await expect(modal(win).locator("h3")).toHaveText("Turn on paid background calls?");
  await modal(win).locator("button", { hasText: "Cancel" }).click();
  await expect(modal(win)).toHaveCount(0);
  expect(at(MACHINE, "provider")).toBe("none");
  await expect(sw(win, "Background AI")).not.toHaveClass(/is-on/);
});

test("Telemetry off and on: the live-runs watcher restarts and recreates its folder (S3)", async () => {
  const { win } = app();
  const live = FX.v("brain/_index/agent-runs/live");
  await sw(win, "Telemetry").locator("input").click();
  await expect.poll(() => at(MACHINE, "telemetry.enabled")).toBe(false);
  await shows(lacksClass(sw(win, "Telemetry"), /is-on/));
  // Take the folder away while telemetry is off; turning it on makes the watcher create it again.
  const parked = path.join(FX.root, "live-runs-parked");
  if (fs.existsSync(live)) fs.renameSync(live, parked);
  try {
    await sw(win, "Telemetry").locator("input").click();
    await expect.poll(() => at(MACHINE, "telemetry.enabled")).toBe(true);
    await expect.poll(() => fs.existsSync(live)).toBe(true);
    await shows(hasClass(sw(win, "Telemetry"), /is-on/));
  } finally {
    if (fs.existsSync(parked)) { fs.rmSync(live, { recursive: true, force: true }); fs.renameSync(parked, live); }
  }
});

test("chips: a routine tool change asks first; switching all but one off locks the last one; ↺ brings every chip back (S6)", async () => {
  const { win } = app();
  const key = "routines.tools";
  const chip = (name: string) => row(win, key).locator(".aos-st-chip", { hasText: name });
  // routines.tools is an autonomy setting: every change asks first, and Cancel writes nothing.
  await chip("Glob").locator("input").click();
  await expect(modal(win).locator("h3")).toHaveText("Change Routine tools?");
  await modal(win).locator("button", { hasText: "Cancel" }).click();
  expect(at(VAULT_CFG, key)).toBe("Read,Glob,Grep");
  await expect(chip("Glob")).toHaveClass(/is-on/);
  for (const [name, left] of [["Glob", "Read,Grep"], ["Grep", "Read"]]) {
    await chip(name).locator("input").click();
    await modal(win).locator("button.mod-cta", { hasText: "Change" }).click();
    await expect.poll(() => at(VAULT_CFG, key)).toBe(left);
    await loaded(win);
  }
  await shows(async () => (await row(win, key).locator(".aos-st-chip.is-on").allTextContents()).join() === "Read");
  await expect(chip("Read").locator("input")).toBeDisabled();
  // ↺ asks the same question.
  await row(win, key).locator(".extra-setting-button[aria-label*='default'], .extra-setting-button[title*='default']").first().click();
  await modal(win).locator("button.mod-cta", { hasText: "Change" }).click();
  await expect.poll(() => at(VAULT_CFG, key)).toBeUndefined();
  await shows(async () => (await row(win, key).locator(".aos-st-chip.is-on").allTextContents()).join() === "Read,Glob,Grep");
});

test("Probe resolves node again and saves it in the app's own settings (I2)", async () => {
  const { win } = app();
  const node = String(read(MACHINE).node);
  const item = C(win).locator(".aos-st-plugin .setting-item", { has: win.locator(".setting-item-name", { hasText: /^Node binary$/ }) });
  await item.locator("button", { hasText: "Probe" }).click();
  await expect(win.locator(".notice-container")).toContainText(`node: ${node}`);
  // The app keeps the plugin's data.json as userData/plugins/<plugin id>.json.
  const data = path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)", "plugins", "agentic-os.json");
  await expect.poll(() => (fs.existsSync(data) ? (JSON.parse(fs.readFileSync(data, "utf8")) as Json).nodePath : null)).toBe(node);
});

test("with only Settings on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
