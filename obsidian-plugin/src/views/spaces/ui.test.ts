import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANES_FOR, entryAbs, entryPlace, moreMenuItems, panesFor, primaryAction, sessionsFooter, splitMenuItems, targetFor,
  threadSignature, tilde, typedCommand, watchFlags, type SpacesActions, type SpacesCtx,
} from "./ui";
import { SESSIONS_OFF_TEXT, CLI_THREAD_TEXT } from "../../data/spacesModel";
import { launchLine, type LaunchSpec, type PlaceWorld, type TermHostChoice } from "../../data/terminalLaunch";
import type { Snapshot, WorkspaceEntry, WorkspaceSessionRow } from "../../data/snapshot";
import type { HostSessionThread } from "../../host";

// spaces-redesign PR 2: the parts of the Spaces panes that decide something (what a file event redraws, what Resume
// and its menu offer per host, D7, D31, D32) are data in ui.ts, so they are pinned here without a DOM.

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const HOME = "/home/demo";
const VAULT = "/home/demo/vault";
const ago = (min: number): string => new Date(NOW - min * 60000).toISOString();
const ID1 = "0a1b2c3d-1111-4222-8333-444455556666";
const ID2 = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
const THREAD = "12345678-1234-4234-8234-123456789abc";

function entry(name: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    name, path: `workspaces/${name}`, status: "active", statusSource: "derived", summary: null, summarySource: "derived",
    objectives: [], isCollection: false, subprojects: [], docs: [], next: { text: null, source: "derived" },
    insight: { text: null, status: "unavailable" }, lastEvent: { iso: null, ageDays: null, subject: null }, inputHash: "x",
    ...extra,
  };
}

function row(id: string, extra: Partial<WorkspaceSessionRow> = {}): WorkspaceSessionRow {
  return {
    id, host: "claude", format: "claude", kind: "interactive", title: "A thread", titleSource: "ai", startedAt: ago(120),
    lastAt: ago(60), cwd: `${VAULT}/workspaces/site`, startExists: true, via: "cwd", resumable: true, reason: null, ...extra,
  };
}

const sessions = (recent: WorkspaceSessionRow[]) => ({ claude: 1, codex: 1, total: 2, lastAt: ago(60), windowDays: 30, recent });
const world = (links: Record<string, string> = {}): PlaceWorld => ({ vault: VAULT, home: HOME, workspaces: ["site", "notes"], links });

function choices(o: { claude?: "on" | "off" | "out"; codex?: "on" | "off" | "out" } = {}): TermHostChoice[] {
  const one = (host: "claude" | "codex", label: string, s: "on" | "off" | "out" = "on"): TermHostChoice => ({
    host, label, hidden: s === "off", ready: s === "on", bin: null,
    reason: s === "off" ? `${label} is off on this machine` : s === "out" ? `${label} is not logged in: run its login` : null,
  });
  return [one("claude", "Claude Code", o.claude), one("codex", "Codex", o.codex), { host: "shell", label: "Shell", hidden: false, ready: true, reason: null, bin: null }];
}

/** The ctx the pure helpers read, with the calls they make recorded. */
function ctx(e: WorkspaceEntry, o: { claude?: "on" | "off" | "out"; codex?: "on" | "off" | "out"; sessions?: boolean; links?: Record<string, string>; quick?: "claude" | "codex" | null } = {}) {
  const calls: string[] = [];
  const act = new Proxy({}, { get: (_t, k: string) => (...args: unknown[]) => { calls.push(`${k}(${args.map((a) => JSON.stringify(a)).join(",")})`); } }) as SpacesActions;
  const snapshot = { workspaces: [e] } as unknown as Snapshot;
  const c = { snapshot, choices: choices(o), world: world(o.links), sessionsAvailable: o.sessions ?? true, act, vault: VAULT, quick: o.quick ?? null } as unknown as SpacesCtx;
  return { c, calls };
}

// ── file events (Mechanics › PR 2 › Files and wiring) ──

test("watchFlags: each watched path raises what it changes, and only the selected map or folder counts", () => {
  const o = { selected: "site", selectedPath: "workspaces/site", modify: true };
  assert.deepEqual(watchFlags("brain/_index/snapshot.json", o), ["snapshot"]);
  assert.deepEqual(watchFlags("brain/_index/workspace-maps/site.json", o), ["map"]);
  assert.deepEqual(watchFlags("brain/_index/workspace-maps/notes.json", o), [], "another workspace's map");
  // A thread's file appearing or going is a thread list change; a running turn appending its events is not (they come
  // through the Sessions events, SpacesTab's TURN_EVENTS), so a modify there raises nothing.
  assert.deepEqual(watchFlags("brain/_index/sessions/x/t.jsonl", o), []);
  assert.deepEqual(watchFlags("brain/_index/sessions/x/t.jsonl", { ...o, modify: false }), ["threads"]);
  assert.deepEqual(watchFlags("workspaces/notes/workspace.md", o), ["world"]);
  assert.deepEqual(watchFlags("TODO.md", o), ["linked"]);
  assert.deepEqual(watchFlags("persona/proposals/2026-10-01-x.md", o), ["linked"]);
  assert.deepEqual(watchFlags("brain/memory/projects/site.md", o), ["linked"]);
  assert.deepEqual(watchFlags("brain/memory/feedback/x.md", o), []);
  assert.deepEqual(watchFlags("workspaces/site/PLAN.md", o), [], "a modify inside the folder changes no listing");
  assert.deepEqual(watchFlags("workspaces/site/PLAN.md", { ...o, modify: false }), ["listing"], "a create, delete or rename does");
  assert.deepEqual(watchFlags("workspaces/site/workspace.md", { ...o, modify: false }), ["world", "listing"]);
  assert.deepEqual(watchFlags("workspaces/site-repo/x.md", { ...o, modify: false }), [], "a folder whose name only starts the same");
  assert.deepEqual(watchFlags("brain/_index/snapshot.json", { selected: null, selectedPath: null, modify: true }), ["snapshot"]);
  assert.deepEqual([...PANES_FOR.live], ["list"], "a terminal starting redraws only the list's live dot");
  assert.deepEqual([...PANES_FOR.map], ["centre", "right"]);
  assert.deepEqual([...PANES_FOR.world], ["centre", "right"], "the linked code folder is where History's Resume says it resumes");
});

test("panesFor: while Files shows the preview, only what the preview shows redraws it (no scroll reset on a turn or a to-do)", () => {
  const files = { previewShown: true, rightChanged: false };
  assert.deepEqual([...panesFor(["threads"], files)], ["list"]);
  assert.deepEqual([...panesFor(["linked"], files)], ["list"]);
  assert.deepEqual([...panesFor(["tree"], files)], ["centre"], "opening a folder in the tree");
  assert.deepEqual([...panesFor(["world"], files)], ["centre"]);
  assert.deepEqual([...panesFor(["map"], files)], ["centre", "right"], "the map is the preview's description");
  assert.deepEqual([...panesFor(["snapshot"], files)], ["list", "centre", "right"]);
  assert.deepEqual([...panesFor(["listing"], files)], ["centre", "right"]);
  assert.deepEqual([...panesFor(["tree"], { previewShown: true, rightChanged: true })], ["centre", "right"], "Overview → Files swaps the right pane");
  assert.deepEqual([...panesFor(["threads"], { previewShown: false, rightChanged: false })], ["list", "right"], "History is redrawn as before");
  assert.deepEqual([...panesFor([], files)], []);
  assert.deepEqual([...panesFor([], { previewShown: true, rightChanged: true })], ["right"]);
});

test("threadSignature: the same threads, workspaces and running states read the same in any order", () => {
  const t = (id: string, workspace: string, running: boolean) => ({ id, workspace, running });
  assert.equal(threadSignature([t("a", "site", false), t("b", "notes", true)]), threadSignature([t("b", "notes", true), t("a", "site", false)]));
  assert.notEqual(threadSignature([t("a", "site", false)]), threadSignature([t("a", "site", true)]), "a turn starting");
  assert.notEqual(threadSignature([t("a", "site", false)]), threadSignature([t("a", "site", false), t("b", "site", false)]), "a new thread");
  assert.equal(threadSignature([]), "");
});

// ── places and Resume (D5, D7, D31, D32) ──

test("entryPlace: a listed workspace's place (its code folder when linked); a hidden or vanished one is off with why", () => {
  const w = world({ site: `${HOME}/code/site` });
  assert.deepEqual(entryPlace(entry("site"), w).place, { kind: "workspace", label: "site", dir: `${HOME}/code/site`, workspace: "site", linked: true });
  assert.equal(entryPlace(entry("notes"), w).place?.dir, `${VAULT}/workspaces/notes`);
  assert.match(entryPlace(entry("_archive/old", { hidden: true, hiddenReason: "archived" }), w).reason ?? "", /^Archived and _ folders start no terminal/);
  assert.match(entryPlace(entry("gone"), w).reason ?? "", /rescan/);
});

test("primaryAction resumes the last thread in Code; a Codex-only vault's Claude thread is off with the host's reason", () => {
  const e = entry("site", { sessions: sessions([row(ID1, { host: "claude" }), row(ID2, { host: "codex", format: "codex", lastAt: ago(600) })]) });
  const both = ctx(e);
  const a = primaryAction(both.c, e);
  assert.equal(a.label, "Resume in Code");
  assert.equal(a.disabled, false);
  assert.match(a.title, /Resumes in workspaces\/site$/);
  a.run!();
  assert.deepEqual(both.calls, [`resume(${JSON.stringify({ workspace: "site", id: ID1 })})`]);

  const codexOnly = primaryAction(ctx(e, { claude: "off" }).c, e);
  assert.equal(codexOnly.disabled, true);
  assert.equal(codexOnly.reason, "Claude Code is off on this machine: run aos init --host claude");
  const notLogged = primaryAction(ctx(e, { claude: "out" }).c, e);
  assert.equal(notLogged.reason, "Claude Code is not logged in: run its login");
});

test("primaryAction: an app thread opens in Sessions; no thread yet starts the first ready host; none ready says why", () => {
  const app = entry("site", { sessions: sessions([row(ID1, { kind: "app", via: "app", thread: THREAD })]) });
  const s = ctx(app);
  const a = primaryAction(s.c, app);
  assert.equal(a.label, "Open in Sessions");
  a.run!();
  assert.deepEqual(s.calls, [`openSessions("${THREAD}")`]);
  assert.equal(primaryAction(ctx(app, { sessions: false }).c, app).reason, SESSIONS_OFF_TEXT);

  const fresh = entry("notes");
  const codexOnly = ctx(fresh, { claude: "off" });
  const start = primaryAction(codexOnly.c, fresh);
  assert.equal(start.label, "Start in Code");
  start.run!();
  assert.deepEqual(codexOnly.calls, [`newSession("codex")`], "a Codex-only vault starts Codex, never Claude Code");
  const none = primaryAction(ctx(fresh, { claude: "out", codex: "off" }).c, fresh);
  assert.equal(none.disabled, true);
  assert.equal(none.reason, "Claude Code is not logged in: run its login");
  // Both hosts ready: the one ⌘T would start (the last launched), not the first in the choices' order (host parity).
  const both = ctx(fresh, { quick: "codex" });
  const q = primaryAction(both.c, fresh);
  assert.equal(q.title, "No session yet: start a new Codex session in a Code terminal");
  q.run!();
  assert.deepEqual(both.calls, [`newSession("codex")`]);
  const outQuick = ctx(fresh, { quick: "codex", codex: "out" });
  primaryAction(outQuick.c, fresh).run!();
  assert.deepEqual(outQuick.calls, [`newSession("claude")`], "a quick host that is not ready falls back to the first ready one");
});

test("splitMenuItems: a row per host that is on, Terminal here, Open last thread in Sessions off for a CLI thread", () => {
  const e = entry("site", { sessions: sessions([row(ID1)]) });
  const both = splitMenuItems(ctx(e).c, e);
  assert.deepEqual(both.map((i) => [i.label, !!i.disabled, i.detail ?? null]), [
    ["New Claude Code session", false, null],
    ["New Codex session", false, null],
    ["Terminal here", false, null],
    ["Open last thread in Sessions", true, CLI_THREAD_TEXT],
  ]);
  const codexOnly = splitMenuItems(ctx(e, { claude: "off" }).c, e);
  assert.deepEqual(codexOnly.map((i) => i.label), ["New Codex session", "Terminal here", "Open last thread in Sessions"], "no row for a host that is off");
  const out = splitMenuItems(ctx(e, { codex: "out" }).c, e).find((i) => i.key === "new:codex")!;
  assert.deepEqual([out.disabled, out.detail], [true, "Codex is not logged in: run its login"]);
  const hidden = entry("_archive/old", { hidden: true });
  assert.ok(splitMenuItems(ctx(hidden).c, hidden).filter((i) => i.key !== "sessions").every((i) => i.disabled && /^Archived/.test(i.detail ?? "")));
});

test("moreMenuItems: Copy path, Reveal in Finder, Link code folder (Change… when linked); targetFor turns a hidden entry's Resume off", () => {
  const e = entry("site", { absPath: `${VAULT}/workspaces/site` });
  const m = ctx(e);
  assert.deepEqual(moreMenuItems(m.c, e).map((i) => i.label), ["Copy path", "Reveal in Finder", "Link code folder…"]);
  moreMenuItems(m.c, e)[0].run!();
  assert.deepEqual(m.calls, [`copy("${VAULT}/workspaces/site")`]);
  assert.equal(moreMenuItems(ctx(e, { links: { site: `${HOME}/code/site` } }).c, e)[2].label, "Change code folder…");
  const hidden = entry("_archive/old", { hidden: true, sessions: sessions([row(ID1)]) });
  const t = targetFor(ctx(hidden).c, hidden, { workspace: "_archive/old", id: ID1 });
  assert.equal(t.kind, "disabled");
});

test("sessionsFooter counts this workspace's app threads, is off with the reason when Sessions is hidden", () => {
  const t = (workspace: string) => ({ id: THREAD, workspace } as HostSessionThread);
  assert.deepEqual(sessionsFooter([t("site"), t("site"), t("notes")], "site", true), { text: "All 2 in Sessions →", disabled: false, reason: null });
  assert.equal(sessionsFooter([t("notes")], "site", true), null);
  assert.deepEqual(sessionsFooter([], "site", false), { text: "Threads in Sessions", disabled: true, reason: SESSIONS_OFF_TEXT });
});

test("typedCommand shows what a resume line types after exec: the configured binary, and Codex's -C folder (D7)", () => {
  const spec = (s: Partial<LaunchSpec>): LaunchSpec => ({ host: "claude", bin: null, model: null, access: "host", ...s });
  assert.equal(typedCommand(launchLine(spec({ resume: { id: ID1 } }))), `claude --resume ${ID1}`);
  assert.equal(typedCommand(launchLine(spec({ host: "codex", resume: { id: ID2 }, cwd: `${VAULT}/workspaces/site` }))), `codex resume -C ${VAULT}/workspaces/site ${ID2}`);
  assert.equal(typedCommand(launchLine(spec({ bin: "/opt/bin/claude", envPrefix: "CLAUDE_CONFIG_DIR='/x' ", resume: { id: ID1 } }))), `/opt/bin/claude --resume ${ID1}`);
  // On screen a path under home reads ~/… (the hint; its title keeps the full line); a shared prefix is not home.
  assert.equal(typedCommand(launchLine(spec({ host: "codex", resume: { id: ID2 }, cwd: `${VAULT}/workspaces/site` })), HOME), `codex resume -C ~/vault/workspaces/site ${ID2}`);
  assert.equal(typedCommand(launchLine(spec({ bin: `${HOME}/.local/bin/claude`, resume: { id: ID1 } })), HOME), `~/.local/bin/claude --resume ${ID1}`);
  assert.equal(typedCommand(launchLine(spec({ host: "codex", resume: { id: ID2 }, cwd: `${HOME}ed/x` })), HOME), `codex resume -C ${HOME}ed/x ${ID2}`);
  assert.equal(tilde(`${HOME}/code/site`, HOME), "~/code/site");
  assert.equal(entryAbs({ path: "workspaces/site" }, VAULT), `${VAULT}/workspaces/site`);
});
