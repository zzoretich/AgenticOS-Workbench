// Sessions (spec 2026-10-07-unidex-sessions S10, §4.5, §6), the Chat tab's place on the rail, with their surface on
// (AOS_APP_WRITE=sessions). Main runs every turn through the vault's own runtime (lib/sessions.js args, events,
// record), so the plan, the events, the cap and the run record are the real ones; only the host CLIs are stand-ins:
// `claude` prints a stream-json turn and `codex` an `exec --json` one, each recording its argv and folder, and a prompt
// with "[sleep]" in it waits instead, for Stop. Their paths are the vault config's hosts.<host>.bin, where the runtime
// looks first. The repository card runs the user's git on a repository the test makes in workspaces/tide-log.

import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, expectNoErrors, openTab, providerState, rail, useApp } from "./harness";

// ── the host stand-ins ───────────────────────────────────────────────

const STUBS = path.join(FX.root, "session-stubs");
const BIN = { claude: path.join(STUBS, "claude"), codex: path.join(STUBS, "codex") };
type Host = keyof typeof BIN;
interface Call { argv: string[]; cwd: string }
const calls = (host: Host): Call[] => {
  const file = path.join(STUBS, `${host}-calls.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
};

/** What the claude stand-in's turn costs and what it writes in its folder (a new file the repository card shows). */
const CLAUDE_TURN = { usd: 0.0213, footer: "$0.02 · 1,200 in · 45 out", note: "Tide notes from the agent." };

function installSessionStubs(): void {
  fs.rmSync(STUBS, { recursive: true, force: true });
  fs.mkdirSync(STUBS, { recursive: true });
  const node = path.join(FX.root, "bin", "node");
  const head = (host: Host) => `#!${node}
// fixture stub: never reaches the real ${host}. Records the call; a prompt with [sleep] in it waits to be stopped.
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(STUBS, `${host}-calls.jsonl`))}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const prompt = argv[argv.length - 1] || "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
`;
  fs.writeFileSync(BIN.claude, `${head("claude")}const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const id = at("--session-id") || at("--resume");
out({ type: "system", subtype: "init", session_id: id });
if (prompt.includes("[sleep]")) setTimeout(() => {}, 120000);
else {
  fs.appendFileSync(path.join(process.cwd(), "notes.md"), ${JSON.stringify(`${CLAUDE_TURN.note}\n`)});
  out({ type: "assistant", session_id: id, message: { content: [
    { type: "text", text: "Fixed the **tide parser**." },
    { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "notes.md", old_string: "", new_string: "Tide notes" } },
    { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
  ] } });
  out({ type: "user", session_id: id, message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "The file notes.md has been updated." },
    { type: "tool_result", tool_use_id: "t2", content: "1 test failing", is_error: true },
  ] } });
  out({ type: "result", subtype: "success", is_error: false, session_id: id, total_cost_usd: ${CLAUDE_TURN.usd}, usage: { input_tokens: 1200, output_tokens: 45 } });
}
`, { mode: 0o755 });
  fs.writeFileSync(BIN.codex, `${head("codex")}const resume = argv[1] === "resume";
out({ type: "thread.started", thread_id: "codex-thread-1" });
if (prompt.includes("[sleep]")) setTimeout(() => {}, 120000);
else {
  out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", status: "in_progress" } });
  out({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "all green", exit_code: 0, status: "completed" } });
  out({ type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/tiles.js", kind: "update" }], status: "completed" } });
  out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: resume ? "Codex cached the tiles." : "Codex charted the harbour." } });
  out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 } });
}
`, { mode: 0o755 });
}

// ── the fixture ──────────────────────────────────────────────────────

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const VAULT_CONFIG = FX.v("brain/config.json");
const REPO = FX.v("workspaces/tide-log");
/** git as the app's main runs it: the fixture's HOME, so no user or system setting (signing, hooks) applies. */
const gitEnv = { ...process.env, HOME: FX.home, GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, env: gitEnv, encoding: "utf8" }).trim();

/** A workspace that is a repository of its own, with one commit; an identity built here so no address sits in the source. */
function makeRepo(): void {
  fs.mkdirSync(REPO, { recursive: true });
  fs.writeFileSync(path.join(REPO, "README.md"), "# Tide log\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", ["fixture", "example.invalid"].join("@"));
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "Start the tide log");
}

/** The stand-ins as the hosts' binaries, the hosts switched on as asked, a provider on record (so the tab shows). */
function prepare(hosts: Record<Host, boolean>): void {
  installSessionStubs();
  editJson(path.join(FX.claude, "agenticos.json"), (j) => { j.hosts.claude.enabled = hosts.claude; j.hosts.codex.enabled = hosts.codex; });
  editJson(VAULT_CONFIG, (j) => {
    j.hosts = { ...(j.hosts ?? {}) };
    for (const h of ["claude", "codex"] as Host[]) j.hosts[h] = { ...(j.hosts[h] ?? {}), bin: BIN[h] };
  });
  providerState(hosts.claude ? "claude" : "codex", hosts);
  makeRepo();
}

// The fixture's environment hides both CLIs from the runtime (AOS_NO_CLAUDE, AOS_NO_CODEX); here they are the stand-ins.
const HOSTS_ON = { AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined };

// ── helpers ──────────────────────────────────────────────────────────

const list = (win: Page) => content(win).locator(".aos-ss-list");
const reader = (win: Page) => content(win).locator(".aos-ss-reader");
const group = (win: Page, workspace: string) => list(win).locator(`.aos-ss-group[data-workspace="${workspace}"]`);

async function newSession(win: Page, o: { workspace: string; host: Host; text: string; allowCommands?: boolean }): Promise<void> {
  await content(win).locator(".aos-ss-newbtn").click();
  await expect(reader(win).locator(".aos-reader-title")).toHaveText("New session");
  await reader(win).locator("select.aos-ss-workspace").selectOption(o.workspace);
  await reader(win).locator(`.aos-ss-hostchip[data-host="${o.host}"]`).click();
  await expect(reader(win).locator(`.aos-ss-hostchip[data-host="${o.host}"]`)).toHaveClass(/is-active/);
  if (o.allowCommands) await reader(win).locator(".aos-ss-allow input").check();
  await reader(win).locator("textarea.aos-ss-input").fill(o.text);
  await reader(win).locator(".aos-ss-send").click();
}

/** The open thread's id, once its row is selected in the list. */
const openId = async (win: Page) => (await list(win).locator(".aos-ss-row.is-selected").getAttribute("data-thread")) ?? "";

// ── both hosts, the surface on ───────────────────────────────────────

test.describe("both hosts, the Sessions surface on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "sessions", ...HOSTS_ON }, prepare: () => prepare({ claude: true, codex: true }) });

  test.beforeEach(async () => { await openTab(app().win, "chat"); });
  test.afterEach(async () => {
    expectNoErrors(app());
    // The cap test turns sessions off for the day; every other test runs with the defaults.
    editJson(VAULT_CONFIG, (j) => { delete j.sessions; });
  });

  test("the rail says Sessions and opens on Vault, today's chat as before; the status bar names the surface", async () => {
    const { win } = app();
    await expect(rail(win, "chat").locator(".aos-wb-raillabel")).toHaveText("Sessions");
    await expect(rail(win, "chat")).toHaveAttribute("aria-label", "Sessions");
    await expect(win.locator(".aos-host-status .aos-host-mode")).toHaveText("WRITES: Sessions");
    await expect(content(win).locator(".aos-rt-title")).toHaveText("Sessions");
    const first = list(win).locator(".aos-ss-row").first();
    await expect(first).toHaveAttribute("data-thread", "vault");
    await expect(first).toHaveClass(/is-selected/);
    await expect(reader(win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    await expect(reader(win).locator("textarea.aos-asst-input")).toHaveAttribute("placeholder", "ask the brain…");
    await expect(list(win).locator(".aos-ss-note")).toHaveText("No workspace sessions yet. New session starts one.");
  });

  test("a Claude turn end to end: the prompt, the agent's text, tool rows that open to their result, the cost footer, the thread under its workspace", async () => {
    const { win } = app();
    const before = calls("claude").length;
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Fix the tide parser", allowCommands: true });
    const r = reader(win);
    await expect(r.locator(".aos-ss-done")).toHaveText([CLAUDE_TURN.footer], { timeout: 30_000 });
    await expect(r.locator(".aos-ss-crumb-ws")).toHaveText("harbor-map");
    await expect(r.locator(".aos-ss-crumb-title")).toHaveText("Fix the tide parser");
    await expect(r.locator(".aos-ss-headmeta .aos-ss-host")).toHaveText("Claude Code");
    await expect(r.locator(".aos-ss-bubble")).toHaveText(["Fix the tide parser"]);
    await expect(r.locator(".aos-ss-text")).toHaveText(["Fixed the tide parser."]);
    await expect(r.locator(".aos-ss-text strong")).toHaveText("tide parser");   // rendered as Markdown
    const tools = r.locator(".aos-ss-tool");
    await expect(tools.locator(".aos-ss-toolline")).toHaveText(["edit · Edit · notes.md", "bash · Bash"]);
    await expect(tools.nth(0)).toHaveClass(/is-ok/);
    await expect(tools.nth(1)).toHaveClass(/is-failed/);
    await expect(tools.nth(1).locator(".aos-ss-toolout")).toBeHidden();
    await tools.nth(1).locator("summary").click();
    await expect(tools.nth(1).locator(".aos-ss-toolin")).toContainText("npm test");
    await expect(tools.nth(1).locator(".aos-ss-toolstate")).toHaveText("Failed");
    await expect(tools.nth(1).locator(".aos-ss-toolout")).toHaveText("1 test failing");
    await expect(r.locator(".aos-ss-stop")).toHaveCount(0);
    // harbor-map is a plain folder, so the card says there is nothing to review.
    await expect(r.locator(".aos-ss-reposum")).toHaveText("workspaces/harbor-map is not a git repository, so there is nothing to review or commit");

    const g = group(win, "harbor-map");
    await expect(g.locator(".aos-ss-row")).toHaveCount(1);
    await expect(g.locator(".aos-ss-title")).toHaveText("Fix the tide parser");
    await expect(g.locator(".aos-ss-host")).toHaveText("Claude Code");
    await expect(g.locator(".aos-ss-meta")).toContainText("1 turn · $0.02");
    await expect(g.locator(".aos-ss-row")).not.toHaveClass(/is-running/);

    const id = await openId(win);
    const [call] = calls("claude").slice(before);
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(FX.v("workspaces/harbor-map")));
    expect(call.argv[call.argv.indexOf("--session-id") + 1]).toBe(id);
    expect(call.argv.slice(call.argv.indexOf("--allowedTools"), call.argv.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "Bash"]);
    expect(call.argv.at(-1)).toBe("Fix the tide parser");
    expect(fs.existsSync(FX.v(`brain/_index/sessions/harbor-map/${id}.jsonl`))).toBe(true);
    const runs = fs.readFileSync(FX.v("brain/_index/agent-runs/runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(runs.filter((row) => row.thread === id).map((row) => [row.script, row.status])).toEqual([["session:claude", "ok"]]);

    // Vault is one click away, and back again: the thread is read from its file.
    await list(win).locator('.aos-ss-row[data-thread="vault"]').click();
    await expect(reader(win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    await g.locator(".aos-ss-row").click();
    await expect(r.locator(".aos-ss-done")).toHaveText([CLAUDE_TURN.footer]);

    // A reply resumes the same Claude session.
    await r.locator("textarea.aos-ss-input").fill("And the tests");
    await r.locator(".aos-ss-send").click();
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-bubble")).toHaveText(["Fix the tide parser", "And the tests"]);
    const second = calls("claude").slice(before)[1];
    expect(second.argv[second.argv.indexOf("--resume") + 1]).toBe(id);
    expect(second.argv).not.toContain("--session-id");
    await expect(g.locator(".aos-ss-meta")).toContainText("2 turns · $0.04");
  });

  test("a Codex turn, then a reply that resumes it: commands in its sandbox, the files it changed, an estimated cost", async () => {
    const { win } = app();
    const before = calls("codex").length;
    await content(win).locator(".aos-ss-newbtn").click();
    await reader(win).locator('.aos-ss-hostchip[data-host="codex"]').click();
    await expect(reader(win).locator(".aos-ss-sandbox")).toHaveText("Codex runs commands in its sandbox");
    await expect(reader(win).locator(".aos-ss-allow")).toHaveCount(0);
    await reader(win).locator("select.aos-ss-workspace").selectOption("harbor-map");
    await reader(win).locator("textarea.aos-ss-input").fill("Chart the harbour");
    await reader(win).locator(".aos-ss-send").click();
    const r = reader(win);
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-done")).toHaveText(/^\$0\.\d+ estimated · 1,200 in · 80 out$/);
    await expect(r.locator(".aos-ss-headmeta .aos-ss-host")).toHaveText("Codex");
    await expect(r.locator(".aos-ss-text")).toHaveText(["Codex charted the harbour."]);
    await expect(r.locator(".aos-ss-toolline")).toHaveText(["bash · shell"]);
    await expect(r.locator(".aos-ss-tool")).toHaveClass(/is-ok/);
    await expect(r.locator(".aos-ss-patchhead")).toHaveText("Changed 1 file");
    await expect(r.locator(".aos-ss-patchfile")).toHaveText("updatesrc/tiles.js");
    await expect(r.locator(".aos-ss-sandbox")).toHaveText("Codex runs commands in its sandbox");
    const id = await openId(win);
    await expect(list(win).locator(`.aos-ss-row[data-thread="${id}"]`)).not.toHaveClass(/is-running/);

    await r.locator("textarea.aos-ss-input").fill("And cache the tiles");
    await r.locator(".aos-ss-send").click();
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-bubble")).toHaveText(["Chart the harbour", "And cache the tiles"]);
    await expect(r.locator(".aos-ss-text")).toHaveText(["Codex charted the harbour.", "Codex cached the tiles."]);
    const [first, second] = calls("codex").slice(before);
    expect(first.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(second.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(second.argv).toContain("codex-thread-1");
    expect(second.argv.at(-1)).toBe("And cache the tiles");
    await expect(list(win).locator(`.aos-ss-row[data-thread="${id}"] .aos-ss-meta`)).toContainText(/^2 turns · ≈\$0\.\d+/);
  });

  for (const host of ["claude", "codex"] as Host[]) {
    test(`Stop ends a running ${host} turn: the running dot and Stop while it runs, then stopped, and the thread can go on`, async () => {
      const { win } = app();
      const prompt = `[sleep] Wait for the tide on ${host}`;
      await newSession(win, { workspace: "harbor-map", host, text: prompt });
      const r = reader(win);
      await expect(r.locator(".aos-ss-stop")).toHaveText("Stop", { timeout: 30_000 });
      await expect(r.locator(".aos-ss-working")).toHaveText("Working…");
      const id = await openId(win);
      await expect(list(win).locator(`.aos-ss-row[data-thread="${id}"]`)).toHaveClass(/is-running/);
      await expect(r.locator(".aos-ss-send")).toBeDisabled();
      // The stand-in is running before Stop is pressed, so SIGTERM ends it.
      await expect.poll(() => calls(host).some((c) => c.argv.at(-1) === prompt), { timeout: 15_000 }).toBe(true);
      await r.locator(".aos-ss-stop").click();
      // The stand-in printed no result: the runtime closes the turn as unfinished, and main says it was stopped.
      await expect(r.locator(".aos-ss-error")).toHaveText(["the turn ended before the host finished it", "stopped"], { timeout: 30_000 });
      await expect(r.locator(".aos-ss-done")).toHaveText(["did not finish · no cost recorded"]);
      await expect(r.locator(".aos-ss-done")).toHaveClass(/is-failed/);
      await expect(r.locator(".aos-ss-stop")).toHaveCount(0);
      await expect(list(win).locator(`.aos-ss-row[data-thread="${id}"]`)).not.toHaveClass(/is-running/);
      await expect(r.locator(".aos-ss-send")).toBeEnabled();
    });
  }

  test("the repository card: what changed, a file's diff on Review, a refusal inline, and Commit with the message as edited", async () => {
    const { win } = app();
    await newSession(win, { workspace: "tide-log", host: "claude", text: "Log the tides" });
    const r = reader(win);
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-reposum")).toHaveText("1 file changed");
    await expect(r.locator(".aos-ss-branch")).toHaveText("main");
    const file = r.locator('.aos-ss-file[data-file="notes.md"]');
    await expect(file.locator(".aos-ss-change")).toHaveText("new");
    await file.locator(".aos-ss-review").click();
    await expect(r.locator("pre.aos-ss-diff")).toContainText(`+${CLAUDE_TURN.note}`);
    await expect(file.locator(".aos-ss-review")).toHaveText("Close");

    const msg = r.locator("input.aos-ss-message");
    await expect(msg).toHaveValue("Log the tides");   // the thread's title
    await msg.fill("   ");
    await r.locator(".aos-ss-commitbtn").click();
    await expect(r.locator(".aos-ss-commitresult")).toHaveText("A commit needs a message.");
    await expect(r.locator(".aos-ss-commitresult")).toHaveClass(/is-failed/);
    expect(git("log", "--format=%s")).toBe("Start the tide log");

    await msg.fill("Log the tides from the agent");
    await r.locator(".aos-ss-commitbtn").click();
    await expect(r.locator(".aos-ss-commitresult")).toHaveText(/^Committed [0-9a-f]{7}$/);
    await expect(r.locator(".aos-ss-reposum")).toHaveText("No changes");
    expect(git("log", "--format=%s").split("\n")).toEqual(["Log the tides from the agent", "Start the tide log"]);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("notes.md");
    expect(git("remote")).toBe("");   // nothing to push to, and nothing pushed

    // A detached HEAD, then a merge in progress: the card says why, and Commit is off. It re-reads on opening the thread.
    const reopen = async () => {
      await list(win).locator('.aos-ss-row[data-thread="vault"]').click();
      await list(win).locator(".aos-ss-row", { hasText: "Log the tides" }).click();
    };
    fs.appendFileSync(path.join(REPO, "notes.md"), "More notes.\n");
    git("checkout", "-q", "--detach");
    await reopen();
    await expect(r.locator(".aos-ss-commit .aos-ss-note")).toHaveText("HEAD is detached: check out a branch to commit.");
    await expect(r.locator(".aos-ss-commitbtn")).toBeDisabled();
    git("checkout", "-q", "main");
    fs.writeFileSync(path.join(REPO, ".git", "MERGE_HEAD"), `${git("rev-parse", "HEAD")}\n`);
    await reopen();
    await expect(r.locator(".aos-ss-commit .aos-ss-note")).toHaveText("A merge is in progress: finish it in a terminal.");
    await expect(r.locator(".aos-ss-commitbtn")).toBeDisabled();
    fs.rmSync(path.join(REPO, ".git", "MERGE_HEAD"));
  });

  test("the day cap (sessions.perDayUsd 0) refuses the turn: the runtime's reason is shown in the thread, and no host runs", async () => {
    const { win } = app();
    editJson(VAULT_CONFIG, (j) => { j.sessions = { perDayUsd: 0 }; });
    const before = calls("claude").length;
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Over the cap" });
    const r = reader(win);
    await expect(r.locator(".aos-ss-error")).toHaveText(["sessions.perDayUsd is 0, which turns sessions off"], { timeout: 30_000 });
    await expect(r.locator(".aos-ss-done")).toHaveText(["did not finish · no cost recorded"]);
    expect(calls("claude").length).toBe(before);
  });
});

// ── the surface off ──────────────────────────────────────────────────

test.describe("the Sessions surface off", () => {
  const app = useApp({ env: HOSTS_ON, prepare: () => prepare({ claude: true, codex: true }) });

  test("the list says why, a new session is refused inline, Vault still works, and nothing runs", async () => {
    const h = app();
    await openTab(h.win, "chat");
    await expect(list(h.win).locator(".aos-ss-note")).toHaveText("Workspace sessions are unavailable: the Sessions surface is off.");
    await expect(reader(h.win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    await newSession(h.win, { workspace: "harbor-map", host: "claude", text: "Refused?" });
    await expect(reader(h.win).locator(".aos-ss-composererror")).toHaveText("the Sessions surface is off");
    await expect(reader(h.win).locator("textarea.aos-ss-input")).toHaveValue("Refused?");   // the prompt is kept
    expect(calls("claude")).toEqual([]);
    expect(fs.existsSync(FX.v("brain/_index/sessions"))).toBe(false);
    await list(h.win).locator('.aos-ss-row[data-thread="vault"]').click();
    await expect(reader(h.win).locator("textarea.aos-asst-input")).toBeVisible();
    expectNoErrors(h);
  });
});

// ── a Codex-only machine ─────────────────────────────────────────────

test.describe("a Codex-only machine", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "sessions", ...HOSTS_ON }, prepare: () => prepare({ claude: false, codex: true }) });

  test("the composer offers Codex alone, with Claude Code off and why; a Codex turn runs", async () => {
    const h = app();
    await openTab(h.win, "chat");
    await content(h.win).locator(".aos-ss-newbtn").click();
    const claude = reader(h.win).locator('.aos-ss-hostchip[data-host="claude"]');
    const codex = reader(h.win).locator('.aos-ss-hostchip[data-host="codex"]');
    await expect(claude).toBeDisabled();
    await expect(claude).toHaveAttribute("title", "Claude Code is off on this machine");
    await expect(codex).toBeEnabled();
    await expect(codex).toHaveClass(/is-active/);
    await expect(reader(h.win).locator(".aos-ss-sandbox")).toHaveText("Codex runs commands in its sandbox");
    await reader(h.win).locator("textarea.aos-ss-input").fill("Chart the harbour");
    await reader(h.win).locator(".aos-ss-send").click();
    await expect(reader(h.win).locator(".aos-ss-text")).toHaveText(["Codex charted the harbour."], { timeout: 30_000 });
    await expect(reader(h.win).locator(".aos-ss-done")).toHaveText(/estimated/);
    expect(calls("claude")).toEqual([]);
    expectNoErrors(h);
  });
});
