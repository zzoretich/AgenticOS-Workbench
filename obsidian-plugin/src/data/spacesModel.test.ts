import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_RESUME_CROSS_FOLDER, CLI_THREAD_TEXT, HEURISTIC_READ_TEXT, LINKED_EMPTY_TEXT, PICKUP_EMPTY,
  SESSIONS_OFF_TEXT, formerNames, gitBrief, gitMeta, gitMetaParts, groupOf, hiddenToggleText, historyFor, hostOffText,
  linkedCounts, linkedFor, liveByWorkspace, matchesQuery, namesPath, newSessionRows, overviewFor, pickupFor,
  resumeTarget, sessionsLink, spaceList, spaceRow, statusPill, statusWord, workspaceSlug,
} from "./spacesModel";
import type { ResumeContext } from "./spacesModel";
import type { WorkspaceEntry, WorkspaceSessionRow } from "./snapshot";
import { CODEX_RESUME_CD, launchArgs } from "./terminalLaunch";
import type { PlaceWorld, TermHostChoice } from "./terminalLaunch";
import { groupKey } from "./termGroups";
import { parseTodos } from "./todos";
import { parseProposal } from "./proposals";
import { parseMemoryMeta } from "./memories";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const HOME = "/home/demo";
const VAULT = "/home/demo/vault";
const ago = (min: number): string => new Date(NOW - min * 60000).toISOString();

const ID1 = "0a1b2c3d-1111-4222-8333-444455556666";
const ID2 = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
const ID3 = "12345678-1234-4234-8234-123456789abc";

function entry(name: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    name, path: `workspaces/${name}`, status: "idle", statusSource: "derived", summary: null, summarySource: "derived",
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

const world = (links: Record<string, string> = {}): PlaceWorld => ({ vault: VAULT, home: HOME, workspaces: ["site", "notes", "scratch"], links });

function choices(o: { claude?: "on" | "off" | "out"; codex?: "on" | "off" | "out" } = {}): TermHostChoice[] {
  const one = (host: "claude" | "codex", label: string, s: "on" | "off" | "out" = "on"): TermHostChoice => ({
    host, label, hidden: s === "off", ready: s === "on", bin: null,
    reason: s === "off" ? `${label} is off on this machine` : s === "out" ? `${label} is not logged in` : null,
  });
  return [one("claude", "Claude Code", o.claude), one("codex", "Codex", o.codex), { host: "shell", label: "Shell", hidden: false, ready: true, reason: null, bin: null }];
}

// ── status and groups (D4, D11, D22) ──

test("statusWord reads the five words and maps workspace.md's and older snapshots' words; statusPill marks auto", () => {
  assert.equal(statusWord({ status: "active" }), "active");
  assert.equal(statusWord({ status: "Shipped" }), "done");
  assert.equal(statusWord({ status: "on_hold" }), "paused");
  assert.equal(statusWord({ status: "planned" }), "idle", "an older snapshot's word reads idle");
  assert.equal(statusWord({ status: null }), "idle");
  assert.deepEqual(statusPill({ status: "active", statusSource: "derived", statusOverride: null }), { word: "active", auto: true, text: "active · auto", tone: "ok", hollow: false });
  assert.deepEqual(statusPill({ status: "paused", statusSource: "manifest", statusOverride: "paused" }), { word: "paused", auto: false, text: "paused", tone: "warn", hollow: true });
  assert.equal(statusPill({ status: "stalled", statusSource: "derived" }).tone, "warn");
  assert.equal(statusPill({ status: "idle", statusSource: "derived" }).tone, "off");
});

test("spaceList groups PINNED, ACTIVE, STALLED, IDLE; paused and done in IDLE; pinned first whatever its status", () => {
  const list = [
    entry("old", { status: "idle", activity: { at: ago(60 * 24 * 40), ageDays: 40, from: "commit" } }),
    entry("site", { status: "active", activity: { at: ago(30), ageDays: 0, from: "session" } }),
    entry("pinned-idle", { status: "idle", pinned: true }),
    entry("pinned-active", { status: "active", pinned: true, activity: { at: ago(10), ageDays: 0, from: "session" } }),
    entry("waiting", { status: "stalled" }),
    entry("hold", { status: "paused", statusOverride: "paused", statusSource: "manifest" }),
    entry("shipped", { status: "done", statusOverride: "done", statusSource: "manifest" }),
    entry("notes", { status: "active", activity: { at: ago(300), ageDays: 0, from: "commit" } }),
  ];
  const l = spaceList(list);
  assert.deepEqual(l.groups.map((g) => [g.label, g.entries.map((e) => e.name)]), [
    ["PINNED", ["pinned-active", "pinned-idle"]],
    ["ACTIVE", ["site", "notes"]],
    ["STALLED", ["waiting"]],
    ["IDLE", ["old", "hold", "shipped"]],
  ]);
  assert.deepEqual(l.groups.map((g) => g.collapsed), [false, false, false, true], "IDLE starts folded");
  assert.equal(l.total, 8);
  assert.equal(l.shown, 8);
  assert.equal(l.hiddenCount, 0);
});

test("hidden entries stay out unless the toggle is on, and then sit in their own group; the toggle counts them", () => {
  const list = [
    entry("site", { status: "active" }),
    entry("_spikes", { hidden: true, hiddenReason: "underscore" }),
    entry("_archive/old", { hidden: true, hiddenReason: "archived", label: "old", pinned: true }),
  ];
  const off = spaceList(list);
  assert.deepEqual(off.groups.map((g) => g.key), ["active"]);
  assert.equal(off.hiddenCount, 2);
  assert.equal(off.total, 1);
  assert.equal(hiddenToggleText(off.hiddenCount), "Show archived and _ folders (2)");
  const on = spaceList(list, { showHidden: true });
  assert.deepEqual(on.groups.map((g) => [g.key, g.entries.map((e) => e.name)]), [["active", ["site"]], ["hidden", ["_archive/old", "_spikes"]]]);
  assert.equal(groupOf(list[2]), "hidden", "an archived entry is never PINNED");
});

test("the filter matches name, branch and next step, every word, case-insensitive; a typed filter unfolds IDLE", () => {
  const repo = { kind: "repo" as const, branch: "feat/tiles", detached: false, head: "abc1234", upstream: null, ahead: null, behind: null, dirty: 0, remotes: ["origin"] };
  const list = [
    entry("site", { status: "idle", git: repo }),
    entry("notes", { status: "active", next: { text: "Decide the dark colour", source: "derived", from: "HANDOFF-x.md › Next" } }),
    entry("career", { status: "active", summary: "tiles everywhere" }),
  ];
  assert.equal(matchesQuery(list[0], "TILES"), true, "branch");
  assert.equal(matchesQuery(list[1], "dark colour"), true, "next, two words");
  assert.equal(matchesQuery(list[1], "dark site"), false, "every word must match");
  assert.equal(matchesQuery(list[2], "tiles"), false, "the summary is not searched");
  const l = spaceList(list, { query: "tiles" });
  assert.deepEqual(l.groups.map((g) => [g.key, g.entries.map((e) => e.name), g.collapsed]), [["idle", ["site"], false]]);
  assert.equal(spaceList(list, { query: "  " }).shown, 3);
});

// ── live (D26) ──

test("liveByWorkspace counts running terminals placed in a workspace and running Sessions threads", () => {
  const live = liveByWorkspace(
    [{ workspace: "site", running: true }, { workspace: "site", running: false }, { workspace: "notes", running: true }],
    [{ place: { workspace: "site" }, exited: false }, { place: { workspace: "site" }, exited: true }, { place: {}, exited: false }, { place: { workspace: "notes" }, exited: false }],
  );
  assert.deepEqual([...live.keys()].sort(), ["notes", "site"]);
  assert.deepEqual(live.get("site"), { terminals: 1, threads: 1, total: 2, title: "Live: 1 terminal in Code, 1 running thread in Sessions" });
  assert.equal(live.get("notes")!.title, "Live: 1 terminal in Code, 1 running thread in Sessions");
  assert.equal(liveByWorkspace(null, null).size, 0);
});

// ── git and the row (D4, D24) ──

test("gitBrief and gitMeta: clean, dirty, no remote, detached, vault-tracked, none", () => {
  const base = { kind: "repo" as const, branch: "main", detached: false, head: "7fda846", upstream: "origin/main", ahead: 0, behind: 0, dirty: 0, remotes: ["origin"] };
  assert.deepEqual(gitBrief(base), { kind: "repo", text: "main ✓", tone: null, dirty: 0, noRemote: false });
  assert.deepEqual(gitBrief({ ...base, dirty: 11 }).text, "main · 11 changed");
  assert.equal(gitBrief({ ...base, dirty: 11 }).tone, "warn");
  assert.deepEqual(gitBrief({ ...base, remotes: [] }), { kind: "repo", text: "main ✓ · no remote", tone: "off", dirty: 0, noRemote: true });
  assert.equal(gitBrief({ ...base, branch: null, detached: true }).text, "detached 7fda846 ✓");
  assert.equal(gitBrief({ kind: "vault" }).text, "tracked by the vault");
  assert.equal(gitBrief(null).text, "no git");
  assert.equal(gitMeta(base), "main · clean · 7fda846");
  assert.equal(gitMeta({ ...base, dirty: 2, ahead: 1, behind: 2, remotes: [] }), "main · 2 changed · 7fda846 · ↑1 ↓2 · no remote");
  assert.equal(gitMeta({ kind: "vault" }), "tracked by the vault");
  assert.equal(gitMeta(undefined), null);
  // The pane colours only the parts that carry a state (D19): dirty warn, no remote off; branch, hash, ahead/behind none.
  assert.deepEqual(gitMetaParts({ ...base, dirty: 2, ahead: 1, behind: 2, remotes: [] }), [
    { text: "main", tone: null }, { text: "2 changed", tone: "warn" }, { text: "7fda846", tone: null }, { text: "↑1 ↓2", tone: null }, { text: "no remote", tone: "off" },
  ]);
  assert.deepEqual(gitMetaParts(base)?.map((p) => p.tone), [null, null, null]);
  assert.equal(gitMetaParts(null), null);
});

test("spaceRow: status, age, git, hosts with counts, live dot, the next step or the handoff's Now line, counts", () => {
  const e = entry("site", {
    status: "stalled", activity: { at: ago(60 * 24 * 12), ageDays: 12, from: "commit" },
    sessions: { claude: 6, codex: 2, total: 8, lastAt: ago(40), windowDays: 30 },
    handoff: { file: "HANDOFF-site.md", now: "Ship the tiles", next: null, asOf: null, mtime: null },
  });
  const live = liveByWorkspace([], [{ place: { workspace: "site" }, exited: false }]);
  const r = spaceRow(e, { live, counts: { todos: 2, proposals: 1 }, now: NOW });
  assert.equal(r.age, "12d");
  assert.equal(r.ageTone, "warn");
  assert.equal(r.hostsText, "claude 6 · codex 2");
  assert.equal(r.line, "Now: Ship the tiles");
  assert.equal(r.lineKind, "now");
  assert.equal(r.live?.terminals, 1);
  assert.equal(r.git.text, "no git");
  assert.deepEqual([r.todos, r.proposals], [2, 1]);
  const withNext = spaceRow({ ...e, next: { text: "Decide the colour", source: "derived" }, sessions: { claude: 0, codex: 1, total: 1, lastAt: null } }, { now: NOW });
  assert.equal(withNext.line, "Next: Decide the colour");
  assert.equal(withNext.hostsText, "codex 1");
  assert.equal(withNext.live, null);
});

// ── Resume (D7, D31, D32) ──

const snap = (rows: WorkspaceSessionRow[], extra: Partial<WorkspaceEntry> = {}) => ({
  workspaces: [entry("site", { sessions: { claude: 1, codex: 1, total: 2, lastAt: ago(60), windowDays: 30, recent: rows }, ...extra })],
});
// Each case names the D7 branch it takes, so flipping CLAUDE_RESUME_CROSS_FOLDER.works (as its comment says to, should a
// later Claude Code stop finding threads across folders) leaves these tests meaning what they say.
const CTX: ResumeContext = { world: world(), claudeCrossFolder: true };

test("the D7 build checks: resumeTarget's default is the recorded answer; a Codex resume types -C before the id", () => {
  const s = snap([row(ID1, { cwd: VAULT })]);
  const noDefault: ResumeContext = { world: CTX.world };
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID1 }, s, choices(), noDefault),
    resumeTarget({ workspace: "site", id: ID1 }, s, choices(), { ...CTX, claudeCrossFolder: CLAUDE_RESUME_CROSS_FOLDER.works }));
  // What a Codex resume types comes from launchArgs (LaunchSpec.cwd): the recorded flag, then the folder, then the id.
  const cwd = `${VAULT}/workspaces/site`;
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "host", resume: { id: ID2 }, cwd }), ["resume", "-C", cwd, ID2]);
  assert.equal(CODEX_RESUME_CD.flag, "-C");
});

test("resumeTarget: both hosts resume in the workspace's place, its linked code folder when it has one (D7, A1)", () => {
  const s = snap([row(ID1), row(ID2, { host: "codex", format: "codex", cwd: VAULT })]);
  const c = resumeTarget({ workspace: "site", id: ID1 }, s, choices(), CTX);
  assert.equal(c.kind, "terminal");
  if (c.kind !== "terminal") return;
  assert.deepEqual([c.host, c.id, c.cwd, c.startFolder, c.hint], ["claude", ID1, `${VAULT}/workspaces/site`, false, "Resumes in workspaces/site"]);
  assert.equal(groupKey(c.place), "ws:site");
  const x = resumeTarget({ workspace: "site", id: ID2 }, s, choices(), CTX);
  assert.equal(x.kind === "terminal" && x.cwd, `${VAULT}/workspaces/site`, "a Codex row started at the vault root resumes in the workspace");
  const linked = resumeTarget({ workspace: "site", id: ID1 }, s, choices(), { ...CTX, world: world({ site: `${HOME}/code/site` }) });
  assert.equal(linked.kind, "terminal");
  if (linked.kind !== "terminal") return;
  assert.equal(linked.cwd, `${HOME}/code/site`);
  assert.equal(linked.place.linked, true);
  assert.equal(linked.hint, "Resumes in ~/code/site, its code folder");
  assert.equal(groupKey(linked.place), "ws:site");
});

test("resumeTarget with the start-folder fallback on: a Claude row resumes where it started, a Codex row in the workspace", () => {
  const fallback: ResumeContext = { ...CTX, claudeCrossFolder: false };
  const s = snap([
    row(ID1, { cwd: VAULT }),
    row(ID2, { host: "codex", format: "codex", cwd: VAULT }),
    row(ID3, { cwd: `${HOME}/gone/place`, startExists: false }),
  ]);
  const c = resumeTarget({ workspace: "site", id: ID1 }, s, choices(), fallback);
  assert.equal(c.kind, "terminal");
  if (c.kind !== "terminal") return;
  assert.equal(c.cwd, VAULT);
  assert.equal(c.startFolder, true);
  assert.equal(c.hint, "Resumes at ~/vault where it started");
  assert.equal(c.place.dir, VAULT);
  assert.equal(c.place.linked, false);
  assert.equal(groupKey(c.place), "ws:site", "a vault-root start folder still lands in the workspace's Code group");
  const x = resumeTarget({ workspace: "site", id: ID2 }, s, choices(), fallback);
  assert.equal(x.kind === "terminal" && x.cwd, `${VAULT}/workspaces/site`, "Codex rollouts are global: always the workspace");
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID3 }, s, choices(), fallback), { kind: "disabled", disabled: true, reason: "Started in ~/gone/place, which no longer exists" });
  assert.equal(resumeTarget({ workspace: "site", id: ID3 }, s, choices(), CTX).kind, "terminal", "with the fallback off a vanished start folder does not matter");
  // A Claude row with no start folder recorded: the fallback knows no folder to find it from, so it says so.
  const noCwd = snap([row(ID1, { cwd: null })]);
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID1 }, noCwd, choices(), fallback), { kind: "disabled", disabled: true, reason: "No start folder recorded for this thread" });
  assert.equal(resumeTarget({ workspace: "site", id: ID1 }, noCwd, choices(), CTX).kind, "terminal", "with the fallback off the workspace's place is used");
});

test("resumeTarget: a thread credited through a worktree resumes in the workspace's place, and the hint says so (D7)", () => {
  const wt = `${VAULT}/workspaces/.worktrees/site/feat-x`;
  const s = snap([row(ID2, { host: "codex", format: "codex", via: "worktree", cwd: wt })]);
  const t = resumeTarget({ workspace: "site", id: ID2 }, s, choices(), CTX);
  assert.equal(t.kind, "terminal");
  if (t.kind !== "terminal") return;
  assert.equal(t.cwd, `${VAULT}/workspaces/site`);
  assert.equal(t.hint, "Resumes in workspaces/site, not the worktree it started in");
  const plain = resumeTarget({ workspace: "site", id: ID2 }, snap([row(ID2, { host: "codex", format: "codex" })]), choices(), CTX);
  assert.equal(plain.kind === "terminal" && plain.hint, "Resumes in workspaces/site");
});

test("resumeTarget refuses an id that is not a UUID, starts with -, or is not in this workspace's recent sessions", () => {
  const s = snap([row("not-a-uuid"), row("--dangerous"), row(ID1.toUpperCase())]);
  assert.deepEqual(resumeTarget({ workspace: "site", id: "not-a-uuid" }, s, choices(), CTX), { kind: "disabled", disabled: true, reason: "Not a session id that can be resumed" });
  assert.deepEqual(resumeTarget({ workspace: "site", id: "--dangerous" }, s, choices(), CTX), { kind: "disabled", disabled: true, reason: "Not a session id that can be resumed" });
  assert.equal(resumeTarget({ workspace: "site", id: ID1.toUpperCase() }, s, choices(), CTX).kind, "disabled", "the scan records lowercase ids");
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID2 }, s, choices(), CTX), { kind: "disabled", disabled: true, reason: "No longer among this workspace's recent sessions" });
  // Another workspace's id: "notes" is in the scan, but ID1 is only in site's recent, so it cannot be resumed through notes.
  const two = { workspaces: [
    entry("site", { sessions: { claude: 1, codex: 0, total: 1, lastAt: ago(60), windowDays: 30, recent: [row(ID1)] } }),
    entry("notes", { sessions: { claude: 0, codex: 0, total: 0, lastAt: null, windowDays: 30, recent: [] } }),
  ] };
  assert.deepEqual(resumeTarget({ workspace: "notes", id: ID1 }, two, choices(), CTX), { kind: "disabled", disabled: true, reason: "No longer among this workspace's recent sessions" });
  assert.equal(resumeTarget({ workspace: "site", id: ID1 }, two, choices(), CTX).kind, "terminal");
  assert.deepEqual(resumeTarget({ workspace: "gone", id: ID1 }, snap([row(ID1)]), choices(), CTX), { kind: "disabled", disabled: true, reason: "This workspace is not in the current scan" });
  assert.equal(resumeTarget({ workspace: "site", id: ID1 }, null, choices(), CTX).kind, "disabled");
});

test("resumeTarget shows each resumable:false reason the scan recorded", () => {
  const reasons = [
    "Headless run: open it in Sessions or start a new session",
    "Archived in Codex",
    "A team seat's run: it belongs to its board item, not to a terminal",
    "The transcript names no session id, so it cannot be resumed by id",
    "Its session id is not the lowercase id in its file name, so resuming by id could open another thread",
  ];
  for (const reason of reasons) {
    const t = resumeTarget({ workspace: "site", id: ID1 }, snap([row(ID1, { resumable: false, reason, kind: reason.startsWith("A team") ? "team" : "interactive" })]), choices(), CTX);
    assert.deepEqual(t, { kind: "disabled", disabled: true, reason });
  }
  assert.equal((resumeTarget({ workspace: "site", id: ID1 }, snap([row(ID1, { resumable: false, reason: null })]), choices(), CTX) as { reason: string }).reason, "This session cannot be resumed");
});

test("resumeTarget: host off is disabled with the aos init fix, also when the choices have no row for it; not logged in with its reason (D31)", () => {
  const s = snap([row(ID1), row(ID2, { host: "codex", format: "codex" })]);
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID1 }, s, choices({ claude: "off" }), CTX),
    { kind: "disabled", disabled: true, reason: "Claude Code is off on this machine: run aos init --host claude" });
  assert.equal(hostOffText("codex"), "Codex is off on this machine: run aos init --host codex");
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID2 }, s, choices().filter((c) => c.host !== "codex"), CTX),
    { kind: "disabled", disabled: true, reason: hostOffText("codex") });
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID2 }, s, choices({ codex: "out" }), CTX), { kind: "disabled", disabled: true, reason: "Codex is not logged in" });
  // A Codex-only vault resumes a Codex thread.
  const x = resumeTarget({ workspace: "site", id: ID2 }, s, choices({ claude: "off" }), CTX);
  assert.equal(x.kind === "terminal" && x.host, "codex");
});

test("resumeTarget opens a Sessions thread in Sessions, off with the reason where Sessions is hidden (D32)", () => {
  const thread = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000";
  const s = snap([row(ID1, { kind: "app", via: "app", resumable: false, reason: "A Sessions thread: open it in Sessions", thread })]);
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID1 }, s, choices(), CTX), { kind: "sessions", disabled: false, workspace: "site", thread, hint: "Opens in Sessions" });
  assert.deepEqual(resumeTarget({ workspace: "site", id: ID1 }, s, choices(), { ...CTX, sessionsAvailable: false }), { kind: "disabled", disabled: true, reason: SESSIONS_OFF_TEXT });
  const bad = snap([row(ID1, { kind: "app", via: "app", resumable: false, thread: "../x" })]);
  assert.equal(resumeTarget({ workspace: "site", id: ID1 }, bad, choices(), CTX).kind, "disabled");
});

test("newSessionRows lists only hosts that are on; one not logged in is disabled with its reason (D31)", () => {
  assert.deepEqual(newSessionRows(choices({ claude: "off" })), [{ host: "codex", label: "New Codex session", disabled: false, reason: null }], "Codex-only: no Claude row");
  assert.deepEqual(newSessionRows(choices({ codex: "out" })), [
    { host: "claude", label: "New Claude Code session", disabled: false, reason: null },
    { host: "codex", label: "New Codex session", disabled: true, reason: "Codex is not logged in" },
  ]);
});

test("sessionsLink: only a Sessions thread opens in Sessions; a CLI thread says to resume it in Code (D32)", () => {
  assert.deepEqual(sessionsLink(row(ID1), true), { disabled: true, reason: CLI_THREAD_TEXT, thread: null });
  assert.deepEqual(sessionsLink(row(ID1, { kind: "app", thread: ID2 }), true), { disabled: false, reason: null, thread: ID2 });
  assert.deepEqual(sessionsLink(row(ID1, { kind: "app", thread: ID2 }), false), { disabled: true, reason: SESSIONS_OFF_TEXT, thread: null });
  assert.equal(sessionsLink(null, true).reason, "No session yet");
  // The same id check resumeTarget makes: a malformed thread field opens nothing.
  assert.deepEqual(sessionsLink(row(ID1, { kind: "app", thread: "../x" }), true), { disabled: true, reason: "This Sessions thread has no id the page can open", thread: null });
  assert.equal(sessionsLink(row(ID1, { kind: "app" }), true).disabled, true, "an app row with no thread");
});

// ── pick-up, Overview, History (D6, D8, D10) ──

test("pickupFor: last is the newest interactive or Sessions row; now, next and read name their sources", () => {
  const e = entry("site", {
    sessions: { claude: 2, codex: 1, total: 3, lastAt: ago(5), windowDays: 30, recent: [
      row(ID3, { kind: "team", lastAt: ago(5), resumable: false }),
      row(ID2, { host: "codex", format: "codex", kind: "headless", lastAt: ago(10) }),
      row(ID1, { title: "Rail sections", lastAt: ago(40) }),
    ] },
    handoff: { file: "HANDOFF-site.md", now: "1.6.0 is released", next: "Decide the colour", asOf: "2026-10-09", mtime: null },
    next: { text: "Decide the colour", source: "derived", from: "HANDOFF-site.md › Next" },
    insight: { text: "Moving fast.", status: "ok", model: "qwen3.5:9b", generatedAt: ago(120), next: "fold the handoffs into one" },
  });
  const p = pickupFor(e, { now: NOW, provider: "ollama" });
  assert.equal(p.last.text, "claude · 40m — “Rail sections”");
  assert.deepEqual(p.last.resume, { workspace: "site", id: ID1 });
  assert.equal(p.now.text, "1.6.0 is released");
  assert.equal(p.now.source, "from HANDOFF-site.md › Now");
  assert.equal(p.header, "from HANDOFF-site.md › Now");
  assert.equal(p.next.source, "from HANDOFF-site.md › Next");
  assert.equal(p.read.text, "Moving fast.");
  assert.equal(p.read.source, "qwen3.5:9b · 2h");
  assert.equal(p.read.suggests, "fold the handoffs into one");
  assert.equal(p.read.refreshNote, null);
});

test("pickupFor empty states; under provider none ↻ stays on and says the read will be the heuristic's", () => {
  const p = pickupFor(entry("site", { sessions: { claude: 1, codex: 0, total: 1, lastAt: ago(5), recent: [row(ID1, { kind: "headless" })] } }), { now: NOW, provider: "none" });
  assert.equal(p.last.text, null);
  assert.equal(p.last.empty, PICKUP_EMPTY.last);
  assert.equal(p.now.empty, "No Now line in a handoff");
  assert.equal(p.next.empty, "No next step in HANDOFF, STATUS or PLAN");
  assert.equal(p.read.empty, PICKUP_EMPTY.read);
  assert.equal(p.read.refreshNote, HEURISTIC_READ_TEXT);
  assert.equal(pickupFor(entry("site"), { now: NOW }).read.refreshNote, HEURISTIC_READ_TEXT, "no provider given reads as none");
  assert.equal(PICKUP_EMPTY.read, "No insight yet", "the row's ↻ button is the glyph; the text names none");
  assert.equal(pickupFor(entry("site"), { now: NOW, provider: "claude" }).read.refreshNote, null, "a provider: ↻ needs no note");
  const manifest = pickupFor(entry("site", { next: { text: "Write it", source: "manifest" } }), { now: NOW });
  assert.equal(manifest.next.source, "from workspace.md");
});

test("overviewFor: summary with its source, objectives n of m, documents with age, note and done", () => {
  const o = overviewFor(entry("site", {
    summary: "Product work.", summarySource: "manifest",
    objectives: [{ text: "Ship", source: "manifest", done: true }, { text: "Record", source: "manifest" }, { text: "Decide", source: "manifest", done: false }],
    docs: [{ name: "HANDOFF-site.md", path: "workspaces/site/HANDOFF-site.md", mtime: ago(60 * 24), note: "Now: shipped", done: true }],
  }), { now: NOW });
  assert.deepEqual(o.summary, { text: "Product work.", source: "workspace.md", template: false });
  assert.deepEqual([o.objectives.done, o.objectives.total, o.objectives.pct, o.objectives.label], [1, 3, 33, "1 of 3"]);
  assert.deepEqual(o.docs, [{ name: "HANDOFF-site.md", path: "workspaces/site/HANDOFF-site.md", note: "Now: shipped", age: "1d", done: true }]);
  const t = overviewFor(entry("x", { summaryTemplate: true }), { now: NOW });
  assert.deepEqual(t.summary, { text: null, source: null, template: true });
  assert.equal(t.objectives.label, "");
});

test("historyFor merges sessions and commits newest first; commits from a linked code folder say so", () => {
  const e = entry("site", {
    repoPath: `${HOME}/code/site`,
    git: { kind: "repo", branch: "main", detached: false, head: "7fda846", upstream: null, ahead: null, behind: null, dirty: 0, remotes: ["origin"] },
    commits: [{ hash: "7fda846", iso: ago(60), subject: "docs: record the run" }, { hash: "61f20cf", iso: ago(300), subject: "chore: 1.6.0" }],
    sessions: { claude: 1, codex: 1, total: 2, lastAt: ago(40), recent: [row(ID1, { lastAt: ago(40), title: "Rail" }), row(ID2, { host: "codex", format: "codex", lastAt: ago(540), title: null })] },
  });
  const all = historyFor(e, "all", { now: NOW, home: HOME });
  assert.deepEqual(all.map((h) => [h.kind, h.title, h.meta]), [
    ["session", "Rail", "claude · 40m"],
    ["commit", "docs: record the run", "7fda846 · 1h · code folder"],
    ["commit", "chore: 1.6.0", "61f20cf · 5h · code folder"],
    ["session", "Untitled session", "codex · 9h"],
  ]);
  assert.deepEqual(all[0].resume, { workspace: "site", id: ID1 });
  assert.deepEqual(historyFor(e, "sessions", { now: NOW }).map((h) => h.kind), ["session", "session"]);
  assert.deepEqual(historyFor(e, "commits", { now: NOW }).map((h) => h.hash), ["7fda846", "61f20cf"]);
});

// ── Linked (D27) ──

const TODO = `# To-Do

## Open

- [ ] Run the update check #ws/site 📅 2026-10-12
- [ ] Fix the old tiles #ws/old-site
- [ ] Something else #ws/site-repo
- [ ] Untagged but names site
- [x] Done already #ws/site ✅ 2026-10-01
`;

function proposal(name: string, target: string, recheck: string): ReturnType<typeof parseProposal> {
  return parseProposal(name, `---\nkind: product\nsurface: hud\ntarget: ${target}\nrecheck: "${recheck}"\n---\n\n## What\n\nx\n`);
}

test("linkedFor: tagged to-dos, proposals by target or recheck, memory by workspace:, slug or a body mention; each says how", () => {
  const e = entry("site", { aliases: [`${VAULT}/workspaces/old-site`, `${HOME}/code/site-old`] });
  const memories = [
    parseMemoryMeta("brain/memory/projects/unrelated.md", "---\nworkspace: site\n---\n# Keyed\n"),
    parseMemoryMeta("brain/memory/projects/site.md", "---\ntype: memory\n---\n# Same slug\n"),
    parseMemoryMeta("brain/memory/projects/notes.md", "# Mentioned\n\nSee workspaces/old-site/PLAN.md for the plan.\n"),
    parseMemoryMeta("brain/memory/projects/other.md", "# Not\n\nworkspaces/site-repo/ and workspaces/site but no slash.\n"),
  ];
  const proposals = [
    proposal("2026-10-01-a.md", "workspaces/site/PLAN.md", "test -f x"),
    proposal("2026-10-02-b.md", "brain/scripts/x.js", "grep -q y workspaces/site"),
    proposal("2026-10-03-c.md", "workspaces/site-repo/x", "true"),
    proposal("2026-10-04-d.md", "~/code/site-old/src/x.ts", "true"),
    proposal("2026-10-05-e.md", "workspaces/old-site/x.md", "true"),
  ];
  const l = linkedFor(e, { todos: parseTodos(TODO), proposals, memories }, { vault: VAULT, home: HOME });
  const [todo, prop, mem] = l.groups;
  assert.deepEqual(todo.items.map((i) => [i.text, i.how, i.howText]), [
    ["Run the update check", "tag", "tagged #ws/site"],
    ["Fix the old tiles", "tag", "tagged #ws/old-site (former name old-site)"],
  ]);
  assert.deepEqual(prop.items.map((i) => [i.text, i.how, i.howText, i.tag]), [
    ["a", "target", "its target names workspaces/site", "pending"],
    ["b", "recheck", "its recheck names workspaces/site", "pending"],
    ["d", "target", "its target names ~/code/site-old", "pending"],
    ["e", "target", "its target names workspaces/old-site (former name old-site)", "pending"],
  ]);
  assert.deepEqual(mem.items.map((i) => [i.text, i.how, i.howText]), [
    ["Keyed", "workspace", "workspace: site"],
    ["Same slug", "slug", "named site"],
    ["Mentioned", "mention", "mentions workspaces/old-site/ (former name old-site)"],
  ]);
  assert.deepEqual([todo.countText, prop.countText, mem.countText], ["2", "4", "3"]);
  assert.equal(l.total, 9);
  assert.deepEqual(linkedCounts(l), { todos: 2, proposals: 4 });
});

test("linkedFor: zero counts show no number; nothing linked is empty", () => {
  const l = linkedFor(entry("lonely"), { todos: parseTodos(TODO), proposals: [], memories: [] }, { vault: VAULT });
  assert.equal(l.empty, true);
  assert.equal(l.total, 0);
  assert.deepEqual(l.groups.map((g) => [g.label, g.count, g.countText]), [["To-do", 0, null], ["Proposal", 0, null], ["Memory", 0, null]]);
  assert.equal(LINKED_EMPTY_TEXT, "Nothing links to this space: no to-dos, proposals or memory notes name it.");
  assert.equal(linkedFor(entry("x"), {}).empty, true);
});

test("formerNames come from aliases under the vault's workspaces/ (Rename's), not adopted folders; workspaceSlug", () => {
  const e = entry("site", { aliases: [`${VAULT}/workspaces/old-site`, `${VAULT}/workspaces/_archive/older`, `${HOME}/code/x`, `${VAULT}/workspaces/site`] });
  assert.deepEqual(formerNames(e, VAULT), ["old-site", "older"]);
  assert.deepEqual(formerNames(e), ["old-site", "older"], "without the vault, the parent folder's name decides");
  assert.equal(workspaceSlug(entry("_archive/My Site", { label: "My Site" })), "my-site");
});

test("namesPath: whole path segments only", () => {
  assert.equal(namesPath("workspaces/site/PLAN.md", "workspaces/site"), true);
  assert.equal(namesPath("see (workspaces/site).", "workspaces/site"), true);
  assert.equal(namesPath("ends in workspaces/site.", "workspaces/site"), true);
  assert.equal(namesPath("/abs/vault/workspaces/site", "workspaces/site"), true);
  assert.equal(namesPath("workspaces/site-repo/x", "workspaces/site"), false);
  assert.equal(namesPath("workspaces/site.com/x", "workspaces/site"), false);
  assert.equal(namesPath("myworkspaces/site", "workspaces/site"), false);
  assert.equal(namesPath(null, "workspaces/site"), false);
});
