// hostSessions.ts — formatting for the per-workspace session counts the runtime's
// collectors/hostSessions.js attaches to the snapshot (workspace hub spec D5). Pure, so node:test can load it.
import * as os from "os";
import type { HostSessionsOutside, WorkspaceSessions } from "./snapshot";

export function agoLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const d = Math.floor((now - t) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

/** "claude 12 · codex 3 · 2d ago", omitting a host with no sessions; null when there were none at all. */
export function sessionsChip(s: WorkspaceSessions | undefined | null, now: number = Date.now()): string | null {
  if (!s || !(s.claude || s.codex)) return null;
  const parts: string[] = [];
  if (s.claude) parts.push(`claude ${s.claude}`);
  if (s.codex) parts.push(`codex ${s.codex}`);
  parts.push(agoLabel(s.lastAt, now));
  return parts.join(" · ");
}

export function shortenCwd(cwd: string, home: string = os.homedir()): string {
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}

export interface OutsideRow { cwd: string; label: string; chip: string }

/** The footer rows: newest first (the runtime sorts), capped, with a ~-shortened path. */
export function outsideRows(list: HostSessionsOutside[] | undefined | null, limit = 8, now: number = Date.now(), home: string = os.homedir()): OutsideRow[] {
  return (list ?? []).slice(0, limit).map((o) => ({
    cwd: o.cwd,
    label: shortenCwd(o.cwd, home),
    chip: sessionsChip({ claude: o.claude, codex: o.codex, total: o.total, lastAt: o.lastAt }, now) ?? agoLabel(o.lastAt, now),
  }));
}
