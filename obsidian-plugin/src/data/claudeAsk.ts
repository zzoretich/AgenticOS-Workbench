// claudeAsk.ts — the Chat tab's headless Claude path (the reasoner role). Two spawns per question:
//   1. node <vault>/brain/scripts/sdk/recall-cli.js <question>   → recall hits (best-effort, 15 s)
//   2. claude -p <prompt> … the exact headless recipe from brain/scripts/sdk/lib/claude-cli.js
//      (--tools "" --setting-sources "" --strict-mcp-config --no-session-persistence
//       --system-prompt … --max-budget-usd <cap> --output-format json), cwd = vault,
//      env AOS_HEADLESS=1 and CLAUDECODE unset so the user's hooks never re-enter.
// Returns the same AskHandle shape as askSpawner.runAsk so ChatTab treats both alike.
// Each answered call appends the contract §3 spend row to brain/_index/provider-spend.jsonl
// (feature "reason:chat" by default: the reasoner cap's family) so `aos status` and the daily
// caps account for chat spend too. chatRoute() decides between this path and askSpawner.
import { spawn as nodeSpawn, ChildProcess, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lastStderrLine, type AskHandle, type AskResult } from "./askSpawner";
import { readAgenticosJson, readProviderState, AgenticosJson, ProviderState } from "./aosConfig";

export interface ClaudeAskOptions {
  vault: string;
  node: string;          // Plugin.nodeBin()
  claudeBin: string;     // Plugin.claudeBin()
  question: string;
  model: string;         // readVaultConfig().reasoner.model
  maxBudgetUsd: number;  // readVaultConfig().reasoner.perCallUsd
  effort?: string;       // readVaultConfig().reasoner.effort → --effort (low|medium|high; anything else is left off)
  feature?: string;      // ledger row feature, default "reason:chat"
  timeoutMs?: number;        // default 120 s
  recallTimeoutMs?: number;  // default 15 s
}

export interface ClaudeAskDeps {
  spawn: (file: string, args: string[], opts: SpawnOptions) => ChildProcess;
  appendFileSync: (p: string, s: string) => void;
}

const DEFAULT_DEPS: ClaudeAskDeps = {
  spawn: (file, args, opts) => nodeSpawn(file, args, opts),
  appendFileSync: (p, s) => fs.appendFileSync(p, s),
};

export const CHAT_SYSTEM_PROMPT =
  "You answer questions about the user's AgenticOS vault. Use the CONTEXT block when it is relevant and say so when it is not. Answer in concise Markdown.";
const RECALL_CAP_CHARS = 12_000;
export const SPEND_LEDGER_PATH = "brain/_index/provider-spend.jsonl";

export function composePrompt(question: string, recallContext: string): string {
  const ctx = recallContext.trim().slice(0, RECALL_CAP_CHARS);
  return ctx ? `CONTEXT (recall hits from the vault):\n${ctx}\n\nQUESTION: ${question}` : `QUESTION: ${question}`;
}

export const EFFORTS = ["low", "medium", "high"];
export const CHAT_FEATURE = "reason:chat";

/**
 * Which spawner answers a Chat question. The reasoner is a Claude model, so headless Claude is
 * the route whenever the scripts' last probe found a login (the cache both resolvers share in
 * provider-state.json) or the global provider is claude; a reachable Ollama alone means the
 * script path, which falls back to the workhorse. No state at all is "none".
 */
export function chatRoute(state: ProviderState | null): "claude" | "local" | "none" {
  if (!state || state.name === "none") return "none";
  if (state.name === "claude" || state.claude?.loggedIn === true) return "claude";
  return "local";
}

export function buildClaudeArgs(o: { prompt: string; model: string; maxBudgetUsd: number; effort?: string }): string[] {
  return [
    "-p", o.prompt,
    "--model", o.model,
    ...(o.effort && EFFORTS.includes(o.effort) ? ["--effort", o.effort] : []),
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt", CHAT_SYSTEM_PROMPT,
    "--max-budget-usd", String(o.maxBudgetUsd),
    "--output-format", "json",
  ];
}

export function headlessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, AOS_HEADLESS: "1" };
  delete env.CLAUDECODE;
  return env;
}

export interface ClaudeJsonResult { text: string; usd: number; inputTokens: number; outputTokens: number; isError: boolean }

export function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  try {
    const j = JSON.parse(stdout) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      text: typeof j.result === "string" ? j.result : "",
      usd: num(j.total_cost_usd),
      inputTokens: num(j.usage?.input_tokens),
      outputTokens: num(j.usage?.output_tokens),
      isError: j.is_error === true,
    };
  } catch { return null; }
}

interface Collected { code: number | null; stdout: string; stderr: string; killed: boolean }

function collect(child: ChildProcess, timeoutMs: number): Promise<Collected> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", killed = false, done = false;
    const finish = (c: Collected) => { if (!done) { done = true; clearTimeout(timer); resolve(c); } };
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch { /* ignore */ } }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => finish({ code: null, stdout, stderr: `${stderr}${e.message}`, killed }));
    child.on("close", (code) => finish({ code, stdout, stderr, killed }));
  });
}

export interface ClaudeBinDeps {
  readAgenticosJson: () => AgenticosJson | null;
  readProviderState: (v: string) => ProviderState | null;
  existsSync: (p: string) => boolean;
  homedir: () => string;
}

const DEFAULT_BIN_DEPS: ClaudeBinDeps = {
  readAgenticosJson: () => readAgenticosJson(),
  readProviderState,
  existsSync: (p) => fs.existsSync(p),
  homedir: () => os.homedir(),
};

/**
 * `deps` is a Partial so a caller can override one reader and keep the rest: main.ts supplies
 * `readAgenticosJson: () => readAgenticosJson(this.claudeConfigDir())` so the settings-level
 * config dir reaches the recorded claude.bin (Ruling A6); the tests supply all four.
 */
export function resolveClaudeBin(vaultRoot: string, deps: Partial<ClaudeBinDeps> = {}): string {
  const d: ClaudeBinDeps = { ...DEFAULT_BIN_DEPS, ...deps };
  // Contract §2: the path `aos init` recorded outranks every probe; a recorded path that is gone falls through.
  const recorded = d.readAgenticosJson()?.claude?.bin;
  if (recorded && d.existsSync(recorded)) return recorded;
  const fromState = d.readProviderState(vaultRoot)?.claude?.bin;
  if (fromState && d.existsSync(fromState)) return fromState;
  const local = path.join(d.homedir(), ".local", "bin", "claude");
  if (d.existsSync(local)) return local;
  return "claude";
}

export function runClaudeAsk(opts: ClaudeAskOptions, deps: ClaudeAskDeps = DEFAULT_DEPS): AskHandle {
  const start = Date.now();
  let cancelled = false;
  let current: ChildProcess | null = null;
  const fail = (error: string, extra: Partial<AskResult> = {}): AskResult =>
    ({ ok: false, runId: null, answer: "", stderr: "", elapsedMs: Date.now() - start, exitCode: null, error, ...extra });

  const result = (async (): Promise<AskResult> => {
    // 1. recall context (best-effort)
    let context = "";
    try {
      const rc = deps.spawn(opts.node, [path.join(opts.vault, "brain", "scripts", "sdk", "recall-cli.js"), opts.question],
        { cwd: opts.vault, env: { ...process.env, AOS_VAULT: opts.vault }, windowsHide: true });
      current = rc;
      const r = await collect(rc, opts.recallTimeoutMs ?? 15_000);
      if (r.code === 0) context = r.stdout;
    } catch { context = ""; }
    if (cancelled) return fail("cancelled");

    // 2. headless claude
    let child: ChildProcess;
    try {
      child = deps.spawn(opts.claudeBin,
        buildClaudeArgs({ prompt: composePrompt(opts.question, context), model: opts.model, maxBudgetUsd: opts.maxBudgetUsd, effort: opts.effort }),
        { cwd: opts.vault, env: headlessEnv(process.env), windowsHide: true });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    current = child;
    const r = await collect(child, opts.timeoutMs ?? 120_000);
    const elapsedMs = Date.now() - start;
    if (r.killed || cancelled) return fail(cancelled ? "cancelled" : "cancelled (timeout)", { stderr: r.stderr, exitCode: r.code, elapsedMs });

    const parsed = parseClaudeJson(r.stdout);

    // One contract §3 spend row per BILLED call, exactly like claude-cli.js:114 `if (usd > 0)
    // ledger();`. A failed result can still carry cost (subtype error_max_budget does), so the
    // failure path ledgers too — otherwise the scripts' claude.perDayUsd cap under-counts chat.
    // A cost-free failure (non-JSON, non-zero exit, "Not logged in") records nothing.
    const ledger = (): void => {
      if (!parsed) return;
      try {
        deps.appendFileSync(path.join(opts.vault, SPEND_LEDGER_PATH), JSON.stringify({
          ts: new Date().toISOString(), feature: opts.feature ?? CHAT_FEATURE, provider: "claude", model: opts.model,
          usd: parsed.usd, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, ms: elapsedMs,
        }) + "\n");
      } catch { /* ledger is best-effort */ }
    };

    if (r.code !== 0 || !parsed || parsed.isError) {
      if (parsed && parsed.usd > 0) ledger();
      const msg = lastStderrLine(r.stderr) || lastStderrLine(parsed?.text ?? "") || lastStderrLine(r.stdout) || `exit ${r.code}`;
      return { ok: false, runId: null, answer: parsed?.text ?? "", stderr: r.stderr, elapsedMs, exitCode: r.code, error: msg.slice(0, 400) };
    }

    ledger();

    return { ok: true, runId: null, answer: parsed.text.trim(), stderr: r.stderr, elapsedMs, exitCode: r.code, usd: parsed.usd };
  })();

  return {
    runIdPromise: Promise.resolve<string | null>(null),
    result,
    cancel: () => { cancelled = true; try { current?.kill("SIGKILL"); } catch { /* ignore */ } },
  };
}
