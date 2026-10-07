// Sessions and their repositories as main runs them (spec 2026-10-07-unidex-sessions S1–S3, S8, S9, S11). The vault's
// brain/scripts is the checkout's own runtime, so a turn goes through the real lib/sessions.js (plan, events, record);
// the host CLIs are stand-ins that print a recorded-shape stream and note their argv. No network, nothing spent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent, SessionEventRecord } from "../../src/shared/ipc";
import type { ProgramContext } from "../../src/main/policy/programs";
import { GitService, parseStatus } from "../../src/main/services/git";
import { SessionService, workspaceDir } from "../../src/main/services/sessions";

const REPO = path.resolve(process.cwd(), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-app-"));
const vault = path.join(tmp, "vault");
const bin = path.join(tmp, "bin");
const ws = path.join(vault, "workspaces", "harbor-map");
fs.mkdirSync(path.join(vault, "brain", "_index"), { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(bin);
fs.writeFileSync(path.join(vault, "AGENTICOS.md"), "# vault\n");
fs.symlinkSync(path.join(REPO, "brain", "scripts"), path.join(vault, "brain", "scripts"));

/** A stand-in CLI: notes its argv and cwd, then prints `lines` (or sleeps when told to). */
function fakeHost(name: string, lines: object[]): string {
  const p = path.join(bin, name);
  const out = lines.map((l) => JSON.stringify(l)).join("\n");
  fs.writeFileSync(p, `#!${process.execPath}
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(path.join(tmp, `${name}.argv`))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), headless: process.env.AOS_HEADLESS }) + "\\n");
if (process.argv.includes("--sleep")) setTimeout(() => {}, 60000);
else process.stdout.write(${JSON.stringify(out)} + "\\n");
`, { mode: 0o755 });
  return p;
}
const CLAUDE = fakeHost("claude", [
  { type: "system", subtype: "init", session_id: "will-be-replaced" },
  { type: "assistant", message: { content: [{ type: "text", text: "Fixed." }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.js" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } },
]);
const CODEX = fakeHost("codex", [{ type: "thread.started", thread_id: "th-1" }, { type: "item.completed", item: { id: "a", type: "agent_message", text: "Done." } }, { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } }]);
const config = (extra: object = {}) => fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } }, ...extra }));
config();

const context: ProgramContext = { vaultRoot: vault, home: tmp, userData: path.join(tmp, "user-data"), env: process.env, agenticos: null, shells: [] } as unknown as ProgramContext;
const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, "claude-config"), AOS_CONFIG: path.join(tmp, "none.json") };
function service(on = true): { s: SessionService; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const s = new SessionService({ vaultRoot: () => vault, enabled: () => on, context: () => context, env, node: () => process.execPath, emit: (e) => events.push(e), graceMs: 500 });
  return { s, events };
}
async function idle(s: SessionService): Promise<void> {
  for (let i = 0; i < 400 && s.runningCount > 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.runningCount, 0, "the turn finished");
}
const kinds = (rows: SessionEventRecord[]) => rows.map((r) => r.kind);
const runs = () => fs.readFileSync(path.join(vault, "brain", "_index", "agent-runs", "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("workspaceDir: a folder under workspaces, by one plain name", () => {
  assert.deepEqual(workspaceDir(vault, "harbor-map"), { dir: ws });
  for (const bad of ["../etc", ".git", "_worktrees", "a/b", ""]) assert.ok("refusal" in workspaceDir(vault, bad), bad);
  assert.deepEqual(workspaceDir(vault, "nope"), { refusal: "no such workspace" });
  assert.deepEqual(workspaceDir(null, "harbor-map"), { refusal: "no vault is open" });
});

test("a claude turn: planned by the runtime, run in the workspace, its events stored and sent, its spend and run recorded; the next turn resumes it", async () => {
  const { s, events } = service();
  const r = await s.start({ workspace: "harbor-map", host: "claude", text: "fix the parser", model: "sonnet" });
  assert.ok(r.ok, JSON.stringify(r));
  await idle(s);
  const read = await s.read(r.data.id);
  assert.ok(read.ok);
  assert.deepEqual(kinds(read.data), ["prompt", "session", "text", "tool", "tool_result", "usage", "done"]);
  assert.equal(read.data.at(-1)?.ok, true);
  assert.deepEqual(events.map((e) => e.event.kind), kinds(read.data), "the page saw every stored event");
  const call = JSON.parse(fs.readFileSync(path.join(tmp, "claude.argv"), "utf8").trim()) as { argv: string[]; cwd: string; headless: string };
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(ws), "it ran in the workspace");
  assert.equal(call.headless, "1");
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--session-id"), call.argv.indexOf("--session-id") + 2), ["--session-id", r.data.id], "the thread id is the claude session id");
  assert.deepEqual(runs().map((row) => [row.script, row.status, row.thread]), [["session:claude", "ok", r.data.id]]);
  const ledger = fs.readFileSync(path.join(vault, "brain", "_index", "provider-spend.jsonl"), "utf8");
  assert.match(ledger, /"feature":"session:claude"/);

  const next = await s.send({ thread: r.data.id, text: "and the tests" });
  assert.ok(next.ok);
  await idle(s);
  const second = JSON.parse(fs.readFileSync(path.join(tmp, "claude.argv"), "utf8").trim().split("\n")[1]) as { argv: string[] };
  assert.ok(second.argv.includes("--resume"), "a later turn resumes");
  const list = await s.list();
  assert.ok(list.ok);
  assert.deepEqual(list.data.map((t) => [t.workspace, t.host, t.turns, t.running, t.title]), [["harbor-map", "claude", 2, false, "fix the parser"]]);
  assert.equal(list.data[0].usd, 0.04);
});

test("a codex turn resumes by the thread id codex reported", async () => {
  const { s } = service();
  const r = await s.start({ workspace: "harbor-map", host: "codex", text: "go" });
  assert.ok(r.ok);
  await idle(s);
  await s.send({ thread: r.data.id, text: "again" });
  await idle(s);
  const calls = fs.readFileSync(path.join(tmp, "codex.argv"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv);
  assert.deepEqual(calls[0].slice(0, 2), ["exec", "--json"]);
  assert.deepEqual(calls[1].slice(0, 2), ["exec", "resume"]);
  assert.ok(calls[1].includes("th-1"));
});

test("the runtime's refusal (the day cap) is the turn's error; Stop ends a running turn as stopped", async () => {
  config({ sessions: { perDayUsd: 0 } });
  const { s } = service();
  const r = await s.start({ workspace: "harbor-map", host: "claude", text: "x" });
  assert.ok(r.ok);
  await idle(s);
  const read = await s.read(r.data.id);
  assert.ok(read.ok);
  assert.deepEqual(kinds(read.data), ["prompt", "error", "done"]);
  assert.match(String(read.data[1].message), /sessions\.perDayUsd is 0/);
  config();

  const slow = await s.start({ workspace: "harbor-map", host: "claude", text: "--sleep" });
  assert.ok(slow.ok);
  for (let i = 0; i < 200 && !fs.readFileSync(path.join(tmp, "claude.argv"), "utf8").includes("--sleep"); i++) await new Promise((res) => setTimeout(res, 25));
  s.stop(slow.data.id);
  await idle(s);
  const stopped = await s.read(slow.data.id);
  assert.ok(stopped.ok);
  assert.deepEqual(kinds(stopped.data).slice(-2), ["error", "done"]);
  assert.equal(stopped.data.at(-2)?.message, "stopped");
  assert.equal(runs().at(-1)?.status, "stopped");
});

test("nothing runs while the Sessions surface is off, and a thread that is not there is ENOENT", async () => {
  const { s } = service(false);
  assert.deepEqual(await s.start({ workspace: "harbor-map", host: "claude", text: "x" }), { ok: false, error: "the Sessions surface is off", code: "EROFS" });
  const on = service().s;
  assert.equal((await on.read("00000000-0000-4000-8000-000000000000")).ok, false);
});

test("git: status, a new file's diff, and a commit only with a message, on a branch, with something to commit", async () => {
  const repo = path.join(vault, "workspaces", "tide");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", ["test", "example.invalid"].join("@")); // a placeholder identity, built so no address sits in the source
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  const git = new GitService({ workspace: (n) => workspaceDir(vault, n), enabled: () => true, env: process.env });
  const st = await git.status("tide");
  assert.ok(st.ok);
  assert.deepEqual([st.data.repo, st.data.branch, st.data.files], [true, "main", [{ status: "??", path: "a.txt" }]]);
  const d = await git.diff("tide", "a.txt");
  assert.ok(d.ok);
  assert.match(d.data.text, /\+one/);
  assert.deepEqual(await git.diff("tide", "../outside"), { ok: false, error: "a file outside the workspace", code: "EROFS" });
  assert.deepEqual(await git.commit("tide", "  "), { ok: false, error: "a commit needs a message", code: "EROFS" });
  const c = await git.commit("tide", "Add a");
  assert.ok(c.ok && /^[0-9a-f]{40}$/.test(c.data.commit), JSON.stringify(c));
  assert.deepEqual(await git.commit("tide", "again"), { ok: false, error: "nothing to commit", code: "EROFS" });
  assert.deepEqual((await git.status("harbor-map")).ok && (await git.status("harbor-map")), { ok: true, data: { repo: false, branch: null, detached: false, merging: false, files: [] } });
  const off = new GitService({ workspace: (n) => workspaceDir(vault, n), enabled: () => false, env: process.env });
  assert.deepEqual(await off.status("tide"), { ok: false, error: "the Sessions surface is off", code: "EROFS" });
});

test("parseStatus reads branch, detached HEAD, changed, renamed, unmerged and new files", () => {
  const out = ["# branch.head (detached)", "1 .M N... 100644 100644 100644 a b src/a b.js", "2 R. N... 100644 100644 100644 a b R100 new.js\told.js", "u UU N... 1 2 3 4 a b c conflict.js", "? notes.md"].join("\n");
  assert.deepEqual(parseStatus(out), { branch: null, detached: true, files: [
    { status: ".M", path: "src/a b.js" }, { status: "R.", path: "new.js" }, { status: "UU", path: "conflict.js" }, { status: "??", path: "notes.md" },
  ] });
});

test("git: a workspace folder inside another repository (a vault kept in git) is not a repository of its own: nothing to read or commit", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-outer-"));
  const v = path.join(outer, "vault");
  const plain = path.join(v, "workspaces", "plain");
  fs.mkdirSync(plain, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: v, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(v, "note.md"), "a vault note\n");
  fs.writeFileSync(path.join(plain, "a.txt"), "one\n");
  const git = new GitService({ workspace: (n) => workspaceDir(v, n), enabled: () => true, env: process.env });
  assert.deepEqual(await git.status("plain"), { ok: true, data: { repo: false, branch: null, detached: false, merging: false, files: [] } });
  assert.deepEqual(await git.diff("plain", "a.txt"), { ok: false, error: "not a git repository", code: "EROFS" });
  assert.deepEqual(await git.commit("plain", "Add a"), { ok: false, error: "not a git repository", code: "EROFS" });
  fs.rmSync(outer, { recursive: true, force: true });
});
