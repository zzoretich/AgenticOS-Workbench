// aosRun.ts — run the vendored `aos` CLI and WAIT for it (spec 2026-09-24-settings-tab D3). Plugin.runBrainScript is
// fire-and-forget (detached, stdio ignored): right for a "sync now" whose file event re-renders a tab, wrong for a
// settings write, which must show the CLI's own verdict ("must be more than 0") beside the field. This one captures
// stdout, stderr and the exit code, pins AOS_VAULT/AOS_CONFIG like RoutinesTab.spawnEnv, and kills a child that hangs.
// Pure over an injectable spawn so node:test drives it with a fixture script.
import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import * as path from "path";

/** The vendored CLI, relative to the vault (`aos upgrade` copies cli/ into brain/scripts/cli/). */
export const AOS_CLI = "brain/scripts/cli/aos.js";

export interface AosRunOptions {
  node: string;             // Plugin.nodeBin()
  vault: string;            // Plugin.vaultRoot(): AOS_VAULT, the cwd, and where the vendored CLI lives
  configDir: string;        // Plugin.claudeConfigDir(): AOS_CONFIG is <configDir>/agenticos.json
  timeoutMs?: number;       // default 60 s; the child is killed after it
  cli?: string;             // the CLI path, when not the vendored one (tests)
  env?: NodeJS.ProcessEnv;  // the base environment (default process.env)
}

export interface AosResult { code: number; stdout: string; stderr: string; timedOut: boolean; error?: string }
export interface AosJsonResult<T> extends AosResult { json: T | null; parseError?: string }

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function aosEnv(o: AosRunOptions): NodeJS.ProcessEnv {
  return { ...(o.env ?? process.env), AOS_VAULT: o.vault, AOS_CONFIG: path.join(o.configDir, "agenticos.json") };
}

export function runAos(args: string[], o: AosRunOptions, spawnFn: SpawnFn = nodeSpawn): Promise<AosResult> {
  return new Promise((resolve) => {
    const cli = o.cli ?? path.join(o.vault, AOS_CLI);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: AosResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawnFn(o.node, [cli, ...args], { cwd: o.vault, env: aosEnv(o), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ code: -1, stdout, stderr, timedOut, error: (e as Error).message });
      return;
    }
    timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, o.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => finish({ code: -1, stdout, stderr, timedOut, error: e.message }));
    child.on("close", (code) => finish({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut }));
  });
}

/** runAos plus the parsed stdout on exit 0; `json` is null on a failure or an unparseable body (parseError says why). */
export async function runAosJson<T>(args: string[], o: AosRunOptions, spawnFn?: SpawnFn): Promise<AosJsonResult<T>> {
  const r = await runAos(args, o, spawnFn);
  if (r.code !== 0) return { ...r, json: null };
  try { return { ...r, json: JSON.parse(r.stdout) as T }; } catch (e) { return { ...r, json: null, parseError: (e as Error).message }; }
}

/** The one line to show for a failed run: the CLI's own `aos: …` / `aos config: …` message, else why it did not run. */
export function failureText(r: AosResult): string {
  if (r.timedOut) return "aos did not answer in time";
  if (r.error) return `could not run aos: ${r.error}`;
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.find((l) => /^aos( config)?: /.test(l));
  return (own ?? lines[0] ?? `aos exited ${r.code}`).replace(/^aos( config)?: /, "");
}

/** D13: the vendored runtime predates `aos config` (or is missing), so the tab asks for `aos upgrade`. */
export function needsUpgrade(r: AosResult): boolean {
  return /unknown command: config|unknown script config|Cannot find module/.test(r.stderr);
}
