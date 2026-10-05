// The page's child processes, in main (phase 4, S4). A spawn runs only when the write policy names the command (a
// background refresh or an enabled surface's), the program is one the user installed (policy/programs.ts), its folder
// is inside the vault, and every variable it sets passes its rule. Never through a shell; stdin is /dev/null. Output
// streams back as UTF-8 text events under the page's own id for the child.

import * as childProcess from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecRequest, ProcEvent, Result, SpawnRequest } from "../../shared/ipc";
import { cwdRefusal, programRefusal, spawnEnv, type ProgramContext } from "../policy/programs";
import type { WritePolicy } from "../policy/write-policy";
import { failure, refused } from "./fs";

/** How many children the page may have running at once. */
export const MAX_CHILDREN = 64;

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

export interface ProcServiceOptions {
  policy: () => WritePolicy;
  context: () => ProgramContext;
  /** Main's own environment, the base of every child's. */
  env: NodeJS.ProcessEnv;
  emit: (ev: ProcEvent) => void;
  spawnImpl?: typeof childProcess.spawn;
}

export class ProcService {
  private readonly children = new Map<string, { child: childProcess.ChildProcess; detached: boolean }>();

  constructor(private readonly o: ProcServiceOptions) {}

  /** Why this command may not run, or null. */
  refusal(cmd: string, args: readonly string[], cwd: string | undefined): string | null {
    if (!this.o.policy().canSpawn(cmd, args, cwd)) return "no write surface runs it";
    return programRefusal(cmd, this.o.context()) ?? cwdRefusal(cwd, this.o.context());
  }

  spawn(req: SpawnRequest): Result<{ pid: number | null }> {
    if (this.children.has(req.id)) return { ok: false, error: "a child with this id is running", code: "EEXIST" };
    if (this.children.size >= MAX_CHILDREN) return { ok: false, error: "too many children", code: "EAGAIN" };
    const why = this.refusal(req.cmd, req.args, req.cwd);
    if (why) return refused(why);
    const env = spawnEnv(this.o.env, req.env, req.unsetEnv, this.o.context());
    if ("refusal" in env) return refused(env.refusal);
    let child: childProcess.ChildProcess;
    try {
      child = (this.o.spawnImpl ?? childProcess.spawn)(req.cmd, req.args, {
        cwd: req.cwd, env: env.env, shell: false, detached: !!req.detached, windowsHide: true,
        stdio: req.stdio === "ignore" ? "ignore" : ["ignore", "pipe", "pipe"],
      });
    } catch (err) { return failure(err); }
    const { id } = req;
    this.children.set(id, { child, detached: !!req.detached });
    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      child[stream]?.on("data", (b: Buffer) => { const data = decoder.write(b); if (data) this.o.emit({ id, type: stream, data }); });
      child[stream]?.on("end", () => { const data = decoder.end(); if (data) this.o.emit({ id, type: stream, data }); });
    }
    child.on("error", (err) => this.o.emit({ id, type: "error", message: (err as NodeJS.ErrnoException).code ?? err.message }));
    child.on("close", (code, signal) => {
      this.children.delete(id);
      this.o.emit({ id, type: "exit", code, signal });
    });
    if (req.detached) child.unref();
    return { ok: true, data: { pid: child.pid ?? null } };
  }

  kill(id: string, signal = "SIGTERM"): void {
    const c = this.children.get(id);
    if (c && SIGNALS.has(signal)) { try { c.child.kill(signal as NodeJS.Signals); } catch { /* gone */ } }
  }

  /** A short command's output (nodeResolver's login-shell probe), run from the vault with a timeout. */
  execSync(req: ExecRequest): Result<string> {
    const cwd = this.o.context().vaultRoot ?? undefined;
    const why = this.refusal(req.file, req.args, cwd);
    if (why) return refused(why);
    try {
      const out = childProcess.execFileSync(req.file, req.args, {
        cwd, env: this.o.env, encoding: "utf8", timeout: Math.min(Math.max(req.timeoutMs, 100), 10_000), stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, data: out };
    } catch (err) { return failure(err); }
  }

  /** On quit or when the page goes: the children the page was waiting on. Detached refreshes finish on their own. */
  killAttached(): void {
    for (const [, c] of this.children) if (!c.detached) { try { c.child.kill("SIGTERM"); } catch { /* gone */ } }
  }

  get running(): number { return this.children.size; }
}
