// Reader + writer for brain/_index/promote-log.jsonl — the auto-promote audit trail.
// (written by brain/scripts/lib/promote-log.js — keep shapes in lockstep).
// Pure core (parseTrail) is importable from node:test without resolving the
// "obsidian" external; the App-taking functions below it are the only ones that
// touch the vault at runtime, via their `app` param.
import type { App } from "obsidian";
import type { MemoryType } from "./memoryWriter";

export const TRAIL_PATH = "brain/_index/promote-log.jsonl";

export type TrailAction = "written" | "reverted" | "edited" | "kept";

export interface TrailEntry {
  ts: string;
  session: string;
  action: TrailAction;
  slug: string;
  type: MemoryType;
  title: string;
}

// Mirrors promote-log.js's readTrail: reverse to newest-first then slice, skipping
// any line that doesn't parse as JSON (a torn append shouldn't sink the whole read).
export function parseTrail(raw: string, limit: number): TrailEntry[] {
  const rows: TrailEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as TrailEntry); } catch { /* corrupt line — skip */ }
  }
  return rows.reverse().slice(0, limit);
}

export function memoryFilePath(entry: Pick<TrailEntry, "type" | "slug">): string {
  return `brain/memory/${entry.type}/${entry.slug}.md`;
}

// ── IO (the only functions that touch Obsidian at runtime — via their `app` param) ──

export async function loadTrail(app: App, limit: number): Promise<TrailEntry[]> {
  try {
    const raw = await app.vault.adapter.read(TRAIL_PATH);
    return parseTrail(raw, limit);
  } catch (err) {
    console.error("[agentic-os] failed to load promote trail:", err);
    return [];
  }
}

// True while the memory file `entry` points at is still unreviewed — i.e. the
// PulseTab trail row should keep showing its keep/edit/revert links.
export async function isPendingReview(app: App, entry: Pick<TrailEntry, "type" | "slug">): Promise<boolean> {
  try {
    const raw = await app.vault.adapter.read(memoryFilePath(entry));
    return /^reviewed: false$/m.test(raw);
  } catch {
    return false; // file gone (reverted) or unreadable — nothing left to review
  }
}

// Reuses entry's own key order (ts, session, action, slug, type, title) — overriding
// ts/action in place keeps the jsonl shape identical to the script-side lib's
// appendTrail({ ts: new Date().toISOString(), ...entry }).
async function appendTrailRow(app: App, entry: TrailEntry, action: TrailAction): Promise<void> {
  const row: TrailEntry = { ...entry, ts: new Date().toISOString(), action };
  await app.vault.adapter.append(TRAIL_PATH, JSON.stringify(row) + "\n");
}

// Flip `reviewed: false` → `reviewed: true` in the memory file's frontmatter and
// record a `kept` trail line. Returns false (no-op — no flip, no trail append) if
// the file is already gone, e.g. a stale row race where "revert" was clicked
// elsewhere and this render's "keep" fires after. Unlike revertMemory's guard
// (which only gates the delete — stripIndexLine/appendTrailRow still run so a
// double-revert stays harmless), keepMemory's remaining steps are all wrong to
// run on a missing file, so this guard is an early return rather than a single
// gated call: a keep of nothing is not an audit event.
export async function keepMemory(app: App, entry: TrailEntry): Promise<boolean> {
  const path = memoryFilePath(entry);
  if (!(await app.vault.adapter.exists(path))) return false;
  const raw = await app.vault.adapter.read(path);
  const next = raw.replace(/^reviewed: false$/m, "reviewed: true");
  if (next !== raw) await app.vault.adapter.write(path, next);
  await appendTrailRow(app, entry, "kept");
  return true;
}

// Delete the memory file, strip its MEMORY.md index line, and record a `reverted`
// trail line. Reverted slugs are never re-written by auto-wrap — the script side's
// revertedSlugs() reads this same trail.
export async function revertMemory(app: App, entry: TrailEntry): Promise<void> {
  const path = memoryFilePath(entry);
  if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
  await stripIndexLine(app, path);
  await appendTrailRow(app, entry, "reverted");
}

// Records edit intent before the caller opens the memory file for hand-editing
// (PulseTab's "edit" link) — the plugin doesn't track the edit's outcome, only
// that a human intervened. Returns false (no trail append) if the file is
// already gone: the caller must not call openLinkText on a dead path either,
// since Obsidian's link-following resurrects an empty file at a missing target.
export async function editMemory(app: App, entry: TrailEntry): Promise<boolean> {
  const path = memoryFilePath(entry);
  if (!(await app.vault.adapter.exists(path))) return false;
  await appendTrailRow(app, entry, "edited");
  return true;
}

async function stripIndexLine(app: App, memoryPath: string): Promise<void> {
  const indexPath = "MEMORY.md";
  if (!(await app.vault.adapter.exists(indexPath))) return;
  const raw = await app.vault.adapter.read(indexPath);
  const marker = `(${memoryPath})`;
  const lines = raw.split("\n");
  const next = lines.filter((l) => !l.includes(marker));
  if (next.length !== lines.length) await app.vault.adapter.write(indexPath, next.join("\n"));
}
