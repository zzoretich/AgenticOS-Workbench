// orphanSweep.ts — port of dashboards/agent-runs.js:sweepOrphans.
//
// Run once on plugin load. Walks brain/_index/agent-runs/live/ for stale
// ndjson files (process died before endRun could clean up), synthesizes a
// crashed-status summary into runs.jsonl, and deletes the ndjson.
//
// Guards (tightened vs the server's sweep):
//   - Only sweep files older than ORPHAN_MIN_AGE_MS (5 min) to avoid racing
//     a freshly-started run whose header hasn't been flushed yet.
//   - Header pid must NOT be alive (process.kill(pid, 0) raises ESRCH).
//   - Skip files we can't read at all (treat as orphan but don't crash).

import * as fs from "fs";
import * as path from "path";

const ORPHAN_MIN_AGE_MS = 5 * 60 * 1000;

export interface OrphanSweepResult {
  swept: string[];           // ndjson basenames that were cleaned up
  skipped: number;           // present-but-not-orphan (alive pid, too young, unreadable…)
  errors: number;
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function sweepOrphans(vault: string): OrphanSweepResult {
  const out: OrphanSweepResult = { swept: [], skipped: 0, errors: 0 };
  const runsDir = path.join(vault, "brain/_index/agent-runs");
  const liveDir = path.join(runsDir, "live");
  const summaryLog = path.join(runsDir, "runs.jsonl");
  if (!fs.existsSync(liveDir)) return out;

  let names: string[];
  try { names = fs.readdirSync(liveDir); } catch { return out; }

  for (const name of names) {
    if (!name.endsWith(".ndjson")) continue;
    const abs = path.join(liveDir, name);

    // Age guard — skip files younger than 5min to avoid racing live runs.
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(abs).mtimeMs; }
    catch { out.errors++; continue; }
    if ((Date.now() - mtimeMs) < ORPHAN_MIN_AGE_MS) { out.skipped++; continue; }

    // Read header (first line) to fetch pid + identifying fields.
    let header: Record<string, unknown> | null = null;
    try {
      const head = fs.readFileSync(abs, "utf8").split("\n", 1)[0];
      header = JSON.parse(head);
    } catch { /* unreadable header — treat as orphan and synthesize what we can */ }

    if (header && isPidAlive(header.pid as number | undefined)) {
      out.skipped++;
      continue;
    }

    // Synthesize a crashed summary so the run shows up in the log.
    const id = (header && typeof header.id === "string" ? header.id : null) || name.replace(/\.ndjson$/, "");
    const startedAt = (header && typeof header.started_at === "string" ? header.started_at : null) || new Date(mtimeMs).toISOString();
    const summary = {
      id,
      script: (header && typeof header.script === "string" ? header.script : null) || "unknown",
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      duration_ms: null,
      cost_usd: null,
      turns: null,
      status: "crashed",
      prompt: header && typeof header.prompt === "string" ? header.prompt : null,
      reply: null,
      tool_count: 0,
      subagents: [],
      error: "process died before endRun",
    };

    try { fs.appendFileSync(summaryLog, JSON.stringify(summary) + "\n"); }
    catch (e) { console.warn("[agentic-os] orphanSweep appendFile:", e); out.errors++; continue; }
    try { fs.unlinkSync(abs); out.swept.push(name); }
    catch (e) { console.warn("[agentic-os] orphanSweep unlink:", e); out.errors++; }
  }

  return out;
}
