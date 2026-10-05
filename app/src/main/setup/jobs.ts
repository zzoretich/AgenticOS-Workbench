// The wizard's one running job (phase 5, I4, I5): a fix-it in a terminal, or `aos init` / `aos upgrade` as a child
// process. A fix-it gets a pty because Homebrew asks for a password and the logins print a code to type; the install
// and the upgrade get no stdin at all (`--yes`), so nothing in them can wait on a prompt the user cannot see. Output
// streams to the page as setup events; the page draws all of it in one terminal view.

import * as childProcess from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Result, SetupEvent, SetupJob } from "../../shared/ipc";
import type { PtyLib, PtyProcess } from "../services/pty";

export interface JobRunnerOptions {
  emit: (ev: SetupEvent) => void;
  /** node-pty (the tests pass a fake). */
  pty: () => PtyLib;
  spawnImpl?: typeof childProcess.spawn;
  /** Called after a job's exit event, with its code (main refreshes state there). */
  onExit?: (job: SetupJob, code: number | null) => void;
}

interface Running { job: SetupJob; pty?: PtyProcess; child?: childProcess.ChildProcess }

const busy: Result<never> = { ok: false, error: "another setup step is running", code: "EBUSY" };

export class JobRunner {
  private current: Running | null = null;

  constructor(private readonly o: JobRunnerOptions) {}

  get running(): SetupJob | null { return this.current?.job ?? null; }

  private exited(job: SetupJob, code: number | null, signal: string | null): void {
    this.current = null;
    this.o.emit({ job, type: "exit", code, signal });
    this.o.onExit?.(job, code);
  }

  /** A command in a terminal: the user sees it typed, then its output, and can answer what it asks. */
  startPty(job: SetupJob, file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; echo: string }): Result<null> {
    if (this.current) return busy;
    let p: PtyProcess;
    try {
      p = this.o.pty().spawn(file, args, { name: "xterm-256color", cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
    } catch (err) { return { ok: false, error: `could not open a terminal: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, code: "ENOSYS" }; }
    this.current = { job, pty: p };
    this.o.emit({ job, type: "data", data: `\x1b[2m$ ${o.echo}\x1b[0m\r\n` });
    p.onData((data) => this.o.emit({ job, type: "data", data }));
    p.onExit((e) => this.exited(job, e.exitCode, e.signal ? String(e.signal) : null));
    return { ok: true, data: null };
  }

  /** A command with no stdin, its stdout and stderr together, line ends made terminal-ready. */
  startProc(job: SetupJob, file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; echo: string }): Result<null> {
    if (this.current) return busy;
    let child: childProcess.ChildProcess;
    try {
      child = (this.o.spawnImpl ?? childProcess.spawn)(file, args, { cwd: o.cwd, env: o.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), code: "EIO" }; }
    this.current = { job, child };
    const term = (s: string) => s.replace(/\r?\n/g, "\r\n");
    this.o.emit({ job, type: "data", data: `\x1b[2m$ ${o.echo}\x1b[0m\r\n` });
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (b: Buffer) => { const data = decoder.write(b); if (data) this.o.emit({ job, type: "data", data: term(data) }); });
      stream?.on("end", () => { const data = decoder.end(); if (data) this.o.emit({ job, type: "data", data: term(data) }); });
    }
    let done = false;
    child.on("error", (err) => {
      this.o.emit({ job, type: "data", data: `\r\n${(err as NodeJS.ErrnoException).code ?? err.message}\r\n` });
      if (!done) { done = true; this.exited(job, null, null); }
    });
    child.on("close", (code, signal) => { if (!done) { done = true; this.exited(job, code, signal); } });
    return { ok: true, data: null };
  }

  input(data: string): void { this.current?.pty?.write(data); }

  resize(cols: number, rows: number): void {
    try { this.current?.pty?.resize(cols, rows); } catch { /* a race with its exit */ }
  }

  /** Stops the running job (the page's Stop button, the page going away, quit). */
  cancel(): void {
    const c = this.current;
    if (!c) return;
    try { c.pty?.kill(); } catch { /* gone */ }
    try { c.child?.kill("SIGTERM"); } catch { /* gone */ }
  }
}
