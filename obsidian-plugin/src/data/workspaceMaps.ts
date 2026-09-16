// Reader for brain/_index/workspace-maps/<name>.json (written by
// brain/scripts/collectors/fileMap.js — keep shapes in lockstep).
// Pure core; only loadWorkspaceMap/loadAllMaps touch Obsidian, via their param.
import type { App } from "obsidian";

export const MAPS_DIR = "brain/_index/workspace-maps";

export interface MapFile {
  path: string;
  desc: string | null;
  descAt: string | null;
  mtime: number;
  size: number;
  status: "new" | "changed" | "fresh";
}
export interface WorkspaceMap {
  workspace: string;
  generatedAt: string | null;
  files: MapFile[];
  pending: number;
}

export function mapStats(map: WorkspaceMap): { mapped: number; pending: number; total: number } {
  const total = map.files.length;
  const pending = map.files.filter((f) => f.desc === null || f.status !== "fresh").length;
  return { mapped: total - pending, pending, total };
}

export function filterFiles(map: WorkspaceMap, query: string): MapFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return map.files;
  return map.files.filter(
    (f) => f.path.toLowerCase().includes(q) || (f.desc ?? "").toLowerCase().includes(q)
  );
}

// ── IO ──
export async function loadWorkspaceMap(app: App, name: string): Promise<WorkspaceMap | null> {
  try {
    const raw = await app.vault.adapter.read(`${MAPS_DIR}/${name}.json`);
    const parsed = JSON.parse(raw) as WorkspaceMap;
    return parsed && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null; // missing map = not yet scanned; renders as "no map yet"
  }
}

export async function loadAllMaps(app: App, names: string[]): Promise<Record<string, WorkspaceMap | null>> {
  const out: Record<string, WorkspaceMap | null> = {};
  for (const n of names) out[n] = await loadWorkspaceMap(app, n);
  return out;
}
