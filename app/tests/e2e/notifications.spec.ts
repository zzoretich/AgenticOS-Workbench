// Notifications (app-smoke: Notifications) with its write surface off: items posted through the runtime's
// lib/notifications.js, the unread badge (rose while a breaking item is unread), views, level and sender filters,
// sections with their actions, the unreadable-file footer, a live post, and opening an unread item, whose attempt to
// mark it read the guard refuses. The writes themselves (read, archive, votes) are in notifications-writes.spec.ts.

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { FX, appEnv, badge, closeNotes, content, expected, guardWrites, noteBody, notePath, openTab, terminalText, useApp } from "./harness";

const app = useApp();
const N = () => content(app().win);
const item = (title: string) => N().locator(".aos-nt-row", { has: app().win.locator(".aos-rt-name > div:first-child", { hasText: title }) });
/** The expanded detail right under an item's row. */
const detail = (title: string) => item(title).locator("xpath=following-sibling::div[1][contains(@class, 'aos-nt-detail')]");
const chip = (text: string) => N().locator(".aos-nt-filters .aos-nt-chip", { hasText: new RegExp(`^${text}$`) });

test.beforeEach(async () => { await openTab(app().win, "notifications"); });

test("rail badge counts unread items and is rose while a breaking one is unread", async () => {
  const { win } = app();
  await expect(badge(win, "notifications")).toHaveText(String(expected().notifications.unread));
  await expect(badge(win, "notifications")).toHaveClass(/is-urgent/);
});

test("Unread lists the unread items newest first with level pill, sender and age", async () => {
  const e = expected().notifications;
  await expect(N().locator(".aos-rt-count")).toHaveText(`${e.unread} unread · ${e.total} total`);
  await expect(N().locator(".aos-rt-actions button")).toHaveText("Mark all read");
  await expect(chip("Unread")).toHaveClass(/is-active/);
  const rows = N().locator(".aos-nt-row");
  await expect(rows.locator(".aos-rt-name > div:first-child")).toHaveText(["Breaking: tide gauge offline", "The Morning Edition", "Disk usage above 80%"]);
  await expect(rows.locator(".aos-pill")).toHaveText(["BREAKING", "edition", "alert"]);
  await expect(rows.nth(0).locator(".aos-pill")).toHaveClass(/aos-pill-rose/);
  await expect(rows.nth(2).locator(".aos-pill")).toHaveClass(/aos-pill-amber/);
  await expect(rows.locator(".aos-rt-slug")).toHaveText(["harbor-desk", "harbor-desk", "monitor"]);
  // Ages as the tab computes them (lib/notifications.js ago()), from each item's created time.
  const agoOf = (title: string) => {
    const s = Math.max(0, (Date.now() - Date.parse(expected().notifications.items.find((n) => n.title === title)!.created)) / 1000);
    return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  };
  const titles = ["Breaking: tide gauge offline", "The Morning Edition", "Disk usage above 80%"];
  // A minute may turn over between reading the row and computing here: accept either side of it.
  const ages = await rows.locator(".aos-nt-age").allTextContents();
  ages.forEach((a, i) => expect([agoOf(titles[i]), agoOf(titles[i]).replace(/^(\d+)/, (n) => String(Number(n) - 1))]).toContain(a));
  await expect(rows.locator(".aos-nt-dot")).toHaveText(["●", "●", "●"]);
  await expect(N().locator(".aos-nt-foot")).toHaveText(`${e.unreadable} unreadable file(s) in brain/notifications skipped`);
});

test("level chips and the sender dropdown filter; All and Archived views", async () => {
  const e = expected().notifications;
  await chip("alert").click();
  await expect(N().locator(".aos-nt-row .aos-rt-name > div:first-child")).toHaveText(["Disk usage above 80%"]);
  await chip("alert").click();
  await expect(N().locator(".aos-nt-row")).toHaveCount(e.unread);
  const from = N().locator("select.aos-nt-from");
  await expect(from.locator("option")).toHaveText(["all senders", ...e.senders]);
  await from.selectOption("harbor-desk");
  await expect(N().locator(".aos-nt-row .aos-rt-name > div:first-child")).toHaveText(["Breaking: tide gauge offline", "The Morning Edition"]);
  await N().locator("select.aos-nt-from").selectOption("");
  await chip("All").click();
  await expect(N().locator(".aos-nt-row")).toHaveCount(e.total);
  await expect(item("Weekly health").locator(".aos-nt-dot")).toHaveText("");
  await expect(item("Weekly health")).not.toHaveClass(/is-unread/);
  await chip("Archived").click();
  await expect(N().locator(".aos-nt-row .aos-rt-name > div:first-child")).toHaveText(["Nightly scan finished", "Backup missed"]);
  await chip("info").click();
  await expect(N().locator(".aos-nt-row .aos-rt-name > div:first-child")).toHaveText(["Nightly scan finished"]);
  await chip("info").click();
  await chip("Unread").click();
});

test("a read item expands to its body and the Mark unread / Archive / Open note links, writing nothing", async () => {
  const h = app();
  const before = await guardWrites(h);
  await chip("All").click();
  await item("Weekly health").click();
  const d = detail("Weekly health");
  await expect(d.locator(".aos-nt-md")).toHaveText("All green.");
  await expect(d.locator(".aos-nt-links a")).toHaveText(["Mark unread", "Archive", "Open note"]);
  expect(await guardWrites(h)).toEqual(before);
  await item("Weekly health").click();
  await expect(N().locator(".aos-nt-detail")).toHaveCount(0);
  await chip("Unread").click();
});

test("an item hand-edited to carry a command shows no button: actions are re-checked against the allow-list", async () => {
  await chip("All").click();
  await item("Cache cleaned").click();
  await expect(detail("Cache cleaned").locator(".aos-nt-md")).toHaveText("Removed 12 stale files.");
  await expect(detail("Cache cleaned").locator(".aos-nt-actions")).toHaveCount(0);
  await expect(detail("Cache cleaned").locator("button")).toHaveCount(0);
  await item("Cache cleaned").click();
  await chip("Unread").click();
});

test("an edition expands to its sections with the actions anchored under each; the rest go last", async () => {
  await item("The Morning Edition").click();
  const d = detail("The Morning Edition");
  await expect(d.locator(".aos-nt-h")).toHaveText(["Tides and Weather", "Chart Updates"]);
  await expect(d.locator(".aos-nt-md").first()).toHaveText("Good morning from the harbor desk.");
  const bars = d.locator(".aos-nt-actions");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0).locator("button")).toHaveText(["Deep dive ❯_", "▲ More like this", "▼ Less like this"]);
  await expect(bars.nth(0).locator("button", { hasText: "Deep dive" })).toHaveAttribute("title", "Opens a Claude Code session in the vault running: claude '/agenticos:ask-brain tide tables'");
  // The vote recorded in reactions.jsonl shows as chosen.
  await expect(bars.nth(0).locator("button", { hasText: "More like this" })).toHaveClass(/is-chosen/);
  await expect(bars.nth(0).locator("button", { hasText: "Less like this" })).not.toHaveClass(/is-chosen/);
  await expect(bars.nth(1).locator("button")).toHaveText(["Weekly outlook ❯_"]);
  await item("The Morning Edition").click();
  await expect(N().locator(".aos-nt-detail")).toHaveCount(0);
});

test("with the Notifications surface off, opening an unread item tries to mark it read; the guard refuses the state.json write and the row stays unread", async () => {
  const h = app();
  const writes = await guardWrites(h);
  await item("Disk usage above 80%").click();
  await expect(detail("Disk usage above 80%").locator(".aos-nt-md")).toHaveText("The vault volume is at 81%.");
  await expect.poll(async () => (await guardWrites(h)).length).toBeGreaterThan(writes.length);
  const refused = (await guardWrites(h)).slice(writes.length);
  expect(refused.every((w) => w.includes("brain/notifications/state.json"))).toBe(true);
  await expect(h.win.locator(".notice-container")).toContainText("Could not update brain/notifications/state.json");
  await expect(item("Disk usage above 80%")).toHaveClass(/is-unread/);
  await expect(badge(h.win, "notifications")).toHaveText(String(expected().notifications.unread));
  await item("Disk usage above 80%").click();
  await expect(detail("Disk usage above 80%")).toHaveCount(0);
});

test("Open note opens the item's file in a new tab", async () => {
  const { win } = app();
  await chip("All").click();
  await item("Weekly health").click();
  await detail("Weekly health").locator(".aos-nt-links a", { hasText: "Open note" }).click();
  const id = expected().notifications.items.find((n) => n.title === "Weekly health")!.id;
  await expect(notePath(win)).toHaveText(`brain/notifications/${id.slice(0, 4)}/${id}.md`);
  await expect(noteBody(win)).toContainText("All green.");
  await closeNotes(win);
  await chip("Unread").click();
});

test("Deep dive ❯_ switches to Term with a Claude Code session running the skill", async () => {
  const { win } = app();
  await chip("All").click();
  await item("The Morning Edition").click();
  await detail("The Morning Edition").locator(".aos-nt-actions button", { hasText: "Deep dive" }).click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] /agenticos:ask-brain tide tables");
});

test("a post from `aos notify post` shows within a second, with another tab active", async () => {
  const { win } = app();
  await openTab(win, "memory");
  const r = spawnSync(process.execPath, [path.join(FX.vault, "brain", "scripts", "notify.js"), "post", "--from", "demo", "--level", "edition", "--title", "Demo edition", "--root", FX.vault],
    { env: appEnv(), encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  await expect(badge(win, "notifications")).toHaveText(String(expected().notifications.unread + 1), { timeout: 2000 });
  await openTab(win, "notifications");
  await expect(N().locator(".aos-nt-row").first().locator(".aos-rt-name > div:first-child")).toHaveText("Demo edition");
  await expect(N().locator("select.aos-nt-from option")).toHaveText(["all senders", "demo", ...expected().notifications.senders]);
});
