// BoardPane.ts — the Agent Teams tab's Work board (spec 2026-09-28-agent-teams-design §4.4): one column per stage, an
// item's detail, and the gate card the "Needs you" strip shares. Approve and budget changes go through `aos team` with
// the rendered row's ts as --expect (D3); Redirect opens the lead in the terminal to take the user's note (D10).
import {
  Team, BoardItem, GateCard, boardColumns, itemTone, isBudgetGate, budgetFloor, budgetPresets, stepBudget, gatePitch, pendingGates,
  channelView, runTone, usd, titleCase,
} from "../../data/teams";
import { approveArgs, budgetArgs } from "../../data/teamWriter";
import { TeamsCtx, itemKey, statusChip, errorLine, postRow, mentionText, since, hostButtons, redirectCommand, HOST_LABEL } from "./ui";

/** The pending gate the user decides: context, the budget for a gate that funds work, Approve and Redirect. */
export function renderGateCard(parent: HTMLElement, ctx: TeamsCtx, card: GateCard, { showTeam }: { showTeam: boolean }): void {
  const { team: t, item: it } = card;
  const key = `gate:${t.id}:${it.id}`;
  const busy = ctx.busy(key);
  const gate = titleCase(it.gate?.name ?? "");
  const el = parent.createDiv({ cls: `aos-at-gate${busy ? " is-busy" : ""}`, attr: { "aria-label": `${gate} gate on ${it.id}` } });

  const head = el.createDiv({ cls: "aos-at-gatehead" });
  if (showTeam) head.createSpan({ cls: "aos-at-teamtag", text: t.name });
  const id = head.createEl("a", { cls: "aos-at-itemid", text: it.id, href: "#", attr: { title: "show on the board" } });
  id.addEventListener("click", (e) => { e.preventDefault(); ctx.select(t.id, "board", it.id); });
  if (it.title) head.createSpan({ cls: "aos-at-itemtitle", text: it.title });

  const meta = el.createDiv({ cls: "aos-at-gatemeta" });
  meta.createSpan({ cls: "aos-at-gatename", text: `${gate} gate` });
  if (card.since) meta.createSpan({ cls: "aos-dim", text: `waiting ${since(card.since, ctx.now)}`, attr: { title: card.since } });
  meta.createSpan({ cls: "aos-dim", text: `${usd(it.budget.spentUsd)} spent${it.budget.usd ? ` of ${usd(it.budget.usd)}` : ""}${it.budget.codexRuns ? ` · ${it.budget.codexRuns} Codex run${it.budget.codexRuns === 1 ? "" : "s"}` : ""}` });

  if (card.pitch) {
    const pitch = el.createDiv({ cls: "aos-at-pitch" });
    pitch.createSpan({ cls: "aos-at-from is-lead", text: t.members.find((m) => m.id === card.pitch!.from)?.name ?? card.pitch.from });
    mentionText(pitch.createSpan({ cls: "aos-at-pitchtext" }), ` ${card.pitch.text}`, t);
  }

  let pick: number | null = null;
  if (card.budget) {
    const floor = budgetFloor(t, it);
    const presets = budgetPresets(it.budget.usd, t.budgetDefault);
    const proposal = it.budget.usd > 0 ? it.budget.usd : presets[1];
    const chosen = ctx.ui.gateUsd.get(itemKey(t, it)) ?? proposal;
    pick = chosen >= floor ? chosen : presets.find((p) => p >= floor) ?? Math.ceil(floor);
    const row = el.createDiv({ cls: "aos-at-budget", attr: { role: "group", "aria-label": "Phase budget" } });
    row.createSpan({ cls: "aos-at-label", text: "Budget" });
    const set = (n: number) => { ctx.ui.gateUsd.set(itemKey(t, it), n); ctx.render(); };
    for (const p of presets) {
      const b = row.createEl("button", {
        cls: `aos-at-preset${p === pick ? " is-active" : ""}`, text: `${usd(p)}${p === it.budget.usd ? " proposed" : ""}`,
        attr: { "aria-pressed": String(p === pick), title: p < floor ? `below the ${usd(floor)} already spent or held` : `approve with a ${usd(p)} phase budget` },
      });
      b.disabled = busy || p < floor;
      b.addEventListener("click", () => set(p));
    }
    stepper(row, pick, (dir) => stepBudget(pick!, dir, presets, floor), set, busy);
    if (floor > 0) row.createSpan({ cls: "aos-dim aos-at-floor", text: `at least ${usd(floor)}`, attr: { title: "spent so far, plus what live Claude runs hold" } });
  }

  const acts = el.createDiv({ cls: "aos-at-gateacts" });
  const approve = acts.createEl("button", { cls: "mod-cta aos-at-approve", text: busy ? "Recording…" : `Approve${pick != null ? ` · ${usd(pick)}` : ""}` });
  approve.disabled = busy;
  approve.addEventListener("click", () => {
    const lead = t.members.find((m) => m.id === t.lead);
    const budget = pick != null ? ` with a ${usd(pick)} phase budget (${usd(it.budget.spentUsd)} spent so far)` : "";
    void ctx.act(key, approveArgs(t.id, it, pick), {
      title: `Approve the ${gate} gate on ${it.id}?`,
      message: `${it.title ? `${it.title}. ` : ""}${it.id} moves on from ${it.stage}, and ${lead?.name ?? t.lead} takes the next step${budget}.`,
      cta: "Approve",
    });
  });
  hostButtons(acts, ctx, "Redirect", (h) => redirectCommand(ctx, t, it, h),
    (h) => `Opens ${t.members.find((m) => m.id === t.lead)?.name ?? "the lead"} in ${HOST_LABEL[h]}: say what should change, and the lead records the redirect`,
    "Redirect: enable a host to talk to the lead");
  errorLine(el, ctx.error(key));
}

/** − value + over the budget ladder; a side at its end is disabled. */
function stepper(parent: HTMLElement, value: number, next: (dir: -1 | 1) => number | null, set: (n: number) => void, busy: boolean): void {
  const wrap = parent.createSpan({ cls: "aos-at-stepper" });
  const btn = (dir: -1 | 1) => {
    const n = next(dir);
    const b = wrap.createEl("button", { cls: "aos-at-step", text: dir === -1 ? "−" : "+", attr: { "aria-label": n == null ? (dir === -1 ? "lowest amount" : "highest amount") : `${dir === -1 ? "lower" : "raise"} to ${usd(n)}` } });
    b.disabled = busy || n == null;
    b.addEventListener("click", () => { if (n != null) set(n); });
  };
  btn(-1);
  wrap.createSpan({ cls: "aos-at-stepvalue", text: usd(value), attr: { "aria-live": "polite" } });
  btn(1);
}

export function renderBoard(host: HTMLElement, ctx: TeamsCtx): void {
  const t = ctx.team;
  if (!t.board.length) {
    host.createDiv({ cls: "aos-at-emptyline aos-dim", text: `No work items yet. The lead adds them with aos team put: tell ${t.members.find((m) => m.id === t.lead)?.name ?? "the lead"} what to build in Interact.` });
    return;
  }
  const grid = host.createDiv({ cls: "aos-at-board" });
  for (const col of boardColumns(t)) {
    const c = grid.createDiv({ cls: "aos-at-col", attr: { role: "group", "aria-label": `${col.stage}: ${col.items.length} open` } });
    const head = c.createDiv({ cls: "aos-at-colhead" });
    head.createSpan({ text: col.stage.toUpperCase() });
    head.createSpan({ cls: "aos-dim", text: String(col.items.length) });
    if (t.gates.includes(col.stage)) head.createSpan({ cls: "aos-at-gatemark", text: "◆", attr: { title: `the ${col.stage} gate: you decide before an item leaves this stage` } });
    for (const it of col.items) card(c, ctx, t, it);
    if (col.done.length) {
      const k = `${t.id}/${col.stage}`;
      const shown = ctx.ui.showDone.has(k);
      const tog = c.createEl("button", { cls: "aos-at-donetoggle", text: shown ? `hide ${col.done.length} done` : `${col.done.length} done`, attr: { "aria-expanded": String(shown) } });
      tog.addEventListener("click", () => { if (shown) ctx.ui.showDone.delete(k); else ctx.ui.showDone.add(k); ctx.render(); });
      if (shown) for (const it of col.done) card(c, ctx, t, it);
    }
  }
  const open = t.board.find((i) => i.id === ctx.ui.openItem);
  if (open) detail(host, ctx, t, open);
}

function card(col: HTMLElement, ctx: TeamsCtx, t: Team, it: BoardItem): void {
  const open = ctx.ui.openItem === it.id;
  const live = t.live.filter((m) => m.item === it.id);
  const el = col.createDiv({
    cls: `aos-at-card${open ? " is-open" : ""}${it.status === "done" ? " is-done" : ""}${it.status === "gate" ? " is-gate" : ""}`,
    attr: { role: "button", tabindex: "0", "aria-expanded": String(open), "aria-label": `${it.id}${it.title ? `: ${it.title}` : ""}, ${it.status}` },
  });
  const top = el.createDiv({ cls: "aos-at-cardtop" });
  top.createSpan({ cls: "aos-at-itemid", text: it.id });
  statusChip(top, itemTone(it), it.status === "gate" && it.gate ? `${it.gate.name} gate` : it.status);
  if (it.title) el.createDiv({ cls: "aos-at-cardtitle", text: it.title, attr: { title: it.title } });
  const meta = el.createDiv({ cls: "aos-at-cardmeta aos-dim" });
  const names = it.owners.map((o) => t.members.find((m) => m.id === o)?.name ?? o);
  if (names.length) meta.createSpan({ text: names.join(", ") });
  if (it.budget.usd || it.budget.spentUsd) meta.createSpan({ cls: "aos-at-money", text: `${usd(it.budget.spentUsd)} / ${usd(it.budget.usd)}` });
  for (const m of live) {
    const run = el.createDiv({ cls: "aos-at-live", attr: { title: `running now: ${m.run}, started ${m.startedAt ?? "?"}` } });
    run.createSpan({ cls: "aos-at-livedot" });
    run.createSpan({ text: `${t.members.find((x) => x.id === m.member)?.name ?? m.member} · ${m.provider ?? "?"} · ${since(m.startedAt, ctx.now)}` });
  }
  const toggle = () => { ctx.ui.openItem = open ? null : it.id; ctx.render(); };
  el.addEventListener("click", toggle);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}

function detail(host: HTMLElement, ctx: TeamsCtx, t: Team, it: BoardItem): void {
  const d = host.createDiv({ cls: "aos-at-detail", attr: { "aria-label": `${it.id} detail` } });
  const head = d.createDiv({ cls: "aos-at-detailhead" });
  head.createSpan({ cls: "aos-at-itemid", text: it.id });
  if (it.title) head.createSpan({ cls: "aos-at-detailtitle", text: it.title });
  const close = head.createEl("button", { cls: "aos-at-close", text: "✕", attr: { "aria-label": "Close the detail" } });
  close.addEventListener("click", () => { ctx.ui.openItem = null; ctx.render(); });

  const facts = d.createEl("dl", { cls: "aos-at-facts" });
  const fact = (k: string, v: string) => { if (!v) return; facts.createEl("dt", { text: k }); facts.createEl("dd", { text: v }); };
  const raw = it.raw;
  fact("Stage", `${it.stage} · ${it.status}`);
  fact("Owner", it.owners.map((o) => t.members.find((m) => m.id === o)?.name ?? o).join(", ") || "none");
  if (it.gate) fact("Gate", `${it.gate.name} ${it.gate.state}${it.gate.by ? ` by ${it.gate.by}` : ""}${it.gate.note ? `: ${it.gate.note}` : ""}`);
  fact("Budget", `${usd(it.budget.spentUsd)} spent of ${usd(it.budget.usd)}${it.budget.codexRuns ? ` · ${it.budget.codexRuns} Codex run${it.budget.codexRuns === 1 ? "" : "s"}` : ""}`);
  const b = raw.builders as { claude?: unknown; codex?: unknown } | undefined;
  const built = b ? (["claude", "codex"] as const).map((h) => (Array.isArray(b[h]) && (b[h] as unknown[]).length ? `${h}: ${(b[h] as unknown[]).join(", ")}` : "")).filter(Boolean).join(" · ") : "";
  fact("Built by", built);
  fact("Project", [raw.project, raw.phase ? `phase ${String(raw.phase)}` : "", raw.path].filter((x) => typeof x === "string" && x).join(" · "));

  const card = pendingGates(t).find((x) => x.id === it.id);
  if (card) renderGateCard(d, ctx, { team: t, item: it, since: t.pendingSince[it.id] ?? null, pitch: gatePitch(t, it.id), budget: isBudgetGate(t, it) }, { showTeam: false });
  else if (it.status !== "done") budgetEditor(d, ctx, t, it);

  const posts = channelView(t, it.id, 6);
  if (posts.length) {
    d.createDiv({ cls: "aos-rt-subhead aos-dim", text: "LATEST POSTS" });
    const list = d.createDiv({ cls: "aos-at-posts" });
    for (const p of posts) postRow(list, t, p, ctx.now, false);
    const all = d.createEl("a", { cls: "aos-link", text: "All posts on this item in Interact", href: "#" });
    all.addEventListener("click", (e) => { e.preventDefault(); ctx.ui.channelItem = it.id; ctx.select(t.id, "interact"); });
  }
  const runs = t.runs.filter((r) => r.item === it.id).slice(-5).reverse();
  if (runs.length) {
    d.createDiv({ cls: "aos-rt-subhead aos-dim", text: "RUNS" });
    const table = d.createDiv({ cls: "aos-inv-table aos-at-runs" });
    for (const r of runs) {
      const row = table.createDiv({ cls: "aos-inv-row" });
      row.createSpan({ cls: "aos-at-runwho", text: t.members.find((m) => m.id === r.member)?.name ?? r.member });
      row.createSpan({ cls: "aos-dim", text: r.provider ?? "?" });
      statusChip(row, runTone(r.status), r.status);
      row.createSpan({ cls: "aos-at-money", text: r.usd == null ? "cost unknown" : `${usd(r.usd)}${r.provider === "codex" ? " est." : ""}` });
      row.createSpan({ cls: "aos-dim aos-at-runwhen", text: `${r.ms == null ? "?" : Math.round(r.ms / 60000)} min · ${since(r.ts, ctx.now)} ago`, attr: { title: r.ts } });
    }
  }
}

/** Set an open item's phase budget (the new total), never below spend plus live holds. */
function budgetEditor(parent: HTMLElement, ctx: TeamsCtx, t: Team, it: BoardItem): void {
  const key = `budget:${t.id}:${it.id}`;
  const busy = ctx.busy(key);
  const floor = budgetFloor(t, it);
  const cur = it.budget.usd;
  const chosen = ctx.ui.budgetUsd.get(itemKey(t, it)) ?? cur;
  const row = parent.createDiv({ cls: "aos-at-budget", attr: { role: "group", "aria-label": "Phase budget" } });
  row.createSpan({ cls: "aos-at-label", text: "Budget" });
  const set = (n: number) => { ctx.ui.budgetUsd.set(itemKey(t, it), n); ctx.render(); };
  stepper(row, chosen, (dir) => stepBudget(chosen, dir, cur > 0 ? [cur] : [], floor), set, busy);
  const apply = row.createEl("button", { cls: "aos-ws-action aos-at-btn", text: busy ? "Saving…" : chosen === cur ? "Set budget" : `Set to ${usd(chosen)}` });
  apply.disabled = busy || chosen === cur || chosen < floor;
  apply.addEventListener("click", () => void ctx.act(key, budgetArgs(t.id, it, chosen)).then((ok) => { if (ok) ctx.ui.budgetUsd.delete(itemKey(t, it)); }));
  if (it.status === "paused") row.createSpan({ cls: "aos-at-hint", text: "paused at its budget: raising it lets work resume" });
  else if (floor > 0) row.createSpan({ cls: "aos-dim aos-at-floor", text: `at least ${usd(floor)}` });
  errorLine(parent, ctx.error(key));
}
