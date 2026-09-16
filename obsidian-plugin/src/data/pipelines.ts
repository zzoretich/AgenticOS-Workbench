// Ledger reader + health classifier for brain/_index/pipelines.json
// (written by brain/scripts/lib/pipeline-report.js — keep shapes in lockstep).
// Pure core; the obsidian import below is TYPE-ONLY (erased at runtime) so
// node:test can import this module without resolving the "obsidian" external.
import type { App } from "obsidian";

export const PIPELINES_PATH = "brain/_index/pipelines.json";

export interface PipelineEntry {
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "ok" | "error";
  error: string | null;
  wrote: string[];
  counts: Record<string, number>;
  pid?: number;
}
export interface PipelineState { lastRun: PipelineEntry | null; history: PipelineEntry[]; }
export interface PipelinesFile { version: number; pipelines: Record<string, PipelineState>; }

export type PipelineHealth = "ok" | "stale" | "failed" | "died" | "never";
export interface PipelineStatus {
  name: string;
  health: PipelineHealth;
  label: string;   // short chip text, e.g. "SCAN ok 2m"
  detail: string;  // tooltip/expanded text incl. error message when failed/died
  entry?: PipelineEntry;
}

// staleAfterMs: null disables age-based staleness entirely (on-demand pipelines).
export interface ClassifyCfg { staleAfterMs: number | null; diedAfterMs: number; }

// Freshness windows per pipeline (how old an ok run may be before "stale").
// `null` means "never stale by age" — reserved for on-demand pipelines, where
// elapsed time carries no signal at all: nothing schedules them, so a quiet
// stretch means "no work to do", not "something is wrong".
const STALE_WINDOWS: Record<string, number | null> = {
  "scan-vault": 45 * 60_000,          // scan runs every 15 min while Obsidian is open
  "heartbeat-writer": 45 * 60_000,
  "session-summary": 24 * 60 * 60_000, // only runs when sessions run
  "auto-cost": 24 * 60 * 60_000,
  "auto-cost-backfill": 7 * 24 * 60 * 60_000,
  // file-map only runs when someone invokes brain/scripts/map-workspace.js, and
  // it has nothing to do while scan-vault reports 0 pending files. An age window
  // therefore flagged it permanently with no action that could ever clear it.
  // Genuine backlog surfaces instead as the Fix Queue's "N file(s) unmapped"
  // rows (fixQueue's mapPending), which is driven by real pending counts — and a
  // crashed or wedged run still classifies failed/died below.
  "file-map": null,
  "auto-wrap": 24 * 60 * 60_000,       // SessionEnd-driven — only runs when sessions run (P4)
  "build-brain-md": 45 * 60_000,       // scan-time compiler, same cadence as scan-vault (P4)
};
const DIED_AFTER_MS = 10 * 60_000;

export const EXPECTED_PIPELINES = [
  "scan-vault", "session-summary", "auto-cost", "heartbeat-writer", "file-map",
  "auto-wrap", "build-brain-md",
];

const SHORT: Record<string, string> = {
  "scan-vault": "SCAN", "session-summary": "WRAP", "auto-cost": "COST",
  "auto-cost-backfill": "BACKFILL", "heartbeat-writer": "STAFF", "file-map": "MAP",
  "auto-wrap": "AWRAP", "build-brain-md": "BRAIN",
};

function ago(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function classifyPipeline(
  name: string, state: PipelineState | undefined, nowMs: number, cfg?: Partial<ClassifyCfg>
): PipelineStatus {
  const short = SHORT[name] ?? name.toUpperCase();
  const last = state?.lastRun ?? null;
  if (!last) return { name, health: "never", label: `${short} —`, detail: `${name}: no recorded runs yet` };

  // Explicit undefined checks, not ??: a configured `null` window means "never
  // stale by age" and must not fall through to the default.
  const staleAfter: number | null =
    cfg?.staleAfterMs !== undefined ? cfg.staleAfterMs
      : name in STALE_WINDOWS ? STALE_WINDOWS[name]
        : 60 * 60_000;
  const diedAfter = cfg?.diedAfterMs ?? DIED_AFTER_MS;
  const startMs = Date.parse(last.startedAt);
  const age = nowMs - startMs;

  if (last.status === "running") {
    if (age > diedAfter) {
      return { name, health: "died", entry: last,
        label: `${short} died`,
        detail: `${name}: started ${ago(age)} ago and never finished — process likely killed mid-run` };
    }
    return { name, health: "ok", entry: last, label: `${short} running`, detail: `${name}: in flight (${ago(age)})` };
  }
  if (last.status === "error") {
    return { name, health: "failed", entry: last,
      label: `${short} failed`,
      detail: `${name}: ${last.error ?? "unknown error"} (${ago(age)} ago)` };
  }
  if (staleAfter !== null && age > staleAfter) {
    return { name, health: "stale", entry: last,
      label: `${short} stale ${ago(age)}`,
      detail: `${name}: last ok run ${ago(age)} ago — past its ${Math.round(staleAfter / 60_000)}m freshness window` };
  }
  return { name, health: "ok", entry: last, label: `${short} ok ${ago(age)}`, detail: `${name}: ok, ${ago(age)} ago` };
}

export function pipelineStatuses(file: PipelinesFile | null, nowMs: number): PipelineStatus[] {
  const known = new Set(EXPECTED_PIPELINES);
  const names = [...EXPECTED_PIPELINES];
  for (const n of Object.keys(file?.pipelines ?? {})) if (!known.has(n)) names.push(n);
  return names.map((n) => classifyPipeline(n, file?.pipelines?.[n], nowMs));
}

// ── IO (the only function that touches Obsidian at runtime — via its param) ──
export async function loadPipelines(app: App): Promise<PipelinesFile | null> {
  try {
    const raw = await app.vault.adapter.read(PIPELINES_PATH);
    const parsed = JSON.parse(raw) as PipelinesFile;
    return parsed && parsed.pipelines ? parsed : null;
  } catch (err) {
    console.error("[agentic-os] failed to load pipelines ledger:", err);
    return null;
  }
}
