// To-Do (app-smoke: To-Do) with its write surface off: TODO.md in Tasks syntax grouped into Overdue / Today /
// Upcoming / Someday by priority, tag chips, done this week, the live badge, the edit box's cancel path, and a tick
// refused. The writes themselves (quick-add, tick, edits, the stale-write guard) are in todo-writes.spec.ts.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { FX, badge, content, day, expected, guardWrites, noteBody, notePath, openTab, rail, useApp } from "./harness";

const app = useApp();
const td = (win: import("@playwright/test").Page) => content(win);

test.beforeEach(async () => { await openTab(app().win, "todo"); });

test("head counts and the four groups, with late / today / tomorrow markers", async () => {
  const { win } = app();
  const e = expected().todo;
  await expect(td(win).locator(".aos-rt-count")).toHaveText(`${e.open} open · ${e.overdue} overdue · ${e.today} today`);
  const heads = td(win).locator(".aos-rt-subhead").filter({ hasNotText: "DONE THIS WEEK" });
  await expect(heads).toHaveText([`OVERDUE (${e.overdue})`, `TODAY (${e.today})`, `UPCOMING (${e.upcoming})`, `SOMEDAY (${e.someday})`]);
  await expect(heads.nth(0)).toHaveClass(/aos-text-rose/);
  await expect(heads.nth(1)).toHaveClass(/aos-text-amber/);
  const tables = td(win).locator(".aos-rt-table");
  const texts = async (i: number) => (await tables.nth(i).locator(".aos-td-text").allTextContents()).map((t) => t.trim());
  // Within a group: 🔺 ⏫ 🔼 (none) 🔽, then by date.
  expect(await texts(0)).toEqual(["Renew the sample domain", "File the quarterly notes"]);
  expect(await texts(1)).toEqual(["Review the tide parser PR", "Call the chart vendor"]);
  expect(await texts(2)).toEqual(["Draft the release notes", "Plan the offline sync spike"]);
  expect(await texts(3)).toEqual(["Read the field guide", "Sort the old survey photos"]);
  await expect(tables.nth(0).locator(".aos-td-when")).toHaveText(["3d late", "1d late"]);
  await expect(tables.nth(0).locator(".aos-td-when").first()).toHaveClass(/aos-text-rose/);
  await expect(tables.nth(1).locator(".aos-td-when")).toHaveText(["today", "today"]);
  await expect(tables.nth(2).locator(".aos-td-when")).toHaveText(["tomorrow"]);
  // Each open row: checkbox, priority button, date picker, delete.
  const first = tables.nth(0).locator(".aos-td-row").first();
  await expect(first.locator(".aos-td-prio-btn")).toHaveText("⏫");
  await expect(first.locator("input.aos-td-date")).toHaveValue(day(-3));
  await expect(first.locator(".aos-td-check")).not.toBeChecked();
  await expect(tables.nth(0).locator(".aos-td-row").nth(1).locator(".aos-td-prio-btn")).toHaveText("·");
});

test("quick-add row: text box, priority picker and date picker", async () => {
  const { win } = app();
  await expect(td(win).locator("input.aos-td-input")).toHaveAttribute("placeholder", /Add a todo/);
  await expect(td(win).locator("select.aos-td-prio option")).toHaveText(["no priority", "⏫ high", "🔼 medium", "🔽 low"]);
  await expect(td(win).locator(".aos-td-add input.aos-td-date")).toHaveAttribute("type", "date");
});

test("tag chips filter the list; a row's tag filters by it; all clears", async () => {
  const { win } = app();
  const e = expected().todo;
  await expect(td(win).locator(".aos-td-tags .aos-td-tagchip")).toHaveText(["all", ...e.tags.map((t) => `#${t}`)]);
  await td(win).locator(".aos-td-tagchip", { hasText: "#harbor" }).click();
  await expect(td(win).locator(".aos-td-text")).toHaveText(["Review the tide parser PR", "Call the chart vendor", "Draft the release notes"]);
  await expect(td(win).locator(".aos-td-tagchip", { hasText: "#harbor" })).toHaveClass(/aos-pill-cyan/);
  await td(win).locator(".aos-td-row", { hasText: "Draft the release notes" }).locator(".aos-td-tag").click();
  await expect(td(win).locator(".aos-td-text")).toHaveCount(3);
  await td(win).locator(".aos-td-tagchip", { hasText: /^all$/ }).click();
  await td(win).locator(".aos-td-row", { hasText: "Renew the sample domain" }).locator(".aos-td-tag", { hasText: "#admin" }).click();
  await expect(td(win).locator(".aos-td-text")).toHaveText(["Renew the sample domain", "File the quarterly notes"]);
  await td(win).locator(".aos-td-tagchip", { hasText: /^all$/ }).click();
  await expect(td(win).locator(".aos-td-row:not(.is-done)")).toHaveCount(e.open);
});

test("▸ DONE THIS WEEK expands to the items ticked in the last seven days", async () => {
  const { win } = app();
  const head = td(win).locator(".aos-rt-subhead", { hasText: "DONE THIS WEEK" });
  await expect(head).toHaveText(`▸ DONE THIS WEEK (${expected().todo.doneThisWeek})`);
  await head.click();
  await expect(td(win).locator(".aos-rt-subhead", { hasText: "DONE THIS WEEK" })).toHaveText(/^▾/);
  const done = td(win).locator(".aos-td-row.is-done");
  await expect(done).toHaveCount(1);
  await expect(done.locator(".aos-td-text")).toHaveText("Set up the fixture vault");
  await expect(done.locator(".aos-td-when")).toHaveText(`✅ ${day(-1)}`);
  await expect(done.locator(".aos-td-check")).toBeChecked();
  await td(win).locator(".aos-rt-subhead", { hasText: "DONE THIS WEEK" }).click();
  await expect(td(win).locator(".aos-td-row.is-done")).toHaveCount(0);
});

test("double-click edits the whole line, tokens included; Escape cancels and writes nothing", async () => {
  const h = app();
  const { win } = h;
  const before = await guardWrites(h);
  await td(win).locator(".aos-td-text", { hasText: "Call the chart vendor" }).dblclick();
  const edit = td(win).locator("input.aos-td-edit");
  await expect(edit).toHaveValue(`Call the chart vendor 📅 ${day(0)} #harbor`);
  await expect(edit).toBeFocused();
  await win.keyboard.press("Escape");
  await expect(td(win).locator("input.aos-td-edit")).toHaveCount(0);
  await expect(td(win).locator(".aos-td-text", { hasText: "Call the chart vendor" })).toBeVisible();
  expect(await guardWrites(h)).toEqual(before);
});

test("open TODO.md opens the file in a new tab, rendered with task boxes", async () => {
  const { win } = app();
  await td(win).locator("button", { hasText: "open TODO.md" }).click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("TODO");
  await expect(notePath(win)).toHaveText("TODO.md");
  await expect(noteBody(win).locator("input.task-list-item-checkbox")).toHaveCount(expected().todo.open + 2);
  await win.locator(".aos-host-tab", { hasText: "TODO" }).locator(".aos-host-tab-close").click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("Workbench");
});

test("badge counts overdue + today and follows a hand edit of TODO.md within a second, with another tab active", async () => {
  const { win } = app();
  const e = expected().todo;
  await expect(badge(win, "todo")).toHaveText(String(e.badge));
  await openTab(win, "memory");
  const file = FX.v("TODO.md");
  const text = fs.readFileSync(file, "utf8");
  // What `/todo Pay the mooring fee` in a session would append.
  fs.writeFileSync(file, text.replace("## Open\n\n", `## Open\n\n- [ ] Pay the mooring fee 📅 ${day(0)} #harbor\n`));
  await expect(badge(win, "todo")).toHaveText(String(e.badge + 1), { timeout: 3000 });
  await openTab(win, "todo");
  await expect(td(win).locator(".aos-rt-count")).toHaveText(`${e.open + 1} open · ${e.overdue} overdue · ${e.today + 1} today`);
  fs.writeFileSync(file, text);
  await expect(badge(win, "todo")).toHaveText(String(e.badge), { timeout: 3000 });
  await expect(rail(win, "todo")).toHaveClass(/is-active/);
});

test("with the To-Do surface off, a tick is refused: TODO.md is unchanged and the Notice says why", async () => {
  const h = app();
  const { win } = h;
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  const writes = await guardWrites(h);
  await td(win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect(win.locator(".notice-container")).toContainText("To-Do: UniDeX: write TODO.md refused; no write surface that allows it is on");
  expect((await guardWrites(h)).slice(writes.length)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  // The HUD re-renders after a stale line but not after other failed writes, so the box keeps the click until the next
  // render (upstream, in Obsidian too). Re-opening the tab shows the file as it is.
  const box = () => td(win).locator(".aos-td-row:not(.is-done)", { hasText: "Call the chart vendor" }).locator(".aos-td-check");
  await expect(box()).toBeChecked();
  await openTab(win, "memory");
  await openTab(win, "todo");
  await expect(box()).not.toBeChecked();
});
