// Routines (plugin-smoke: Routines): every brain/routines/*.md with cadence, next fire, last run and health after
// `aos routines sync` (launchctl stubbed) and two manual runs; guarded duties; the read-only rows outside the runtime
// (a launchd label from routines.externalLabels and the imported Claude Code cloud routines); the editor drawer's
// cron preview; with the Routines surface off, on/off, ▶ and apply schedules are refused. The writes themselves (create,
// save, on-off, delete, ▶, apply schedules) are in routines-writes.spec.ts.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { FX, content, drawer, guardWrites, openTab, readVaultJson, useApp } from "./harness";

const app = useApp();
const C = () => content(app().win);
const row = (slug: string) => C().locator(".aos-rt-row", { has: app().win.locator(".aos-rt-slug", { hasText: new RegExp(`^${slug}( · guarded)?$`) }) });

test.beforeEach(async () => { await openTab(app().win, "routines"); });

test("lists every routine file with kind, cadence, next fire, last run and a health chip", async () => {
  const files = fs.readdirSync(FX.v("brain/routines")).filter((f) => f.endsWith(".md") && f !== "README.md");
  await expect(C().locator(".aos-rt-table").first().locator(".aos-rt-row")).toHaveCount(files.length);
  await expect(C().locator(".aos-rt-count")).toHaveText(`${files.length - 1} on · ${files.length} total`);
  await expect(C().locator(".aos-rt-banner")).toHaveCount(0);   // synced: no "schedules out of date"
  const scan = row("nightly-scan");
  await expect(scan.locator(".aos-pill")).toHaveText("command");
  await expect(scan.locator(".aos-rt-cadence")).toHaveText("Every day at 02:15");
  await expect(scan.locator(".aos-rt-cadence")).toHaveAttribute("title", "15 2 * * *");
  await expect(scan.locator(".aos-rt-next")).toHaveText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}-\d{2} 02:15$/);
  await expect(scan.locator(".aos-rt-last")).toHaveText(/ago · exit 0$/);
  await expect(scan.locator(".aos-pulse-chip")).toHaveText("ok");
  await expect(scan.locator(".aos-rt-rowactions a")).toHaveText(["▶", "on", "✎"]);
  const state = readVaultJson<{ runs?: Record<string, { lastTrigger?: string }> }>("brain/_index/routines.json");
  expect(JSON.stringify(state)).toContain("nightly-scan");
});

test("the persona's duties are guarded; a disabled routine dims and has no next fire", async () => {
  for (const duty of ["monitor", "reflect", "sitrep"]) {
    await expect(row(duty).locator(".aos-rt-slug")).toHaveText(`${duty} · guarded`);
    await expect(row(duty).locator(".aos-pill")).toHaveText("duty");
  }
  await expect(row("monitor").locator(".aos-rt-last")).toHaveText("never");
  const off = row("weekly-digest");
  await expect(off).toHaveClass(/is-off/);
  await expect(off.locator(".aos-rt-next")).toHaveText("—");
  await expect(off.locator(".aos-rt-rowactions a").nth(1)).toHaveText("off");
});

test("outside the runtime: the launchd label and the Claude Code cloud routines, read-only", async () => {
  const sub = C().locator(".aos-rt-subhead", { hasText: "OUTSIDE THE RUNTIME" });
  await expect(sub.locator(".aos-rt-asof")).toContainText(/claude as of \d+[smhd] ago/);
  await expect(sub.locator(".aos-rt-asof a")).toHaveText("refresh");
  const ext = C().locator(".aos-rt-table").nth(1);
  const launchd = ext.locator(".aos-rt-row", { hasText: "com.sample.nightly-backup" });
  await expect(launchd.locator(".aos-pill")).toHaveText("launchd");
  await expect(launchd.locator(".aos-rt-cadence")).toHaveText("Every day at 03:30");
  await expect(launchd.locator(".aos-pulse-chip")).toHaveText("read-only");
  // The Obsidian Git plugin's backup timer, from .obsidian/plugins/obsidian-git/data.json.
  const git = ext.locator(".aos-rt-row", { hasText: "Vault backup" });
  await expect(git.locator(".aos-pill")).toHaveText("obsidian");
  await expect(git.locator(".aos-rt-cadence")).toHaveText("backup every 30 min (after a change), pull every 60 min");
  await expect(git.locator(".aos-pulse-chip")).toHaveText("read-only");
  const weekly = ext.locator(".aos-rt-row", { hasText: "Weekly chart digest" });
  await expect(weekly.locator(".aos-pill")).toHaveText("claude");
  await expect(weekly.locator(".aos-pill")).toHaveClass(/aos-pill-cyan/);
  await expect(weekly.locator("a")).toHaveAttribute("href", "https://claude.ai/code/routines/trig_sample_01");
  await expect(weekly.locator(".aos-rt-cadence")).toHaveText("Mondays at 13:00 (UTC)");
  await expect(weekly.locator(".aos-pulse-chip")).toHaveText("active");
  const once = ext.locator(".aos-rt-row", { hasText: "Launch-day check" });
  await expect(once.locator(".aos-rt-cadence")).toHaveText(/^once at /);
  await expect(once.locator(".aos-pulse-chip")).toHaveText("ran once");
  await expect(once).toHaveClass(/is-off/);
  // Read-only rows carry no actions.
  await expect(ext.locator(".aos-rt-rowactions")).toHaveCount(0);
});

test("a cloud routine's name links to claude.ai; the link goes to the OS browser, not into the app", async () => {
  const h = app();
  await C().locator(".aos-rt-row a", { hasText: "Weekly chart digest" }).click();
  await expect.poll(async () => (await h.opened()).map((o) => `${o.via} ${o.fn} ${o.arg}`)).toContain("main openExternal https://claude.ai/code/routines/trig_sample_01");
  await expect(h.win.locator(".aos-wb-rail")).toBeVisible();   // navigation was blocked; the Workbench is still here
});

test("+ new opens the editor: an invalid cron shows the runtime's error, a valid one the cadence and next three fires", async () => {
  const h = app();
  const writes = await guardWrites(h);
  await C().locator(".aos-rt-actions button", { hasText: "+ new" }).click();
  const d = drawer(h.win);
  await expect(d.locator(".aos-wb-drawertitle")).toHaveText("⌜ NEW ROUTINE ⌝");
  await expect(d.locator(".aos-rt-field label")).toContainText(["slug", "name", "kind", "schedule (cron: min hour day month weekday)", "enabled"]);
  const schedule = d.locator(".aos-rt-field", { hasText: "schedule (cron" }).locator("input");
  await schedule.fill("61 * * * *");
  const preview = d.locator(".aos-rt-preview");
  await expect(preview).toHaveClass(/is-error/);
  await expect(preview).not.toBeEmpty();
  await schedule.fill("30 9 * * 1-5");
  await expect(preview).not.toHaveClass(/is-error/);
  await expect(preview.locator("div")).toHaveCount(4);
  await expect(preview.locator("div").first()).toHaveText("Weekdays at 09:30");
  await expect(preview.locator("div").nth(1)).toHaveText(/(Mon|Tue|Wed|Thu|Fri) \d{2}-\d{2} 09:30$/);
  // The kind picker swaps the kind-specific fields.
  await d.locator(".aos-rt-field", { hasText: /^kind/ }).locator("select").selectOption("command");
  await expect(d.locator("textarea.aos-rt-argv")).toBeVisible();
  await expect(d.locator(".aos-capture-actions button")).toHaveText(["create"]);
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  expect(await guardWrites(h)).toEqual(writes);
});

test("✎ on a guarded duty opens its editor with the guarded note and the slug locked", async () => {
  await row("monitor").locator(".aos-rt-rowactions a", { hasText: "✎" }).click();
  const d = drawer(app().win);
  await expect(d.locator(".aos-wb-drawertitle")).toHaveText("⌜ EDIT monitor ⌝");
  await expect(d.locator(".aos-rt-guard")).toContainText("guarded: the persona contract covers this duty");
  await expect(d.locator(".aos-rt-field", { hasText: /^slug/ }).locator("input")).toBeDisabled();
  await expect(d.locator(".aos-rt-note")).toHaveText("runs persona/duties/monitor.md through run-duty.sh (persona caps and journal apply)");
  await expect(d.locator(".aos-capture-actions button")).toHaveText(["delete", "save"]);
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
});

test("changing a guarded duty's schedule asks first; Cancel writes nothing", async () => {
  const h = app();
  const writes = await guardWrites(h);
  const before = fs.readFileSync(FX.v("brain/routines/monitor.md"), "utf8");
  await row("monitor").locator(".aos-rt-rowactions a", { hasText: "✎" }).click();
  const d = drawer(h.win);
  await d.locator(".aos-rt-field", { hasText: "schedule (cron" }).locator("input").fill("0 14 * * *");
  await d.locator(".aos-capture-actions button", { hasText: "save" }).click();
  const modal = h.win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Guarded routine");
  await expect(modal.locator("p")).toContainText("monitor is one of the persona's duties.");
  await expect(modal.locator("button.mod-cta")).toHaveText("Write anyway");
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(h.win.locator(".modal")).toHaveCount(0);
  expect(await guardWrites(h)).toEqual(writes);
  expect(fs.readFileSync(FX.v("brain/routines/monitor.md"), "utf8")).toBe(before);
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
});

test("with the Routines surface off, on/off, ▶ and apply schedules are refused: nothing is written or run, and the Notices say why", async () => {
  const h = app();
  const writes = await guardWrites(h);
  const before = fs.readFileSync(FX.v("brain/routines/weekly-digest.md"), "utf8");
  const syncedAt = readVaultJson<{ syncedAt: string | null }>("brain/_index/routines.json").syncedAt;
  await row("weekly-digest").locator(".aos-rt-rowactions a", { hasText: "off" }).click();
  await expect(h.win.locator(".notice-container")).toContainText("toggle failed: AgenticOS app: write brain/routines/weekly-digest.md refused; no write surface that allows it is on");
  expect(await guardWrites(h)).toEqual([...writes, "write brain/routines/weekly-digest.md"]);
  await row("nightly-scan").locator(".aos-rt-rowactions a", { hasText: "▶" }).click();
  await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/routines/run-routine.js");
  await C().locator(".aos-rt-actions button", { hasText: "apply schedules" }).click();
  await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/cli/aos.js");
  // The failed toggle never reached its sync: the two refused spawns are ▶ and apply schedules.
  await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what))
    .toEqual([expect.stringMatching(/\/routines\/run-routine\.js nightly-scan --manual$/), expect.stringMatching(/\/cli\/aos\.js routines sync$/)]);
  expect(fs.readFileSync(FX.v("brain/routines/weekly-digest.md"), "utf8")).toBe(before);
  expect(readVaultJson<{ syncedAt: string | null }>("brain/_index/routines.json").syncedAt).toBe(syncedAt);
  await expect(row("weekly-digest")).toHaveClass(/is-off/);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
