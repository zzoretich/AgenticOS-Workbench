import { Component, MarkdownRenderer, Notice, TFile } from "obsidian";
import type { DataAdapter, TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import {
  PROPOSALS_DIR, LEDGER_PATH, BACKLOG_PATH, CONFIRMATIONS_PATH, MIN_CONFIRMATIONS,
  Proposal, LedgerRecord, LedgerRates, BacklogEntry,
  isProposalFile, parseProposal, parseLedger, ledgerRates, historyRows, parseBacklog, parseConfirmations, ageDays,
} from "../data/proposals";

/** What Review in Claude types into a fresh Term session: the persona-flag-closer skill's trigger phrase. */
const REVIEW_COMMAND = 'claude "review persona flags"';
const WATCHED = [LEDGER_PATH, BACKLOG_PATH, CONFIRMATIONS_PATH];
const KIND_PILL: Record<string, string> = { self: "aos-pill-cyan", vault: "aos-pill-cyan", workflow: "aos-pill-green", product: "aos-pill-green" };
const EVENT_MARK: Record<string, [string, string]> = {
  approved: ["✓", "aos-text-green"], "auto-applied": ["✓", "aos-text-green"], verified: ["✓", "aos-text-green"],
  accepted: ["◇", "aos-text-cyan"], rejected: ["✗", "aos-text-rose"], regressed: ["✗", "aos-text-rose"],
  dismissed: ["–", "aos-dim"], "stale-dropped": ["–", "aos-dim"],
};
type Group = "pending" | "backlog" | "history";

async function readOr<T extends string | null>(a: DataAdapter, p: string, fallback: T): Promise<string | T> {
  try { return await a.read(p); } catch { return fallback; }
}
const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);

/**
 * PROPOSALS — the Chief of Staff's pending proposals, accepted backlog and ledger history (spec
 * 2026-09-22-todo-and-proposals-tabs D5/D6). Read-only: every decision goes through the
 * persona-flag-closer skill, reached with Review in Claude. Parsing lives in src/data/proposals.ts.
 */
export class ProposalsTab {
  private host: HTMLElement | null = null;
  private personaPresent = true;
  private proposals: Proposal[] = [];
  private ledger: LedgerRecord[] = [];
  private rates: LedgerRates | null = null;
  private backlog: BacklogEntry[] = [];
  private streak: Record<string, number> = {};
  private expanded = new Set<string>();
  private collapsed = new Set<Group>();
  private md: Component | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const hit = (p: string) => p === "persona" || p === PROPOSALS_DIR || p.startsWith(`${PROPOSALS_DIR}/`) || WATCHED.includes(p);
      const watch = (f: TAbstractFile, oldPath?: string) => { if (hit(f.path) || (oldPath !== undefined && hit(oldPath))) this.schedule(); };
      const vault = this.plugin.app.vault;
      this.view.registerEvent(vault.on("modify", (f) => watch(f)));
      this.view.registerEvent(vault.on("create", (f) => watch(f)));
      this.view.registerEvent(vault.on("delete", (f) => watch(f)));
      this.view.registerEvent(vault.on("rename", (f, oldPath) => watch(f, oldPath)));
    }
    void this.refresh();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    this.md?.unload();
    this.md = null;
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    const a = this.plugin.app.vault.adapter;
    this.personaPresent = await a.exists("persona");
    let names: string[] = [];
    try { names = (await a.list(PROPOSALS_DIR)).files.map((f) => f.split("/").pop() ?? "").filter(isProposalFile).sort(); } catch { /* no folder yet */ }
    const proposals: Proposal[] = [];
    for (const n of names) {
      try { proposals.push(parseProposal(n, await a.read(`${PROPOSALS_DIR}/${n}`))); } catch { /* removed between list and read */ }
    }
    this.proposals = proposals;
    this.ledger = parseLedger(await readOr(a, LEDGER_PATH, ""));
    this.rates = ledgerRates(this.ledger, new Date());
    this.backlog = parseBacklog(await readOr(a, BACKLOG_PATH, "")).reverse();   // the file is newest last
    this.streak = parseConfirmations(await readOr(a, CONFIRMATIONS_PATH, null));
    this.view.setBadge("proposals", this.proposals.length);
    this.render();
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("proposals")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    this.md?.unload();
    this.md = new Component();
    this.md.load();

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "PROPOSALS" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${this.proposals.length} pending · ${this.backlog.length} in backlog` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const review = actions.createEl("button", { cls: "aos-ws-action", text: "Review in Claude ❯_" });
    review.setAttr("title", `Opens a Term session in the vault running: ${REVIEW_COMMAND}`);
    review.addEventListener("click", () => this.view.runInTerm(REVIEW_COMMAND));

    if (!this.personaPresent) {
      host.createDiv({ cls: "aos-rt-note aos-dim", text: "The Chief of Staff isn't set up — run `aos persona` to create it." });
      return;
    }
    if (this.rates) {
      host.createDiv({
        cls: "aos-dim aos-pr-rates",
        text: `last ${this.rates.days} d · approval ${pct(this.rates.approvalRate)} · accept ${pct(this.rates.acceptRate)}`,
        attr: { title: "approved ÷ (approved + rejected) and accepted ÷ (accepted + dismissed), as `ledger.js summary` counts them" },
      });
    }

    const pending = this.group(host, "pending", `PENDING (${this.proposals.length})`);
    if (pending) {
      if (!this.proposals.length) pending.createDiv({ cls: "aos-inv-row aos-dim", text: "Nothing pending — the Chief of Staff files proposals from its reflect duties." });
      for (const p of this.proposals) this.renderProposal(pending, p);
    }
    const backlog = this.group(host, "backlog", `BACKLOG (${this.backlog.length})`);
    if (backlog) {
      if (!this.backlog.length) backlog.createDiv({ cls: "aos-inv-row aos-dim", text: "No accepted ideas yet — accepting a workflow or product proposal adds it here." });
      for (const b of this.backlog) this.renderBacklog(backlog, b);
    }
    const rows = historyRows(this.ledger);
    const history = this.group(host, "history", "HISTORY");
    if (history) {
      if (!rows.length) history.createDiv({ cls: "aos-inv-row aos-dim", text: "No decisions recorded yet." });
      for (const r of rows) this.renderHistory(history, r);
    }
  }

  /** A collapsible group; returns its table, or null while collapsed. */
  private group(host: HTMLElement, id: Group, label: string): HTMLElement | null {
    const open = !this.collapsed.has(id);
    const sub = host.createDiv({ cls: "aos-rt-subhead aos-dim aos-pr-grouphead" });
    sub.createSpan({ text: `${open ? "▾" : "▸"} ${label}` });
    sub.addEventListener("click", () => { if (open) this.collapsed.add(id); else this.collapsed.delete(id); this.render(); });
    return open ? host.createDiv({ cls: "aos-inv-table aos-rt-table" }) : null;
  }

  private renderProposal(table: HTMLElement, p: Proposal): void {
    const key = `p:${p.name}`;
    const open = this.expanded.has(key);
    const row = table.createDiv({ cls: "aos-inv-row aos-inv-row-clickable aos-pr-row" });
    row.createSpan({ cls: "aos-pr-caret aos-dim", text: open ? "▾" : "▸" });
    const name = row.createDiv({ cls: "aos-rt-name" });
    name.createDiv({ text: p.slug });
    name.createDiv({ cls: "aos-dim aos-rt-slug", text: p.target });
    row.createSpan({ cls: `aos-pill ${KIND_PILL[p.kind] ?? "aos-pill-dim"}`, text: p.kind });
    if (p.surface) row.createSpan({ cls: "aos-pill aos-pill-dim", text: p.surface });
    const age = ageDays(p.filed, new Date());
    row.createSpan({ cls: "aos-dim aos-pr-age", text: age === null ? p.filed : `${age}d`, attr: { title: `filed ${p.filed}` } });
    const n = this.streak[p.slug] ?? 0;
    if (n > 0) {
      row.createSpan({
        cls: `aos-pr-streak ${n >= MIN_CONFIRMATIONS ? "aos-text-green" : "aos-dim"}`, text: `confirmed ${n}d`,
        attr: { title: `the recheck recipe still found the finding on ${n} consecutive day(s); auto-apply needs ${MIN_CONFIRMATIONS}+ and a whitelisted class` },
      });
    }
    if (p.lint.length) row.createSpan({ cls: "aos-text-amber aos-pr-lint", text: `⚠ ${p.lint.length}`, attr: { title: p.lint.join("\n") } });
    row.addEventListener("click", () => { this.toggle(key); });
    if (!open) return;

    const d = table.createDiv({ cls: "aos-pr-detail" });
    const meta = d.createDiv({ cls: "aos-pr-meta" });
    meta.createDiv({ text: `needs: ${p.decision}` });
    if (p.recheck) meta.createDiv({ cls: "aos-dim" }).createEl("code", { text: p.recheck });
    if (p.autoapplyClass) meta.createDiv({ cls: "aos-dim", text: `auto-apply class: ${p.autoapplyClass}` });
    for (const l of p.lint) meta.createDiv({ cls: "aos-text-amber", text: `⚠ ${l}` });
    const body = [["What", p.what], ["Why", p.why], ["Risk", p.risk]].filter(([, v]) => v).map(([h, v]) => `#### ${h}\n\n${v}`).join("\n\n");
    if (body && this.md) void MarkdownRenderer.renderMarkdown(body, d.createDiv({ cls: "aos-pr-md" }), `${PROPOSALS_DIR}/${p.name}`, this.md);
    if (p.premises.length) {
      const pt = d.createDiv({ cls: "aos-pr-premises" });
      pt.createDiv({ cls: "aos-dim aos-rt-subhead", text: `PREMISES · ${p.premises.filter((x) => x.status === "VERIFIED").length} verified / ${p.premises.filter((x) => x.status === "ASSUMED").length} assumed` });
      for (const x of p.premises) {
        const r = pt.createDiv({ cls: "aos-pr-premise" });
        r.createSpan({ cls: `aos-pill ${x.status === "VERIFIED" ? "aos-pill-green" : "aos-pill-amber"}`, text: x.status });
        r.createSpan({ text: x.claim });
        r.createSpan({ cls: "aos-dim", text: x.evidence });
      }
    }
    const links = d.createDiv({ cls: "aos-rt-rowactions" });
    const openFile = links.createEl("a", { text: "Open file", cls: "aos-link", href: "#" });
    openFile.addEventListener("click", (e) => { e.preventDefault(); void this.openFile(`${PROPOSALS_DIR}/${p.name}`); });
  }

  private renderBacklog(table: HTMLElement, b: BacklogEntry): void {
    const key = `b:${b.slug}`;
    const open = this.expanded.has(key);
    const row = table.createDiv({ cls: "aos-inv-row aos-inv-row-clickable aos-pr-row" });
    row.createSpan({ cls: "aos-pr-caret aos-dim", text: open ? "▾" : "▸" });
    const name = row.createDiv({ cls: "aos-rt-name" });
    name.createDiv({ text: b.slug });
    if (b.target) name.createDiv({ cls: "aos-dim aos-rt-slug", text: b.target });
    row.createSpan({ cls: `aos-pill ${KIND_PILL[b.kind] ?? "aos-pill-dim"}`, text: b.kind });
    if (b.surface) row.createSpan({ cls: "aos-pill aos-pill-dim", text: b.surface });
    row.createSpan({ cls: "aos-dim aos-pr-age", text: b.accepted ? `accepted ${b.accepted}` : `filed ${b.filed}` });
    row.addEventListener("click", () => { this.toggle(key); });
    if (!open) return;
    const d = table.createDiv({ cls: "aos-pr-detail" });
    if (b.body && this.md) void MarkdownRenderer.renderMarkdown(b.body, d.createDiv({ cls: "aos-pr-md" }), BACKLOG_PATH, this.md);
    const links = d.createDiv({ cls: "aos-rt-rowactions" });
    const openFile = links.createEl("a", { text: "Open backlog", cls: "aos-link", href: "#" });
    openFile.addEventListener("click", (e) => { e.preventDefault(); void this.openFile(BACKLOG_PATH); });
  }

  private renderHistory(table: HTMLElement, r: LedgerRecord): void {
    const row = table.createDiv({ cls: "aos-inv-row aos-pr-row" });
    const [mark, cls] = EVENT_MARK[r.event] ?? ["·", "aos-dim"];
    row.createSpan({ cls: `aos-pr-mark ${cls}`, text: mark });
    row.createSpan({ cls: `aos-pr-event ${cls}`, text: r.event });
    row.createSpan({ cls: "aos-rt-name", text: r.slug });
    row.createSpan({ cls: `aos-pill ${KIND_PILL[r.kind] ?? "aos-pill-dim"}`, text: r.kind });
    row.createSpan({ cls: "aos-dim aos-pr-age", text: `${r.ts.slice(0, 10)}${r.by ? ` · ${r.by}` : ""}` });
    if (r.note) row.setAttr("title", r.note);
  }

  private toggle(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
    this.render();
  }

  private async openFile(p: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) { await this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    new Notice(`Cannot open: ${p}`);
  }
}
