// Agent sessions, in main (UniDeX phase 2, spec 2026-10-07-unidex-sessions S1–S3, S8, S11). A turn is three processes,
// none through a shell:
//   1. the runtime's lib/sessions.js `args` plans it: the host is on and has a binary, today's session spend is under
//      sessions.perDayUsd, and the host CLI's argv and environment (the runtime owns every host flag);
//   2. the host's CLI runs it with <vault>/workspaces/<name> as its folder;
//   3. `sessions.js events` turns the CLI's stdout into the runtime's event shape, which main appends to the thread's
//      file (brain/_index/sessions/<workspace>/<thread>.jsonl) and sends to the page.
// When the turn ends, `sessions.js record` ledgers its spend and writes its row in agent-runs/runs.jsonl. Nothing runs
// while the Sessions surface is off. The page names a workspace, a host and a prompt; never a program, an argument or
// a path.

import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Result, SessionEvent, SessionEventRecord, SessionHost, SessionSendRequest, SessionStartRequest, SessionThread } from "../../shared/ipc";
import { programRefusal, spawnEnv, type ProgramContext } from "../policy/programs";
import { refused } from "./fs";
import type { WorkspaceDir } from "./git";

/** How many turns may run at once, across every thread. */
export const MAX_RUNNING = 4;
/** Stop: SIGTERM, then SIGKILL after this long (team seats do the same, lib/team-run.js). */
export const GRACE_MS = 10_000;
const THREAD_MAX_BYTES = 8 * 1024 * 1024;
const RUNTIME_OUT_MAX = 1024 * 1024;
const STDERR_TAIL = 2000;

/** A workspace's folder name: one segment, not hidden (`.git`) and not the team worktrees (`_worktrees`). */
export const WORKSPACE_RE = /^[^._/\\\0][^/\\\0]{0,127}$/;

export function workspaceDir(vault: string | null, name: string): WorkspaceDir {
  if (!vault) return { refusal: "no vault is open" };
  if (typeof name !== "string" || !WORKSPACE_RE.test(name)) return { refusal: "a workspace name" };
  const dir = path.join(vault, "workspaces", name);
  try { if (!fs.statSync(dir).isDirectory()) return { refusal: "not a workspace folder" }; } catch { return { refusal: "no such workspace" }; }
  return { dir };
}

export interface SessionServiceOptions {
  vaultRoot: () => string | null;
  /** Whether the Sessions surface is on. */
  enabled: () => boolean;
  context: () => ProgramContext;
  /** Main's own environment, the base of every child's. */
  env: NodeJS.ProcessEnv;
  /** The user's node, for the runtime's scripts: agenticos.json's `node`, else the login shell's. */
  node: () => string | null;
  emit: (ev: SessionEvent) => void;
  spawnImpl?: typeof childProcess.spawn;
  now?: () => Date;
  graceMs?: number;
}

interface Meta { schema: 1; kind: "meta"; thread: string; workspace: string; host: SessionHost; model: string | null; effort: string | null; title: string; created: string }

interface Running { agent: childProcess.ChildProcess | null; stopped: boolean; timer: NodeJS.Timeout | null }

type Event = Omit<SessionEventRecord, "turn">;

const titleOf = (text: string): string => {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** The thread's records (the meta line first); a damaged line is skipped. */
function readLines(file: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    if (size > THREAD_MAX_BYTES) {
      // Very long threads: the meta line and the newest records.
      const fd = fs.openSync(file, "r");
      try {
        const head = Buffer.alloc(Math.min(size, 64 * 1024));
        fs.readSync(fd, head, 0, head.length, 0);
        const tail = Buffer.alloc(THREAD_MAX_BYTES);
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        const t = tail.toString("utf8");
        text = `${head.toString("utf8").split("\n")[0]}\n${t.slice(t.indexOf("\n") + 1)}`;
      } finally { fs.closeSync(fd); }
    } else text = fs.readFileSync(file, "utf8");
  } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as unknown; if (r && typeof r === "object") out.push(r as Record<string, unknown>); } catch { /* skipped */ }
  }
  return out;
}

function metaOf(lines: Array<Record<string, unknown>>): Meta | null {
  const m = lines[0];
  return m && m.kind === "meta" && typeof m.thread === "string" && (m.host === "claude" || m.host === "codex") && typeof m.workspace === "string" ? (m as unknown as Meta) : null;
}

export class SessionService {
  private readonly running = new Map<string, Running>();
  /** thread id → its file, as threads are opened or listed. */
  private readonly files = new Map<string, string>();

  constructor(private readonly o: SessionServiceOptions) {}

  private now(): Date { return this.o.now ? this.o.now() : new Date(); }

  private refusal(): string | null {
    if (!this.o.enabled()) return "the Sessions surface is off";
    if (!this.o.vaultRoot()) return "no vault is open";
    return null;
  }

  private sessionsDir(vault: string): string { return path.join(vault, "brain", "_index", "sessions"); }

  private find(thread: string): string | null {
    const known = this.files.get(thread);
    if (known && fs.existsSync(known)) return known;
    const vault = this.o.vaultRoot();
    if (!vault) return null;
    const root = this.sessionsDir(vault);
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root); } catch { return null; }
    for (const d of dirs) {
      const f = path.join(root, d, `${thread}.jsonl`);
      if (fs.existsSync(f)) { this.files.set(thread, f); return f; }
    }
    return null;
  }

  private threadOf(meta: Meta, lines: Array<Record<string, unknown>>, file: string): SessionThread {
    let turns = 0;
    let usd = 0;
    for (const r of lines) {
      if (r.kind === "prompt") turns += 1;
      if (r.kind === "done" && typeof r.usd === "number" && Number.isFinite(r.usd)) usd += r.usd;
    }
    let updated = meta.created;
    try { updated = fs.statSync(file).mtime.toISOString(); } catch { /* as created */ }
    return { id: meta.thread, workspace: meta.workspace, host: meta.host, model: meta.model, title: meta.title, created: meta.created, updated, turns, running: this.running.has(meta.thread), usd: Math.round(usd * 1e6) / 1e6 };
  }

  async start(req: SessionStartRequest): Promise<Result<SessionThread>> {
    const why = this.refusal();
    if (why) return refused(why);
    const vault = this.o.vaultRoot() as string;
    const w = workspaceDir(vault, req.workspace);
    if ("refusal" in w) return refused(w.refusal);
    if (!req.text.trim()) return refused("a turn needs a prompt");
    if (this.running.size >= MAX_RUNNING) return { ok: false, error: "too many sessions are running", code: "EAGAIN" };
    const meta: Meta = {
      schema: 1, kind: "meta", thread: randomUUID(), workspace: req.workspace, host: req.host, model: req.model || null,
      effort: req.effort || null, title: titleOf(req.text), created: this.now().toISOString(),
    };
    const file = path.join(this.sessionsDir(vault), req.workspace, `${meta.thread}.jsonl`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(meta)}\n`, { flag: "wx" });
    } catch (err) { return { ok: false, error: (err as NodeJS.ErrnoException).code ?? "failed", code: "EIO" }; }
    this.files.set(meta.thread, file);
    this.running.set(meta.thread, { agent: null, stopped: false, timer: null });
    void this.turn(meta, file, w.dir, req.text, req.allowCommands === true);
    return { ok: true, data: this.threadOf(meta, readLines(file), file) };
  }

  async send(req: SessionSendRequest): Promise<Result<SessionThread>> {
    const why = this.refusal();
    if (why) return refused(why);
    const file = this.find(req.thread);
    if (!file) return { ok: false, error: "no such thread", code: "ENOENT" };
    const lines = readLines(file);
    const meta = metaOf(lines);
    if (!meta) return { ok: false, error: "the thread's file is damaged", code: "EIO" };
    if (this.running.has(meta.thread)) return { ok: false, error: "a turn is running", code: "EBUSY" };
    if (this.running.size >= MAX_RUNNING) return { ok: false, error: "too many sessions are running", code: "EAGAIN" };
    if (!req.text.trim()) return refused("a turn needs a prompt");
    const w = workspaceDir(this.o.vaultRoot(), meta.workspace);
    if ("refusal" in w) return refused(w.refusal);
    this.running.set(meta.thread, { agent: null, stopped: false, timer: null });
    void this.turn(meta, file, w.dir, req.text, req.allowCommands === true);
    return { ok: true, data: this.threadOf(meta, lines, file) };
  }

  stop(thread: string): void {
    const r = this.running.get(thread);
    if (!r || r.stopped) return;
    r.stopped = true;
    if (r.agent) {
      try { r.agent.kill("SIGTERM"); } catch { /* gone */ }
      const agent = r.agent;
      r.timer = setTimeout(() => { try { agent.kill("SIGKILL"); } catch { /* gone */ } }, this.o.graceMs ?? GRACE_MS);
    }
  }

  async list(): Promise<Result<SessionThread[]>> {
    const why = this.refusal();
    if (why) return refused(why);
    const root = this.sessionsDir(this.o.vaultRoot() as string);
    const out: SessionThread[] = [];
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root); } catch { return { ok: true, data: [] }; }
    for (const d of dirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(root, d)).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
      for (const n of names) {
        const file = path.join(root, d, n);
        const lines = readLines(file);
        const meta = metaOf(lines);
        if (!meta) continue;
        this.files.set(meta.thread, file);
        out.push(this.threadOf(meta, lines, file));
      }
    }
    out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    return { ok: true, data: out };
  }

  async read(thread: string): Promise<Result<SessionEventRecord[]>> {
    const why = this.refusal();
    if (why) return refused(why);
    const file = this.find(thread);
    if (!file) return { ok: false, error: "no such thread", code: "ENOENT" };
    return { ok: true, data: readLines(file).filter((r) => r.kind !== "meta") as unknown as SessionEventRecord[] };
  }

  /** On quit: every running turn is stopped (its file says so the next time it is read). */
  killAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  get runningCount(): number { return this.running.size; }

  /** `node <vault>/brain/scripts/lib/sessions.js <args>` from the vault, or why it cannot run. */
  private runtimeSpawn(args: readonly string[], stdio: childProcess.StdioOptions): { child: childProcess.ChildProcess } | { refusal: string } {
    const vault = this.o.vaultRoot();
    if (!vault) return { refusal: "no vault is open" };
    const node = this.o.node();
    if (!node) return { refusal: "no node: run aos doctor" };
    const ctx = this.o.context();
    const bad = programRefusal(node, ctx);
    if (bad) return { refusal: `node: ${bad}` };
    const script = path.join(vault, "brain", "scripts", "lib", "sessions.js");
    if (!fs.existsSync(script)) return { refusal: "this vault's runtime has no sessions yet: run aos upgrade" };
    const env = spawnEnv(this.o.env, { AOS_VAULT: vault, AOS_HOST: "" }, [], ctx);
    if ("refusal" in env) return { refusal: env.refusal };
    try {
      return { child: (this.o.spawnImpl ?? childProcess.spawn)(node, [script, ...args], { cwd: vault, env: env.env, shell: false, stdio, windowsHide: true }) };
    } catch (err) { return { refusal: (err as NodeJS.ErrnoException).code ?? "the runtime did not start" }; }
  }

  /** One short runtime command's output. */
  private runtime(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const s = this.runtimeSpawn(args, ["ignore", "pipe", "pipe"]);
    if ("refusal" in s) return Promise.resolve({ code: -1, stdout: "", stderr: s.refusal });
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      s.child.stdout?.on("data", (b: Buffer) => { if (stdout.length < RUNTIME_OUT_MAX) stdout += b.toString("utf8"); });
      s.child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-STDERR_TAIL); });
      s.child.on("error", (err) => resolve({ code: -1, stdout, stderr: (err as NodeJS.ErrnoException).code ?? err.message }));
      s.child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  private async turn(meta: Meta, file: string, dir: string, text: string, allowCommands: boolean): Promise<void> {
    const before = readLines(file);
    const n = before.filter((r) => r.kind === "prompt").length + 1;
    const resume = [...before].reverse().find((r) => r.kind === "session" && typeof r.id === "string")?.id as string | undefined;
    const startedAt = this.now();
    const append = (e: Event): void => {
      const rec = { ...e, turn: n } as SessionEventRecord;
      try { fs.appendFileSync(file, `${JSON.stringify(rec)}\n`); } catch { /* the page still sees it */ }
      this.o.emit({ thread: meta.thread, event: rec });
    };
    const iso = (): string => this.now().toISOString();
    let usd: number | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCount = 0;
    let reply = "";
    let failure: string | null = null;
    const state = this.running.get(meta.thread) ?? { agent: null, stopped: false, timer: null };
    this.running.set(meta.thread, state);
    append({ t: iso(), kind: "prompt", text });
    try {
      const req: Record<string, unknown> = { host: meta.host, prompt: text, model: meta.model, effort: meta.effort, allowCommands };
      if (resume) req.resume = resume;
      else if (meta.host === "claude") req.sessionId = meta.thread;
      const planned = await this.runtime(["args", JSON.stringify(req)]);
      let plan: { ok?: boolean; reason?: string; bin?: string; argv?: string[]; env?: { set?: Record<string, string>; unset?: string[] } } | null = null;
      try { plan = JSON.parse(planned.stdout.trim().split("\n").pop() || "null"); } catch { plan = null; }
      if (!plan || !plan.ok || typeof plan.bin !== "string" || !Array.isArray(plan.argv)) {
        failure = plan?.reason || planned.stderr.trim().split("\n").pop() || "the runtime did not plan the turn";
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      if (state.stopped) { failure = "stopped"; append({ t: iso(), kind: "error", message: "stopped" }); append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" }); return; }
      const ctx = this.o.context();
      const bad = programRefusal(plan.bin, ctx);
      const env = spawnEnv(this.o.env, plan.env?.set, plan.env?.unset, ctx);
      if (bad || "refusal" in env) {
        failure = bad ? `${meta.host}: ${bad}` : `the environment: ${(env as { refusal: string }).refusal}`;
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      const filter = this.runtimeSpawn(["events", "--host", meta.host, ...(meta.model ? ["--model", meta.model] : [])], ["pipe", "pipe", "pipe"]);
      if ("refusal" in filter) {
        failure = filter.refusal;
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      let agent: childProcess.ChildProcess;
      try {
        agent = (this.o.spawnImpl ?? childProcess.spawn)(plan.bin, plan.argv, { cwd: dir, env: env.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (err) {
        try { filter.child.kill("SIGTERM"); } catch { /* gone */ }
        failure = `${meta.host} did not start (${(err as NodeJS.ErrnoException).code ?? "error"})`;
        append({ t: iso(), kind: "error", message: failure });
        append({ t: iso(), kind: "done", ok: false, usd: null, estimated: meta.host === "codex" });
        return;
      }
      state.agent = agent;
      let stderrTail = "";
      agent.stderr?.on("data", (b: Buffer) => { stderrTail = (stderrTail + b.toString("utf8")).slice(-STDERR_TAIL); });
      if (agent.stdout && filter.child.stdin) agent.stdout.pipe(filter.child.stdin);
      filter.child.stdin?.on("error", () => { /* the filter went first */ });
      let pendingDone: Event | null = null;
      const decoder = new StringDecoder("utf8");
      let rest = "";
      const onLine = (line: string): void => {
        if (!line.trim()) return;
        let e: Event;
        try { e = JSON.parse(line) as Event; } catch { return; }
        if (!e || typeof e !== "object" || typeof e.kind !== "string") return;
        if (e.kind === "done") { pendingDone = e; return; }
        if (e.kind === "usage") { inputTokens = Number(e.in) || 0; outputTokens = Number(e.out) || 0; if (typeof e.usd === "number") usd = e.usd; }
        if (e.kind === "tool") toolCount += 1;
        if (e.kind === "text" && typeof e.text === "string") reply = e.text;
        append(e);
      };
      filter.child.stdout?.on("data", (b: Buffer) => {
        const lines = (rest + decoder.write(b)).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      });
      const closed = (c: childProcess.ChildProcess): Promise<number | null> => new Promise((resolve) => {
        c.on("error", () => resolve(-1));
        c.on("close", (code) => resolve(code));
      });
      const [agentCode] = await Promise.all([closed(agent), closed(filter.child)]);
      onLine(rest + decoder.end());
      if (state.timer) clearTimeout(state.timer);
      const done = pendingDone as Event | null;
      if (state.stopped) { failure = "stopped"; append({ t: iso(), kind: "error", message: "stopped" }); }
      else if ((!done || done.ok !== true) && agentCode !== 0 && stderrTail.trim()) {
        failure = stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        append({ t: iso(), kind: "error", message: failure });
      }
      if (done && typeof done.usd === "number") usd = done.usd;
      append(state.stopped ? { ...(done ?? { t: iso(), kind: "done", estimated: meta.host === "codex" }), ok: false, usd } : (done ?? { t: iso(), kind: "done", ok: false, usd, estimated: meta.host === "codex" }));
      if (!state.stopped && !(done && done.ok === true) && !failure) failure = "the turn failed";
    } finally {
      // The turn's spend and its run row land before the thread reads as idle.
      const status = state.stopped ? "stopped" : failure ? "error" : "ok";
      await this.runtime(["record", JSON.stringify({
        host: meta.host, model: meta.model, usd, inputTokens, outputTokens, ms: this.now().getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(), status, prompt: text, reply, toolCount, error: status === "ok" ? null : failure,
        workspace: meta.workspace, thread: meta.thread,
      })]);
      this.running.delete(meta.thread);
    }
  }
}
