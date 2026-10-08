// termGroups.ts — the Term deck's list (spec 2026-10-08-term-agent-deck T1). Pure: terminals grouped by where they run,
// each group in order of the last launch there (as Sessions orders its workspaces), with the vault, home and other
// folders last; each row's end state; and the filter.
import type { Place, TermHost } from "./terminalLaunch";

export interface TermRowInput {
  id: string;
  host: TermHost;
  title: string;
  place: Place;
  origin: string | null;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

export type RowEnd = "running" | "done" | "failed";

export interface TermRow extends TermRowInput { end: RowEnd; endText: string | null }
export interface TermGroup { key: string; label: string; kind: Place["kind"]; place: Place; rows: TermRow[] }

/** A place's group key: a workspace's name (Scratch included), the vault, home, or the folder itself. */
export function groupKey(p: Place): string {
  if (p.workspace) return `ws:${p.workspace}`;
  if (p.kind === "vault" || p.kind === "home") return p.kind;
  return `dir:${p.dir}`;
}

/** How a row ended: still running, Done (exit 0), or Exited n. */
export function rowEnd(r: Pick<TermRowInput, "exited" | "exitCode">): { end: RowEnd; endText: string | null } {
  if (!r.exited) return { end: "running", endText: null };
  return r.exitCode ? { end: "failed", endText: `Exited ${r.exitCode}` } : { end: "done", endText: "Done" };
}

const LAST: Record<string, number> = { vault: 1, home: 2, other: 3 };

/** The groups: workspaces and Scratch by their newest launch, then the vault, home and other folders; rows newest first. */
export function groupTerminals(rows: TermRowInput[], filter = ""): TermGroup[] {
  const q = filter.trim().toLowerCase();
  const by = new Map<string, TermGroup>();
  for (const r of rows) {
    if (q && !`${r.title}\n${r.place.label}\n${r.origin ?? ""}`.toLowerCase().includes(q)) continue;
    const key = groupKey(r.place);
    const g = by.get(key) ?? { key, label: r.place.label, kind: r.place.kind, place: r.place, rows: [] };
    g.rows.push({ ...r, ...rowEnd(r) });
    by.set(key, g);
  }
  const newest = (g: TermGroup) => Math.max(...g.rows.map((r) => r.startedAt));
  for (const g of by.values()) g.rows.sort((a, b) => b.startedAt - a.startedAt);
  return [...by.values()].sort((a, b) => {
    const la = LAST[a.kind] ?? 0;
    const lb = LAST[b.kind] ?? 0;
    return la !== lb ? la - lb : newest(b) - newest(a);
  });
}

/** The next or previous row in list order (⇧⌘] / ⇧⌘[), wrapping; null with no rows. */
export function stepRow(groups: TermGroup[], current: string | null, dir: 1 | -1): string | null {
  const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
  if (!ids.length) return null;
  const i = current ? ids.indexOf(current) : -1;
  return ids[(i + dir + ids.length) % ids.length] ?? ids[0];
}
