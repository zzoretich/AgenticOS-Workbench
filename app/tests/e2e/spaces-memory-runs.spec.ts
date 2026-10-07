// Spaces, Memory and Runs (app-smoke: Spaces / Memory / Runs): workspaces from snapshot.json with their host
// session chips and the "outside workspaces" footer, the memory browser, drawer inspector, split pop-out and graph,
// and the runs list, its drawer, pop-out, agents roster and live tail. With the Spaces surface off, ↻ regen and ↻
// re-describe are refused; map now, ↻ and regen themselves are in spaces-writes.spec.ts.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { FX, closeNotes, content, drawer, expected, notePath, openTab, readVaultJson, useApp } from "./harness";

const app = useApp();
const C = () => content(app().win);

interface WS { name: string; summary: string | null; sessions?: { claude: number; codex: number }; insight: { status: string; model?: string | null; text?: string | null } }

// ── Spaces ───────────────────────────────────────────────────────────

test.describe("Spaces", () => {
  test.beforeEach(async () => { await openTab(app().win, "spaces"); });

  test("lists workspaces from snapshot.json with a sessions chip only where a host worked", async () => {
    const snap = readVaultJson<{ workspaces: WS[] }>("brain/_index/snapshot.json");
    await expect(C().locator(".aos-ws-row .aos-ws-name")).toHaveText(snap.workspaces.map((w) => w.name));
    const harbor = C().locator(".aos-ws-row", { hasText: "harbor-map" });
    await expect(harbor.locator(".aos-ws-sub").first()).toHaveText("An offline harbor chart viewer with tide overlays.");
    await expect(harbor.locator(".aos-ws-sub").nth(1)).toHaveText("codex 2 · 1d ago");
    await expect(C().locator(".aos-ws-row", { hasText: "field-notes" }).locator(".aos-ws-sub")).toHaveCount(1);
  });

  test("an outside-workspaces footer names the other working directories, newest first, with the adopt command", async () => {
    const foot = C().locator(".aos-ws-outside");
    await expect(foot.locator(".aos-ws-name")).toHaveText("outside workspaces (3)");
    // A directory under HOME is ~-shortened.
    await expect(foot.locator(".aos-ws-sub")).toHaveText(["/opt/sample/scratchpad — claude 2 · today", "/opt/sample/sandbox — codex 1 · 2d ago", "~/sketches — codex 1 · 5d ago"]);
    await expect(foot.locator(".aos-ws-sub").first()).toHaveAttribute("title", '/opt/sample/scratchpad\naos workspace adopt "/opt/sample/scratchpad"');
  });

  test("overview: summary, objectives, key documents, what's next and the insight footer", async () => {
    await C().locator(".aos-ws-row", { hasText: "harbor-map" }).click();
    const detail = C().locator(".aos-ws-detail");
    await expect(detail.locator(".aos-ws-detail-title")).toHaveText("harbor-map");
    await expect(detail.locator(".aos-ws-detail-head .aos-pill")).toHaveText("active");
    await expect(detail.locator(".aos-ws-tab")).toHaveText(["overview", "files", /^map/]);
    const section = (t: string) => detail.locator(".aos-ws-section", { has: app().win.locator(".aos-panel-title", { hasText: t }) });
    await expect(section("SUMMARY").locator(".aos-ws-badge")).toHaveText("manifest");
    await expect(section("OBJECTIVES").locator("li")).toHaveText(["Parse the sample tide tables", "Cache chart tiles for offline use"]);
    await expect(section("KEY DOCUMENTS").locator(".aos-ws-link")).toHaveText(["PLAN.md", "README.md"]);
    await expect(section("WHAT'S NEXT").locator(".aos-ws-text")).toHaveText("Wire the tide parser into the chart view");
    const ws = readVaultJson<{ workspaces: WS[] }>("brain/_index/snapshot.json").workspaces.find((w) => w.name === "harbor-map")!;
    if (ws.insight.status === "ok") await expect(section("INSIGHTS").locator(".aos-ws-insight-foot")).toContainText(`${ws.insight.model ?? "local"} · `);
    else await expect(section("INSIGHTS")).toContainText("insights unavailable");
  });

  test("a key document opens as a note", async () => {
    const { win } = app();
    await C().locator(".aos-ws-row", { hasText: "harbor-map" }).click();
    await C().locator(".aos-ws-link", { hasText: "README.md" }).click();
    await expect(notePath(win)).toHaveText("workspaces/harbor-map/README.md");
    await closeNotes(win);
  });

  test("files: the workspace tree expands and previews a file", async () => {
    await C().locator(".aos-ws-row", { hasText: "harbor-map" }).click();
    await C().locator(".aos-ws-tab", { hasText: "files" }).click();
    const tree = C().locator(".aos-ws-tree");
    await expect(tree.locator(":scope > .aos-ws-tnode")).toHaveText(["▸src", "·PLAN.md", "·README.md", "·workspace.md"]);
    await tree.locator(".aos-ws-tnode-dir", { hasText: "src" }).click();
    await expect(C().locator(".aos-ws-subtree .aos-ws-tnode")).toHaveText(["·tides.js", "·tiles.js"]);
    await C().locator(".aos-ws-tnode", { hasText: "tides.js" }).click();
    await expect(C().locator(".aos-ws-preview-name")).toHaveText("tides.js");
    await expect(C().locator(".aos-ws-pre")).toContainText("export function parseTides");
    await expect(C().locator(".aos-ws-preview-head button")).toHaveText(["copy abs", "copy rel", "open"]);
    await C().locator(".aos-ws-tab", { hasText: "overview" }).click();
  });

  test("with the Spaces surface off, ↻ regen and ↻ re-describe are refused; regen announces itself and then says nothing", async () => {
    const h = app();
    const map = fs.readFileSync(FX.v("brain/_index/workspace-maps/harbor-map.json"), "utf8");
    const insightOf = () => JSON.stringify(readVaultJson<{ workspaces: WS[] }>("brain/_index/snapshot.json").workspaces.find((w) => w.name === "harbor-map")!.insight);
    const insight = insightOf();
    await C().locator(".aos-ws-row", { hasText: "harbor-map" }).click();
    const d = C().locator(".aos-ws-detail");
    const notices = h.notices.length;
    await d.locator(".aos-ws-section", { has: h.win.locator(".aos-panel-title", { hasText: "INSIGHTS" }) }).locator("button", { hasText: "↻ regen" }).click();
    await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)).toEqual([expect.stringMatching(/\/regen-workspace-insight\.js harbor-map$/)]);
    // The regen spawn has no completion handler: a refusal (or a failed run) reaches the console only.
    await h.win.waitForTimeout(500);
    expect(h.notices.slice(notices)).toEqual(["Regenerating insight for harbor-map…"]);
    await d.locator(".aos-ws-tab", { hasText: /^map/ }).click();
    await d.locator(".aos-sp-maprow", { has: h.win.locator(".aos-sp-mappath", { hasText: /^README\.md$/ }) }).locator("a.aos-sp-redesc").click();
    await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/map-workspace.js");
    expect((await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)[1]).toMatch(/\/map-workspace\.js harbor-map --file README\.md$/);
    expect(fs.readFileSync(FX.v("brain/_index/workspace-maps/harbor-map.json"), "utf8")).toBe(map);
    expect(insightOf()).toBe(insight);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });
});

// ── Memory ───────────────────────────────────────────────────────────

test.describe("Memory", () => {
  test.beforeEach(async () => { await openTab(app().win, "memory"); });

  const memoryFiles = () => {
    const out: string[] = [];
    for (const t of fs.readdirSync(FX.v("brain/memory"))) for (const f of fs.readdirSync(FX.v(`brain/memory/${t}`))) if (f.endsWith(".md")) out.push(`${t}/${f}`);
    return out;
  };

  test("browse: every memory file, newest first, with type and the unreviewed marker", async () => {
    const rows = C().locator(".aos-mem-row");
    await expect(rows).toHaveCount(memoryFiles().length);
    await expect(C().locator(".aos-mem-head .aos-mem-chip")).toHaveText(["all", "user", "feedback", "projects", "reference", "◈ graph"]);
    await expect(rows.first().locator("span").first()).toHaveText("Harbor Map");
    const unreviewed = rows.filter({ hasText: "Release checklist" });
    await expect(unreviewed.locator(".aos-mem-unreviewed")).toHaveText("unreviewed");
    await expect(C().locator(".aos-mem-unreviewed")).toHaveCount(1);
  });

  test("type chips and search narrow the list without losing focus", async () => {
    const { win } = app();
    await C().locator(".aos-mem-chip", { hasText: /^feedback$/ }).first().click();
    const n = memoryFiles().filter((f) => f.startsWith("feedback/")).length;
    await expect(C().locator(".aos-mem-row")).toHaveCount(n);
    await C().locator(".aos-mem-chip", { hasText: /^all$/ }).click();
    const search = C().locator("input.aos-mem-search");
    await search.click();
    await win.keyboard.type("tide");
    await expect(C().locator(".aos-mem-row")).toHaveCount(1);
    await expect(C().locator(".aos-mem-row span").first()).toHaveText("Tide API notes");
    await expect(search).toBeFocused();
    await search.fill("");
  });

  test("a row opens the drawer inspector: frontmatter, rendered body, backlinks", async () => {
    const { win } = app();
    await C().locator(".aos-mem-row", { hasText: "Tide API notes" }).click();
    const d = drawer(win);
    await expect(d.locator(".aos-wb-drawertitle")).toHaveText("Tide API notes");
    await expect(d.locator(".aos-mem-fmrow")).toHaveText([/^pathbrain\/memory\/reference\/tide-api-notes\.md$/, /^typereference$/, /^created\d{4}-\d{2}-\d{2}$/, /^updated\d{4}-\d{2}-\d{2}$/, /^reviewed—$/]);
    await expect(d.locator(".aos-memscope-body li")).toHaveText(["Rate limit: 60 requests a minute.", "Station ids are five digits."]);
    await expect(d.locator(".aos-memscope-backrow")).toContainText(["MEMORY.md"]);
    await expect(d.locator(".aos-mem-footer a")).toHaveText("▸ open as file");
  });

  test("the inspector pops out into the split pane (⧉), and ▸ open as file opens the note", async () => {
    const { win } = app();
    await C().locator(".aos-mem-row", { hasText: "Prefer small diffs" }).click();
    await drawer(win).locator(".aos-wb-draweractions a[aria-label='Open in split']").click();
    await expect(drawer(win)).not.toHaveClass(/is-open/);
    const split = win.locator(".aos-host-pane.is-split");
    await expect(split).not.toHaveClass(/is-empty/);
    await expect(split.locator(".workspace-leaf-content[data-type='agentic-os-memory-inspector']")).toContainText("Keep each change reviewable in one sitting.");
    await expect(win.locator(".aos-host-tab.is-split")).toHaveCount(1);
    await closeNotes(win);
    await openTab(win, "memory");
    await C().locator(".aos-mem-row", { hasText: "Prefer small diffs" }).click();
    await drawer(win).locator(".aos-mem-footer a").click();
    await expect(notePath(win)).toHaveText("brain/memory/feedback/prefer-small-diffs.md");
    await closeNotes(win);
  });

  test("graph: the Cortex renders nodes and edges; daily notes under dailyNote.layout are session nodes", async () => {
    const { win } = app();
    await C().locator(".aos-mem-chip", { hasText: "◈ graph" }).click();
    await expect(C().locator(".aos-cortex-header .aos-title")).toHaveText("Knowledge graph");
    await expect(C().locator(".aos-cortex-stats")).toHaveText(/^\d+ nodes · \d+ edges$/);
    await expect(C().locator(".aos-cortex-chips button")).toHaveText(["memory", "pattern", "session", "agent"]);
    const kinds = await win.evaluate(() => {
      const w = window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): { graph: { nodes: Array<{ kind: string; path: string }> } } } }> } } } };
      const graph = w.aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.getTab("memory").graph;
      return graph.nodes.map((n) => `${n.kind}:${n.path}`);
    });
    const sessions = kinds.filter((k) => k.startsWith("session:"));
    expect(sessions).toHaveLength(2);   // today's and yesterday's daily notes
    expect(sessions.some((k) => k.endsWith(`/${expected().today}.md`))).toBe(true);
    const nodes = C().locator("svg.aos-cortex-svg g.aos-cortex-node");
    await expect.poll(() => nodes.count()).toBe(kinds.length);
    await C().locator(".aos-cortex-chips button", { hasText: "session" }).click();
    await expect.poll(() => nodes.count()).toBe(kinds.length - sessions.length);
    await C().locator(".aos-cortex-chips button", { hasText: "session" }).click();
    await C().locator(".aos-mem-chip", { hasText: "◈ graph" }).click();
    await expect(C().locator(".aos-mem-rows")).toBeVisible();
  });
});

// ── Runs ─────────────────────────────────────────────────────────────

test.describe("Runs", () => {
  test.beforeEach(async () => { await openTab(app().win, "runs"); });

  const runsRows = () => fs.readFileSync(FX.v("brain/_index/agent-runs/runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; script: string; started_at: string });

  test("lists runs.jsonl newest first with id, script, duration, cost and age", async () => {
    const rows = runsRows().slice().reverse();
    await expect(C().locator(".aos-runs-row .aos-runs-script")).toHaveText(rows.map((r) => r.script));
    await expect(C().locator(".aos-runs-row .aos-runs-id")).toHaveText(rows.map((r) => r.id.slice(-10)));
    const costed = C().locator(".aos-runs-row", { hasText: "0000000001" });
    await expect(costed).toContainText("$1.250");   // the costs.jsonl record laid over the session
    await expect(costed).toContainText("40m00s");
  });

  test("the filter narrows by id, script or status", async () => {
    await C().locator("input.aos-runs-filter").fill("error");
    await expect(C().locator(".aos-runs-row .aos-runs-script")).toHaveText(["standup"]);
    await C().locator("input.aos-runs-filter").fill("session");
    await expect(C().locator(".aos-runs-row")).toHaveCount(runsRows().filter((r) => r.script === "session").length);
    await C().locator("input.aos-runs-filter").fill("");
  });

  test("a run opens its detail drawer: status, stats, error, prompt, timeline, raw JSON", async () => {
    const { win } = app();
    await C().locator(".aos-runs-row", { hasText: "standup" }).click();
    const d = drawer(win);
    await expect(d.locator(".aos-wb-drawertitle")).toHaveText("run andup-cccc");
    await expect(d.locator(".aos-ri-status")).toHaveText("error");
    await expect(d.locator(".aos-ri-status")).toHaveClass(/aos-text-rose/);
    await expect(d.locator(".aos-ri-stat-l")).toHaveText(["duration", "cost", "turns", "tools", "subagents"]);
    await expect(d.locator(".aos-ri-error")).toHaveText("no provider: set one with aos provider");
    await expect(d.locator(".aos-ri-section-head")).toContainText([/PROMPT/, /REPLY/, "TIMELINE · 3 events", /RAW JSON/]);
    await d.locator(".aos-ri-collapse-head", { hasText: "PROMPT" }).click();
    await expect(d.locator(".aos-ri-collapse-body")).toHaveText("Standup");
    await expect(d.locator(".aos-ri-evt-type")).toHaveText(["tool_use(1) · Read", "tool_result(1)", "tool_use(1) · Bash"]);
    await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  });

  test("a session run from the telemetry hook shows its tools and subagents", async () => {
    const { win } = app();
    await C().locator(".aos-runs-row", { hasText: "000000000a" }).click();
    const d = drawer(win);
    await expect(d.locator(".aos-ri-script")).toHaveText("session");
    await expect(d.locator(".aos-ri-stat", { hasText: "tools" }).locator(".aos-ri-stat-v")).toHaveText("3");
    await expect(d.locator(".aos-ri-section-head", { hasText: "SUBAGENTS" })).toHaveText("SUBAGENTS · 1");
    await expect(d.locator(".aos-ri-subagent")).toHaveText("field-researcher");
    await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  });

  test("the run inspector pops out into the split pane", async () => {
    const { win } = app();
    await C().locator(".aos-runs-row", { hasText: "reflect-week" }).click();
    await drawer(win).locator(".aos-wb-draweractions a[aria-label='Open in split']").click();
    const leaf = win.locator(".aos-host-pane.is-split .workspace-leaf-content[data-type='agentic-os-run-inspector']");
    await expect(leaf).toContainText("Run inspector");
    await expect(leaf).toContainText("reflect-week");
    await expect(leaf).toContainText("TIMELINE · 3 events");
    await leaf.getByText("▸ REPLY").click();
    await expect(leaf).toContainText("Three themes: tides, tiles, tests.");
    await closeNotes(win);
  });

  test("⌬ agents: the staff roster from brain/agents heartbeats", async () => {
    await C().locator(".aos-runs-chip", { hasText: "⌬ agents" }).click();
    const staff = fs.readdirSync(FX.v("brain/agents")).filter((d) => fs.existsSync(FX.v(`brain/agents/${d}/heartbeat.json`))).sort();
    await expect(C().locator(".aos-staff-header .aos-title")).toHaveText("Staff roster");
    await expect(C().locator(".aos-staff-card .aos-staff-name")).toHaveText(staff);
    await expect(C().locator(".aos-staff-header .aos-dim")).toContainText(`${staff.length} agents · live tail`);
    await C().locator("input.aos-runs-filter").fill("team-");
    await expect(C().locator(".aos-staff-card .aos-staff-name")).toHaveText(staff.filter((s) => s.startsWith("team-")));
    await C().locator("input.aos-runs-filter").fill("");
    await C().locator(".aos-runs-chip", { hasText: "≣ runs" }).click();
  });

  test("a line appended to runs.jsonl shows within a second", async () => {
    const t = new Date(Date.now() - 5000).toISOString();
    const row = { id: "probe-live-zzzz", script: "probe", started_at: t, ended_at: new Date().toISOString(), duration_ms: 5000, cost_usd: 0, turns: 1, status: "ok" };
    fs.appendFileSync(FX.v("brain/_index/agent-runs/runs.jsonl"), `${JSON.stringify(row)}\n`);
    await expect(C().locator(".aos-runs-row").first().locator(".aos-runs-script")).toHaveText("probe", { timeout: 2000 });
  });
});
