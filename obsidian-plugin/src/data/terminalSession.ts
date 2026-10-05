// TerminalSession — wraps one terminal from the host (host.ts: node-pty in Obsidian; the app's main process in the app).
// Holds a circular scrollback buffer so xterm instances can be (re)attached at will.
// The host loads node-pty lazily, so a missing or broken install degrades to "terminals unavailable".
import { pty as hostPty, type HostPtyProcess } from "../host";

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

/** Obsidian: the plugin folder, where "Install terminal support" puts node-pty (main.ts sets it at load). */
export function setPluginDir(dir: string): void { hostPty.setPluginDir(dir); }

const SCROLLBACK_CAP = 200_000;

export class TerminalSession {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;
  private pty: HostPtyProcess;
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

    this.pty = hostPty.spawn(opts.shell, [], {
      name: "xterm-256color",
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd,
      env: { ...(opts.env || {}), TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1" },
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
  return hostPty.loadError();
}

export function isPtyAvailable(): boolean {
  return hostPty.loadError() === null;
}
