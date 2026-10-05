// The terminal view a setup job draws into (phase 5): a fix-it's terminal, which the user can type into (a password, a
// login's code), and the output of `aos init` and `aos upgrade`. It keeps a plain-text copy of what it showed, for the
// e2e suite and for a Copy button.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const THEME = { background: "#0d1219", foreground: "#c5d6e0", cursor: "#00d4ff", selectionBackground: "#1f3a4a", brightBlack: "#6b7d8c" };

export class JobTerminal {
  readonly el: HTMLElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private text = "";

  constructor(parent: HTMLElement, o: { input?: (data: string) => void; resize?: (cols: number, rows: number) => void; rows?: number } = {}) {
    this.el = parent.createDiv({ cls: "aos-setup-term" });
    this.term = new Terminal({
      theme: THEME,
      fontFamily: "'Berkeley Mono', 'JetBrains Mono', 'SF Mono', Menlo, monospace",
      fontSize: 12,
      rows: o.rows ?? 14,
      cols: 100,
      scrollback: 5000,
      convertEol: false,
      cursorBlink: !!o.input,
      disableStdin: !o.input,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.el);
    if (o.input) this.term.onData((d) => o.input?.(d));
    if (o.resize) this.term.onResize(({ cols, rows }) => o.resize?.(cols, rows));
    requestAnimationFrame(() => this.refit());
  }

  refit(): void {
    try { this.fit.fit(); } catch { /* not laid out yet */ }
  }

  get size(): { cols: number; rows: number } { return { cols: this.term.cols, rows: this.term.rows }; }

  write(data: string): void {
    this.text += data;
    this.term.write(data);
  }

  /** A line of our own, dimmed, after the job's output. */
  note(line: string): void { this.write(`\r\n\x1b[2m${line}\x1b[0m\r\n`); }

  clear(): void {
    this.text = "";
    this.term.reset();
  }

  focus(): void { this.term.focus(); }

  /** What the terminal showed, without colour codes. */
  get plain(): string {
    // eslint-disable-next-line no-control-regex
    return this.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n");
  }

  dispose(): void {
    this.term.dispose();
    this.el.remove();
  }
}
