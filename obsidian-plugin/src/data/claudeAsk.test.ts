import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { runClaudeAsk, buildClaudeArgs, composePrompt, parseClaudeJson, headlessEnv, resolveClaudeBin, chatRoute, ClaudeAskDeps } from "./claudeAsk";

function fakeChild(stdout: string, code = 0, stderr = ""): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child as unknown as ChildProcess;
}

/** A child whose "close" fires (with code null, as a real killed process reports) only when
 *  kill() is called — never on its own, unlike fakeChild's setImmediate. Models the headless
 *  claude process while a user cancel is in flight. */
function cancelableChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setImmediate(() => child.emit("close", null)); return true; };
  return child as unknown as ChildProcess;
}

const CLAUDE_JSON = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "**Answer** from context",
  total_cost_usd: 0.0034, usage: { input_tokens: 1505, output_tokens: 185 }, duration_api_ms: 2911,
});

function harness(children: ChildProcess[]) {
  const calls: Array<{ file: string; args: string[]; cwd?: string | URL; env?: NodeJS.ProcessEnv }> = [];
  const ledger: string[] = [];
  const deps: ClaudeAskDeps = {
    spawn: (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd, env: opts.env }); return children.shift()!; },
    appendFileSync: (_p, s) => { ledger.push(s); },
  };
  return { calls, ledger, deps };
}

const OPTS = { vault: "/tmp/v", node: "/usr/bin/node", claudeBin: "/bin/claude", question: "what did I decide?", model: "haiku", maxBudgetUsd: 0.05 };

test("runClaudeAsk: recall context first, then the exact headless recipe; usd surfaces; spend is ledgered", async () => {
  const h = harness([fakeChild("hit one\nhit two\n"), fakeChild(CLAUDE_JSON)]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(h.calls[0].file, "/usr/bin/node");
  assert.match(h.calls[0].args[0], /brain\/scripts\/sdk\/recall-cli\.js$/);
  assert.equal(h.calls[0].args[1], "what did I decide?");
  const c = h.calls[1];
  assert.equal(c.file, "/bin/claude");
  assert.equal(c.cwd, "/tmp/v");
  assert.equal(c.env?.AOS_HEADLESS, "1");
  assert.equal("CLAUDECODE" in (c.env ?? {}), false);
  assert.equal(c.args[0], "-p");
  assert.match(c.args[1], /CONTEXT \(recall hits from the vault\):\nhit one\nhit two/);
  assert.match(c.args[1], /QUESTION: what did I decide\?$/);
  for (const pair of [["--model", "haiku"], ["--tools", ""], ["--setting-sources", ""], ["--max-budget-usd", "0.05"], ["--output-format", "json"]]) {
    const i = c.args.indexOf(pair[0]);
    assert.ok(i > 0, `missing ${pair[0]}`);
    assert.equal(c.args[i + 1], pair[1]);
  }
  assert.ok(c.args.includes("--strict-mcp-config") && c.args.includes("--no-session-persistence") && c.args.includes("--system-prompt"));
  assert.equal(r.ok, true);
  assert.equal(r.answer, "**Answer** from context");
  assert.equal(r.usd, 0.0034);
  assert.equal(r.runId, null);
  const row = JSON.parse(h.ledger[0]);
  assert.equal(row.feature, "reason:chat", "chat is a reasoner call: its rows belong to the reasoner cap");
  assert.equal(row.provider, "claude");
  assert.equal(row.usd, 0.0034);
  assert.equal(row.inputTokens, 1505);
  assert.ok(!c.args.includes("--effort"), "no effort given → no flag");
});

test("effort and feature: a valid effort becomes --effort after --model; the feature labels the ledger row", async () => {
  const h = harness([fakeChild(""), fakeChild(CLAUDE_JSON)]);
  await runClaudeAsk({ ...OPTS, model: "claude-opus-5", maxBudgetUsd: 0.5, effort: "high", feature: "reason:chat" }, h.deps).result;
  const c = h.calls[1];
  assert.deepEqual(c.args.slice(2, 6), ["--model", "claude-opus-5", "--effort", "high"]);
  assert.equal(JSON.parse(h.ledger[0]).model, "claude-opus-5");
  for (const bad of ["max", "", undefined]) {
    assert.ok(!buildClaudeArgs({ prompt: "p", model: "m", maxBudgetUsd: 1, effort: bad }).includes("--effort"), `effort=${String(bad)}`);
  }
});

test("chatRoute: claude when the scripts saw a login or resolved claude; local for Ollama alone; none otherwise", () => {
  const base = { checkedAt: "", reason: "" };
  assert.equal(chatRoute(null), "none");
  assert.equal(chatRoute({ ...base, name: "none" }), "none");
  assert.equal(chatRoute({ ...base, name: "ollama" }), "local");
  assert.equal(chatRoute({ ...base, name: "ollama", claude: { loggedIn: false, checkedAt: "" } }), "local");
  assert.equal(chatRoute({ ...base, name: "ollama", claude: { loggedIn: true, checkedAt: "" } }), "claude", "Ollama up but the reasoner is a Claude model");
  assert.equal(chatRoute({ ...base, name: "claude" }), "claude");
});

test("a failed recall still asks, with no CONTEXT block", async () => {
  const h = harness([fakeChild("", 1, "recall index missing"), fakeChild(CLAUDE_JSON)]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(r.ok, true);
  assert.equal(h.calls[1].args[1], "QUESTION: what did I decide?");
});

test("a non-zero claude exit surfaces the last stderr line, not 'exit N'", async () => {
  const h = harness([fakeChild(""), fakeChild("", 1, "Invalid API key\nNot logged in · Please run /login\n")]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "Not logged in · Please run /login");
  assert.equal(h.ledger.length, 0);
});

test("parseClaudeJson tolerates non-JSON and reads is_error", () => {
  assert.equal(parseClaudeJson("not json"), null);
  const p = parseClaudeJson(JSON.stringify({ result: "x", is_error: true, total_cost_usd: 0.01, usage: {} }));
  assert.equal(p?.isError, true);
  assert.equal(p?.usd, 0.01);
  assert.equal(p?.inputTokens, 0);
});

test("composePrompt caps the context at 12k chars; buildClaudeArgs emits the recipe order; headlessEnv guards recursion", () => {
  const big = "x".repeat(20_000);
  assert.equal(composePrompt("q", big).length, 12_000 + "CONTEXT (recall hits from the vault):\n".length + "\n\nQUESTION: q".length);
  const args = buildClaudeArgs({ prompt: "P", model: "haiku", maxBudgetUsd: 0.02 });
  assert.deepEqual(args.slice(0, 4), ["-p", "P", "--model", "haiku"]);
  const env = headlessEnv({ CLAUDECODE: "1", HOME: "/home/alice" });
  assert.equal(env.AOS_HEADLESS, "1");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.HOME, "/home/alice");
});

test("a BILLED failure is ledgered anyway (contract §3, claude-cli.js:114) and still reports the error", async () => {
  const BILLED_ERROR = JSON.stringify({
    type: "result", subtype: "error_max_budget", is_error: true, result: "Budget exceeded",
    total_cost_usd: 0.05, usage: { input_tokens: 900, output_tokens: 12 }, duration_api_ms: 1200,
  });
  const h = harness([fakeChild(""), fakeChild(BILLED_ERROR)]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "Budget exceeded");
  assert.equal(h.ledger.length, 1, "the spend happened, so the daily cap must see it");
  const row = JSON.parse(h.ledger[0]);
  assert.equal(row.feature, "reason:chat");
  assert.equal(row.provider, "claude");
  assert.equal(row.usd, 0.05);
  assert.equal(row.inputTokens, 900);
});

test("resolveClaudeBin prefers agenticos.json claude.bin, then provider-state, then ~/.local/bin/claude, then the bare name", () => {
  const state = () => ({ checkedAt: "", name: "claude" as const, reason: "", claude: { loggedIn: true, checkedAt: "", bin: "/opt/claude" } });
  const d0 = { readAgenticosJson: () => ({ claude: { bin: "/cfg/claude" } }), readProviderState: state, existsSync: (p: string) => p === "/cfg/claude" || p === "/opt/claude", homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d0), "/cfg/claude");
  const d1 = { readAgenticosJson: () => ({ claude: { bin: "/cfg/gone" } }), readProviderState: state, existsSync: (p: string) => p === "/opt/claude", homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d1), "/opt/claude", "a recorded path that is gone falls through (contract §2)");
  const d2 = { readAgenticosJson: () => null, readProviderState: () => null, existsSync: (p: string) => p === "/home/alice/.local/bin/claude", homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d2), "/home/alice/.local/bin/claude");
  const d3 = { readAgenticosJson: () => null, readProviderState: () => null, existsSync: () => false, homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d3), "claude");
});

test('a user cancel under claude reports "cancelled", never "exit null"', async () => {
  const h = harness([fakeChild(""), cancelableChild()]);
  const handle = runClaudeAsk(OPTS, h.deps);
  while (h.calls.length < 2) await new Promise((r) => setImmediate(r));
  handle.cancel();
  const r = await handle.result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
  assert.equal(h.ledger.length, 0);
});
