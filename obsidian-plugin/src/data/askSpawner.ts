// askSpawner.ts — local spawner for brain/scripts/sdk/ask.js.
//
// Replaces the legacy POST /api/ask round-trip. Captures the run id by
// scraping the first stderr chunk (telemetry.js writes `[telemetry] run_id=<id>`)
// so subscribers can filter the plugin.bus stream by this run.
//
// Concurrency: hard-capped to 2 in-flight calls — matches serve.js's ASK_MAX.
// Timeout: 90s default (longer than serve.js's 60s; SDK + tool calls add up).

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;

let inflight = 0;

function resolveNode(): string {
  const candidates =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
      : process.platform === "linux"
      ? ["/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node"]
      : ["node.exe", "node"];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return "node";
}

export interface AskResult {
  ok: boolean;
  runId: string | null;     // null only if telemetry stderr line never arrived
  answer: string;           // trimmed stdout
  stderr: string;           // captured stderr (minus the run_id line)
  elapsedMs: number;
  exitCode: number | null;
  error?: string;
}

export interface AskHandle {
  /** Resolves with the captured run id once stderr produces it (or after 5s, with null). */
  runIdPromise: Promise<string | null>;
  /** Resolves when the child process exits or is cancelled. */
  result: Promise<AskResult>;
  /** Kill the child process. Result will resolve with ok:false and error="cancelled". */
  cancel(): void;
}

export function isAskBusy(): boolean { return inflight >= MAX_CONCURRENT; }

export interface RunAskOptions {
  vault: string;
  question: string;
  timeoutMs?: number;
}

export function runAsk(opts: RunAskOptions): AskHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let stdoutBuf = "";
  let stderrBuf = "";
  let runId: string | null = null;
  let runIdResolve!: (id: string | null) => void;
  const runIdPromise = new Promise<string | null>((r) => { runIdResolve = r; });
  // Fallback: if telemetry never emits the line within 5s, resolve as null
  const runIdTimer = setTimeout(() => runIdResolve(runId), 5000);

  if (isAskBusy()) {
    const err: AskResult = {
      ok: false, runId: null, answer: "", stderr: "",
      elapsedMs: 0, exitCode: null,
      error: `ask busy (>= ${MAX_CONCURRENT} in flight)`,
    };
    runIdResolve(null);
    return {
      runIdPromise,
      result: Promise.resolve(err),
      cancel: () => { /* no-op */ },
    };
  }

  inflight++;
  let child: ChildProcess;
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const result = new Promise<AskResult>((resolve) => {
    try {
      child = spawn(resolveNode(), ["brain/scripts/sdk/ask.js", opts.question], {
        cwd: opts.vault,
        windowsHide: true,
      });
    } catch (err) {
      inflight--;
      clearTimeout(runIdTimer);
      runIdResolve(null);
      resolve({
        ok: false, runId: null, answer: "", stderr: "",
        elapsedMs: Date.now() - start, exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    killTimer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdoutBuf += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      // Scrape run_id from the first stderr write — the [telemetry] line is
      // emitted synchronously right after live ndjson is opened.
      if (!runId) {
        const m = /\[telemetry\] run_id=(\S+)/.exec(chunk);
        if (m) {
          runId = m[1];
          runIdResolve(runId);
        }
      }
      // Strip the telemetry line from the surfaced stderr so callers don't see noise.
      stderrBuf += chunk.replace(/\[telemetry\] run_id=\S+\n?/g, "");
    });

    child.on("error", (err) => {
      inflight--;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(runIdTimer);
      runIdResolve(runId);
      resolve({
        ok: false, runId, answer: stdoutBuf.trim(), stderr: stderrBuf,
        elapsedMs: Date.now() - start, exitCode: null,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      inflight--;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(runIdTimer);
      runIdResolve(runId);
      resolve({
        ok: code === 0 && !killed,
        runId,
        answer: stdoutBuf.trim(),
        stderr: stderrBuf,
        elapsedMs: Date.now() - start,
        exitCode: code,
        error: killed ? "cancelled (timeout)" : code !== 0 ? `exit ${code}` : undefined,
      });
    });
  });

  return {
    runIdPromise,
    result,
    cancel: () => {
      if (!child || killed) return;
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    },
  };
}
