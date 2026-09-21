import { MarkdownRenderer, Component, EventRef } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { runAsk, isAskBusy, AskHandle, AskResult } from "../data/askSpawner";
import { runClaudeAsk, chatRoute, CHAT_FEATURE } from "../data/claudeAsk";
import { readProviderState, readVaultConfig } from "../data/aosConfig";

// PORT of the old Assistant view's module-level constants (~7-8) — verbatim.
const CHAT_LOG_PATH = "brain/_index/agentic-os-chat.jsonl";
const MAX_TIMELINE_ROWS = 80;

// PORT of the old Assistant view's interfaces (~10-41) — verbatim.
interface ChatEntry {
  ts: number;
  role: "user" | "assistant";
  text: string;
  elapsedMs?: number;
  error?: string;
  usd?: number;
}

interface TimelineRow {
  ts: number;
  kind: "tool" | "result" | "text" | "system" | "info";
  msg: string;
  cls?: string;
  isError?: boolean;
}

interface LiveTurn {
  runId: string | null;
  startedAt: number;
  timeline: TimelineRow[];
  partialText: string;
  handle: AskHandle;
  busSub: EventRef | null;
  // DOM refs for in-place updates (avoid full re-render per event)
  el: {
    container: HTMLElement;
    runMeta: HTMLElement;
    timeline: HTMLElement;
    partial: HTMLElement;
    cancelBtn: HTMLButtonElement;
  } | null;
}

// PORT of the old Assistant view (whole class) — the entire message-thread UI, input box, and
// send/live-tail logic, moved into the tab surface. The ask.js spawn engine
// (runAsk/isAskBusy from askSpawner.ts) is untouched — ChatTab calls the exact same
// functions the old Assistant view did.
export class ChatTab {
  private host: HTMLElement | null = null;
  private history: ChatEntry[] = [];
  private busy = false;
  private mdHost: Component | null = null;
  private liveTurn: LiveTurn | null = null;
  // tab-surface bookkeeping — new (no equivalent in the ItemView source, which had
  // registerEvent auto-cleanup and a single onOpen()); mirrors RunsTab/MemoryTab/PulseTab.
  private listenersRegistered = false;
  // lets updateStatusPill() (see below) patch the header pill without a full render().
  private statusPillEl: HTMLElement | null = null;
  // Fix (task-4-review.md, Important #1): an unsent draft has no source equivalent to port —
  // the old Assistant view's instance simply stayed alive with its one <textarea> across the
  // heartbeat-retargeted render() calls, so the draft never needed capturing there. Once
  // switching rail tabs tears down and rebuilds the composer's DOM (WorkbenchView.setTab()'s
  // contentHost.empty()), a plain instance field is the only thing that survives the gap;
  // kept in sync by an `input` listener and seeded back into every fresh <textarea> in render().
  private draftText = "";

  // Adaptation: the old Assistant view extended ItemView, so its constructor called super(leaf)
  // and assigns `this.plugin` in the body. ChatTab has no superclass — constructor
  // matches the tab-surface (plugin, view) param-property pattern used by
  // RunsTab/MemoryTab/PulseTab instead.
  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  // Adaptation: getViewType()/getDisplayText()/getIcon() are ItemView registration
  // hooks with no equivalent in the { mount, refresh, unmount } tab-surface interface
  // (the RAIL entry in WorkbenchView.ts already supplies icon/label) — dropped, not
  // ported, matching every other tab (RunsTab/MemoryTab/PulseTab/SpacesTab).

  // PORT of the old Assistant view's onOpen (~59). Split across mount()/refresh() to match the
  // tab-surface interface: mount() sets the host and registers the one-time listener
  // (WorkbenchView.setTab() calls mount() again on every tab switch back to "chat", so
  // registration is guarded exactly like RunsTab/MemoryTab/PulseTab); refresh() does the
  // async loadHistory()+render() the source did inline in onOpen(). mount() also calls
  // refresh() itself, mirroring the redundant-but-established mount()-calls-refresh()
  // convention in RunsTab/MemoryTab/PulseTab (WorkbenchView.setTab() calls both).
  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      // Adaptation: this.registerEvent(...) → this.view.registerEvent(...) — WorkbenchView
      // is the owning ItemView now, not this tab. Also retargeted from this.render() to
      // updateStatusPill() — see that method's comment for why.
      this.view.registerEvent(this.plugin.hb.on("change", () => this.updateStatusPill()));
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.loadHistory();
    this.render();
  }

  // PORT of the old Assistant view's onClose (~65). Adaptation: onClose→unmount; only reachable when
  // the whole Workbench view closes (WorkbenchView.onClose() calls unmount() on every
  // cached tab) — NOT on a plain tab switch (WorkbenchView.setTab() never calls the
  // outgoing tab's unmount(), it only empties contentHost and mounts the next tab). So
  // cancelling any in-flight ask here mirrors the source's "view closed → nobody is
  // listening, kill it" behavior exactly; a running ask survives ordinary tab switches
  // because nothing here fires for those. See task report for the full spawn-vs-DOM
  // lifecycle write-up.
  unmount(): void {
    if (this.mdHost) { this.mdHost.unload(); this.mdHost = null; }
    if (this.liveTurn) {
      try { this.liveTurn.handle.cancel(); } catch { /* ignore */ }
      if (this.liveTurn.busSub) this.plugin.bus.offref(this.liveTurn.busSub);
      this.liveTurn = null;
    }
    this.statusPillEl = null;
    this.host?.empty();
    this.host = null;
  }

  /** Provider the scripts last resolved (brain/_index/provider-state.json); missing state = none. */
  private providerName(): "ollama" | "claude" | "none" {
    return readProviderState(this.plugin.vaultRoot())?.name ?? "none";
  }

  /** A question is a reasoner call: headless Claude when a login is known, else the script path (data/claudeAsk.ts chatRoute). */
  private route(): "claude" | "local" | "none" {
    return chatRoute(readProviderState(this.plugin.vaultRoot()));
  }

  // PORT of the old Assistant view's loadHistory (~74). Adaptation: this.app → this.plugin.app.
  private async loadHistory(): Promise<void> {
    try {
      if (!(await this.plugin.app.vault.adapter.exists(CHAT_LOG_PATH))) return;
      const raw = await this.plugin.app.vault.adapter.read(CHAT_LOG_PATH);
      const lines = raw.trim().split("\n").filter(Boolean);
      const tail = lines.slice(-60);
      this.history = [];
      for (const line of tail) {
        try { this.history.push(JSON.parse(line) as ChatEntry); } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // PORT of the old Assistant view's appendHistory (~87). Adaptation: this.app → this.plugin.app.
  private async appendHistory(entry: ChatEntry): Promise<void> {
    this.history.push(entry);
    try {
      const line = JSON.stringify(entry) + "\n";
      const exists = await this.plugin.app.vault.adapter.exists(CHAT_LOG_PATH);
      const prev = exists ? await this.plugin.app.vault.adapter.read(CHAT_LOG_PATH) : "";
      await this.plugin.app.vault.adapter.write(CHAT_LOG_PATH, prev + line);
    } catch (e) { console.warn("[agentic-os] chat log:", e); }
  }

  // ── render ─────────────────────────────────────────────────────────────

  // PORT of the old Assistant view's render (~99). Adaptations:
  //  - this.containerEl.children[1] → this.host (the tab's content host).
  //  - root.addClass("aos-root", "aos-assistant") → host.addClass("aos-assistant") only
  //    ("aos-root" is dropped: WorkbenchView's own outer root already carries it once —
  //    see WorkbenchView.onOpen's `root.addClass("aos-root", "aos-wb")` — reapplying it
  //    per-tab would nest the scanline background effect; MemoryTab's graph mode drops it
  //    the same way when reusing the old Cortex view's `.aos-cortex` root class).
  //  - Header title text "[ ASSISTANT ]" kept verbatim (not renamed to "[ CHAT ]") —
  //    matches the Task 2 precedent of not renaming ported view headers (the old Cortex view's
  //    "[ CORTEX // KNOWLEDGE GRAPH ]" survives unchanged inside MemoryTab).
  //  - Background-repaint guard (new, Lesson 2): bails before touching DOM if another
  //    rail tab is active. The status span is saved to this.statusPillEl so
  //    updateStatusPill() can patch it in place later without a full render().
  //  - Trailing requestAnimationFrame callback gains the same active-tab check before
  //    calling input.focus(), since the tab may have been switched away during the async
  //    gap between scheduling the callback and it firing.
  //  - Fix (task-4-review.md, Important #1): the fresh <textarea> is seeded from
  //    this.draftText instead of always starting empty, so an unsent draft survives a
  //    tab-switch-away-and-return the same way the running ask already does.
  private render(): void {
    if (!this.view.isTabActive("chat")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    host.addClass("aos-assistant");

    const provider = this.providerName();
    if (provider === "none") {
      const hint = host.createDiv({ cls: "aos-asst-nohint aos-dim" });
      hint.createSpan({ cls: "aos-title", text: "[ ASSISTANT ]" });
      hint.createDiv({ text: "no provider — run `aos provider` (Ollama reachable or Claude Code logged in), then reopen the Workbench." });
      return;
    }

    const header = host.createDiv({ cls: "aos-asst-head" });
    header.createSpan({ cls: "aos-title", text: "[ ASSISTANT ]" });
    const status = header.createSpan({ cls: "aos-pill" });
    this.statusPillEl = status;
    const up = this.plugin.hb.getStatus().up;
    status.addClass(up ? "aos-pill-cyan" : "aos-pill-dim");
    status.textContent = up ? "live tail" : "idle";
    const reasonerModel = readVaultConfig(this.plugin.vaultRoot(), this.plugin.claudeConfigDir()).reasoner.model;
    header.createSpan({ cls: "aos-dim aos-asst-mode", text: this.route() === "claude" ? ` · claude (${reasonerModel}, capped)` : " · local ask.js" });

    // history log
    const log = host.createDiv({ cls: "aos-asst-log" });
    if (this.mdHost) { this.mdHost.unload(); this.mdHost = null; }
    this.mdHost = new Component();
    this.mdHost.load();
    for (const e of this.history.slice(-20)) {
      this.renderTurn(log, e);
    }

    // in-flight live turn
    if (this.busy && this.liveTurn) {
      this.mountLiveTurn(log);
    }

    // composer
    const composer = host.createDiv({ cls: "aos-asst-composer" });
    const input = composer.createEl("textarea", { cls: "aos-asst-input" });
    input.placeholder = isAskBusy() ? "ask busy (max 2 in flight)…" : "ask the brain…";
    input.rows = 3;
    input.disabled = this.busy;
    input.value = this.draftText; // restore an unsent draft across a tab-switch-away-and-return
    input.addEventListener("input", () => { this.draftText = input.value; });
    const actions = composer.createDiv({ cls: "aos-asst-actions" });
    const send = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "…" : "Send (⌘↵)" });
    send.disabled = this.busy;
    send.addEventListener("click", () => { void this.send(input.value); input.value = ""; this.draftText = ""; });
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!input.value.trim()) return;
        const q = input.value;
        input.value = "";
        this.draftText = "";
        void this.send(q);
      }
    });

    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
      if (!this.view.isTabActive("chat")) return;
      input.focus();
    });
  }

  // New — not in the source. The old Assistant view's `this.plugin.hb.on("change", () =>
  // this.render())` tore down and rebuilt the whole panel (including the composer's
  // <textarea>) on every heartbeat connectivity flip. That was fine for a single-purpose
  // side panel; now that Chat is a persistently-mounted tab, a background flip while the
  // user has an unsent draft in progress would wipe the draft, the cursor position, and
  // the textarea's native undo history. Scoped to patch just the status pill in place —
  // same "don't nuke the input" lesson RunsTab/MemoryTab already apply to their search
  // boxes, applied here to the composer instead of a search field. The full render() path
  // is untouched for every other trigger (mount, send, finalize).
  private updateStatusPill(): void {
    if (!this.view.isTabActive("chat")) return;
    const pill = this.statusPillEl;
    if (!pill) return;
    const up = this.plugin.hb.getStatus().up;
    pill.removeClass("aos-pill-cyan", "aos-pill-dim");
    pill.addClass(up ? "aos-pill-cyan" : "aos-pill-dim");
    pill.textContent = up ? "live tail" : "idle";
  }

  // PORT of the old Assistant view's renderTurn (~149) — verbatim, no adaptation needed.
  private renderTurn(log: HTMLElement, e: ChatEntry): void {
    const turn = log.createDiv({ cls: `aos-asst-turn aos-asst-turn-${e.role}` });
    turn.createDiv({ cls: "aos-asst-label aos-dim", text: e.role === "user" ? "you" : "brain" });
    const body = turn.createDiv({ cls: "aos-asst-body" });
    if (e.role === "assistant") {
      if (e.error) body.createDiv({ cls: "aos-text-rose", text: e.error });
      else if (this.mdHost) void MarkdownRenderer.renderMarkdown(e.text, body, CHAT_LOG_PATH, this.mdHost);
      const meta = [e.elapsedMs ? `${(e.elapsedMs / 1000).toFixed(1)}s` : "", typeof e.usd === "number" ? `$${e.usd.toFixed(4)}` : ""].filter(Boolean).join(" · ");
      if (meta) turn.createDiv({ cls: "aos-asst-meta aos-dim", text: meta });
    } else {
      body.textContent = e.text;
    }
  }

  /** Mount the in-flight turn UI and save DOM refs so subsequent events can mutate in place. */
  // PORT of the old Assistant view's mountLiveTurn (~163) — verbatim. Only called from render(), which
  // already gates on isTabActive("chat"); doubles as the "re-render on return" path — when
  // the user switches back to this tab, render() calls this again and it replays
  // this.liveTurn.timeline/partialText (off-DOM state, kept up to date the whole time the
  // tab was inactive — see appendRow/appendPartial below) into fresh DOM.
  private mountLiveTurn(log: HTMLElement): void {
    if (!this.liveTurn) return;
    const turn = log.createDiv({ cls: "aos-asst-turn aos-asst-turn-assistant aos-asst-live" });
    turn.createDiv({ cls: "aos-asst-label aos-dim", text: "brain" });

    const runMeta = turn.createDiv({ cls: "aos-asst-run-meta aos-dim" });
    runMeta.textContent = this.liveTurn.runId ? `run ${this.liveTurn.runId.slice(0, 24)}…` : "spawning…";

    // Timeline — collapsible details element so the user can collapse-on-demand
    const timelineWrap = turn.createEl("details", { cls: "aos-asst-timeline-wrap" });
    timelineWrap.open = true;
    const summary = timelineWrap.createEl("summary", { cls: "aos-asst-timeline-summary aos-dim", text: "▸ thinking…" });
    summary.style.cursor = "pointer";
    const timelineList = timelineWrap.createDiv({ cls: "aos-asst-timeline" });

    // Partial answer area — text streams in here as assistant_text events arrive
    const partial = turn.createDiv({ cls: "aos-asst-partial" });

    // Cancel button
    const actions = turn.createDiv({ cls: "aos-asst-live-actions" });
    const cancelBtn = actions.createEl("button", { cls: "aos-asst-cancel", text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      if (this.liveTurn) {
        try { this.liveTurn.handle.cancel(); } catch { /* ignore */ }
      }
    });

    this.liveTurn.el = { container: turn, runMeta, timeline: timelineList, partial, cancelBtn };

    // Replay any rows already collected (e.g., if runId resolved before mount completed,
    // or the tab was inactive while events accumulated off-DOM).
    for (const row of this.liveTurn.timeline) this.appendTimelineRow(row);
    if (this.liveTurn.partialText) partial.textContent = this.liveTurn.partialText;
  }

  // PORT of the old Assistant view's appendTimelineRow (~197) — verbatim.
  private appendTimelineRow(row: TimelineRow): void {
    const list = this.liveTurn?.el?.timeline;
    if (!list) return;
    const el = list.createDiv({ cls: `aos-asst-timeline-row ${row.cls || ""}${row.isError ? " aos-text-rose" : ""}` });
    el.createSpan({ cls: "aos-asst-timeline-time aos-dim", text: new Date(row.ts).toLocaleTimeString(undefined, { hour12: false, minute: "2-digit", second: "2-digit" }) });
    el.createSpan({ cls: "aos-asst-timeline-msg", text: row.msg });
  }

  // ── send + live event bridge ──────────────────────────────────────────

  // PORT of the old Assistant view's send (~207). Adaptation: this.app.vault.adapter →
  // this.plugin.app.vault.adapter. The this.plugin.bus.on("sse", ...) subscription is
  // untouched — the source already created/tore it down manually (busSub field +
  // explicit offref in finalizeRun/onClose) rather than via this.registerEvent(), so
  // there's nothing to convert to this.view.registerEvent() here; its lifetime is already
  // bound to this specific ask, not to view/tab mount state, which is exactly what lets it
  // survive a tab switch away and back (see task report).
  private async send(question: string): Promise<void> {
    const q = question.trim();
    if (!q) return;
    if (this.busy) return;
    if (isAskBusy()) {
      this.history.push({ ts: Date.now(), role: "assistant", text: "", error: "ask busy (>= 2 in flight). Try again in a moment." });
      this.render();
      return;
    }

    this.busy = true;
    await this.appendHistory({ ts: Date.now(), role: "user", text: q });

    const vaultRoot = this.plugin.vaultRoot();
    const node = this.plugin.nodeBin();
    const cfg = readVaultConfig(vaultRoot, this.plugin.claudeConfigDir());
    const handle = this.route() === "claude"
      ? runClaudeAsk({ vault: vaultRoot, node, question: q, claudeBin: this.plugin.claudeBin(), model: cfg.reasoner.model, maxBudgetUsd: cfg.reasoner.perCallUsd, effort: cfg.reasoner.effort, feature: CHAT_FEATURE })
      : runAsk({ vault: vaultRoot, node, question: q });

    this.liveTurn = {
      runId: null,
      startedAt: Date.now(),
      timeline: [],
      partialText: "",
      handle,
      busSub: null,
      el: null,
    };
    this.render();

    // Subscribe to bus immediately; filter by runId once it arrives. Stays subscribed
    // across tab switches — nothing in WorkbenchView.setTab() touches this.
    const sub = this.plugin.bus.on("sse", (e: { type: string; data: any }) => {
      if (!this.liveTurn) return;
      if (!this.liveTurn.runId) return; // wait until id resolves
      this.handleLiveEvent(e);
    });
    this.liveTurn.busSub = sub;

    // Resolve run id and update UI
    void handle.runIdPromise.then((id) => {
      if (!this.liveTurn) return;
      this.liveTurn.runId = id;
      // Background repaint guard (Lesson 2): only touch the live DOM ref while this tab
      // is the one on screen; mountLiveTurn() re-derives this same text from
      // this.liveTurn.runId when the tab becomes active again.
      if (this.view.isTabActive("chat") && this.liveTurn.el?.runMeta) {
        this.liveTurn.el.runMeta.textContent = id ? `run ${id.slice(0, 24)}…` : "(no run id — events may be unavailable)";
      }
      if (!id) {
        this.appendRow({ ts: Date.now(), kind: "info", msg: "no run id from telemetry — answer still incoming", cls: "aos-dim" });
      }
    });

    // Wait for the run to finish
    const result = await handle.result;
    await this.finalizeRun(q, result);
  }

  // PORT of the old Assistant view's handleLiveEvent (~260) — verbatim. Dispatches into
  // appendRow/appendPartial, which now carry the background-repaint guard themselves
  // (see below), so this dispatcher needs no guard of its own.
  private handleLiveEvent(e: { type: string; data: any }): void {
    if (!this.liveTurn) return;
    if (e.type === "run-start") {
      if (e.data?.id !== this.liveTurn.runId) return;
      this.appendRow({ ts: Date.now(), kind: "system", msg: `▶ ${e.data?.script || "ask"} started`, cls: "aos-text-cyan" });
      return;
    }
    if (e.type === "run-end") {
      if (e.data?.id !== this.liveTurn.runId) return;
      const status = e.data?.summary?.status || "?";
      const ok = status === "ok";
      this.appendRow({ ts: Date.now(), kind: "system", msg: `■ run-end · ${status}`, cls: ok ? "aos-text-cyan" : "aos-text-rose" });
      return;
    }
    if (e.type !== "event") return;
    if (e.data?.runId !== this.liveTurn.runId) return;
    const ev = e.data?.event;
    if (!ev || typeof ev !== "object") return;
    const ts = typeof ev.ts === "number" ? ev.ts : Date.now();

    switch (ev.type) {
      case "tool_use_batch": {
        const tools = (ev.tools as Array<{ name: string }>) || [];
        const names = tools.map((t) => t.name).join(", ");
        this.appendRow({ ts, kind: "tool", msg: `▸ ${names || "tool_use"}`, cls: "aos-text-cyan" });
        if (ev.text && typeof ev.text === "string") {
          this.appendPartial(ev.text);
        }
        break;
      }
      case "tool_result_batch": {
        const results = (ev.results as Array<{ is_error?: boolean; output_summary?: string }>) || [];
        const errs = results.filter((r) => r.is_error).length;
        this.appendRow({
          ts,
          kind: "result",
          msg: `← ${results.length} result${results.length === 1 ? "" : "s"}${errs ? ` · ${errs} err` : ""}`,
          cls: errs ? "aos-text-rose" : "aos-dim",
          isError: errs > 0,
        });
        break;
      }
      case "assistant_text": {
        if (typeof ev.text === "string") this.appendPartial(ev.text);
        break;
      }
      case "result": {
        const cost = typeof ev.cost_usd === "number" ? `$${ev.cost_usd.toFixed(4)}` : "?";
        const turns = typeof ev.turns === "number" ? `${ev.turns} turns` : "";
        this.appendRow({ ts, kind: "info", msg: `result · ${cost}${turns ? " · " + turns : ""}`, cls: "aos-dim" });
        break;
      }
      case "system": {
        if (ev.subtype) this.appendRow({ ts, kind: "system", msg: `system:${ev.subtype}`, cls: "aos-dim" });
        break;
      }
      default: {
        // unknown event — show type-only so we don't lose visibility
        this.appendRow({ ts, kind: "system", msg: String(ev.type), cls: "aos-dim" });
      }
    }
  }

  // PORT of the old Assistant view's appendRow (~323). Adaptation (Lesson 2, background repaint
  // guard): this.liveTurn.timeline.push(row) — the off-DOM state a returning render()
  // replays via mountLiveTurn() — always happens. Only the DOM-touching tail (trimming
  // the on-screen list, appending the new row element) is skipped while another rail tab
  // is active, so a live event streaming in the background can't paint over whatever tab
  // the user is actually looking at; the underlying ask.js spawn keeps running either way.
  private appendRow(row: TimelineRow): void {
    if (!this.liveTurn) return;
    this.liveTurn.timeline.push(row);
    if (this.liveTurn.timeline.length > MAX_TIMELINE_ROWS) {
      this.liveTurn.timeline.shift();
      const list = this.liveTurn.el?.timeline;
      if (list && list.firstElementChild) list.firstElementChild.remove();
    }
    if (!this.view.isTabActive("chat")) return;
    this.appendTimelineRow(row);
  }

  // PORT of the old Assistant view's appendPartial (~334). Same guard as appendRow, same reasoning:
  // this.liveTurn.partialText (off-DOM) always accumulates; the DOM write is skipped
  // while inactive and replayed in full by mountLiveTurn() on return.
  private appendPartial(chunk: string): void {
    if (!this.liveTurn) return;
    this.liveTurn.partialText += chunk;
    if (!this.view.isTabActive("chat")) return;
    if (this.liveTurn.el?.partial) {
      this.liveTurn.el.partial.textContent = this.liveTurn.partialText;
    }
  }

  // PORT of the old Assistant view's finalizeRun (~342) — verbatim. No isTabActive guard needed here:
  // the state mutations (clearing liveTurn, unsubscribing busSub, appending history,
  // clearing busy) must happen regardless of which tab is on screen; the trailing
  // this.render() call is already a safe no-op via render()'s own guard when inactive.
  private async finalizeRun(question: string, result: AskResult): Promise<void> {
    const live = this.liveTurn;
    this.liveTurn = null;
    if (live?.busSub) this.plugin.bus.offref(live.busSub);

    const entry: ChatEntry =
      result.ok && result.answer
        ? { ts: Date.now(), role: "assistant", text: result.answer, elapsedMs: result.elapsedMs, usd: result.usd }
        : { ts: Date.now(), role: "assistant", text: "", error: result.error || result.stderr?.slice(0, 400) || "no answer" };
    await this.appendHistory(entry);

    this.busy = false;
    this.render();
  }
}
