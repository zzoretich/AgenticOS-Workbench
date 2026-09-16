// TerminalSession — wraps one node-pty instance.
// Holds a circular scrollback buffer so xterm instances can be (re)attached at will.
// node-pty is loaded lazily so import errors degrade gracefully.

export interface TerminalSessionOptions {
  id: string;
  shell: string;
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

type DataListener = (data: string) => void;
type ExitListener = (info: { exitCode: number; signal?: number }) => void;

let ptyLib: unknown = null;
let ptyLoadError: string | null = null;

// Plugin dir injected by main.ts at plugin load. Required because Obsidian
// renderer's require() can't resolve "node-pty" by bare name and __dirname
// isn't reliable in this context — we need an explicit absolute path.
let pluginDir: string | null = null;
export function setPluginDir(dir: string): void { pluginDir = dir; }

function loadPty(): unknown {
  if (ptyLib) return ptyLib;
  if (ptyLoadError) throw new Error(`node-pty failed to load: ${ptyLoadError}`);
  const attempts: Array<{ where: string; err: string }> = [];
  try {
    const path = require("path") as typeof import("path");
    const candidates: string[] = [];
    if (pluginDir) {
      candidates.push(path.join(pluginDir, "node_modules", "node-pty"));
      candidates.push(path.join(pluginDir, "node_modules", "node-pty", "lib", "index.js"));
    }
    // last-ditch: bare name in case Electron's resolver finds it
    candidates.push("node-pty");

    for (const c of candidates) {
      try {
        ptyLib = require(c);
        return ptyLib;
      } catch (e) {
        attempts.push({ where: c, err: e instanceof Error ? e.message : String(e) });
      }
    }
    const detail = attempts.map(a => `  • ${a.where} → ${a.err.split("\n")[0]}`).join("\n");
    throw new Error(`tried ${attempts.length} paths:\n${detail}`);
  } catch (e) {
    ptyLoadError = e instanceof Error ? e.message : String(e);
    throw new Error(`node-pty failed to load: ${ptyLoadError}`);
  }
}

const SCROLLBACK_CAP = 200_000;

export class TerminalSession {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;
  private pty: { write: (s: string) => void; resize: (c: number, r: number) => void; kill: (s?: string) => void; onData: (cb: (d: string) => void) => void; onExit: (cb: (info: { exitCode: number; signal?: number }) => void) => void };
  private scrollback: string = "";
  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();
  private exited = false;
  private title: string;

  constructor(opts: TerminalSessionOptions) {
    this.id = opts.id;
    this.shell = opts.shell;
    this.cwd = opts.cwd;
    this.title = `t${opts.id}`;

    const lib = loadPty() as { spawn: (shell: string, args: string[], options: Record<string, unknown>) => typeof this.pty };
    this.pty = lib.spawn(opts.shell, [], {
      name: "xterm-256color",
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...(opts.env || {}),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        AGENTIC_OS: "1",
      } as Record<string, string>,
    });

    this.pty.onData((d: string) => {
      this.scrollback = (this.scrollback + d).slice(-SCROLLBACK_CAP);
      for (const l of this.dataListeners) {
        try { l(d); } catch (err) { console.warn("[agentic-os] term data listener:", err); }
      }
    });
    this.pty.onExit((info: { exitCode: number; signal?: number }) => {
      this.exited = true;
      for (const l of this.exitListeners) {
        try { l(info); } catch { /* ignore */ }
      }
    });
  }

  get isExited(): boolean { return this.exited; }

  getTitle(): string { return this.title; }
  setTitle(t: string): void { this.title = t; }

  getScrollback(): string { return this.scrollback; }

  write(data: string): void {
    if (this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try { this.pty.resize(cols, rows); } catch { /* race on exit */ }
  }

  onData(l: DataListener): () => void {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  dispose(): void {
    try { this.pty.kill(); } catch { /* ignore */ }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

export function getPtyLoadError(): string | null {
  return ptyLoadError;
}

export function isPtyAvailable(): boolean {
  try { loadPty(); return true; } catch { return false; }
}
