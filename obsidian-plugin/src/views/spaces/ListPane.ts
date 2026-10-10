// ListPane.ts — the left pane (spaces-redesign D4): the search, + New (Code's New workspace sheet until PR 3), the
// groups PINNED / ACTIVE / STALLED / IDLE as disclosure buttons, rows as options with aria-selected, the hidden toggle
// and the "Outside workspaces (n)" footer; and the outside list it opens in the centre (D21, the PR 2 stand-in: read
// only, no move command).
import { groupOf, hiddenToggleText, spaceList, spaceRow } from "../../data/spacesModel";
import type { WorkspaceEntry } from "../../data/snapshot";
import { outsideGroups, sessionsTitle, type OutsideListRow } from "../../data/hostSessions";
import { arrowKeys, button, hostDot, keepPlace, statusDot, type SpacesCtx } from "./ui";

/** The outside rows drawn per group before "Show all n": the runtime lists every start folder, windowed or not. */
export const OUTSIDE_SHOWN = 100;

export function renderList(host: HTMLElement, ctx: SpacesCtx): void {
  const head = host.createDiv({ cls: "aos-spc-listhead" });
  const top = head.createDiv({ cls: "aos-spc-listtop" });
  top.createEl("h2", { cls: "aos-spc-h2", text: "Spaces" });
  const visible = ctx.entries.filter((e) => !e.hidden).length;
  top.createSpan({ cls: "aos-spc-count", text: String(visible), attr: { title: `${visible} workspace${visible === 1 ? "" : "s"}` } });
  top.createSpan({ cls: "aos-spc-grow" });
  const nb = button(top, "aos-spc-btn aos-spc-newbtn", null, { key: "new", title: "New workspace: opens Code's New workspace sheet (⇧⌘N)" });
  const newIco = nb.createSpan({ cls: "aos-spc-ico" });
  ctx.setIcon(newIco, "plus");
  nb.createSpan({ text: "New" });
  nb.addEventListener("click", () => ctx.act.newWorkspace());

  const search = head.createEl("label", { cls: "aos-spc-search" });
  const searchIco = search.createSpan({ cls: "aos-spc-ico aos-spc-searchico" });
  ctx.setIcon(searchIco, "search");
  const input = search.createEl("input", {
    cls: "aos-spc-q",
    attr: { type: "search", "aria-label": "Filter workspaces", placeholder: "Filter by name, branch, next step…", "data-spc-key": "q", spellcheck: "false" },
  });
  input.value = ctx.ui.query;

  const body = host.createDiv({ cls: "aos-spc-listbody", attr: { "data-spc-scroll": "list" } });
  // The filter and the group toggles redraw only the rows, keeping the focused row or group and the scroll.
  const drawBody = (): void => keepPlace(body, () => { body.empty(); renderGroups(body, ctx, drawBody); });
  drawBody();
  // One Tab stop for the rows (the listbox pattern): the selected row, else the first; it follows the focus.
  body.addEventListener("focusin", (ev) => {
    const r = (ev.target as HTMLElement | null)?.closest?.(".aos-spc-row");
    if (!r) return;
    for (const x of Array.from(body.querySelectorAll<HTMLElement>(".aos-spc-row"))) x.setAttribute("tabindex", x === r ? "0" : "-1");
  });
  input.addEventListener("input", () => { ctx.ui.query = input.value; drawBody(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; ctx.ui.query = ""; drawBody(); }
    if (e.key === "ArrowDown") { e.preventDefault(); body.querySelector<HTMLElement>(".aos-spc-row")?.focus(); }
  });
  arrowKeys(body, ".aos-spc-row, .aos-spc-ghead");

  renderFooter(host, ctx);
}

function renderGroups(body: HTMLElement, ctx: SpacesCtx, redraw: () => void): void {
  if (!ctx.loaded) { body.createDiv({ cls: "aos-spc-empty", text: "Reading the vault's scan…" }); return; }
  const list = spaceList(ctx.entries, { query: ctx.ui.query, showHidden: ctx.ui.showHidden });
  if (!list.total && !list.groups.length) {
    body.createDiv({ cls: "aos-spc-empty", text: ctx.snapshot ? "No workspaces yet: + New makes one." : "No scan yet: the list fills in after the vault's first scan." });
    return;
  }
  if (!list.groups.length) { body.createDiv({ cls: "aos-spc-empty", text: `Nothing matches “${ctx.ui.query.trim()}”.` }); return; }
  const typed = !!ctx.ui.query.trim();
  for (const g of list.groups) {
    // A typed filter opens every group; a folded group (IDLE, the hidden one) opens when it holds the selection.
    const open = typed ? true : ctx.ui.groupOpen.get(g.key) ?? (!g.collapsed || g.entries.some((e) => e.name === ctx.ui.selected));
    const id = `aos-spc-group-${g.key}`;
    // While a filter is typed every group shows open and a click does nothing: say so rather than look clickable.
    const hb = button(body, "aos-spc-ghead", null, {
      key: `group:${g.key}`, title: typed ? "A filter shows every group" : null,
      attr: { "aria-expanded": String(open), "aria-controls": id, ...(typed ? { "aria-disabled": "true" } : {}) },
    });
    const chev = hb.createSpan({ cls: "aos-spc-chev" });
    ctx.setIcon(chev, open ? "chevron-down" : "chevron-right");
    hb.createSpan({ cls: "aos-spc-glabel", text: g.label });
    hb.createSpan({ cls: "aos-spc-gcount", text: String(g.entries.length) });
    hb.addEventListener("click", () => {
      if (typed) return;   // a typed filter shows every group open
      ctx.ui.groupOpen.set(g.key, !open);
      redraw();
    });
    const rows = body.createDiv({ cls: "aos-spc-rows", attr: { id, role: "listbox", "aria-label": g.label.toLowerCase() } });
    if (!open) { rows.hidden = true; continue; }
    for (const e of g.entries) renderRow(rows, ctx, e);
  }
  const rows = Array.from(body.querySelectorAll<HTMLElement>(".aos-spc-row"));
  (rows.find((x) => x.classList.contains("is-selected")) ?? rows[0])?.setAttribute("tabindex", "0");
}

function renderRow(parent: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const r = spaceRow(e, { live: ctx.live, counts: ctx.counts.get(e.name) ?? null, now: ctx.now });
  const sel = ctx.ui.selected === e.name;
  const b = button(parent, `aos-spc-row${sel ? " is-selected" : ""}`, null, {
    key: `row:${e.name}`, attr: { role: "option", "aria-selected": String(sel), "data-workspace": e.name, tabindex: "-1" },
  });
  const top = b.createSpan({ cls: "aos-spc-rowtop" });
  statusDot(top, r.status);
  top.createSpan({ cls: "aos-spc-rowname", text: r.label });
  if (e.hidden) top.createSpan({ cls: "aos-spc-tag", text: e.hiddenReason === "archived" ? "archived" : "_ folder" });
  // The status word where the group heading does not say it (D4: paused and done sit in IDLE "with their pill"; PINNED
  // holds every status), so a status never rests on the dot's colour alone (D19). The dot's label already reads it.
  const word = r.status.word;
  if (!e.hidden && (word === "paused" || word === "done" || (groupOf(e) === "pinned" && word !== "active"))) {
    top.createSpan({ cls: "aos-spc-tag aos-spc-statustag", text: word, attr: { "aria-hidden": "true" } });
  }
  if (r.live) top.createSpan({ cls: "aos-spc-live", text: "live", attr: { title: r.live.title } });
  if (r.age) {
    // The glyph-short text is hidden from the row's accessible name; a full phrase stands in for it.
    top.createSpan({ cls: `aos-spc-age${r.ageTone ? " is-warn" : ""}`, text: r.age, attr: { title: `Last active ${r.age} ago`, "aria-hidden": "true" } });
    top.createSpan({ cls: "aos-spc-sr", text: `last active ${r.age} ago` });
  }

  const meta = b.createSpan({ cls: "aos-spc-rowmeta" });
  meta.createSpan({ cls: `aos-spc-git${r.git.tone ? ` is-${r.git.tone}` : ""}`, text: r.git.text });
  const windowTitle = sessionsTitle(e.sessions, ctx.now);
  for (const h of r.hosts) {
    const s = meta.createSpan({ cls: "aos-spc-hostcount", attr: { title: windowTitle ?? `${h.count} ${h.host === "claude" ? "Claude Code" : "Codex"} session${h.count === 1 ? "" : "s"}` } });
    hostDot(s, h.host);
    s.appendText(`${h.host} ${h.count}`);
  }

  if (r.line || r.todos || r.proposals) {
    const line = b.createSpan({ cls: "aos-spc-rowline" });
    line.createSpan({ cls: `aos-spc-rownext${r.lineKind === "none" ? " is-empty" : ""}`, text: r.line });
    const count = (glyph: string, n: number, said: string) => {
      line.createSpan({ cls: "aos-spc-rowcount", text: `${glyph} ${n}`, attr: { title: said, "aria-hidden": "true" } });
      line.createSpan({ cls: "aos-spc-sr", text: said });
    };
    if (r.todos) count("☐", r.todos, `${r.todos} open to-do${r.todos === 1 ? "" : "s"} tagged for this workspace`);
    if (r.proposals) count("◇", r.proposals, `${r.proposals} pending proposal${r.proposals === 1 ? "" : "s"} about this workspace`);
  }
  b.addEventListener("click", () => ctx.act.select(e.name));
}

function renderFooter(host: HTMLElement, ctx: SpacesCtx): void {
  const hs = ctx.snapshot?.hostSessions;
  const out = outsideGroups(hs?.outsideWorkspaces, ctx.now, ctx.home, hs?.windowDays ?? null);
  const hidden = ctx.entries.filter((e) => e.hidden).length;
  if (!out.total && !hidden) return;
  const foot = host.createDiv({ cls: "aos-spc-listfoot" });
  if (out.total) {
    const on = ctx.ui.centre === "outside";
    const b = button(foot, `aos-spc-outbtn${on ? " is-on" : ""}`, null, {
      key: "outside", title: "Folders where Claude Code or Codex sessions ran outside every workspace", attr: { "aria-pressed": String(on) },
    });
    b.createSpan({ cls: "aos-spc-outlabel", text: `Outside workspaces (${out.total})` });
    b.createSpan({ cls: "aos-spc-grow" });
    const outChev = b.createSpan({ cls: "aos-spc-chev" });
    ctx.setIcon(outChev, "chevron-right");
    b.addEventListener("click", () => ctx.act.showOutside(!on));
  }
  if (hidden) {
    // The label says what a click does next ("Show…" / "Hide…"), so it carries no aria-pressed as well.
    const t = button(foot, "aos-spc-hiddenbtn", ctx.ui.showHidden ? "Hide archived and _ folders" : hiddenToggleText(hidden), { key: "hidden" });
    // Hiding them again moves the selection off a hidden entry: reselect() checks it before the redraw.
    // Showing them opens their group (it starts folded, D4).
    t.addEventListener("click", () => {
      ctx.ui.showHidden = !ctx.ui.showHidden;
      if (ctx.ui.showHidden) ctx.ui.groupOpen.set("hidden", true);
      ctx.act.reselect();
    });
  }
}

// ── the outside list, in the centre (D21; PR 2 reads it, PR 3 adds Adopt and Hide) ──

export function renderOutside(host: HTMLElement, ctx: SpacesCtx): void {
  const hs = ctx.snapshot?.hostSessions;
  const days = hs?.windowDays ?? null;
  const out = outsideGroups(hs?.outsideWorkspaces, ctx.now, ctx.home, days);
  const head = host.createEl("header", { cls: "aos-spc-head" });
  const t = head.createDiv({ cls: "aos-spc-titlebar" });
  t.createEl("h1", { cls: "aos-spc-h1", text: "Outside workspaces", attr: { tabindex: "-1", "data-spc-key": "outside-title" } });
  t.createSpan({ cls: "aos-spc-count", text: String(out.total) });
  t.createSpan({ cls: "aos-spc-grow" });
  const close = button(t, "aos-spc-btn", ctx.entry ? `Back to ${ctx.entry.label || ctx.entry.name}` : "Close", { key: "outside-close" });
  close.addEventListener("click", () => ctx.act.showOutside(false));
  head.createDiv({
    cls: "aos-spc-lede",
    text: `Folders where Claude Code or Codex sessions ran${days ? ` in the last ${days} days` : ""}, outside every workspace. Nothing here moves a folder.`,
  });
  const body = host.createDiv({ cls: "aos-spc-body" });
  if (!out.total) { body.createDiv({ cls: "aos-spc-empty", text: "No sessions ran outside a workspace." }); return; }
  // A table only where it has rows: with every folder gone, a line says so above VANISHED instead of a bare header.
  if (out.present.length) outsideTable(body, ctx, out.present, null);
  else body.createEl("p", { cls: "aos-spc-emptyval", text: "None of these folders is still on disk." });
  if (out.vanished.length) outsideTable(body, ctx, out.vanished, `Vanished (${out.vanished.length})`);
}

function outsideTable(parent: HTMLElement, ctx: SpacesCtx, rows: OutsideListRow[], heading: string | null): void {
  const sec = parent.createEl("section", { cls: "aos-spc-outside", attr: { "aria-label": heading ?? "Folders" } });
  if (heading) sec.createEl("h3", { cls: "aos-spc-h3", text: heading.toUpperCase() });
  const table = sec.createEl("table", { cls: "aos-spc-outtable" });
  const hr = table.createEl("thead").createEl("tr");
  for (const h of ["Folder", "Sessions", "Last active", "Matches", "Git"]) hr.createEl("th", { text: h, attr: { scope: "col" } });
  const tb = table.createEl("tbody");
  // The runtime lists every distinct start folder (collectors/hostSessions.js): draw the first OUTSIDE_SHOWN of a group
  // until "Show all n" asks for the rest, so a long-lived machine does not rebuild hundreds of rows on every redraw.
  const shown = ctx.ui.outsideAll ? rows : rows.slice(0, OUTSIDE_SHOWN);
  for (const r of shown) {
    const tr = tb.createEl("tr", { cls: r.exists ? "" : "is-gone" });
    const path = tr.createEl("td", { cls: "aos-spc-outpath", attr: { title: r.cwd } });
    path.createSpan({ cls: "aos-spc-outname", text: r.label });
    if (!r.exists) path.createSpan({ cls: "aos-spc-tag", text: "gone" });
    const s = tr.createEl("td", { cls: "aos-spc-outhosts" });
    if (r.claude) { const c = s.createSpan({ cls: "aos-spc-hostcount" }); hostDot(c, "claude"); c.appendText(`claude ${r.claude}`); }
    if (r.codex) { const c = s.createSpan({ cls: "aos-spc-hostcount" }); hostDot(c, "codex"); c.appendText(`codex ${r.codex}`); }
    if (!r.claude && !r.codex) s.createSpan({ cls: "aos-spc-dim", text: r.chip });
    tr.createEl("td", { cls: "aos-spc-mono aos-spc-outage", text: r.age || "—", attr: r.lastAt ? { title: r.lastAt } : {} });
    const m = tr.createEl("td", { cls: "aos-spc-outmatch" });
    const match = r.match ? ctx.entries.find((e) => e.name === r.match) ?? null : null;
    if (match) {
      const b = button(m, "aos-spc-linkbtn", match.label || match.name, { key: `outside-match:${r.cwd}`, title: `A workspace with this folder's name: open ${match.name}` });
      b.addEventListener("click", () => ctx.act.showOutside(false, match.name));
    } else m.createSpan({ cls: "aos-spc-dim", text: r.match ?? "—" });
    const g = tr.createEl("td", { cls: "aos-spc-mono aos-spc-outgit", text: r.git ?? "—", attr: r.gitRoot ? { title: r.gitRoot } : {} });
    if (!r.git) g.addClass("aos-spc-dim");
  }
  if (shown.length < rows.length) {
    const more = button(sec, "aos-spc-linkbtn aos-spc-more", `Show all ${rows.length}`, { key: `outside-more:${heading ?? ""}`, title: `${rows.length - shown.length} more folders` });
    more.addEventListener("click", () => { ctx.ui.outsideAll = true; ctx.act.redraw(["centre"]); });
  }
}
