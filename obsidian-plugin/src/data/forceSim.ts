import { Graph, GraphNode } from "./graph";

export interface SimParams {
  repulsion: number;
  spring: number;
  restLength: number;
  centerGravity: number;
  damping: number;
}

export const DEFAULT_PARAMS: SimParams = {
  repulsion: 1600,
  spring: 0.045,
  restLength: 90,
  centerGravity: 0.0015,
  damping: 0.84,
};

export function tick(graph: Graph, p: SimParams = DEFAULT_PARAMS): void {
  const { nodes, edges } = graph;

  // repulsion: O(n^2) — fine for <300 nodes
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.fixed) continue;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // jitter when nodes overlap
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d2 = dx * dx + dy * dy + 1;
      }
      const f = p.repulsion / d2;
      const inv = 1 / Math.sqrt(d2);
      a.vx += dx * inv * f;
      a.vy += dy * inv * f;
    }
  }

  // spring along edges
  for (const e of edges) {
    const a = graph.byId.get(e.from);
    const b = graph.byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const f = p.spring * (dist - p.restLength);
    const fx = (dx / dist) * f;
    const fy = (dy / dist) * f;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }

  // gravity + integrate
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += -n.x * p.centerGravity;
    n.vy += -n.y * p.centerGravity;
    n.vx *= p.damping;
    n.vy *= p.damping;
    n.x += n.vx;
    n.y += n.vy;
  }
}

export function settle(graph: Graph, iterations: number = 180, p?: SimParams): void {
  for (let i = 0; i < iterations; i++) tick(graph, p);
}
