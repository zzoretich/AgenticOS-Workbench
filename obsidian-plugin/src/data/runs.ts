import { App } from "obsidian";

export const RUNS_PATH = "brain/_index/agent-runs/runs.jsonl";

export interface AgentRun {
  id: string;
  script: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  cost_usd: number;
  turns: number;
  status: "ok" | "error" | string;
  prompt?: string;
  reply?: string;
  tool_count?: number;
  subagents?: unknown[];
  error?: string | null;
}

/** Parse JSONL lines into AgentRun[], silently skipping malformed lines. */
function parseRuns(lines: string[]): AgentRun[] {
  const out: AgentRun[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as AgentRun);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export async function loadRuns(app: App, limit = 50): Promise<AgentRun[]> {
  try {
    const raw = await app.vault.adapter.read(RUNS_PATH);
    const lines = raw.trim().split("\n").filter(Boolean);
    return parseRuns(lines.slice(-limit).reverse());
  } catch (err) {
    console.error("[agentic-os] failed to load runs:", err);
    return [];
  }
}

/**
 * Load every run whose started_at falls in the same calendar month (local time)
 * as `ref` (default: now), newest-first. Reads the full log rather than the
 * newest-N window, because a busy month can exceed loadRuns()'s cap and clip the
 * month-to-date total. Filtering by date keeps the result bounded to one month.
 */
export async function loadRunsForMonth(app: App, ref: Date = new Date()): Promise<AgentRun[]> {
  try {
    const raw = await app.vault.adapter.read(RUNS_PATH);
    const lines = raw.trim().split("\n").filter(Boolean);
    const y = ref.getFullYear();
    const m = ref.getMonth();
    const inMonth = parseRuns(lines).filter((r) => {
      if (!r.started_at) return false;
      const d = new Date(r.started_at);
      return d.getFullYear() === y && d.getMonth() === m;
    });
    return inMonth.reverse(); // newest-first, matching loadRuns()
  } catch (err) {
    console.error("[agentic-os] failed to load month runs:", err);
    return [];
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
