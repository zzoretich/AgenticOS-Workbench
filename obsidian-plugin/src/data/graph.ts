import { App, TFile } from "obsidian";
import { DEFAULT_LAYOUT } from "./dailyNote";
import { classifyPath } from "./graphKinds";
import type { NodeKind } from "./graphKinds";
export type { NodeKind };

export interface GraphNode {
  id: string;
  path: string;
  label: string;
  kind: NodeKind;
  mtime: number;
  // simulation state
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
}

const LINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** @param layout dailyNote.layout from brain/config.json — daily notes under it become "session" nodes. */
export async function buildGraph(app: App, layout: string = DEFAULT_LAYOUT): Promise<Graph> {
  const files = app.vault.getMarkdownFiles();
  const nodes: GraphNode[] = [];
  const labelIndex = new Map<string, string>(); // lowercase label -> node id

  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const f of files) {
    const kind = classifyPath(f.path, layout);
    if (!kind) continue;
    // sessions: keep only last 30 days
    if (kind === "session" && f.stat.mtime < recentCutoff) continue;

    const label = makeLabel(f, kind);
    const id = f.path;
    nodes.push({
      id,
      path: f.path,
      label,
      kind,
      mtime: f.stat.mtime,
      x: 0, y: 0, vx: 0, vy: 0,
    });
    labelIndex.set(slugForMatch(f.basename), id);
    labelIndex.set(label.toLowerCase(), id);
  }

  // seed initial positions per cluster
  const clusters: Record<NodeKind, { cx: number; cy: number }> = {
    memory:  { cx:  0,   cy:  0   },
    pattern: { cx: 220,  cy: -150 },
    session: { cx: -220, cy: -150 },
    agent:   { cx:  0,   cy:  240 },
  };
  for (const n of nodes) {
    const c = clusters[n.kind];
    const angle = Math.random() * Math.PI * 2;
    const r = 30 + Math.random() * 80;
    n.x = c.cx + Math.cos(angle) * r;
    n.y = c.cy + Math.sin(angle) * r;
  }

  // edges from wikilink references — only across nodes we know
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "session") continue; // skip body parse on sessions for perf
    try {
      const tfile = app.vault.getAbstractFileByPath(n.path);
      if (!(tfile instanceof TFile)) continue;
      const body = await app.vault.cachedRead(tfile);
      let m: RegExpExecArray | null;
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(body)) !== null) {
        const target = m[1].trim().toLowerCase();
        const targetId = labelIndex.get(target) || labelIndex.get(slugForMatch(target));
        if (!targetId || targetId === n.id) continue;
        const key = `${n.id}::${targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: n.id, to: targetId });
      }
    } catch { /* skip */ }
  }

  const byId = new Map<string, GraphNode>();
  for (const n of nodes) byId.set(n.id, n);
  return { nodes, edges, byId };
}

function makeLabel(f: TFile, kind: NodeKind): string {
  const base = f.basename;
  if (kind === "session") return base; // date
  // truncate long memory titles
  return base.length > 32 ? base.slice(0, 30) + "…" : base;
}

function slugForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
