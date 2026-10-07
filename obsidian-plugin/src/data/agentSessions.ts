// agentSessions.ts — what the Sessions tab shows of an agent session (spec 2026-10-07-unidex-sessions S10, §4.2, §4.5).
// Pure: the threads grouped by workspace, a thread's events as timeline rows, a tool row's one line, a turn's footer,
// the repository card's summary, and which hosts the composer offers. The app's main runs the turns and keeps the
// threads; views/SessionsTab.ts reaches them through the HudHost (host.ts sessions and git).
import type { AgenticosJson, ProviderState, SessionHost } from "./aosConfig";
import { sessionHosts } from "./aosConfig";
import type { HostGitStatus, HostSessionEvent, HostSessionThread } from "../host";

export const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };
/** What the composer says in place of Allow commands on a Codex thread (spec S5). */
export const CODEX_SANDBOX_NOTE = "Codex runs commands in its sandbox";

/** Folder names under <vault>/workspaces a session may run in: not hidden (`.git`) and not the team worktrees (`_…`). */
export function workspaceNames(names: string[]): string[] {
  return names.filter((n) => !!n && !n.startsWith(".") && !n.startsWith("_")).sort((a, b) => a.localeCompare(b));
}

export interface ThreadGroup { workspace: string; threads: HostSessionThread[] }

/** Threads by workspace, newest first within each, and the workspace with the newest thread first. */
export function groupThreads(threads: HostSessionThread[]): ThreadGroup[] {
  const newest = (a: HostSessionThread, b: HostSessionThread) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0);
  const by = new Map<string, HostSessionThread[]>();
  for (const t of [...threads].sort(newest)) {
    const list = by.get(t.workspace) ?? [];
    list.push(t);
    by.set(t.workspace, list);
  }
  return [...by.entries()].map(([workspace, list]) => ({ workspace, threads: list }));
}

/** Dollars as the HUD shows them: four places under a cent, else two. */
export function usdText(usd: number): string {
  return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** A thread's line under its title in the list: turns and spend (Codex's is an estimate). */
export function threadMeta(t: HostSessionThread): string {
  const turns = `${t.turns} turn${t.turns === 1 ? "" : "s"}`;
  return t.usd > 0 ? `${turns} · ${t.host === "codex" ? "≈" : ""}${usdText(t.usd)}` : turns;
}

export interface ToolCall { name: string; toolKind: string; filePath: string | null; summary: string }

/** A tool row collapsed to one line: `kind · name · file`. */
export function toolLine(t: ToolCall): string {
  return [t.toolKind || "other", t.name, t.filePath].filter((s) => !!s).join(" · ");
}

export type TimelineRow =
  | { kind: "prompt"; turn: number; text: string }
  | { kind: "text"; turn: number; text: string }
  | { kind: "tool"; turn: number; key: string; tool: ToolCall; result: { ok: boolean; summary: string } | null }
  | { kind: "patch"; turn: number; files: { path: string; change: string }[] }
  | { kind: "error"; turn: number; message: string }
  | { kind: "done"; turn: number; ok: boolean; footer: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A turn's quiet footer: what it cost ("estimated" for Codex), its tokens, and whether it failed. */
export function doneFooter(done: HostSessionEvent, usage: HostSessionEvent | null): string {
  const usd = num(done.usd) ?? num(usage?.usd);
  const parts: string[] = [];
  if (done.ok !== true) parts.push("did not finish");
  parts.push(usd === null ? "no cost recorded" : `${usdText(usd)}${done.estimated === true ? " estimated" : ""}`);
  const tin = num(usage?.in);
  const tout = num(usage?.out);
  if (tin !== null || tout !== null) parts.push(`${(tin ?? 0).toLocaleString("en-US")} in · ${(tout ?? 0).toLocaleString("en-US")} out`);
  return parts.join(" · ");
}

/**
 * A thread's events as the rows its timeline draws: each tool with the result of the same id folded in, a turn's usage
 * folded into its footer, and the host's session id (resume bookkeeping) left out.
 */
export function timelineRows(events: HostSessionEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const tools = new Map<string, Extract<TimelineRow, { kind: "tool" }>>();
  const usage = new Map<number, HostSessionEvent>();
  events.forEach((e, i) => {
    const turn = typeof e.turn === "number" ? e.turn : 0;
    if (e.kind === "prompt") rows.push({ kind: "prompt", turn, text: str(e.text) });
    else if (e.kind === "text") rows.push({ kind: "text", turn, text: str(e.text) });
    else if (e.kind === "tool") {
      const id = str(e.id);
      const row: Extract<TimelineRow, { kind: "tool" }> = {
        kind: "tool", turn, key: `${turn}:${id || i}`, result: null,
        tool: { name: str(e.name), toolKind: str(e.toolKind), filePath: str(e.filePath) || null, summary: str(e.summary) },
      };
      if (id) tools.set(`${turn}:${id}`, row);
      rows.push(row);
    } else if (e.kind === "tool_result") {
      const row = tools.get(`${turn}:${str(e.id)}`);
      if (row) row.result = { ok: e.ok !== false, summary: str(e.summary) };
    } else if (e.kind === "patch") {
      const files = Array.isArray(e.files) ? (e.files as Array<Record<string, unknown>>).map((f) => ({ path: str(f?.path), change: str(f?.change) || "update" })) : [];
      rows.push({ kind: "patch", turn, files });
    } else if (e.kind === "usage") usage.set(turn, e);
    else if (e.kind === "error") rows.push({ kind: "error", turn, message: str(e.message) || str(e.error) || "error" });
    else if (e.kind === "done") rows.push({ kind: "done", turn, ok: e.ok === true, footer: doneFooter(e, usage.get(turn) ?? null) });
  });
  return rows;
}

/** Whether the thread's last turn is still running: it has a prompt and no `done` after it. */
export function turnOpen(events: HostSessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "done") return false;
    if (events[i].kind === "prompt") return true;
  }
  return false;
}

/**
 * `extra` appended to `base`, each record once. A thread is read from its file while its turn may still be sending
 * events; main writes a record before it sends it, so the two can overlap but never miss one.
 */
export function mergeEvents(base: HostSessionEvent[], extra: HostSessionEvent[]): HostSessionEvent[] {
  const seen = new Set(base.map((e) => JSON.stringify(e)));
  const out = [...base];
  for (const e of extra) {
    const k = JSON.stringify(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** A `git status --porcelain=v2` code in words. */
export function fileStatusLabel(code: string): string {
  if (code === "??") return "new";
  if (/U/.test(code) || code === "AA" || code === "DD") return "conflict";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

/** The repository card's first line. */
export function statusSummary(st: HostGitStatus): string {
  if (!st.repo) return "Not a git repository";
  const n = st.files.length;
  if (!n) return "No changes";
  return `${n} file${n === 1 ? "" : "s"} changed`;
}

export interface HostChoice { host: SessionHost; label: string; ready: boolean; reason: string | null }

/**
 * The hosts the composer offers, in a fixed order: one is ready when it is on in agenticos.json (aosConfig
 * sessionHosts) and its login is not known to be missing (the provider probe's cache). Off: disabled, with why.
 */
export function hostChoices(cfg: AgenticosJson | null, state: ProviderState | null): HostChoice[] {
  const on = sessionHosts(cfg);
  return (["claude", "codex"] as SessionHost[]).map((host) => {
    const label = HOST_LABEL[host];
    if (!on.includes(host)) return { host, label, ready: false, reason: `${label} is off on this machine` };
    if (state?.[host]?.loggedIn === false) return { host, label, ready: false, reason: `${label} is not logged in` };
    return { host, label, ready: true, reason: null };
  });
}
