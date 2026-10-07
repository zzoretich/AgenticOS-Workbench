import { Component, MarkdownRenderer } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { ChatTab } from "./ChatTab";
import { fs, sessionsHost, type HostGitStatus, type HostResult, type HostSessionEvent, type HostSessionThread } from "../host";
import { readAgenticosJson, readProviderState, type SessionHost } from "../data/aosConfig";
import {
  CODEX_SANDBOX_NOTE, HOST_LABEL, fileStatusLabel, groupThreads, hostChoices, mergeEvents, statusSummary, threadMeta,
  timelineRows, toolLine, turnOpen, workspaceNames, type TimelineRow,
} from "../data/agentSessions";
import { ago } from "../data/notifications";

/** The list's first row: today's Q&A chat about the vault (ChatTab). */
const VAULT = "vault";
/** The reader while a new session is being written: the composer with its workspace, host and model pickers. */
const NEW = "new";
/** After a turn ends, main records its spend and run before the thread reads as idle: the list looks again after these. */
const LIST_RECHECK_MS = [400, 1500, 4000];
/** A reply sent while main is still recording the last turn: tries again this often, this many times. */
const BUSY_RETRY_MS = 300;
const BUSY_RETRIES = 10;

interface RepoCard {
  workspace: string;
  status: HostGitStatus | null;
  error: string | null;
  loading: boolean;
  /** The file whose diff the card shows, and that diff. */
  review: { file: string; text: string; truncated: boolean; error: string | null } | null;
  /** The commit message, prefilled from the thread's title; what the user typed survives a refresh. */
  message: string;
  result: { ok: boolean; text: string } | null;
  committing: boolean;
}

/**
 * SESSIONS — agent sessions in the centre (spec 2026-10-07-unidex-sessions S10, §4.5). The rail tab keeps the id
 * "chat", so links and Home still reach it. The list: Vault first (today's chat about the vault, ChatTab, unchanged),
 * then the app's threads by workspace with a running dot. The reader: the thread's timeline (prompts, the agent's
 * text, tool rows that open to their input and result, changed files, errors, a footer per turn), the repository card
 * (what changed, Review, Commit), and the composer. The app's main process runs every turn and keeps every thread;
 * this tab only names a workspace, a host and a prompt (host.ts sessions and git). Without them, Vault alone works.
 */
export class SessionsTab {
  private host: HTMLElement | null = null;
  private chat: ChatTab;
  private selected = VAULT;
  private threads: HostSessionThread[] = [];
  private listError: string | null = null;
  private listLoaded = false;
  private listSeq = 0;
  /** The open thread, from the list or from the start/send that opened it. */
  private thread: HostSessionThread | null = null;
  private events: HostSessionEvent[] = [];
  /** Live events of the open thread that arrive while its file is being read; merged in when the read answers. */
  private pending: HostSessionEvent[] | null = null;
  private loading = false;
  private expanded = new Set<string>();
  private repo: RepoCard | null = null;
  private draft: { workspace: string; host: SessionHost | null; model: string; allowCommands: boolean } = { workspace: "", host: null, model: "", allowCommands: false };
  private text = "";
  private composerError: string | null = null;
  private sending = false;
  private stopping: string | null = null;
  private md: Component | null = null;
  private unsubscribe: (() => void) | null = null;
  private timers = new Set<number>();
  private el: { list: HTMLElement; reader: HTMLElement; head?: HTMLElement; scroll?: HTMLElement; timeline?: HTMLElement; repo?: HTMLElement; composer?: HTMLElement } | null = null;

  constructor(private plugin: AgenticOSPlugin, private wb: WorkbenchView) {
    this.chat = new ChatTab(plugin, wb, () => this.selected === VAULT);
  }

  mount(host: HTMLElement): void {
    this.host = host;
    const sh = sessionsHost();
    if (sh && !this.unsubscribe) this.unsubscribe = sh.sessions.onEvent((ev) => this.onEvent(ev.thread, ev.event));
    this.render();
    if (this.isThread(this.selected)) void this.openThread(this.selected);
    void this.loadList();
  }

  async refresh(): Promise<void> {
    await this.loadList();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    this.chat.unmount();
    this.md?.unload();
    this.md = null;
    this.el = null;
    this.host?.empty();
    this.host = null;
  }

  private active(): boolean { return this.wb.isTabActive("chat") && !!this.host; }
  private isThread(id: string): boolean { return id !== VAULT && id !== NEW; }

  // ── data ──

  private async loadList(): Promise<void> {
    const sh = sessionsHost();
    if (sh) {
      const seq = ++this.listSeq;
      const r = await sh.sessions.list();
      if (seq !== this.listSeq) return;   // a later look already answered
      this.listLoaded = true;
      if (r.ok) {
        this.threads = r.data;
        this.listError = null;
        const open = r.data.find((t) => t.id === this.selected);
        if (open) this.thread = open;
      } else {
        this.threads = [];
        this.listError = r.error;
      }
    }
    if (this.active()) this.renderList();
  }

  private scheduleList(ms: number): void {
    const id = window.setTimeout(() => { this.timers.delete(id); void this.loadList(); }, ms);
    this.timers.add(id);
  }

  /** Reads the thread's file, then keeps it current from live events. */
  private async openThread(id: string): Promise<void> {
    const sh = sessionsHost();
    if (!sh) return;
    this.pending = [];
    this.loading = !this.events.length;
    if (this.active()) this.renderTimeline();
    const r = await sh.sessions.read(id);
    if (this.selected !== id) return;
    const live = this.pending ?? [];
    this.pending = null;
    this.loading = false;
    if (r.ok) this.events = mergeEvents(r.data, live);
    else { this.events = mergeEvents(this.events, live); this.composerError = r.error; }
    if (!this.active()) return;
    this.renderHead();
    this.renderTimeline(true);
    this.renderComposer();
    if (!turnOpen(this.events)) void this.loadRepo();
  }

  private onEvent(thread: string, e: HostSessionEvent): void {
    if (thread === this.selected) {
      if (this.pending) this.pending.push(e);
      else {
        this.events.push(e);
        if (e.kind === "done" && this.stopping === thread) this.stopping = null;
        if (this.active()) {
          this.renderTimeline();
          if (e.kind === "prompt" || e.kind === "done") { this.renderHead(); this.renderComposer(); }
        }
        if (e.kind === "done") void this.loadRepo();
      }
    }
    if (e.kind === "done") for (const ms of LIST_RECHECK_MS) this.scheduleList(ms);
    else if (e.kind === "prompt" || !this.threads.some((t) => t.id === thread)) this.scheduleList(0);
  }

  private async loadRepo(): Promise<void> {
    const sh = sessionsHost();
    const t = this.thread;
    if (!sh || !t || this.selected !== t.id) return;
    const prev = this.repo?.workspace === t.workspace ? this.repo : null;
    this.repo = { workspace: t.workspace, status: prev?.status ?? null, error: null, loading: true, review: null, message: prev?.message || t.title, result: prev?.result ?? null, committing: false };
    if (this.active()) this.renderRepo();
    const r = await sh.git.status(t.workspace);
    if (this.selected !== t.id || !this.repo) return;
    this.repo.loading = false;
    if (r.ok) this.repo.status = r.data;
    else this.repo.error = r.error;
    if (this.active()) this.renderRepo();
  }

  /** Folders under <vault>/workspaces, read as every other tab reads the vault. */
  private workspaces(): string[] {
    const dir = path.join(this.plugin.vaultRoot(), "workspaces");
    try {
      const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => {
        if (d.isDirectory()) return true;
        if (!d.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; }
      });
      return workspaceNames(dirs.map((d) => d.name));
    } catch { return []; }
  }

  // ── actions ──

  private select(id: string): void {
    if (id === this.selected && id !== NEW) return;
    this.selected = id;
    this.thread = this.isThread(id) ? this.threads.find((t) => t.id === id) ?? null : null;
    this.events = [];
    this.pending = null;
    this.expanded.clear();
    this.repo = null;
    this.text = "";
    this.composerError = null;
    this.renderList();
    this.renderReader();
    if (this.isThread(id)) void this.openThread(id);
  }

  private async submit(): Promise<void> {
    const sh = sessionsHost();
    const text = this.text.trim();
    if (!sh || !text || this.sending) return;
    let r: HostResult<HostSessionThread>;
    const isNew = this.selected === NEW;
    if (isNew && !this.draft.workspace) { this.composerError = "Choose a workspace first."; this.renderComposer(); return; }
    if (isNew && !this.draft.host) { this.composerError = "No host is ready to run this session."; this.renderComposer(); return; }
    this.sending = true;
    this.composerError = null;
    this.renderComposer();
    const sent = this.selected;
    if (isNew) {
      const host = this.draft.host as SessionHost;
      r = await sh.sessions.start({ workspace: this.draft.workspace, host, text, model: this.draft.model.trim() || null, allowCommands: host === "claude" && this.draft.allowCommands });
    } else {
      const thread = sent;
      const allowCommands = this.thread?.host === "claude" && this.draft.allowCommands;
      r = await sh.sessions.send({ thread, text, allowCommands });
      // The last turn has ended here, but main may still be recording it (its spend and run row): try again shortly.
      for (let i = 0; i < BUSY_RETRIES && !r.ok && r.code === "EBUSY" && !turnOpen(this.events) && this.selected === thread; i++) {
        await new Promise((res) => window.setTimeout(res, BUSY_RETRY_MS));
        r = await sh.sessions.send({ thread, text, allowCommands });
      }
    }
    this.sending = false;
    // The user may have moved to another thread while main answered: then the answer only updates the list.
    const here = isNew ? this.selected === NEW : this.selected === sent;
    if (!here && this.active()) this.renderComposer();   // its Send was off while this one was sending
    if (!r.ok) {
      if (here) this.composerError = r.error;
      if (here && this.active()) this.renderComposer();
      return;
    }
    this.threads = [r.data, ...this.threads.filter((t) => t.id !== r.data.id)];
    if (!here) {
      if (this.active()) this.renderList();
    } else if (isNew) {
      this.text = "";
      this.thread = r.data;
      this.selected = r.data.id;
      this.events = [];
      this.repo = null;
      if (this.active()) { this.renderList(); this.renderReader(); }
      void this.openThread(r.data.id);
    } else {
      this.text = "";
      this.thread = r.data;
      this.repo = null;
      if (this.active()) {
        this.renderList();
        this.renderHead();
        this.renderRepo();
        this.renderComposer();
      }
    }
    this.scheduleList(0);
  }

  private stop(): void {
    const sh = sessionsHost();
    const t = this.thread;
    if (!sh || !t) return;
    this.stopping = t.id;
    sh.sessions.stop(t.id);
    this.renderHead();
  }

  private async review(file: string): Promise<void> {
    const sh = sessionsHost();
    const repo = this.repo;
    if (!sh || !repo) return;
    if (repo.review?.file === file) { repo.review = null; this.renderRepo(); return; }
    repo.review = { file, text: "", truncated: false, error: null };
    this.renderRepo();
    const r = await sh.git.diff(repo.workspace, file);
    if (this.repo !== repo || repo.review?.file !== file) return;
    repo.review = r.ok ? { file, text: r.data.text, truncated: r.data.truncated, error: null } : { file, text: "", truncated: false, error: r.error };
    if (this.active()) this.renderRepo();
  }

  private async commit(): Promise<void> {
    const sh = sessionsHost();
    const repo = this.repo;
    if (!sh || !repo || repo.committing) return;
    // Main refuses a blank message too, but only as an argument that does not parse.
    if (!repo.message.trim()) { repo.result = { ok: false, text: "A commit needs a message." }; this.renderRepo(); return; }
    repo.committing = true;
    repo.result = null;
    this.renderRepo();
    const r = await sh.git.commit(repo.workspace, repo.message);
    if (this.repo !== repo) return;
    repo.committing = false;
    repo.result = r.ok ? { ok: true, text: `Committed ${r.data.commit.slice(0, 7)}` } : { ok: false, text: r.error };
    if (r.ok) { repo.review = null; await this.loadRepo(); }
    else if (this.active()) this.renderRepo();
  }

  // ── render ──

  private render(): void {
    if (!this.active()) return;
    const host = this.host as HTMLElement;
    host.empty();
    const root = host.createDiv({ cls: "aos-ss" });
    const head = root.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Sessions" });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    if (sessionsHost()) {
      const b = actions.createEl("button", { cls: "aos-ws-action aos-ss-newbtn", text: "New session" });
      b.addEventListener("click", () => this.select(NEW));
    }
    const split = root.createDiv({ cls: "aos-split aos-ss-split" });
    this.el = { list: split.createDiv({ cls: "aos-split-list aos-ss-list" }), reader: split.createDiv({ cls: "aos-split-detail aos-ss-reader" }) };
    this.renderList();
    this.renderReader();
  }

  private clickable(el: HTMLElement, go: () => void): void {
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }

  private renderList(): void {
    const list = this.el?.list;
    if (!list || !this.active()) return;
    list.empty();
    const vault = list.createDiv({ cls: `aos-ss-row aos-ss-vault${this.selected === VAULT ? " is-selected" : ""}`, attr: { "data-thread": VAULT, role: "button", tabindex: "0" } });
    vault.createSpan({ cls: "aos-ss-dot" });
    const name = vault.createDiv({ cls: "aos-ss-name" });
    name.createDiv({ cls: "aos-ss-title", text: "Vault" });
    name.createDiv({ cls: "aos-ss-meta", text: "Questions about your notes" });
    this.clickable(vault, () => this.select(VAULT));

    const note = (text: string) => list.createDiv({ cls: "aos-ss-note", text });
    if (!sessionsHost()) { note("Workspace sessions run in the UniDeX app."); return; }
    if (this.listError) { note(`Workspace sessions are unavailable: ${this.listError}.`); return; }
    if (!this.threads.length) { if (this.listLoaded) note("No workspace sessions yet. New session starts one."); return; }
    for (const g of groupThreads(this.threads)) {
      const group = list.createDiv({ cls: "aos-ss-group", attr: { "data-workspace": g.workspace } });
      group.createDiv({ cls: "aos-ss-ws", text: g.workspace });
      for (const t of g.threads) this.renderThreadRow(group, t);
    }
  }

  /** The open thread's own events say whether its turn runs; the list's flag says it for the others. */
  private isRunning(t: HostSessionThread): boolean {
    return t.id === this.selected && this.events.length ? turnOpen(this.events) : t.running;
  }

  private renderThreadRow(parent: HTMLElement, t: HostSessionThread): void {
    const running = this.isRunning(t);
    const row = parent.createDiv({ cls: `aos-ss-row${this.selected === t.id ? " is-selected" : ""}${running ? " is-running" : ""}`, attr: { "data-thread": t.id, role: "button", tabindex: "0" } });
    row.createSpan({ cls: "aos-ss-dot", attr: running ? { title: "Running", "aria-label": "Running" } : {} });
    const name = row.createDiv({ cls: "aos-ss-name" });
    name.createDiv({ cls: "aos-ss-title", text: t.title || "Untitled" });
    name.createDiv({ cls: "aos-ss-meta", text: `${threadMeta(t)} · ${ago(t.updated, new Date())}` });
    row.createSpan({ cls: `aos-pill aos-ss-host is-${t.host}`, text: HOST_LABEL[t.host] });
    this.clickable(row, () => this.select(t.id));
  }

  private renderReader(): void {
    const list = this.el?.list;
    const reader = this.el?.reader;
    if (!list || !reader || !this.active()) return;
    reader.empty();
    this.md?.unload();
    this.md = new Component();
    this.md.load();
    this.el = { list, reader };
    if (this.selected === VAULT) {
      reader.addClass("is-vault");
      this.chat.mount(reader.createDiv({ cls: "aos-ss-vaultchat" }));
      return;
    }
    reader.removeClass("is-vault");
    const head = reader.createDiv({ cls: "aos-reader-head aos-ss-head" });
    const scroll = reader.createDiv({ cls: "aos-ss-scroll" });
    const timeline = scroll.createDiv({ cls: "aos-ss-timeline" });
    const repo = scroll.createDiv({ cls: "aos-ss-repo-wrap" });
    const composer = reader.createDiv({ cls: "aos-ss-composer-wrap" });
    this.el = { list, reader, head, scroll, timeline, repo, composer };
    this.renderHead();
    this.renderTimeline(true);
    this.renderRepo();
    this.renderComposer();
  }

  private renderHead(): void {
    const head = this.el?.head;
    if (!head || !this.active()) return;
    head.empty();
    if (this.selected === NEW) {
      head.createDiv({ cls: "aos-reader-title", text: "New session" });
      head.createDiv({ cls: "aos-reader-meta", text: "An agent works in a workspace folder, turn by turn; you review and commit what it changed." });
      return;
    }
    const t = this.thread;
    const row = head.createDiv({ cls: "aos-ss-headrow" });
    const crumbs = row.createDiv({ cls: "aos-reader-title aos-ss-crumbs" });
    crumbs.createSpan({ cls: "aos-ss-crumb-ws", text: t?.workspace ?? "" });
    crumbs.createSpan({ cls: "aos-ss-sep", text: "›" });
    crumbs.createSpan({ cls: "aos-ss-crumb-title", text: t?.title ?? "" });
    if (t && turnOpen(this.events)) {
      const stopping = this.stopping === t.id;
      const stop = row.createEl("button", { cls: "aos-ws-action aos-ss-stop", text: stopping ? "Stopping…" : "Stop" });
      stop.disabled = stopping;
      stop.addEventListener("click", () => this.stop());
    }
    if (!t) return;
    const meta = head.createDiv({ cls: "aos-reader-meta aos-ss-headmeta" });
    meta.createSpan({ cls: `aos-pill aos-ss-host is-${t.host}`, text: HOST_LABEL[t.host] });
    if (t.model) meta.createSpan({ cls: "aos-ss-model", text: t.model });
  }

  private renderTimeline(toEnd = false): void {
    const el = this.el?.timeline;
    const scroll = this.el?.scroll;
    if (!el || !scroll || !this.active()) return;
    const atEnd = toEnd || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    el.empty();
    if (this.selected === NEW) return;
    if (this.loading) { el.createDiv({ cls: "aos-ss-note", text: "Reading the thread…" }); return; }
    for (const r of timelineRows(this.events)) this.renderRow(el, r);
    if (turnOpen(this.events)) el.createDiv({ cls: "aos-ss-working", text: this.stopping === this.selected ? "Stopping…" : "Working…" });
    if (atEnd) scroll.scrollTop = scroll.scrollHeight;
  }

  private renderRow(el: HTMLElement, r: TimelineRow): void {
    if (r.kind === "prompt") {
      el.createDiv({ cls: "aos-ss-prompt" }).createDiv({ cls: "aos-ss-bubble", text: r.text });
    } else if (r.kind === "text") {
      const body = el.createDiv({ cls: "aos-ss-text" });
      if (this.md) void MarkdownRenderer.renderMarkdown(r.text, body, `workspaces/${this.thread?.workspace ?? ""}`, this.md);
    } else if (r.kind === "tool") {
      const tone = r.result === null ? "is-pending" : r.result.ok ? "is-ok" : "is-failed";
      const d = el.createEl("details", { cls: `aos-ss-tool ${tone}`, attr: { "data-kind": r.tool.toolKind || "other" } });
      d.open = this.expanded.has(r.key);
      d.addEventListener("toggle", () => { if (d.open) this.expanded.add(r.key); else this.expanded.delete(r.key); });
      d.createEl("summary", { cls: "aos-ss-toolline", text: toolLine(r.tool) });
      const body = d.createDiv({ cls: "aos-ss-toolbody" });
      if (r.tool.summary) body.createEl("pre", { cls: "aos-ss-toolin", text: r.tool.summary });
      if (r.result) {
        body.createDiv({ cls: "aos-ss-toolstate", text: r.result.ok ? "Result" : "Failed" });
        if (r.result.summary) body.createEl("pre", { cls: "aos-ss-toolout", text: r.result.summary });
      } else body.createDiv({ cls: "aos-ss-toolstate", text: "No result yet" });
    } else if (r.kind === "patch") {
      const p = el.createDiv({ cls: "aos-ss-patch" });
      p.createDiv({ cls: "aos-ss-patchhead", text: `Changed ${r.files.length} file${r.files.length === 1 ? "" : "s"}` });
      for (const f of r.files) {
        const row = p.createDiv({ cls: "aos-ss-patchfile" });
        row.createSpan({ cls: "aos-ss-change", text: f.change });
        row.createSpan({ text: f.path });
      }
    } else if (r.kind === "error") {
      el.createDiv({ cls: "aos-ss-error", text: r.message });
    } else {
      el.createDiv({ cls: `aos-ss-done${r.ok ? "" : " is-failed"}`, text: r.footer });
    }
  }

  private renderRepo(): void {
    const el = this.el?.repo;
    if (!el || !this.active()) return;
    el.empty();
    const r = this.repo;
    if (!r || this.selected === NEW || turnOpen(this.events)) return;
    const card = el.createDiv({ cls: "aos-ss-repo" });
    const head = card.createDiv({ cls: "aos-ss-repohead" });
    if (r.error) { head.createSpan({ cls: "aos-ss-reposum", text: r.error }); return; }
    if (!r.status) { head.createSpan({ cls: "aos-ss-reposum aos-dim", text: "Reading the repository…" }); return; }
    const st = r.status;
    head.createSpan({ cls: "aos-ss-reposum", text: st.repo ? statusSummary(st) : `workspaces/${r.workspace} is not a git repository, so there is nothing to review or commit` });
    if (st.branch) head.createSpan({ cls: "aos-ss-branch", text: st.branch });
    if (r.result) card.createDiv({ cls: `aos-ss-commitresult ${r.result.ok ? "is-ok" : "is-failed"}`, text: r.result.text });
    if (!st.repo || !st.files.length) return;

    const files = card.createDiv({ cls: "aos-ss-files" });
    for (const f of st.files) {
      const row = files.createDiv({ cls: `aos-ss-file${r.review?.file === f.path ? " is-open" : ""}`, attr: { "data-file": f.path } });
      row.createSpan({ cls: "aos-ss-change", text: fileStatusLabel(f.status) });
      row.createSpan({ cls: "aos-ss-path", text: f.path });
      const b = row.createEl("button", { cls: "aos-ws-action aos-ss-review", text: r.review?.file === f.path ? "Close" : "Review" });
      b.addEventListener("click", () => void this.review(f.path));
    }
    if (r.review) {
      const pane = card.createDiv({ cls: "aos-ss-diffwrap" });
      if (r.review.error) pane.createDiv({ cls: "aos-ss-error", text: r.review.error });
      else if (!r.review.text) pane.createDiv({ cls: "aos-dim", text: "Reading the diff…" });
      else {
        pane.createEl("pre", { cls: "aos-ss-diff", text: r.review.text });
        if (r.review.truncated) pane.createDiv({ cls: "aos-ss-note", text: "The diff is longer than this; only its first 2 MB are shown." });
      }
    }
    const form = card.createDiv({ cls: "aos-ss-commit" });
    const msg = form.createEl("input", { cls: "aos-ss-message", attr: { type: "text", "aria-label": "Commit message", spellcheck: "false" } });
    msg.value = r.message;
    msg.addEventListener("input", () => { r.message = msg.value; });
    const go = form.createEl("button", { cls: "mod-cta aos-ss-commitbtn", text: r.committing ? "Committing…" : "Commit" });
    go.disabled = r.committing || st.detached || st.merging;
    if (st.detached) form.createDiv({ cls: "aos-ss-note", text: "HEAD is detached: check out a branch to commit." });
    else if (st.merging) form.createDiv({ cls: "aos-ss-note", text: "A merge is in progress: finish it in a terminal." });
    go.addEventListener("click", () => void this.commit());
  }

  private renderComposer(): void {
    const el = this.el?.composer;
    if (!el || !this.active()) return;
    el.empty();
    const isNew = this.selected === NEW;
    const box = el.createDiv({ cls: "aos-ss-composer" });
    let host: SessionHost | null = this.thread?.host ?? null;
    if (isNew) host = this.renderPickers(box);
    const input = box.createEl("textarea", { cls: "aos-ss-input", attr: { rows: "3", placeholder: isNew ? "What should the agent do?" : "Reply…" } });
    input.value = this.text;
    input.addEventListener("input", () => { this.text = input.value; });
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void this.submit(); }
    });
    const foot = box.createDiv({ cls: "aos-ss-foot" });
    if (host === "claude") {
      const allow = foot.createEl("label", { cls: "aos-ss-allow" });
      const box2 = allow.createEl("input", { attr: { type: "checkbox" } });
      box2.checked = this.draft.allowCommands;
      box2.addEventListener("change", () => { this.draft.allowCommands = box2.checked; });
      allow.appendText("Allow commands");
    } else if (host === "codex") {
      foot.createSpan({ cls: "aos-ss-sandbox", text: CODEX_SANDBOX_NOTE });
    }
    if (this.composerError) foot.createDiv({ cls: "aos-ss-composererror", text: this.composerError });
    const running = !isNew && turnOpen(this.events);
    const send = foot.createEl("button", { cls: "mod-cta aos-ss-send", text: this.sending ? "Sending…" : "Send (⌘↵)" });
    send.disabled = this.sending || running || (isNew && (!this.draft.workspace || !host));
    send.addEventListener("click", () => void this.submit());
    input.disabled = this.sending;
  }

  /** The new session's workspace, host and model; returns the host it will run on. */
  private renderPickers(box: HTMLElement): SessionHost | null {
    const opts = box.createDiv({ cls: "aos-ss-opts" });
    const names = this.workspaces();
    if (!names.includes(this.draft.workspace)) this.draft.workspace = names[0] ?? "";
    if (names.length) {
      const sel = opts.createEl("select", { cls: "dropdown aos-ss-workspace", attr: { "aria-label": "Workspace" } });
      for (const n of names) sel.createEl("option", { text: n, value: n });
      sel.value = this.draft.workspace;
      sel.addEventListener("change", () => { this.draft.workspace = sel.value; });
    } else opts.createSpan({ cls: "aos-ss-note", text: "No workspaces yet: add a folder under workspaces/." });

    const choices = hostChoices(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.plugin.vaultRoot()));
    const ready = choices.filter((c) => c.ready).map((c) => c.host);
    if (!this.draft.host || !ready.includes(this.draft.host)) this.draft.host = ready[0] ?? null;
    const chips = opts.createDiv({ cls: "aos-ss-hosts" });
    for (const c of choices) {
      const b = chips.createEl("button", {
        cls: `aos-nt-chip aos-ss-hostchip${this.draft.host === c.host ? " is-active" : ""}`, text: c.label,
        attr: { "data-host": c.host, title: c.reason ?? `Run this session on ${c.label}` },
      });
      b.disabled = !c.ready;
      b.addEventListener("click", () => { this.draft.host = c.host; this.renderComposer(); });
    }
    if (!ready.length) opts.createSpan({ cls: "aos-ss-note", text: "No host is ready: aos init --host turns one on." });

    const model = opts.createEl("input", { cls: "aos-ss-modelinput", attr: { type: "text", placeholder: "Model (optional)", "aria-label": "Model", spellcheck: "false" } });
    model.value = this.draft.model;
    model.addEventListener("input", () => { this.draft.model = model.value; });
    return this.draft.host;
  }
}
