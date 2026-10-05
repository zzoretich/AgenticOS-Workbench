// The page's terminals, in main (phase 4, S5): the app's own node-pty (unpacked from the archive in a packaged build).
// A terminal starts a shell listed in /etc/shells (or main's own $SHELL) with no arguments, in an existing folder, with
// main's environment plus TerminalSession's few variables. What is typed into it is the user's: a terminal is a shell
// by design, and SECURITY.md records that a compromised page could type there too.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PtyEvent, PtySpawnRequest, Result } from "../../shared/ipc";
import { ptyEnv, shellRefusal, type ProgramContext } from "../policy/programs";
import { failure, refused } from "./fs";

/** How many terminals may be open at once. */
export const MAX_TERMINALS = 32;

export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
}

export interface PtyLib { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess }

export interface PtyServiceOptions {
  context: () => ProgramContext;
  env: NodeJS.ProcessEnv;
  emit: (ev: PtyEvent) => void;
  /** Loads node-pty (the tests pass a fake). */
  load: () => PtyLib;
}

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT"]);

export class PtyService {
  private lib: PtyLib | null = null;
  private loadError: string | null = null;
  private readonly sessions = new Map<string, PtyProcess>();

  constructor(private readonly o: PtyServiceOptions) {}

  private loadLib(): PtyLib | null {
    if (this.lib || this.loadError) return this.lib;
    try { this.lib = this.o.load(); } catch (err) { this.loadError = err instanceof Error ? err.message.split("\n")[0] : String(err); }
    return this.lib;
  }

  available(): Result<null> {
    return this.loadLib() ? { ok: true, data: null } : { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
  }

  spawn(req: PtySpawnRequest): Result<{ pid: number }> {
    const lib = this.loadLib();
    if (!lib) return { ok: false, error: `node-pty failed to load: ${this.loadError}`, code: "ENOSYS" };
    if (this.sessions.has(req.id)) return { ok: false, error: "a terminal with this id is open", code: "EEXIST" };
    if (this.sessions.size >= MAX_TERMINALS) return { ok: false, error: "too many terminals", code: "EAGAIN" };
    const why = shellRefusal(req.file, req.args, this.o.context());
    if (why) return refused(why);
    try { if (!path.isAbsolute(req.cwd) || !fs.statSync(req.cwd).isDirectory()) return refused("a working directory that is not a folder"); }
    catch { return refused("a working directory that is not there"); }
    const env = ptyEnv(this.o.env, req.env, this.o.context());
    if ("refusal" in env) return refused(env.refusal);
    let p: PtyProcess;
    try {
      p = lib.spawn(req.file, [], { name: req.name, cols: req.cols, rows: req.rows, cwd: req.cwd, env: env.env });
    } catch (err) { return failure(err); }
    const { id } = req;
    this.sessions.set(id, p);
    p.onData((data) => this.o.emit({ id, type: "data", data }));
    p.onExit((e) => {
      this.sessions.delete(id);
      this.o.emit({ id, type: "exit", exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) });
    });
    return { ok: true, data: { pid: p.pid } };
  }

  write(id: string, data: string): void { this.sessions.get(id)?.write(data); }

  resize(id: string, cols: number, rows: number): void {
    try { this.sessions.get(id)?.resize(cols, rows); } catch { /* a race with its exit */ }
  }

  kill(id: string, signal?: string): void {
    const p = this.sessions.get(id);
    if (!p) return;
    try { p.kill(signal && SIGNALS.has(signal) ? signal : undefined); } catch { /* gone */ }
  }

  /** Every terminal ends with the page that opened it, and on quit. */
  killAll(): void {
    for (const p of this.sessions.values()) { try { p.kill(); } catch { /* gone */ } }
    this.sessions.clear();
  }

  get open(): number { return this.sessions.size; }
}
