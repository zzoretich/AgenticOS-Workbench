// hostSessions.ts — formatting for the per-workspace session counts the runtime's
// collectors/hostSessions.js attaches to the snapshot (workspace hub spec D5). Pure, so node:test can load it.
import type { HostSessionsOutside, WorkspaceSessions } from "./snapshot";
import { env } from "../host";

export function agoLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const d = Math.floor((now - t) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

/** The days the counts cover, or null for a snapshot written before they had a window (all-time counts). */
function windowOf(s: Pick<WorkspaceSessions, "windowDays">): number | null {
  const n = s.windowDays;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

const validIso = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(Date.parse(iso));

/**
 * "claude 12 · codex 3 · 2d ago", omitting a host with no sessions. Since spaces-redesign D34 the counts cover the last
 * `windowDays` days on both hosts, so a workspace whose sessions are all older reads "none in 30d · 45d ago" rather
 * than losing its chip. Null when there were none at all.
 */
export function sessionsChip(s: WorkspaceSessions | undefined | null, now: number = Date.now()): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.claude) parts.push(`claude ${s.claude}`);
  if (s.codex) parts.push(`codex ${s.codex}`);
  if (!parts.length) {
    const days = windowOf(s);
    if (days === null || !validIso(s.lastAt)) return null;
    parts.push(`none in ${days}d`);
  }
  parts.push(agoLabel(s.lastAt, now));
  return parts.join(" · ");
}

/** The chip's tooltip, naming the days its counts cover (spaces-redesign D34); null with no chip or no window. */
export function sessionsTitle(s: WorkspaceSessions | undefined | null, now: number = Date.now()): string | null {
  const days = s ? windowOf(s) : null;
  if (!s || days === null || sessionsChip(s, now) === null) return null;
  const newest = validIso(s.lastAt) ? `; the newest ${agoLabel(s.lastAt, now)}` : "";
  return `Sessions in the last ${days} days, both hosts: Claude Code ${s.claude || 0}, Codex ${s.codex || 0}${newest}`;
}

export function shortenCwd(cwd: string, home: string = env.homedir()): string {
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}

export interface OutsideRow { cwd: string; label: string; chip: string }

/**
 * The footer rows: newest first (the runtime sorts), capped, with a ~-shortened path. `windowDays` is the snapshot's
 * `hostSessions.windowDays`: outside counts cover the same days as a workspace's (spaces-redesign D34).
 */
export function outsideRows(list: HostSessionsOutside[] | undefined | null, limit = 8, now: number = Date.now(), home: string = env.homedir(), windowDays?: number | null): OutsideRow[] {
  return (list ?? []).slice(0, limit).map((o) => ({
    cwd: o.cwd,
    label: shortenCwd(o.cwd, home),
    chip: sessionsChip({ claude: o.claude, codex: o.codex, total: o.total, lastAt: o.lastAt, windowDays: windowDays ?? undefined }, now) ?? agoLabel(o.lastAt, now),
  }));
}
