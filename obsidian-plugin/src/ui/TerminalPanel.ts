// TerminalPanel — embeddable terminal component.
// Renders the panel chrome (header with tabs, body with xterm, optional drag handle)
// inside a host element. Each session gets its own xterm; only the active one is visible.

import { Notice } from "obsidian";
import { Terminal, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type AgenticOSPlugin from "../../main";
import { TerminalSession } from "../data/terminalSession";
import { TOKENS } from "./tokens";

const HUD_THEME: ITheme = {
  background: TOKENS.termBackground,
  foreground: TOKENS.termForeground,
  cursor: TOKENS.termCursor,
  cursorAccent: TOKENS.termCursorAccent,
  selectionBackground: TOKENS.termSelectionBackground,
  black: TOKENS.termBlack,
  red: TOKENS.termRed,
  green: TOKENS.termGreen,
  yellow: TOKENS.termYellow,
  blue: TOKENS.termBlue,
  magenta: TOKENS.termMagenta,
  cyan: TOKENS.termCyan,
  white: TOKENS.termWhite,
  brightBlack: TOKENS.termBrightBlack,
  brightRed: TOKENS.termBrightRed,
  brightGreen: TOKENS.termBrightGreen,
  brightYellow: TOKENS.termBrightYellow,
  brightBlue: TOKENS.termBrightBlue,
  brightMagenta: TOKENS.termBrightMagenta,
  brightCyan: TOKENS.termBrightCyan,
  brightWhite: TOKENS.termBrightWhite,
};

interface XtermBinding {
  term: Terminal;
  fit: FitAddon;
  container: HTMLElement;
  detachData: () => void;
}

export interface TerminalPanelOptions {
  resizable: boolean;          // show drag handle on bottom edge
  initialHeight?: number;
  onHeightChange?: (h: number) => void;
  onClose?: () => void;        // panel-level close (collapses the strip)
  showMaximize?: boolean;
  onMaximize?: () => void;
  fullPane?: boolean;          // render in full-pane mode (no drag handle, fills container)
}

export class TerminalPanel {
  private plugin: AgenticOSPlugin;
  private opts: TerminalPanelOptions;
  private host: HTMLElement | null = null;

  private headerEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  private bindings = new Map<string, XtermBinding>();
  private activeId: string | null = null;
  private resizeObs: ResizeObserver | null = null;
  private height: number;

  constructor(plugin: AgenticOSPlugin, opts: TerminalPanelOptions) {
    this.plugin = plugin;
    this.opts = opts;
    this.height = opts.initialHeight ?? 280;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    host.empty();
    host.addClass("aos-term");
    if (this.opts.fullPane) host.addClass("aos-term-fullpane");
    if (!this.opts.fullPane) host.style.height = `${this.height}px`;

    // header
    this.headerEl = host.createDiv({ cls: "aos-term-header" });
    const left = this.headerEl.createDiv({ cls: "aos-term-header-left" });
    left.createSpan({ cls: "aos-term-title", text: "[ TERMINAL ]" });
    this.tabsEl = this.headerEl.createDiv({ cls: "aos-term-tabs" });

    const right = this.headerEl.createDiv({ cls: "aos-term-header-right" });
    const newBtn = right.createEl("button", { cls: "aos-term-btn", text: "+ new" });
    newBtn.setAttr("title", "New shell session (Cmd-Shift-N)");
    newBtn.addEventListener("click", () => { void this.createNewSession(); });

    if (this.opts.showMaximize && this.opts.onMaximize) {
      const max = right.createEl("button", { cls: "aos-term-btn", text: "⛶" });
      max.setAttr("title", "Open in dedicated tab");
      max.addEventListener("click", () => { this.opts.onMaximize?.(); });
    }
    if (this.opts.onClose) {
      const close = right.createEl("button", { cls: "aos-term-btn aos-term-btn-close", text: "▾" });
      close.setAttr("title", "Collapse panel");
      close.addEventListener("click", () => { this.opts.onClose?.(); });
    }

    // body
    this.bodyEl = host.createDiv({ cls: "aos-term-body" });

    // drag handle
    if (this.opts.resizable && !this.opts.fullPane) {
      const handle = host.createDiv({ cls: "aos-term-handle" });
      this.bindDragResize(handle, host);
    }

    // ensure at least one session
    const pool = this.plugin.terminalPool;
    if (!pool || pool.list().length === 0) {
      if (pool) {
        try { pool.create(); }
        catch (e) { this.renderError(e); return; }
      }
    }
    if (!pool) { this.renderError(new Error("Terminal pool not initialized")); return; }

    this.activeId = pool.list()[0]?.id || null;
    this.renderTabs();
    if (this.activeId) this.ensureBindingForActive();

    // resize observer
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(this.bodyEl);

    // listen for pool changes
    this.plugin.registerEvent(pool.on("session-add", () => { this.renderTabs(); }));
    this.plugin.registerEvent(pool.on("session-remove", (id: string) => {
      const b = this.bindings.get(id);
      if (b) { b.detachData(); try { b.term.dispose(); } catch {} this.bindings.delete(id); }
      this.renderTabs();
      if (this.activeId === id) {
        const next = pool.list()[0];
        this.activeId = next?.id || null;
        if (this.activeId) this.ensureBindingForActive();
      }
    }));
    this.plugin.registerEvent(pool.on("session-exit", () => { this.renderTabs(); }));
  }

  unmount(): void {
    // dispose xterm instances but DON'T touch PTYs in the pool
    for (const b of this.bindings.values()) {
      try { b.detachData(); } catch { /* ignore */ }
      try { b.term.dispose(); } catch { /* ignore */ }
    }
    this.bindings.clear();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.host = null;
  }

  focus(): void {
    if (!this.activeId) return;
    const b = this.bindings.get(this.activeId);
    b?.term.focus();
  }

  async createNewSession(): Promise<void> {
    try {
      const sess = this.plugin.terminalPool.create();
      this.activeId = sess.id;
      this.renderTabs();
      this.ensureBindingForActive();
    } catch (e) {
      this.renderError(e);
    }
  }

  // ── private ──────────────────────────────────────────────────────────

  private renderError(e: unknown): void {
    this.bodyEl?.empty();
    const wrap = this.bodyEl?.createDiv({ cls: "aos-term-error" });
    wrap?.createDiv({ cls: "aos-text-rose", text: "Terminal unavailable" });
    const msg = e instanceof Error ? e.message : String(e);
    wrap?.createDiv({ cls: "aos-dim aos-term-error-msg", text: msg });
    wrap?.createDiv({
      cls: "aos-dim aos-term-error-hint",
      text: "node-pty needs a binary matching Obsidian's Electron ABI. From the plugin dir run: npx @electron/rebuild -v <electron-version> (find it via process.versions.electron in the dev console).",
    });
  }

  private renderTabs(): void {
    this.tabsEl.empty();
    const sessions = this.plugin.terminalPool.list();
    for (const s of sessions) {
      const tab = this.tabsEl.createDiv({ cls: "aos-term-tab" });
      if (s.id === this.activeId) tab.addClass("aos-term-tab-active");
      if (s.isExited) tab.addClass("aos-term-tab-exited");
      tab.createSpan({ cls: "aos-term-tab-label", text: s.getTitle() });
      const close = tab.createSpan({ cls: "aos-term-tab-close", text: "×" });
      close.setAttr("title", "Close session");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.terminalPool.remove(s.id);
      });
      tab.addEventListener("click", () => {
        this.activeId = s.id;
        this.renderTabs();
        this.ensureBindingForActive();
      });
    }
  }

  private ensureBindingForActive(): void {
    if (!this.activeId) return;
    const sess = this.plugin.terminalPool.get(this.activeId);
    if (!sess) return;
    let b = this.bindings.get(sess.id);
    if (!b) b = this.createBinding(sess);

    // show active, hide others
    for (const [id, binding] of this.bindings.entries()) {
      binding.container.style.display = id === this.activeId ? "block" : "none";
    }
    // refit + focus next frame so layout settles
    requestAnimationFrame(() => {
      this.refit();
      b?.term.focus();
    });
  }

  private createBinding(sess: TerminalSession): XtermBinding {
    const container = this.bodyEl.createDiv({ cls: "aos-term-xterm" });
    const term = new Terminal({
      theme: HUD_THEME,
      fontFamily: "'Berkeley Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: this.plugin.settings.terminalFontSize || 13,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: this.plugin.settings.terminalScrollback || 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // hydrate from cached scrollback
    const back = sess.getScrollback();
    if (back) term.write(back);

    // wire PTY → xterm
    const detachData = sess.onData((d) => term.write(d));
    // wire xterm → PTY
    term.onData((d) => sess.write(d));
    term.onResize(({ cols, rows }) => sess.resize(cols, rows));

    const binding: XtermBinding = { term, fit, container, detachData };
    this.bindings.set(sess.id, binding);
    return binding;
  }

  private refit(): void {
    if (!this.activeId) return;
    const b = this.bindings.get(this.activeId);
    if (!b) return;
    try {
      b.fit.fit();
    } catch { /* container not laid out yet */ }
  }

  private bindDragResize(handle: HTMLElement, host: HTMLElement): void {
    let startY = 0;
    let startH = 0;
    let dragging = false;
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const next = Math.max(140, Math.min(900, startH + (e.clientY - startY)));
      this.height = next;
      host.style.height = `${next}px`;
      this.refit();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.opts.onHeightChange?.(this.height);
    };
    handle.addEventListener("mousedown", (e: MouseEvent) => {
      dragging = true;
      startY = e.clientY;
      startH = host.clientHeight;
      document.body.style.cursor = "row-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }
}
