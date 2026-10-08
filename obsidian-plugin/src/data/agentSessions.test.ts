import { test } from "node:test";
import assert from "node:assert/strict";
import {
  doneFooter, fileStatusLabel, groupThreads, hostChoices, mergeEvents, statusSummary, threadMeta, timelineRows, toolLine,
  turnOpen, usdText, workspaceNames,
} from "./agentSessions";
import type { HostGitStatus, HostSessionEvent, HostSessionThread } from "../host";

const thread = (id: string, workspace: string, updated: string, extra: Partial<HostSessionThread> = {}): HostSessionThread => ({
  id, workspace, host: "claude", model: null, effort: null, access: "edit", title: id, created: updated, updated, turns: 1, running: false, usd: 0, ...extra,
});
const ev = (kind: HostSessionEvent["kind"], turn: number, fields: Record<string, unknown> = {}): HostSessionEvent => ({ t: "2026-10-07T10:00:00.000Z", kind, turn, ...fields });

test("workspaceNames: plain folder names, sorted; hidden folders and the team worktrees are left out", () => {
  assert.deepEqual(workspaceNames(["tide", ".git", "_worktrees", "harbor-map", ""]), ["harbor-map", "tide"]);
  assert.deepEqual(workspaceNames([]), []);
});

test("groupThreads: by workspace, newest first within each, the workspace with the newest thread first", () => {
  const groups = groupThreads([
    thread("a", "harbor-map", "2026-10-07T09:00:00Z"),
    thread("b", "tide", "2026-10-07T11:00:00Z"),
    thread("c", "harbor-map", "2026-10-07T10:00:00Z"),
  ]);
  assert.deepEqual(groups.map((g) => [g.workspace, g.threads.map((t) => t.id)]), [["tide", ["b"]], ["harbor-map", ["c", "a"]]]);
  assert.deepEqual(groupThreads([]), []);
});

test("threadMeta and usdText: turns, then the spend (Codex's marked as an estimate)", () => {
  assert.equal(threadMeta(thread("a", "w", "x")), "1 turn");
  assert.equal(threadMeta(thread("a", "w", "x", { turns: 2, usd: 0.04 })), "2 turns · $0.04");
  assert.equal(threadMeta(thread("a", "w", "x", { host: "codex", turns: 3, usd: 0.0012 })), "3 turns · ≈$0.0012");
  assert.equal(usdText(0), "$0.00");
  assert.equal(usdText(1.5), "$1.50");
});

test("toolLine: kind · name · file, with the parts that are missing left out", () => {
  assert.equal(toolLine({ toolKind: "edit", name: "Edit", filePath: "src/a.js", summary: "" }), "edit · Edit · src/a.js");
  assert.equal(toolLine({ toolKind: "bash", name: "shell", filePath: null, summary: "npm test" }), "bash · shell");
  assert.equal(toolLine({ toolKind: "", name: "Task", filePath: null, summary: "" }), "other · Task");
});

test("timelineRows: prompts, text, a tool with its result folded in, files, errors, and a footer per turn; the session id is left out", () => {
  const rows = timelineRows([
    ev("prompt", 1, { text: "fix the parser" }),
    ev("session", 1, { id: "abc" }),
    ev("text", 1, { text: "Fixed." }),
    ev("tool", 1, { id: "t1", name: "Edit", toolKind: "edit", summary: "{\"file_path\":\"src/a.js\"}", filePath: "src/a.js" }),
    ev("tool", 1, { id: "t2", name: "Bash", toolKind: "bash", summary: "npm test", filePath: null }),
    ev("tool_result", 1, { id: "t1", ok: true, summary: "ok" }),
    ev("tool_result", 1, { id: "t2", ok: false, summary: "1 failing" }),
    ev("usage", 1, { in: 1200, out: 45, usd: 0.02, estimated: false }),
    ev("done", 1, { ok: true, usd: 0.02, estimated: false }),
    ev("prompt", 2, { text: "go" }),
    ev("patch", 2, { files: [{ path: "src/b.js", change: "add" }] }),
    ev("error", 2, { message: "stopped" }),
    ev("done", 2, { ok: false, usd: null, estimated: true }),
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "text", "tool", "tool", "done", "prompt", "patch", "error", "done"]);
  const [edit, bash] = rows.filter((r) => r.kind === "tool");
  assert.ok(edit.kind === "tool" && bash.kind === "tool");
  assert.deepEqual(edit.result, { ok: true, summary: "ok" });
  assert.equal(edit.tool.filePath, "src/a.js");
  assert.deepEqual(bash.result, { ok: false, summary: "1 failing" });
  assert.notEqual(edit.key, bash.key);
  const dones = rows.filter((r) => r.kind === "done");
  assert.deepEqual(dones.map((d) => d.kind === "done" && [d.ok, d.footer]), [[true, "$0.02 · 1,200 in · 45 out"], [false, "did not finish · no cost recorded"]]);
  const patch = rows.find((r) => r.kind === "patch");
  assert.deepEqual(patch && patch.kind === "patch" && patch.files, [{ path: "src/b.js", change: "add" }]);
});

test("timelineRows: a tool still waiting has no result; a result of an unknown tool is dropped", () => {
  const rows = timelineRows([ev("prompt", 1, { text: "x" }), ev("tool", 1, { id: "t1", name: "Read", toolKind: "read" }), ev("tool_result", 1, { id: "nope", ok: true })]);
  assert.deepEqual(rows.map((r) => r.kind), ["prompt", "tool"]);
  assert.equal(rows[1].kind === "tool" && rows[1].result, null);
});

test("doneFooter: a Codex turn's cost is an estimate; a missing usage still gives the cost", () => {
  assert.equal(doneFooter(ev("done", 1, { ok: true, usd: 0.0012, estimated: true }), ev("usage", 1, { in: 1200, out: 80 })), "$0.0012 estimated · 1,200 in · 80 out");
  assert.equal(doneFooter(ev("done", 1, { ok: true, usd: 0.5, estimated: false }), null), "$0.50");
});

test("turnOpen: a prompt with no done after it", () => {
  assert.equal(turnOpen([]), false);
  assert.equal(turnOpen([ev("prompt", 1)]), true);
  assert.equal(turnOpen([ev("prompt", 1), ev("text", 1)]), true);
  assert.equal(turnOpen([ev("prompt", 1), ev("done", 1)]), false);
  assert.equal(turnOpen([ev("prompt", 1), ev("done", 1), ev("prompt", 2)]), true);
});

test("mergeEvents: the read and the live events overlap; each record appears once, in order", () => {
  const a = ev("prompt", 1, { text: "x" });
  const b = ev("text", 1, { text: "y" });
  const c = ev("done", 1, { ok: true });
  assert.deepEqual(mergeEvents([a, b], [b, c]), [a, b, c]);
  assert.deepEqual(mergeEvents([], [a, a]), [a]);
});

test("fileStatusLabel and statusSummary: the card's words for git's codes", () => {
  assert.deepEqual(["??", ".M", "M.", "A.", ".D", "R.", "UU", "AA"].map(fileStatusLabel), ["new", "modified", "modified", "added", "deleted", "renamed", "conflict", "conflict"]);
  const st = { repo: true, branch: "main", detached: false, merging: false, files: [] as HostGitStatus["files"] };
  const f = (path: string, status: string) => ({ path, status, added: null, removed: null });
  assert.equal(statusSummary(st), "No changes");
  assert.equal(statusSummary({ ...st, files: [f("a", "??")] }), "1 file changed");
  assert.equal(statusSummary({ ...st, files: [f("a", "??"), f("b", ".M")] }), "2 files changed");
  assert.equal(statusSummary({ ...st, repo: false }), "Not a git repository");
});

test("hostChoices: both hosts in order; one that is off or not logged in is offered disabled, with why", () => {
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  assert.deepEqual(hostChoices(both, null).map((c) => [c.host, c.ready]), [["claude", true], ["codex", true]]);
  const codexOnly = hostChoices({ hosts: { claude: { enabled: false }, codex: { enabled: true } } }, null);
  assert.deepEqual(codexOnly.map((c) => [c.host, c.ready, c.reason]), [["claude", false, "Claude Code is off on this machine"], ["codex", true, null]]);
  // A config written before hosts existed is Claude only.
  assert.deepEqual(hostChoices({}, null).map((c) => c.ready), [true, false]);
  const loggedOut = hostChoices(both, { checkedAt: "", name: "claude", reason: "", claude: { loggedIn: false, checkedAt: "" } });
  assert.deepEqual(loggedOut.map((c) => c.reason), ["Claude Code is not logged in", null]);
});
