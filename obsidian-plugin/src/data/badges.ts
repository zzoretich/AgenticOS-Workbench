// badges.ts — the rail's count badges (spec 2026-09-22-todo-and-proposals-tabs D7). Pure.
// WorkbenchView recomputes them on vault events whether or not the tab is mounted.
import { PROPOSALS_DIR, isProposalFile } from "./proposals";

/** Pending proposals among a listing of persona/proposals (vault paths or bare names). */
export function proposalBadge(paths: string[]): number {
  return paths.filter((p) => isProposalFile(p.split("/").pop() ?? "")).length;
}

/** Rail text for a count: "" hides the badge; anything past 99 reads "99+". */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(Math.floor(n));
}

/** Whether a vault event on `path` can change a badge. */
export function touchesBadges(path: string): boolean {
  return path === PROPOSALS_DIR || path.startsWith(`${PROPOSALS_DIR}/`);
}
