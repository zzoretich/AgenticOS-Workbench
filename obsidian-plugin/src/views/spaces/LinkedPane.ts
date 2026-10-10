// LinkedPane.ts — LINKED in the right pane (spaces-redesign D10, D27): open to-dos tagged #ws/<slug>, proposals whose
// target or recheck names the workspace (pending), memory notes by workspace:, slug or a body mention; each row says
// how it links. Under it the footer links: Threads in Sessions → (off with the reason when Sessions is hidden, D32)
// and Terminals in Code →.
import type { WorkspaceEntry } from "../../data/snapshot";
import { LINKED_EMPTY_TEXT, SESSIONS_OFF_TEXT, type LinkedItem } from "../../data/spacesModel";
import { button, sectionHead, type SpacesCtx } from "./ui";

export function renderLinked(host: HTMLElement, ctx: SpacesCtx): void {
  const sec = host.createEl("section", { cls: "aos-spc-linked", attr: { "aria-labelledby": "aos-spc-linked-h" } });
  sectionHead(sec, "LINKED", { id: "aos-spc-linked-h", focusable: true });
  const l = ctx.linked;
  if (!l || l.empty) { sec.createEl("p", { cls: "aos-spc-emptyval", text: LINKED_EMPTY_TEXT }); return; }
  for (const g of l.groups) {
    if (!g.count) continue;
    const grp = sec.createDiv({ cls: `aos-spc-lgroup is-${g.kind}` });
    const gh = grp.createDiv({ cls: "aos-spc-lhead" });
    gh.createSpan({ cls: "aos-spc-lname", text: g.label });
    gh.createSpan({ cls: "aos-spc-mono aos-spc-dim", text: String(g.count) });
    for (const it of g.items) renderItem(grp, ctx, it);
  }
}

function renderItem(parent: HTMLElement, ctx: SpacesCtx, it: LinkedItem): void {
  const where = it.kind === "todo" ? "To-Do" : it.kind === "proposal" ? "Proposals" : "the memory note";
  const b = button(parent, `aos-spc-litem is-${it.kind}`, null, { key: `linked:${it.kind}:${it.key}`, title: `${it.howText}. Opens ${where}.` });
  b.createSpan({ cls: "aos-spc-lmark", attr: { "aria-hidden": "true" } });
  const body = b.createSpan({ cls: "aos-spc-lbody" });
  body.createSpan({ cls: "aos-spc-ltext", text: it.text });
  body.createSpan({ cls: "aos-spc-lhow", text: it.howText });
  if (it.tag) b.createSpan({ cls: "aos-spc-ltag", text: it.tag });
  b.addEventListener("click", () => {
    if (it.kind === "todo") ctx.act.openTab("todo");
    else if (it.kind === "proposal") ctx.act.openTab("proposals");
    else if (it.memory) ctx.act.openFile(it.memory.path);
  });
}

/** The right pane's footer (D10): Threads in Sessions →, Terminals in Code →. */
export function renderRightFooter(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const foot = host.createDiv({ cls: "aos-spc-rightfoot" });
  const s = button(foot, "aos-spc-linkbtn", "Threads in Sessions →", {
    key: "foot-sessions", disabled: !ctx.sessionsAvailable, title: ctx.sessionsAvailable ? `Sessions, showing ${e.name}'s threads` : SESSIONS_OFF_TEXT,
  });
  s.addEventListener("click", () => ctx.act.openSessions(null));
  if (!ctx.sessionsAvailable) foot.createSpan({ cls: "aos-spc-why", text: SESSIONS_OFF_TEXT });
  const c = button(foot, "aos-spc-linkbtn", "Terminals in Code →", { key: "foot-code", title: `Code, showing ${e.name}'s terminals` });
  c.addEventListener("click", () => ctx.act.openCode());
}
