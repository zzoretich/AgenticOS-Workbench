// Pulse with its write surface on (AOS_APP_WRITE=pulse): the promote trail's keep, edit and revert; the Fix Queue's
// runtime re-runs (the uncosted-sessions backfill, the brain rebuild); the cost anchor; and the deck's /scan and
// /reflect-week (app-smoke P5, P6). The trail's writes are compared byte for byte with what data/promoteTrail.ts
// writes. The Fix Queue and the deck run runtime scripts; the tests check what those scripts leave behind.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, content, guardWrites, notePath, openTab, readVaultJson, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "pulse" } });

const MEMORY = "brain/memory/reference/release-checklist.md";
const TRAIL = "brain/_index/promote-log.jsonl";
const read = (rel: string): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);
const pristine = (rel: string) => fs.readFileSync(path.join(FX.pristine, "vault", rel), "utf8");
const INDEX_LINE = "- [Release checklist](brain/memory/reference/release-checklist.md) — tag, build, smoke-test, publish\n";

const trailRows = (win: Page) => content(win).locator(".aos-trail .aos-trail-row");
const pendingRow = (win: Page) => trailRows(win).filter({ has: win.locator(".aos-trail-actions") });
const fixCard = (win: Page, title: string | RegExp) => content(win).locator(".aos-pulse-fixq .aos-pulse-fix", { has: win.locator(".aos-pulse-fix-title", { hasText: title }) });
const deck = (win: Page, name: string) => content(win).locator(".aos-deck-btn", { hasText: new RegExp(`^${name.replace("/", "\\/")}\\b`) });

/**
 * What a trail action appends, as data/promoteTrail.ts writes it: the entry's own keys in their order, with a fresh ts
 * and the action. Checks everything but the ts, and that the file is the pristine trail plus exactly that one line.
 */
function expectAppended(action: string): void {
  const before = pristine(TRAIL);
  const now = read(TRAIL)!;
  expect(now.startsWith(before)).toBe(true);
  const added = now.slice(before.length);
  expect(added.endsWith("\n")).toBe(true);
  expect(added.slice(0, -1)).not.toContain("\n");
  const entry = JSON.parse(before.trim().split("\n").pop()!) as Record<string, string>;
  const row = JSON.parse(added) as Record<string, string>;
  expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(added).toBe(`${JSON.stringify({ ...entry, ts: row.ts, action })}\n`);
}

/** Puts the unreviewed memory, its index line and the trail back, and waits for the row to offer its actions again. */
async function resetTrail(win: Page): Promise<void> {
  for (const rel of [MEMORY, "MEMORY.md", TRAIL]) fs.writeFileSync(FX.v(rel), pristine(rel));
  await expect(pendingRow(win)).toHaveCount(1);
  await expect(pendingRow(win).locator(".aos-trail-name")).toHaveText("Release checklist");
}

test.beforeEach(async () => { await openTab(app().win, "pulse"); });

test.afterEach(async () => {
  // Every write in this file is Pulse's own, and every spawn it made ran.
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

test("Pulse is the one surface on: the status bar names it and what it may touch", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Pulse");
  await expect(mode).toHaveAttribute("title", /^Pulse: brain\/memory\/\*\*\/\*\.md, MEMORY\.md, brain\/_index\/promote-log\.jsonl, auto-cost\.js, heartbeat-writer\.js, graph-build\.js, build-brain-md\.js, map-workspace\.js, cost-budget\.js, sdk\/reflect-week\.js\n/);
});

test("trail keep marks the memory reviewed and records a kept line; the row's actions go", async () => {
  const { win } = app();
  await resetTrail(win);
  await pendingRow(win).locator(".aos-trail-actions a", { hasText: "keep" }).click();
  await expect.poll(() => read(MEMORY)).toBe(pristine(MEMORY).replace("reviewed: false", "reviewed: true"));
  await expect.poll(() => read(TRAIL)!.length).toBeGreaterThan(pristine(TRAIL).length);
  expectAppended("kept");
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await expect(trailRows(win).first().locator(".aos-trail-chip")).toHaveText("KEPT");
  await expect(trailRows(win).first().locator(".aos-trail-name")).toHaveText("Release checklist");
  await expect(pendingRow(win)).toHaveCount(0);
});

test("trail edit records an edited line and opens the memory in the note pane; the file is not touched", async () => {
  const { win } = app();
  await resetTrail(win);
  await pendingRow(win).locator(".aos-trail-actions a", { hasText: "edit" }).click();
  await expect(notePath(win)).toHaveText(MEMORY);
  await expect.poll(() => read(TRAIL)!.length).toBeGreaterThan(pristine(TRAIL).length);
  expectAppended("edited");
  expect(read(MEMORY)).toBe(pristine(MEMORY));
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await closeNotes(win);
  await openTab(win, "pulse");
  // Still unreviewed: the written row keeps its actions, under the new EDITED line.
  await expect(trailRows(win).first().locator(".aos-trail-chip")).toHaveText("EDITED");
  await expect(pendingRow(win)).toHaveCount(1);
});

test("trail revert deletes the memory and its MEMORY.md line and records a reverted line, without asking (upstream finding 4)", async () => {
  const { win } = app();
  await resetTrail(win);
  expect(pristine("MEMORY.md")).toContain(INDEX_LINE);
  await pendingRow(win).locator(".aos-trail-actions a", { hasText: "revert" }).click();
  await expect.poll(() => read(MEMORY)).toBeNull();
  await expect(win.locator(".modal")).toHaveCount(0);
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md").replace(INDEX_LINE, ""));
  await expect.poll(() => read(TRAIL)!.length).toBeGreaterThan(pristine(TRAIL).length);
  expectAppended("reverted");
  await expect(trailRows(win).first().locator(".aos-trail-chip")).toHaveText("REVERTED");
  await expect(pendingRow(win)).toHaveCount(0);
  await resetTrail(win);
});

test("Fix Queue: the uncosted-sessions card runs the auto-cost backfill, which costs them, and the card goes", async () => {
  const { win } = app();
  const card = fixCard(win, "2 session(s) missing cost");
  await expect(card.locator("a")).toHaveText("▶ run auto-cost.js --backfill");
  const costs = read("brain/_index/agent-runs/costs.jsonl") ?? "";
  await card.locator("a").click();
  await expect(win.locator(".notice-container")).toContainText("▶ auto-cost.js --backfill");
  await expect.poll(() => (read("brain/_index/agent-runs/costs.jsonl") ?? "").length, { timeout: 30_000 }).toBeGreaterThan(costs.length);
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});

test("Fix Queue: the stale-artifacts card rebuilds the brain artifacts with build-brain-md.js", async () => {
  const { win } = app();
  const card = fixCard(win, /^\d+ stale artifact\(s\)$/);
  await expect(card.locator("a")).toHaveText("▶ run build-brain-md.js");
  const brain = FX.v("brain/_index/BRAIN.md");
  const mtime = fs.statSync(brain).mtimeMs;
  await card.locator("a").click();
  await expect(win.locator(".notice-container")).toContainText("▶ build-brain-md.js");
  await expect.poll(() => fs.statSync(brain).mtimeMs, { timeout: 30_000 }).toBeGreaterThan(mtime);
});

test("Fix Queue: re-anchor asks for the billed figure, refuses a bad one, and cost-budget.js stamps the anchor", async () => {
  const { win } = app();
  const card = fixCard(win, "Cost tracking not yet anchored");
  expect(read("brain/_index/cost-budget.json")).toBeNull();
  await card.locator("a", { hasText: "▶ re-anchor…" }).click();
  const modal = win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Re-anchor cost budget");
  const input = modal.locator(".setting-item input[type=text]");
  const anchor = modal.locator("button.mod-cta", { hasText: "Anchor" });
  // A negative or unreadable figure keeps the dialog open and runs nothing.
  for (const bad of ["-5", "lots"]) {
    await input.fill(bad);
    await anchor.click();
    await expect(modal).toBeVisible();
  }
  await input.fill("42.50");
  await anchor.click();
  await expect(modal).toHaveCount(0);
  await expect(win.locator(".notice-container")).toContainText("▶ cost-budget.js --anchor 42.5");
  const month = new Date().toISOString().slice(0, 7);
  await expect.poll(() => (read("brain/_index/cost-budget.json") ?? "").length, { timeout: 30_000 }).toBeGreaterThan(0);
  const budget = readVaultJson<Record<string, unknown>>("brain/_index/cost-budget.json");
  expect(JSON.stringify(budget)).toContain(month);
  expect(JSON.stringify(budget)).toContain("42.5");
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});

test("deck /scan runs scan-vault.js and reports its summary (P5)", async () => {
  const { win } = app();
  const snapshot = FX.v("brain/_index/snapshot.json");
  const mtime = fs.statSync(snapshot).mtimeMs;
  await deck(win, "/scan").click();
  await expect(win.locator(".notice-container")).toContainText("▶ /scan");
  await expect(win.locator(".notice-container")).toContainText(/✓ \/scan: scanned \d+ folders/, { timeout: 30_000 });
  expect(fs.statSync(snapshot).mtimeMs).toBeGreaterThan(mtime);
});

test("deck /reflect-week runs reflect-week.js --local; with no provider it reports why and writes no reflection (P6)", async () => {
  const { win } = app();
  const dir = FX.v("brain/reflections");
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  await deck(win, "/reflect-week").click();
  await expect(win.locator(".notice-container")).toContainText("▶ /reflect-week");
  await expect(win.locator(".notice-container")).toContainText("✗ /reflect-week: [reflect] no model provider for the reasoner", { timeout: 30_000 });
  expect(fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []).toEqual(before);
});

test("with only Pulse on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
