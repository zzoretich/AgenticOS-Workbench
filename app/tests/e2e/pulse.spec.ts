// Pulse (plugin-smoke: Pulse, Review readiness): pipeline LEDs from the runtime's ledger, the persona-named briefing,
// COST and HEALTH rows, the Fix Queue, the command deck, auto-promoted memories, the SYSTEM drawer and the embedded
// terminal. With the Pulse surface off, a trail keep and a Fix Queue run are refused. The writes themselves (keep /
// edit / revert, the Fix Queue runs, re-anchor, /scan, /reflect-week) are in pulse-writes.spec.ts.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { FX, closeNotes, content, drawer, expected, guardWrites, noteBody, notePath, openTab, rail, readVaultJson, useApp } from "./harness";

const app = useApp();

interface Snapshot { health: { issues: Array<{ severity: string; area: string }> } }
interface Ledger { pipelines: Record<string, { lastRun: { status: string; reason?: string | null } | null }> }

test.beforeEach(async () => { await openTab(app().win, "pulse"); });

test("LEDs: every manifest pipeline; never-ran and disabled stages are gray with the reason on hover; nothing red", async () => {
  const { win } = app();
  const strip = win.locator(".aos-pulse-strip .aos-pulse-chip");
  const labels = (await strip.allTextContents()).map((t) => t.trim());
  for (const short of ["SCAN", "WRAP", "COST", "BACKFILL", "STAFF", "MAP", "AWRAP", "BRAIN", "EMBED", "GRAPH", "SEM"]) {
    expect(labels.some((l) => l.startsWith(`${short} `)), `LED ${short}`).toBe(true);
  }
  // Ledger rows beyond the manifest (the routine runs) get a chip of their own.
  const ledger = readVaultJson<Ledger>("brain/_index/pipelines.json");
  for (const name of Object.keys(ledger.pipelines).filter((n) => n.startsWith("routine:"))) {
    expect(labels).toContainEqual(expect.stringMatching(new RegExp(`^${name.toUpperCase()} `)));
  }
  expect(labels).toContain("EMBED off");
  const embed = win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: "EMBED off" });
  await expect(embed).toHaveClass(/is-neutral/);
  await expect(embed).toHaveAttribute("title", /embed-vault: disabled — no-embed/);
  await expect(win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: "GRAPH off" })).toHaveAttribute("title", /graphify missing/);
  const wrap = win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: /^WRAP/ });
  await expect(wrap).toHaveClass(/is-neutral/);
  await expect(wrap).toHaveAttribute("title", "session-summary: no recorded runs yet");
  await expect(win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: /^SCAN ok/ })).toHaveClass(/is-ok/);
  await expect(win.locator(".aos-pulse-strip .aos-pulse-chip.is-failed, .aos-pulse-strip .aos-pulse-chip.is-died")).toHaveCount(0);
});

test("briefing row is labelled with the persona's name from persona/IDENTITY.md", async () => {
  const { win } = app();
  await expect(win.locator(".aos-pulse-briefing .aos-briefing-label")).toHaveText(expected().persona.toUpperCase());
  await expect(win.locator(".aos-pulse-briefing .aos-briefing-text")).toContainText("health");
});

test("COST row (cost on, a $175 budget) and HEALTH row counts", async () => {
  const { win } = app();
  const cost = win.locator(".aos-pulse-row", { has: win.locator(".aos-pulse-rowlabel", { hasText: /^COST$/ }) });
  await expect(cost).toContainText(/\$[\d.]+ this month · [\d.]+% of \$175\.00/);
  const issues = readVaultJson<Snapshot>("brain/_index/snapshot.json").health.issues;
  const errs = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  const health = win.locator(".aos-pulse-row", { has: win.locator(".aos-pulse-rowlabel", { hasText: /^HEALTH$/ }) });
  await expect(health).toContainText(`${errs} err · ${warns} warn`);
  await expect(health.locator("span").nth(1)).toHaveClass(errs ? /aos-text-rose/ : /aos-text-amber/);
});

test("Fix Queue: health errors, stale artifacts, the cost anchor and the uncosted sessions, errors first", async () => {
  const { win } = app();
  const issues = readVaultJson<Snapshot>("brain/_index/snapshot.json").health.issues;
  const errs = issues.filter((i) => i.severity === "error").length;
  const stale = issues.filter((i) => i.area === "artifacts").length;
  const cards = win.locator(".aos-pulse-fixq .aos-pulse-fix");
  const titles = (await cards.locator(".aos-pulse-fix-title").allTextContents()).map((t) => t.trim());
  const want = [
    ...(errs ? [`${errs} health error(s)`] : []),
    ...(stale ? [`${stale} stale artifact(s)`] : []),
    "Cost tracking not yet anchored",
    "2 session(s) missing cost",
  ];
  expect(titles).toEqual(want);
  await expect(win.locator(".aos-pulse-fixq-title")).toHaveText(`⌜ FIX QUEUE (${want.length}) ⌝`);
  await expect(cards.first()).toHaveClass(/is-error/);
  await expect(cards.filter({ hasText: "2 session(s) missing cost" }).locator("a")).toHaveText("▶ run auto-cost.js --backfill");
  await expect(cards.filter({ hasText: "Cost tracking not yet anchored" }).locator("a")).toHaveText("▶ re-anchor…");
});

test("Fix Queue: ▸ open on the health card opens brain/_index/health.md", async () => {
  const { win } = app();
  await win.locator(".aos-pulse-fix", { hasText: "health error(s)" }).locator("a", { hasText: "▸ open" }).click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("health");
  await expect(notePath(win)).toHaveText("brain/_index/health.md");
  await expect(noteBody(win)).toContainText("CLAUDE.md is missing");
  await closeNotes(win);
});

test("command deck lists the registry commands with their kind and description", async () => {
  const { win } = app();
  const deck = win.locator(".aos-pulse-deck");
  await expect(deck.locator(".aos-deck-label")).toHaveText("[ COMMAND DECK ]");
  const names = (await deck.locator(".aos-deck-btn").allTextContents()).map((t) => t.trim());
  expect(names).toEqual(expect.arrayContaining(["/scan", "/reflect-week", "/remember", "/pattern", "/wrap", "/ask-brain"]));
  await expect(deck.locator(".aos-deck-btn", { hasText: "/scan" })).toHaveAttribute("title", /· /);
});

test("command deck: /brain opens BRAIN.md; /remember and /pattern open their forms, and Cancel writes nothing", async () => {
  const h = app();
  const { win } = h;
  const writes = await guardWrites(h);
  const deck = win.locator(".aos-pulse-deck");
  await deck.locator(".aos-deck-btn", { hasText: "/brain" }).click();
  await expect(notePath(win)).toHaveText("brain/_index/BRAIN.md");
  await closeNotes(win);
  await deck.locator(".aos-deck-btn", { hasText: "/remember" }).click();
  const modal = win.locator(".modal");
  await expect(modal.locator("h2")).toHaveText("Remember");
  await expect(modal.locator("textarea")).toHaveAttribute("placeholder", "A note for this session's working memory…");
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(win.locator(".modal")).toHaveCount(0);
  await deck.locator(".aos-deck-btn", { hasText: "/pattern" }).click();
  await expect(win.locator(".modal .modal-content")).toContainText(/area/i);
  await win.keyboard.press("Escape");
  await expect(win.locator(".modal")).toHaveCount(0);
  // ⌘⇧M: the plugin's own hotkey for Quick Capture, dispatched by the host.
  await win.keyboard.press("Meta+Shift+M");
  await expect(win.locator(".modal .modal-content")).toContainText("Quick Capture");
  await win.keyboard.press("Escape");
  expect(await guardWrites(h)).toEqual(writes);
});

test("recently auto-promoted: newest first; the unreviewed memory offers keep / edit / revert", async () => {
  const { win } = app();
  const rows = win.locator(".aos-trail .aos-trail-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator(".aos-trail-chip")).toHaveText("WRITTEN");
  await expect(rows.nth(0).locator(".aos-trail-name")).toHaveText("Release checklist");
  await expect(rows.nth(0).locator(".aos-trail-actions a")).toHaveText(["keep", "edit", "revert"]);
  await expect(rows.nth(1).locator(".aos-trail-chip")).toHaveText("KEPT");
  await expect(rows.nth(1).locator(".aos-trail-name")).toHaveText("Tide API notes");
  // A written memory that is no longer unreviewed has no actions.
  await expect(rows.nth(2).locator(".aos-trail-actions")).toHaveCount(0);
});

test("SYSTEM drawer: inventory counts and lists, the DISK donut and the COST DETAIL sparkline as SVG", async () => {
  const { win } = app();
  await win.locator(".aos-pulse-row a", { hasText: "SYSTEM ▸" }).click();
  const d = drawer(win);
  await expect(d).toHaveClass(/is-open/);
  await expect(d.locator(".aos-wb-drawertitle")).toHaveText("⌜ SYSTEM ⌝");
  const inv = d.locator(".aos-panel", { hasText: "INVENTORY" });
  await expect(inv.locator(".aos-inv-strip .aos-pill")).toHaveText(["0 agents", "0 skills", "1 commands", "0 hooks"]);
  await inv.locator(".aos-inv-tab", { hasText: "commands (1)" }).click();
  await expect(inv.locator(".aos-inv-table .aos-inv-name")).toHaveText(["/standup-lite"]);
  await inv.locator(".aos-inv-input").fill("zzz");
  await expect(inv.locator(".aos-inv-table")).toContainText("no matches");
  // DISK: a donut built from SVG nodes (no innerHTML) and a legend.
  const disk = d.locator(".aos-panel", { hasText: "DISK" });
  await expect(disk.locator(".aos-disk-chart svg")).toHaveCount(1);
  expect(await disk.locator(".aos-disk-chart svg *").count()).toBeGreaterThan(1);
  expect(await disk.locator(".aos-disk-legend-row").count()).toBeGreaterThan(1);
  // COST DETAIL: tiles, the budget bar and a sparkline SVG.
  const cost = d.locator(".aos-panel", { hasText: "COST DETAIL" });
  await expect(cost.locator(".aos-panel-title")).toContainText("/$175");
  await expect(cost.locator(".aos-tile-label")).toHaveText(["this month", "budget", "remaining", "projected"]);
  await expect(cost.locator(".aos-trend-spark svg")).toHaveCount(1);
  await expect(cost.locator(".aos-budget-note")).toContainText("(no anchor set)");
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  await expect(d).not.toHaveClass(/is-open/);
});

test("the embedded terminal panel sits under Pulse", async () => {
  const { win } = app();
  const term = win.locator(".aos-pulse-term");
  await expect(term.locator(".aos-term-title")).toHaveText("[ TERMINAL ]");
  await expect(term.locator(".xterm")).toHaveCount(1);
});

test("listener leak: switching Pulse → Memory → Pulse → Term → Pulse does not add terminal-pool listeners", async () => {
  const { win } = app();
  // Obsidian keeps them in Events._; the compat Events keeps them in _handlers.
  const count = () => win.evaluate(() => {
    const pool = (window as unknown as { aosHost: { plugin: { terminalPool: { _handlers: Map<string, unknown[]> } } } }).aosHost.plugin.terminalPool;
    return pool._handlers.get("session-add")?.length ?? 0;
  });
  const cycle = async () => { for (const t of ["memory", "pulse", "term", "pulse"]) await openTab(win, t); };
  await cycle();
  const once = await count();
  for (let i = 0; i < 4; i++) await cycle();
  expect(await count()).toBe(once);
  expect(once).toBeLessThanOrEqual(2);   // the Pulse panel on screen, plus the Term tab's panel kept for its next visit
  await expect(content(win)).toContainText("FIX QUEUE");
  await expect(rail(win, "pulse")).toHaveClass(/is-active/);
});

test("with the Pulse surface off, keep and a Fix Queue run are refused: the memory, the trail and the costs stay as they were", async () => {
  const h = app();
  const memory = FX.v("brain/memory/reference/release-checklist.md");
  const trail = FX.v("brain/_index/promote-log.jsonl");
  const before = [fs.readFileSync(memory, "utf8"), fs.readFileSync(trail, "utf8")];
  const errors = h.errors.length;
  const row = h.win.locator(".aos-trail .aos-trail-row", { has: h.win.locator(".aos-trail-actions") });
  await row.locator(".aos-trail-actions a", { hasText: "keep" }).click();
  await expect.poll(() => guardWrites(h)).toContain("write brain/memory/reference/release-checklist.md");
  // The trail's actions catch nothing: the refusal reaches the console as an unhandled rejection, and no Notice says so.
  await expect.poll(() => h.errors.slice(errors).join("\n")).toContain("brain/memory/reference/release-checklist.md refused");
  h.errors.splice(errors);
  await expect(row).toHaveCount(1);
  await h.win.locator(".aos-pulse-fixq .aos-pulse-fix", { hasText: "session(s) missing cost" }).locator("a").click();
  await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/auto-cost.js");
  await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)).toEqual([expect.stringMatching(/\/auto-cost\.js --backfill$/)]);
  expect([fs.readFileSync(memory, "utf8"), fs.readFileSync(trail, "utf8")]).toEqual(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
