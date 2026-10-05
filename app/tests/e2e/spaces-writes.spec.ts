// Spaces with its write surface on (AOS_APP_WRITE=spaces): the map tab's "map now" (for unmapped files, and for a
// workspace with no map yet), ↻ re-describe one file, and ↻ regen of the insight. The tab writes nothing itself; each
// action runs a runtime script. The fixture's provider is `none`, so no model is ever called: map now and regen take
// the runtime's heuristic path, and a re-describe, which has no heuristic, fails and is recorded in the pipeline ledger.

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
const detail = (win: Page) => C(win).locator(".aos-ws-detail");
async function openWorkspace(win: Page, name: string, tab: "overview" | "files" | "map"): Promise<void> {
  await C(win).locator(".aos-ws-row", { hasText: name }).click();
  await expect(detail(win).locator(".aos-ws-detail-title")).toHaveText(name);
  await detail(win).locator(".aos-ws-tab", { hasText: new RegExp(`^${tab}`) }).click();
}
const mapRow = (win: Page, rel: string) => detail(win).locator(".aos-sp-maprow", { has: win.locator(".aos-sp-mappath", { hasText: new RegExp(`^${rel.replace(/[.]/g, "\\.")}$`) }) });

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

test("map now describes the unmapped files of a workspace (heuristically under `none`) and the map tab catches up", async () => {
  const { win } = app();
  // A map as a budget-limited run leaves it: one file not described yet.
  const map = pristineMap("harbor-map");
  const tides = map.files.find((f) => f.path === "src/tides.js")!;
  Object.assign(tides, { desc: null, descAt: null, descSource: null, status: "new" });
  map.pending = 1;
  fs.writeFileSync(mapFile("harbor-map"), `${JSON.stringify(map, null, 2)}\n`);

  await C(win).locator(".aos-ws-row", { hasText: "harbor-map" }).click();
  await expect(detail(win).locator(".aos-ws-tab", { hasText: /^map/ })).toHaveText("map (1)");
  await openWorkspace(win, "harbor-map", "map");
  await expect(detail(win).locator(".aos-sp-mapbar")).toContainText("4/5 mapped");
  await expect(mapRow(win, "src/tides.js").locator(".aos-sp-badge")).toHaveText("NEW");
  await expect(mapRow(win, "src/tides.js").locator(".aos-sp-mapdesc")).toHaveText("— not yet described —");
  await detail(win).locator(".aos-sp-mapbar a", { hasText: "▶ 1 unmapped — map now" }).click();
  await expect(win.locator(".notice-container")).toContainText("▶ map-workspace.js harbor-map");

  await expect.poll(() => readMap("harbor-map")?.pending, { timeout: 30_000 }).toBe(0);
  const row = readMap("harbor-map")!.files.find((f) => f.path === "src/tides.js")!;
  // The heuristic description is the one the fixture's own scan wrote.
  const want = pristineMap("harbor-map").files.find((f) => f.path === "src/tides.js")!;
  expect(row).toMatchObject({ desc: want.desc, descSource: "heuristic", status: "fresh" });
  await expect(detail(win).locator(".aos-sp-mapbar")).toContainText("5/5 mapped");
  await expect(detail(win).locator(".aos-sp-mapbar a")).toHaveCount(0);
  await expect(mapRow(win, "src/tides.js").locator(".aos-sp-mapdesc")).toHaveText(want.desc!);
  await expect(detail(win).locator(".aos-ws-tab", { hasText: /^map/ })).toHaveText("map");
});

test("a workspace with no map yet offers ▶ map now, which writes its map", async () => {
  const { win } = app();
  fs.rmSync(mapFile("field-notes"));
  await openWorkspace(win, "field-notes", "map");
  const empty = detail(win).locator(".aos-sp-empty");
  await expect(empty).toContainText("no map yet — run a scan, or map this workspace now");
  await empty.locator("a", { hasText: "▶ map now" }).click();
  await expect(win.locator(".notice-container")).toContainText("▶ map-workspace.js field-notes");
  await expect.poll(() => readMap("field-notes")?.pending, { timeout: 30_000 }).toBe(0);
  const want = pristineMap("field-notes").files.map((f) => ({ path: f.path, desc: f.desc, descSource: f.descSource }));
  expect(readMap("field-notes")!.files.map((f) => ({ path: f.path, desc: f.desc, descSource: f.descSource }))).toEqual(want);
  await expect(detail(win).locator(".aos-sp-mapbar")).toContainText("1/1 mapped");
});

test("↻ re-describes one file; with no model provider it fails, the ledger records why, and the map stays", async () => {
  const { win } = app();
  await openWorkspace(win, "harbor-map", "map");
  const before = fs.readFileSync(mapFile("harbor-map"), "utf8");
  const was = fileMapRun()?.startedAt ?? null;
  await mapRow(win, "README.md").locator("a.aos-sp-redesc").click();
  await expect(win.locator(".notice-container")).toContainText("▶ map-workspace.js harbor-map --file README.md");
  await expect.poll(() => fileMapRun()?.startedAt ?? null, { timeout: 30_000 }).not.toBe(was);
  expect(fileMapRun()).toMatchObject({ status: "error", error: "could not describe README.md (missing file or qwen failure)" });
  expect(fs.readFileSync(mapFile("harbor-map"), "utf8")).toBe(before);
});

test("↻ regen rewrites the workspace's insight (heuristic under `none`), and the footer shows it", async () => {
  const { win } = app();
  await openWorkspace(win, "harbor-map", "overview");
  const was = insight("harbor-map").generatedAt;
  const section = detail(win).locator(".aos-ws-section", { has: win.locator(".aos-panel-title", { hasText: "INSIGHTS" }) });
  await section.locator("button", { hasText: "↻ regen" }).click();
  await expect(win.locator(".notice-container")).toContainText("Regenerating insight for harbor-map…");
  await expect.poll(() => insight("harbor-map").generatedAt, { timeout: 30_000 }).not.toBe(was);
  expect(insight("harbor-map")).toMatchObject({ status: "ok", model: "heuristic" });
  await expect(section.locator(".aos-ws-text")).toHaveText(insight("harbor-map").text!);
  await expect(section.locator(".aos-ws-insight-foot")).toHaveText(/^heuristic · /);
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
