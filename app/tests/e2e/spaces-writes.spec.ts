// Spaces with its write surface on (AOS_APP_WRITE=spaces): Files' Describe N new (for files the map has not described,
// and for a workspace with no map yet), ↻ per file, and the read's ↻ (spec 2026-10-09-spaces-redesign D9, D33). The tab
// writes nothing itself; each action runs a runtime script. The fixture's provider is `none`, so no model is ever
// called: Describe and the read's ↻ take the runtime's heuristic path, and ↻ per file, which has no heuristic, is off
// and says why; with a provider on record it runs, and the runtime's forced `none` stops it in the pipeline ledger.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, guardWrites, openTab, readVaultJson, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "spaces" } });

interface MapFile { path: string; desc: string | null; descAt: string | null; descSource: string | null; status: string }
interface WorkspaceMap { workspace: string; files: MapFile[]; pending: number }
interface Insight { text: string | null; status: string; model: string | null; generatedAt: string | null }

const mapFile = (name: string) => FX.v(`brain/_index/workspace-maps/${name}.json`);
const readMap = (name: string): WorkspaceMap | null => (fs.existsSync(mapFile(name)) ? JSON.parse(fs.readFileSync(mapFile(name), "utf8")) as WorkspaceMap : null);
const pristineMap = (name: string) => JSON.parse(fs.readFileSync(path.join(FX.pristine, "vault", "brain", "_index", "workspace-maps", `${name}.json`), "utf8")) as WorkspaceMap;
const insight = (name: string) => readVaultJson<{ workspaces: Array<{ name: string; insight: Insight }> }>("brain/_index/snapshot.json").workspaces.find((w) => w.name === name)!.insight;
const fileMapRun = () => readVaultJson<{ pipelines: Record<string, { lastRun: { status: string; error?: string | null; startedAt: string } | null }> }>("brain/_index/pipelines.json").pipelines["file-map"]?.lastRun ?? null;

const C = (win: Page) => content(win);
const centre = (win: Page) => C(win).locator(".aos-spc-centre");
const tab = (win: Page, view: "Overview" | "Files") => centre(win).locator(".aos-spc-tab", { hasText: view });
/** Selects a workspace in the list (opening a folded group) and shows `view`. */
async function openWorkspace(win: Page, name: string, view: "Overview" | "Files"): Promise<void> {
  const row = C(win).locator(`.aos-spc-row[data-workspace="${name}"]`);
  if (!(await row.count())) {
    const idle = C(win).locator(".aos-spc-ghead", { has: win.locator(".aos-spc-glabel", { hasText: /^IDLE$/ }) });
    if ((await idle.getAttribute("aria-expanded")) === "false") await idle.click();
  }
  await row.click();
  await expect(centre(win).locator(".aos-spc-h1")).toHaveText(name);
  if ((await tab(win, view).getAttribute("aria-selected")) !== "true") await tab(win, view).click();
  await expect(tab(win, view)).toHaveAttribute("aria-selected", "true");
}
const treeRow = (win: Page, label: string) => centre(win).locator(".aos-spc-tree .aos-spc-trow", { has: win.locator(".aos-spc-tlabel", { hasText: new RegExp(`^${label.replace(/[.]/g, "\\.")}$`) }) });
const mapline = (win: Page) => centre(win).locator(".aos-spc-mapline");
const describe = (win: Page) => centre(win).locator("button.aos-spc-describe");

test.beforeEach(async () => { await openTab(app().win, "spaces"); });

test.afterEach(async () => {
  // The tab writes nothing itself, and every spawn it made ran.
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

test("Spaces is the one surface on: the status bar names it and what it may run", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Spaces");
  await expect(mode).toHaveAttribute("title", /^Spaces: map-workspace\.js, regen-workspace-insight\.js\n/);
});

test("Describe N new describes the files the map has not (heuristically under `none`), and the Files tree catches up", async () => {
  const { win } = app();
  // A map as a budget-limited run leaves it: one file not described yet.
  const map = pristineMap("harbor-map");
  const tides = map.files.find((f) => f.path === "src/tides.js")!;
  Object.assign(tides, { desc: null, descAt: null, descSource: null, status: "new" });
  map.pending = 1;
  fs.writeFileSync(mapFile("harbor-map"), `${JSON.stringify(map, null, 2)}\n`);

  await openWorkspace(win, "harbor-map", "Files");
  await expect(tab(win, "Files").locator(".aos-spc-badge")).toHaveText("1 undescribed");
  await expect(mapline(win)).toHaveText(/^4 of 5 described · /);
  // The folder carries the NEW of what is under it; the file its own, with its empty description (D9, D19: NEW info).
  await expect(treeRow(win, "src").locator(".aos-spc-badge")).toHaveText("NEW");
  await treeRow(win, "src").click();
  await expect(treeRow(win, "tides.js").locator(".aos-spc-badge")).toHaveText("NEW");
  await expect(treeRow(win, "tides.js").locator(".aos-spc-badge")).toHaveClass(/is-new/);
  await expect(treeRow(win, "tides.js").locator(".aos-spc-tdesc")).toHaveText("Not described yet");
  await expect(describe(win)).toHaveText("Describe 1 new");
  await expect(describe(win)).toHaveAttribute("title", "Describes the new files within the scan's budgets, with the heuristic: no model provider is set up");
  await describe(win).click();
  await expect(win.locator(".notice-container")).toContainText("▶ map-workspace.js harbor-map");

  await expect.poll(() => readMap("harbor-map")?.pending, { timeout: 30_000 }).toBe(0);
  const row = readMap("harbor-map")!.files.find((f) => f.path === "src/tides.js")!;
  // The heuristic description is the one the fixture's own scan wrote.
  const want = pristineMap("harbor-map").files.find((f) => f.path === "src/tides.js")!;
  expect(row).toMatchObject({ desc: want.desc, descSource: "heuristic", status: "fresh" });
  await expect(mapline(win)).toHaveText(/^5 of 5 described · /);
  await expect(treeRow(win, "tides.js").locator(".aos-spc-tdesc")).toHaveText(want.desc!);
  await expect(centre(win).locator(".aos-spc-tree .aos-spc-badge")).toHaveCount(0);
  await expect(describe(win)).toHaveText("Nothing new");
  await expect(describe(win)).toBeDisabled();
  await expect(tab(win, "Files").locator(".aos-spc-badge")).toHaveCount(0);
});

test("a workspace with no map yet offers Map now; its files are NEW until it runs, and it writes the map", async () => {
  const { win } = app();
  fs.rmSync(mapFile("field-notes"));
  await openWorkspace(win, "field-notes", "Files");
  await expect(mapline(win)).toHaveText("No map yet: run a scan, or map this workspace now. Map now");
  // The live listing still shows the folder: a file the map has not seen is NEW, and the one Describe counts.
  await expect(treeRow(win, "README.md").locator(".aos-spc-badge")).toHaveText("NEW");
  await expect(treeRow(win, "README.md").locator(".aos-spc-tdesc")).toHaveText("Not described yet");
  await expect(describe(win)).toHaveText("Describe 1 new");
  await mapline(win).locator("button", { hasText: "Map now" }).click();
  await expect(win.locator(".notice-container")).toContainText("▶ map-workspace.js field-notes");
  await expect.poll(() => readMap("field-notes")?.pending, { timeout: 30_000 }).toBe(0);
  const want = pristineMap("field-notes").files.map((f) => ({ path: f.path, desc: f.desc, descSource: f.descSource }));
  expect(readMap("field-notes")!.files.map((f) => ({ path: f.path, desc: f.desc, descSource: f.descSource }))).toEqual(want);
  await expect(mapline(win)).toHaveText(/^1 of 1 described · /);
  await expect(treeRow(win, "README.md").locator(".aos-spc-tdesc")).toHaveText(want[0].desc!);
  await expect(treeRow(win, "README.md").locator(".aos-spc-badge")).toHaveCount(0);
});

test("↻ per file is off under `none` and says why (D33): in the tree and in the preview, and nothing runs", async () => {
  const { win } = app();
  await openWorkspace(win, "harbor-map", "Files");
  const re = treeRow(win, "README.md").locator("button.aos-spc-redesc");
  await expect(re).toBeDisabled();
  await expect(re).toHaveAttribute("title", "Needs a model provider");
  await treeRow(win, "README.md").click();
  const prev = C(win).locator(".aos-spc-right .aos-spc-preview");
  await expect(prev.locator(".aos-spc-prevname")).toHaveText("README.md");
  await expect(prev.locator("button.aos-spc-redesc")).toBeDisabled();
  await expect(prev.locator(".aos-spc-prevdesc .aos-spc-why")).toHaveText("Needs a model provider");
});

test("with a provider on record ↻ describes one file: map-workspace.js --file runs, and the runtime's forced `none` stops it before any model call", async () => {
  const { win } = app();
  const stateFile = FX.v("brain/_index/provider-state.json");
  const state = fs.readFileSync(stateFile, "utf8");
  const before = fs.readFileSync(mapFile("harbor-map"), "utf8");
  const was = fileMapRun()?.startedAt ?? null;
  try {
    // What the HUD reads to decide (D33); the runtime decides again from the vault's own config, forced to `none` here.
    fs.writeFileSync(stateFile, `${JSON.stringify({ ...JSON.parse(state), name: "ollama", reason: "fixture" }, null, 2)}\n`);
    await openTab(win, "pulse");
    await openTab(win, "spaces");
    await openWorkspace(win, "harbor-map", "Files");
    const row = treeRow(win, "README.md");
    const re = row.locator("button.aos-spc-redesc");
    await expect(re).toBeEnabled();
    await expect(re).toHaveAttribute("title", "Describe README.md again");
    await row.hover();
    await re.click();
    await expect(win.locator(".notice-container")).toContainText("▶ map-workspace.js harbor-map --file README.md");
    // The ledger writes lastRun twice (lib/pipeline-report.js): at the start, status "running" with the new startedAt, then
    // the outcome. Wait for a run that started after the click AND ended: reading at the first write saw "running".
    // spaces-redesign D33: the one-file call goes through the provider as feature `file-map`, so under the fixture's
    // `aos init --provider none` it stops before any model call and says so.
    await expect.poll(() => { const r = fileMapRun(); return r && r.startedAt !== was && r.status !== "running" ? r : null; }, { timeout: 30_000 })
      .toMatchObject({ status: "error", error: "no model provider to describe README.md (forced)" });
    expect(fs.readFileSync(mapFile("harbor-map"), "utf8")).toBe(before);
  } finally {
    fs.writeFileSync(stateFile, state);
  }
});

test("↻ on the read regenerates the insight (heuristic under `none`), and the pick-up card's read shows it", async () => {
  const { win } = app();
  await openWorkspace(win, "harbor-map", "Overview");
  const was = insight("harbor-map").generatedAt;
  const read = centre(win).locator(".aos-spc-pickval[data-row='read']");
  await read.locator("button.aos-spc-regen").click();
  await expect(win.locator(".notice-container")).toContainText("Regenerating insight for harbor-map…");
  await expect.poll(() => insight("harbor-map").generatedAt, { timeout: 30_000 }).not.toBe(was);
  expect(insight("harbor-map")).toMatchObject({ status: "ok", model: "heuristic" });
  await expect(read.locator(".aos-spc-readtext")).toHaveText(insight("harbor-map").text!);
  await expect(read.locator(".aos-spc-readsrc")).toHaveText(/^heuristic · (now|\d+m)$/);
});

test("with only Spaces on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
