// Notifications with its write surface on (AOS_APP_WRITE=notifications), the rows of app-smoke:
// Notifications. Opening an unread item marks it read; Mark all read, Mark unread, Archive and Unarchive write
// brain/notifications/state.json in the shape lib/notifications.js writes; a vote appends one line to reactions.jsonl.
// state.json has a second writer (`aos notify`), and a change it made underneath survives the tab's next write.

import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, badge, content, expected, guardWrites, openTab, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "notifications" } });

const STATE = FX.v("brain/notifications/state.json");
const REACTIONS = FX.v("brain/notifications/reactions.jsonl");
const pristine = (f: string): string => fs.readFileSync(path.join(FX.pristine, "vault", path.relative(FX.vault, f)), "utf8");
const onDisk = (f: string) => (): string => fs.readFileSync(f, "utf8");

type Items = Record<string, { read?: true; archived?: true }>;
/** state.json as the tab (and lib/notifications.js) writes it. */
const stateText = (items: Items): string => `${JSON.stringify({ schema: 1, items }, null, 2)}\n`;
const pristineItems = (): Items => (JSON.parse(pristine(STATE)) as { items: Items }).items;

const N = (win: Page) => content(win);
const idOf = (title: string): string => expected().notifications.items.find((n) => n.title === title)!.id;
const item = (win: Page, title: string) => N(win).locator(".aos-nt-row", { has: win.locator(".aos-rt-name > div:first-child", { hasText: title }) });
const detail = (win: Page, title: string) => N(win).locator(".aos-nt-reader", { has: win.locator(".aos-nt-reader-title", { hasText: title }) }).locator(".aos-nt-detail");
const chip = (win: Page, text: string) => N(win).locator(".aos-nt-filters .aos-nt-chip", { hasText: new RegExp(`^${text}$`) });
const link = (win: Page, title: string, text: string) => detail(win, title).locator(".aos-nt-links a", { hasText: new RegExp(`^${text}$`) });

test.beforeEach(async () => {
  const { win } = app();
  const e = expected().notifications;
  for (const f of [STATE, REACTIONS]) if (onDisk(f)() !== pristine(f)) fs.writeFileSync(f, pristine(f));
  await openTab(win, "notifications");
  await expect(N(win).locator(".aos-rt-count")).toHaveText(`${e.unread} unread · ${e.total} total`, { timeout: 3000 });
  await expect(N(win).locator(".aos-nt-detail")).toHaveCount(0);
  if (!(await chip(win, "Unread").getAttribute("class"))?.includes("is-active")) await chip(win, "Unread").click();
});

test.afterEach(async () => {
  expect(await guardWrites(app())).toEqual([]);
});

test("Notifications is the one surface on: the status bar names it and the two files it writes", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Notifications");
  await expect(mode).toHaveAttribute("title", /^Notifications: brain\/notifications\/state\.json, brain\/notifications\/reactions\.jsonl\n/);
});

test("opening an unread item marks it read: state.json gains the flag, the dot goes, the badge drops by one (N4)", async () => {
  const { win } = app();
  const e = expected().notifications;
  await item(win, "Disk usage above 80%").click();
  await expect.poll(onDisk(STATE)).toBe(stateText({ ...pristineItems(), [idOf("Disk usage above 80%")]: { read: true } }));
  await expect(badge(win, "notifications")).toHaveText(String(e.unread - 1));
  await expect(badge(win, "notifications")).toHaveClass(/is-urgent/);
  await expect(N(win).locator(".aos-rt-count")).toHaveText(`${e.unread - 1} unread · ${e.total} total`);
  // Read, it leaves the Unread list but stays open in the reading pane (UniDeX D4); in All it is there without its dot.
  await expect(item(win, "Disk usage above 80%")).toHaveCount(0);
  await expect(detail(win, "Disk usage above 80%")).toHaveCount(1);
  await chip(win, "All").click();
  await expect(item(win, "Disk usage above 80%")).not.toHaveClass(/is-unread/);
  await expect(item(win, "Disk usage above 80%").locator(".aos-nt-dot")).toHaveText("");
  await item(win, "Disk usage above 80%").click();
  await expect(N(win).locator(".aos-nt-detail")).toHaveCount(0);
});

test("Mark all read flags every unread item at once and clears the badge (N4)", async () => {
  const { win } = app();
  await N(win).locator(".aos-rt-actions button", { hasText: "Mark all read" }).click();
  const flagged = ["Breaking: tide gauge offline", "The Morning Edition", "Disk usage above 80%"].map((t) => [idOf(t), { read: true }] as const);
  await expect.poll(onDisk(STATE)).toBe(stateText({ ...pristineItems(), ...Object.fromEntries(flagged) }));
  await expect(badge(win, "notifications")).toBeHidden();
  await expect(N(win).locator(".aos-rt-count")).toHaveText(`0 unread · ${expected().notifications.total} total`);
  await expect(N(win).locator(".aos-inv-row.aos-dim")).toHaveText("All caught up.");
  await expect(N(win).locator(".aos-rt-actions button", { hasText: "Mark all read" })).toHaveCount(0);
});

test("Mark unread, Archive and Unarchive act on the row and rewrite its flags (N5)", async () => {
  const { win } = app();
  const e = expected().notifications;
  const items = pristineItems();
  await chip(win, "All").click();

  // Weekly health: read → unread. An item left with no flags is dropped from state.json.
  await item(win, "Weekly health").click();
  await link(win, "Weekly health", "Mark unread").click();
  delete items[idOf("Weekly health")];
  await expect.poll(onDisk(STATE)).toBe(stateText(items));
  await expect(item(win, "Weekly health")).toHaveClass(/is-unread/);
  await expect(badge(win, "notifications")).toHaveText(String(e.unread + 1));
  await item(win, "Weekly health").click();

  // Cache cleaned: archived, so it leaves All and shows under Archived.
  await item(win, "Cache cleaned").click();
  await link(win, "Cache cleaned", "Archive").click();
  items[idOf("Cache cleaned")] = { read: true, archived: true };
  await expect.poll(onDisk(STATE)).toBe(stateText(items));
  await expect(item(win, "Cache cleaned")).toHaveCount(0);
  await chip(win, "Archived").click();
  await expect(N(win).locator(".aos-nt-row .aos-rt-name > div:first-child")).toHaveText(["Nightly scan finished", "Cache cleaned", "Backup missed"]);
  await expect(link(win, "Cache cleaned", "Unarchive")).toBeVisible();
  await link(win, "Cache cleaned", "Unarchive").click();
  items[idOf("Cache cleaned")] = { read: true };
  await expect.poll(onDisk(STATE)).toBe(stateText(items));
  await expect(item(win, "Cache cleaned")).toHaveCount(0);

  // Backup missed is archived and unread: opening it marks it read, and Unarchive brings it back to All.
  await item(win, "Backup missed").click();
  items[idOf("Backup missed")] = { archived: true, read: true };
  await expect.poll(onDisk(STATE)).toBe(stateText(items));
  await link(win, "Backup missed", "Unarchive").click();
  items[idOf("Backup missed")] = { read: true };
  await expect.poll(onDisk(STATE)).toBe(stateText(items));
  await chip(win, "All").click();
  await expect(item(win, "Backup missed")).toBeVisible();
  await expect(item(win, "Cache cleaned")).toBeVisible();
  for (const t of ["Backup missed", "Cache cleaned"]) if (await detail(win, t).count()) await item(win, t).click();
  await expect(N(win).locator(".aos-nt-detail")).toHaveCount(0);
});

test("a vote appends one line to reactions.jsonl and moves the chosen mark (N6)", async () => {
  const { win } = app();
  await chip(win, "All").click();
  await item(win, "The Morning Edition").click();
  const bar = detail(win, "The Morning Edition").locator(".aos-nt-actions").first();
  await expect(bar.locator("button", { hasText: "More like this" })).toHaveClass(/is-chosen/);
  await bar.locator("button", { hasText: "Less like this" }).click();
  // Wait for the whole line, not just a longer file.
  await expect.poll(() => onDisk(REACTIONS)().slice(pristine(REACTIONS).length))
    .toMatch(/^\{"schema":1,"at":"\d{4}-\d\d-\d\dT[\d:.]+Z","id":"[^"]+","ref":"tides","value":-1\}\n$/);
  const added = onDisk(REACTIONS)().slice(pristine(REACTIONS).length);
  expect(JSON.parse(added)).toMatchObject({ id: idOf("The Morning Edition"), ref: "tides", value: -1 });
  await expect(bar.locator("button", { hasText: "Less like this" })).toHaveClass(/is-chosen/);
  await expect(bar.locator("button", { hasText: "More like this" })).not.toHaveClass(/is-chosen/);
  // Opening the edition also marked it read.
  await expect.poll(onDisk(STATE)).toBe(stateText({ ...pristineItems(), [idOf("The Morning Edition")]: { read: true } }));
  await item(win, "The Morning Edition").click();
});

test("a change `aos notify` made underneath survives the tab's next write: every write re-reads state.json first", async () => {
  const { win } = app();
  await chip(win, "All").click();
  await item(win, "Weekly health").click();
  // Hold back the vault's events so the tab still shows the state from before the runtime's write.
  await win.evaluate(() => {
    const v = (window as unknown as { aosHost: { app: { vault: Record<string, unknown> } } }).aosHost.app.vault;
    v.__trigger = v.trigger;
    v.trigger = () => undefined;
  });
  try {
    const breaking = idOf("Breaking: tide gauge offline");
    const r = spawnSync(process.execPath, [path.join(FX.vault, "brain", "scripts", "notify.js"), "read", breaking, "--root", FX.vault], { env: appEnv(), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(onDisk(STATE)()) as { items: Items }).items[breaking]).toEqual({ read: true });
    await link(win, "Weekly health", "Mark unread").click();
    const items = pristineItems();
    delete items[idOf("Weekly health")];
    items[breaking] = { read: true };
    await expect.poll(() => (JSON.parse(onDisk(STATE)()) as { items: Items }).items).toEqual(items);
    // The tab re-read on its own write, so the runtime's change shows too.
    await expect(item(win, "Breaking: tide gauge offline")).not.toHaveClass(/is-unread/);
  } finally {
    await win.evaluate(() => {
      const v = (window as unknown as { aosHost: { app: { vault: Record<string, unknown> } } }).aosHost.app.vault;
      v.trigger = v.__trigger;
      delete v.__trigger;
    });
  }
  await item(win, "Weekly health").click();
});

test("with only Notifications on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  // The refusal was the point here; clear it so afterEach checks the rest of the file, and redraw the box.
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  await openTab(h.win, "memory");
});
