// Variants of the fixture, each its own app: a vault with no persona, to-dos, notifications or teams (empty states);
// session costing off; a provider on record (the Chat tab); and a Codex-only machine (every "run in a session" button
// names Codex). Each variant edits the restored copy before launch, the way the runtime or the user would leave it.

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, badge, claudeCalls, codexCalls, command, content, drawer, guardWrites, installChatStubs, openTab, rail, terminalText, useApp } from "./harness";
import { SURFACES } from "../../src/shared/surfaces";

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const agenticos = path.join(FX.claude, "agenticos.json");
/** Runs the vault's `aos` launcher as a user at a terminal would (no AOS_HEADLESS), in the fixture's environment. */
const aos = (...args: string[]) => {
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), ...args], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`aos ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};

test.describe("an empty vault: no persona, to-dos, notifications or teams", () => {
  const app = useApp({
    prepare: () => {
      for (const rel of ["persona", "TODO.md", "brain/notifications", "brain/_index/persona-heartbeat.json"]) fs.rmSync(FX.v(rel), { recursive: true, force: true });
      // The runtime's own status-line refresh, so the model matches the emptied vault.
      const r = spawnSync(process.execPath, [FX.v("brain/scripts/statusline.js"), "refresh"], { env: appEnv(), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`statusline refresh failed: ${r.stderr}`);
    },
  });

  test("badges are hidden and the status bar reads all clear", async () => {
    const { win } = app();
    for (const id of ["todo", "proposals", "notifications", "agent-teams"]) await expect(badge(win, id)).toHaveClass(/is-empty/);
    await expect(win.locator(".aos-host-status .aos-statusbar")).toContainText("· all clear");
  });

  test("Pulse: the briefing row falls back to BRIEFING", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await expect(win.locator(".aos-briefing-label")).toHaveText("BRIEFING");
  });

  test("To-Do: nothing open, with the /todo hint", async () => {
    const { win } = app();
    await openTab(win, "todo");
    await expect(content(win).locator(".aos-rt-count")).toHaveText("0 open · 0 overdue · 0 today");
    await expect(content(win).locator(".aos-inv-row")).toHaveText("Nothing open — add one above, or run /todo <text> in a session.");
  });

  test("Proposals: only the 'isn't set up' line", async () => {
    const { win } = app();
    await openTab(win, "proposals");
    await expect(content(win).locator(".aos-rt-note")).toHaveText("The Chief of Staff isn't set up — run `aos persona` to create it.");
    await expect(content(win).locator(".aos-pr-grouphead")).toHaveCount(0);
  });

  test("Notifications: no notifications yet, with the /notifications hint", async () => {
    const { win } = app();
    await openTab(win, "notifications");
    await expect(content(win).locator(".aos-inv-row")).toHaveText("No notifications yet. Agents post with `aos notify post` — see /notifications.");
    await expect(content(win).locator(".aos-rt-actions button")).toHaveCount(0);
  });

  test("Agent Teams: no teams yet, the Seed button and the /team hint", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const empty = content(win).locator(".aos-at-empty");
    await expect(empty.locator(".aos-at-emptytitle")).toHaveText("No teams yet");
    await expect(empty.locator("button.mod-cta")).toHaveText("Seed the example team");
    await expect(empty.locator(".aos-at-emptyacts .aos-dim")).toContainText("It lands in persona/teams/example/.");
    await expect(empty.locator(".aos-at-emptyacts .aos-dim")).toContainText("In a session: /team.");
  });

  test("sidebar: no heartbeat pill on a vault whose watchdog never ran", async () => {
    const { win } = app();
    await command(win, "agentic-os:open-sidebar-hud");
    await expect(win.locator(".aos-host-right .aos-sb-status .aos-pill").first()).toBeVisible();
    await expect(win.locator(".aos-host-right .aos-sb-status .aos-pill", { hasText: "♥" })).toHaveCount(0);
  });
});

test.describe("session costing off", () => {
  const app = useApp({ prepare: () => editJson(agenticos, (j) => { j.cost = { ...(j.cost ?? {}), enabled: false }; }) });

  test("Pulse: no COST row and no anchor or backfill cards; the health card stays", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await expect(win.locator(".aos-pulse-rowlabel", { hasText: /^HEALTH$/ })).toBeVisible();
    await expect(win.locator(".aos-pulse-rowlabel", { hasText: /^COST$/ })).toHaveCount(0);
    const titles = win.locator(".aos-pulse-fixq .aos-pulse-fix-title");
    await expect(titles.filter({ hasText: "health error(s)" })).toHaveCount(1);
    await expect(titles.filter({ hasText: "not yet anchored" })).toHaveCount(0);
    await expect(titles.filter({ hasText: "missing cost" })).toHaveCount(0);
  });

  test("SYSTEM drawer: no COST DETAIL panel", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await win.locator(".aos-pulse-row a", { hasText: "SYSTEM ▸" }).click();
    await expect(drawer(win).locator(".aos-panel-title", { hasText: "DISK" })).toBeVisible();
    await expect(drawer(win).locator(".aos-panel-title", { hasText: "COST DETAIL" })).toHaveCount(0);
    await drawer(win).locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  });

  test("Settings: the Session costing switch is off", async () => {
    const { win } = app();
    await openTab(win, "settings");
    await expect(content(win).locator(".aos-st-master .aos-st-switch", { hasText: "Session costing" })).not.toHaveClass(/is-on/);
  });
});

test.describe("a provider on record", () => {
  // What the scripts publish in provider-state.json once a provider resolves; the HUD only reads it.
  const state = (name: string, loggedIn: boolean) => () => editJson(FX.v("brain/_index/provider-state.json"), (j) => {
    j.name = name; j.reason = "fixture"; j.claude = { loggedIn };
  });
  // The chat stubs only prove that no CLI runs: Chat's surface is off here.
  const app = useApp({ prepare: () => { installChatStubs(); state("claude", true)(); } });

  test("the Chat rail button sits between Agent Teams and Term", async () => {
    const { win } = app();
    const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
    expect(ids.indexOf("chat")).toBe(ids.indexOf("agent-teams") + 1);
    expect(ids.indexOf("term")).toBe(ids.indexOf("chat") + 1);
  });

  test("Chat under claude names the reasoner and its cap; a local provider reads local ask.js", async () => {
    const { win } = app();
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-asst-head .aos-title")).toHaveText("[ ASSISTANT ]");
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · claude (claude-opus-5, capped)");
    await expect(content(win).locator("textarea.aos-asst-input")).toHaveAttribute("placeholder", "ask the brain…");
    await expect(content(win).locator(".aos-asst-actions button")).toHaveText("Send (⌘↵)");
    state("ollama", false)();
    await openTab(win, "pulse");
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · local ask.js");
    state("codex", false)();
    await openTab(win, "pulse");
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · codex via ask.js (reasoner caps)");
  });

  test("Chat surface off: a question is refused on either route; the tab says why, nothing is logged or billed, no CLI runs", async () => {
    const h = app();
    const chatLog = FX.v("brain/_index/agentic-os-chat.jsonl");
    const ledger = FX.v("brain/_index/provider-spend.jsonl");
    const ledger0 = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null;
    const send = async (q: string) => {
      await content(h.win).locator("textarea.aos-asst-input").fill(q);
      await content(h.win).locator(".aos-asst-actions button", { hasText: "Send (⌘↵)" }).click();
    };
    const lastError = () => content(h.win).locator(".aos-asst-turn-assistant:not(.aos-asst-live) .aos-text-rose").last();

    // Claude: recall and `claude -p` are refused, and the refusal is the turn's error.
    state("claude", true)();
    await openTab(h.win, "pulse");
    await openTab(h.win, "chat");
    await send("Refused on the Claude route?");
    await expect(lastError()).toContainText("AgenticOS app: ");
    await expect(lastError()).toContainText("claude -p");
    // The local route: ask.js is refused.
    state("ollama", false)();
    await openTab(h.win, "pulse");
    await openTab(h.win, "chat");
    await expect(content(h.win).locator(".aos-asst-mode")).toHaveText(" · local ask.js");
    await send("Refused on the local route?");
    await expect(lastError()).toContainText("brain/scripts/sdk/ask.js --local Refused on the local route? refused; no write surface that allows it is on");

    const spawns = (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what);
    expect(spawns).toHaveLength(3);
    expect(spawns[0]).toMatch(/recall-cli\.js Refused on the Claude route\?$/);
    expect(spawns[1]).toMatch(/claude -p /);
    expect(spawns[2]).toMatch(/brain\/scripts\/sdk\/ask\.js --local Refused on the local route\?$/);
    // Each question and each answer tried to reach the chat log.
    expect(await guardWrites(h)).toEqual(Array(4).fill("write brain/_index/agentic-os-chat.jsonl"));
    expect(fs.existsSync(chatLog)).toBe(false);
    expect(fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null).toBe(ledger0);
    expect(claudeCalls()).toEqual([]);
    expect(codexCalls()).toEqual([]);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });
});

test.describe("a Codex-only machine", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      aos("routines", "hosts", "--refresh");   // the Codex section: this machine has no Codex automations database
    },
  });

  test("Proposals: Review in Codex ❯_ runs the flag-closer skill through codex", async () => {
    const { win } = app();
    await openTab(win, "proposals");
    const review = content(win).locator(".aos-rt-actions button");
    await expect(review).toHaveText("Review in Codex ❯_");
    await expect(review).toHaveAttribute("title", "Opens a Term session in the vault running: codex '$agenticos:persona-flag-closer'");
    await review.click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture codex stub] $agenticos:persona-flag-closer");
  });

  test("Notifications: the ask buttons open Codex sessions", async () => {
    const { win } = app();
    await openTab(win, "notifications");
    await content(win).locator(".aos-nt-chip", { hasText: /^All$/ }).click();
    await content(win).locator(".aos-nt-row", { hasText: "The Morning Edition" }).click();
    await expect(content(win).locator(".aos-nt-actions button", { hasText: "Deep dive" })).toHaveAttribute("title", "Opens a Codex session in the vault running: codex '$agenticos:ask-brain tide tables'");
  });

  test("Agent Teams: Redirect runs the lead through codex", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const redirect = content(win).locator(".aos-at-needs .aos-at-gate", { hasText: "harbor-01" }).locator("button", { hasText: "Redirect" });
    await expect(redirect).toHaveText("Redirect ❯_");
    await expect(redirect).toHaveAttribute("title", /in Codex/);
  });

  test("Routines: the Codex section names why it is empty, with its age", async () => {
    const { win } = app();
    await openTab(win, "routines");
    await expect(content(win).locator(".aos-rt-asof")).toContainText(/codex as of \d+[smhd] ago/);
    await expect(content(win).locator(".aos-inv-row", { hasText: /^codex: / })).toContainText("no Codex automations database");
  });

  test("Settings: the Claude rows are dimmed and the Codex rows are not", async () => {
    const { win } = app();
    await openTab(win, "settings");
    const row = (key: string) => content(win).locator(".aos-st-row", { has: win.locator(".aos-st-key", { hasText: new RegExp(`^${key.replace(/\./g, "\\.")}$`) }) });
    await expect(row("claude.model")).toHaveClass(/is-dim/);
    await expect(row("claude.model").locator(".aos-st-hostnote")).toHaveText("Claude Code is off on this machine; `aos init --host both` turns it on");
    await expect(row("codex.model")).not.toHaveClass(/is-dim/);
  });
});

test.describe("both hosts", () => {
  const app = useApp({ prepare: () => editJson(agenticos, (j) => { j.hosts.claude.enabled = true; j.hosts.codex.enabled = true; }) });

  test("Notifications: one ask button per host", async () => {
    const { win } = app();
    await openTab(win, "notifications");
    await content(win).locator(".aos-nt-row", { hasText: "The Morning Edition" }).click();
    await expect(content(win).locator(".aos-nt-actions").first().locator("button", { hasText: "Deep dive" })).toHaveText(["Deep dive ❯_ claude", "Deep dive ❯_ codex"]);
  });

  test("Agent Teams: one Redirect button per host", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const gate = content(win).locator(".aos-at-needs .aos-at-gate", { hasText: "harbor-01" });
    await expect(gate.locator("button", { hasText: "Redirect" })).toHaveText(["Redirect ❯_ claude", "Redirect ❯_ codex"]);
  });

  test("Settings: nothing is dimmed", async () => {
    const { win } = app();
    await openTab(win, "settings");
    await expect(content(win).locator(".aos-rt-count")).not.toHaveText("loading…");
    await expect(content(win).locator(".aos-st-row")).not.toHaveCount(0);
    await expect(content(win).locator(".aos-st-row.is-dim")).toHaveCount(0);
  });
});

test.describe("telemetry off", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.telemetry = { ...(j.telemetry ?? {}), enabled: false }; });
      fs.rmSync(FX.v("brain/_index/agent-runs/live"), { recursive: true, force: true });
    },
  });

  test("no agent-runs/live is created and no reconcile runs on load; Runs still reads runs.jsonl", async () => {
    const h = app();
    await openTab(h.win, "runs");
    await expect(content(h.win).locator(".aos-runs-row")).not.toHaveCount(0);
    await h.win.waitForTimeout(1000);
    expect(fs.existsSync(FX.v("brain/_index/agent-runs/live"))).toBe(false);
    const log = await h.guard();
    expect(log.filter((e) => e.kind === "write" && e.what.includes("agent-runs/live"))).toEqual([]);
    // The reconcile spawn is the only script-only spawn on load (the guard shortens its path to "…").
    expect(log.filter((e) => e.kind === "spawn" && (/reconcile-sessions\.js/.test(e.what) || /…$/.test(e.what)))).toEqual([]);
  });
});

test.describe("a data.json from 0.17 or earlier", () => {
  // The app keeps the plugin's data.json in its own userData (never the vault): write an old one there before launch.
  const old = { costEnabled: true, telemetryEnabled: true, statusBarEnabled: true, liveTailPollMs: 1500 };
  const dirs = [
    path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (dev)", "plugins"),
    path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)", "plugins"),
  ];
  const app = useApp({ prepare: () => { for (const d of dirs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "agentic-os.json"), `${JSON.stringify(old, null, 2)}\n`); } } });

  test("loses costEnabled and telemetryEnabled on the first load; the other keys are kept", async () => {
    const { win } = app();
    const userData = await win.evaluate(() => (window as unknown as { aosHost: { info: { userData: string } } }).aosHost.info.userData);
    const file = path.join(userData, "plugins", "agentic-os.json");
    await expect.poll(() => { try { return Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return []; } }).not.toContain("costEnabled");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("telemetryEnabled");
    expect(saved.liveTailPollMs).toBe(1500);
    const settings = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { settings: Record<string, unknown> } } }).aosHost.plugin.settings);
    expect(settings).not.toHaveProperty("costEnabled");
    expect(settings.liveTailPollMs).toBe(1500);
  });
});

test.describe("a runtime that predates aos config (before 0.17)", () => {
  // The vault's CLI without config-cmd.js: `aos config list` fails with "Cannot find module".
  const app = useApp({ prepare: () => fs.rmSync(FX.v("brain/scripts/cli/config-cmd.js")) });

  test("Settings asks for aos upgrade with a button; the WORKBENCH rows still work", async () => {
    const { win } = app();
    await openTab(win, "settings");
    const failure = content(win).locator(".aos-st-failure");
    await expect(failure).toContainText("This vault's AgenticOS runtime has no `aos config` yet: run `aos upgrade` to control every setting from here.");
    await expect(failure.locator("button")).toHaveText("❯_ aos upgrade");
    await expect(content(win).locator(".aos-st-master")).toHaveCount(0);
    await expect(content(win).locator(".aos-st-plugin .setting-item-name", { hasText: "Vault root" })).toBeVisible();
  });
});

test.describe("no teams yet, with the Agent Teams surface on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "teams" }, prepare: () => fs.rmSync(FX.v("persona/teams"), { recursive: true, force: true }) });

  test("Seed the example team runs aos team init, which writes the example team (AT1)", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await expect(content(win).locator(".aos-at-emptytitle")).toHaveText("No teams yet");
    await content(win).locator("button.mod-cta", { hasText: "Seed the example team" }).click();
    await expect(win.locator(".notice-container")).toContainText("seeded persona/teams/example/ from the example team");
    await expect.poll(() => fs.existsSync(FX.v("persona/teams/example/TEAM.md"))).toBe(true);
    // One team: no chip bar, the team's own section.
    await expect(content(win).locator(".aos-rt-count")).toHaveText("0 gates waiting · 1 team");
    await expect(content(win).getByRole("region", { name: "Example team" })).toContainText("lead Lead · 3 members · 0 open");
    expect((await app().guard()).map((e) => `${e.kind} ${e.what}`)).toEqual([]);
  });
});

test.describe("a vault whose HUD ran in Obsidian first", () => {
  const obsidianData = FX.v(".obsidian/plugins/agentic-os/data.json");
  const saved = { autoOpenSidebarOnStart: true, terminalEmbedHeight: 621, statusBarEnabled: true };
  const appData = path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)", "plugins", "agentic-os.json");
  const app = useApp({
    prepare: () => {
      fs.mkdirSync(path.dirname(obsidianData), { recursive: true });
      fs.writeFileSync(obsidianData, `${JSON.stringify(saved, null, 2)}\n`);
      fs.rmSync(appData, { force: true });
    },
  });

  test("the app starts with Obsidian's plugin settings (the SidebarHUD opens), never writes them, and saves its own copy", async () => {
    const { win } = app();
    await expect(win.locator(".aos-host-right .aos-sb-status")).toBeVisible();
    const before = fs.readFileSync(obsidianData, "utf8");
    expect(await command(win, "host:settings")).toBe(true);
    const pane = win.locator(".modal.mod-settings .vertical-tab-content-container");
    const toggle = pane.locator(".setting-item", { has: win.locator(".setting-item-name", { hasText: /^Auto-open sidebar on start$/ }) }).locator(".checkbox-container");
    await expect(toggle).toHaveClass(/is-enabled/);
    await toggle.click();
    await expect.poll(() => (fs.existsSync(appData) ? (JSON.parse(fs.readFileSync(appData, "utf8")) as { autoOpenSidebarOnStart?: boolean }).autoOpenSidebarOnStart : undefined)).toBe(false);
    expect(fs.readFileSync(obsidianData, "utf8")).toBe(before);
    await win.keyboard.press("Escape");
  });
});

test.describe("the app's own default: every verified surface writes", () => {
  // Every other spec runs read-only or with the surfaces it names (AOS_APP_WRITE); this one runs as a user's app does.
  const app = useApp({ env: { AOS_APP_WRITE: undefined } });

  test("every verified surface is on, with no write-mode item and no Write Access menu", async () => {
    const h = app();
    const info = await h.win.evaluate(() => (window as unknown as { aosHost: { info: { writeSurfaces: string[]; writeSource: string } } }).aosHost.info);
    expect(info).toMatchObject({ writeSource: "default", writeSurfaces: SURFACES.filter((s) => s.verified).map((s) => s.id) });
    await expect(h.win.locator(".aos-host-status .aos-host-mode")).toBeHidden();
    const first = await h.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0].submenu!.items.map((i) => i.label));
    expect(first).not.toContain("Write Access");
    // A To-Do tick writes with nothing switched on anywhere.
    await openTab(h.win, "todo");
    await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
    await expect.poll(() => fs.readFileSync(FX.v("TODO.md"), "utf8")).toContain("- [x] Call the chart vendor");
  });
});
