import { Events } from "obsidian";
import { TerminalSession, TerminalSessionOptions } from "./terminalSession";

export class TerminalPool extends Events {
  private sessions: Map<string, TerminalSession> = new Map();
  private counter = 0;

  defaults: { shell: string; cwd: string };

  constructor(defaults: { shell: string; cwd: string }) {
    super();
    this.defaults = defaults;
  }

  list(): TerminalSession[] { return [...this.sessions.values()]; }
  get(id: string): TerminalSession | undefined { return this.sessions.get(id); }

  create(overrides?: Partial<TerminalSessionOptions>): TerminalSession {
    const id = String(++this.counter);
    const opts: TerminalSessionOptions = {
      id,
      shell: overrides?.shell || this.defaults.shell,
      cwd: overrides?.cwd || this.defaults.cwd,
      env: overrides?.env,
      cols: overrides?.cols,
      rows: overrides?.rows,
    };
    const sess = new TerminalSession(opts);
    sess.onExit(() => {
      // keep in pool so user can see exit; UI offers a re-spawn / close action
      this.trigger("session-exit", sess);
    });
    this.sessions.set(id, sess);
    this.trigger("session-add", sess);
    return sess;
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.dispose();
    this.sessions.delete(id);
    this.trigger("session-remove", id);
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      try { s.dispose(); } catch { /* ignore */ }
    }
    this.sessions.clear();
  }
}
