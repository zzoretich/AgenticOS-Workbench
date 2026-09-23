'use strict';
/**
 * graph.js — read side of the vault knowledge graph that graphify writes (spec 2026-09-23-graphify D4, D8).
 * graph.json is networkx node-link data: { nodes: [{id, label, file_type, source_file, community, community_name}],
 * links: [{source, target, relation, confidence, weight, source_file}], hyperedges }. Undirected by default.
 * Pure: no paths.js import, so cli/graph-cmd.js can require it from the vendored copy by absolute path.
 * The query half (resolve, search, query, neighbors, shortestPath, fit) backs the graph_* tools of the MCP server.
 * The marker (.aos-graph.json, schema 1) is ours: what built the graph, when, and in which mode.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_OUT = 'brain/graphify-out';
const MARKER = '.aos-graph.json';

/** <vault>/<graph.out>: the directory graphify writes into (GRAPHIFY_OUT). */
function outDir(vault, graphCfg = {}) {
  return path.resolve(vault, graphCfg.out || DEFAULT_OUT);
}

function endId(end) { return end && typeof end === 'object' ? end.id : end; }

const cache = new Map();   // file → { mtimeMs, size, graph }

/**
 * Load and index graph.json; null when it is missing, unreadable or not node-link shaped. Re-reads only when the
 * file's mtime or size changed, so a long-lived MCP server sees each rebuild without re-parsing on every call.
 */
function loadGraph(file) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.graph;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache.delete(file); return null; }
  if (!raw || !Array.isArray(raw.nodes)) { cache.delete(file); return null; }
  const nodes = raw.nodes.filter((n) => n && n.id !== undefined && n.id !== null);
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const links = [];
  const adj = new Map([...byId.keys()].map((id) => [id, []]));
  for (const l of Array.isArray(raw.links) ? raw.links : Array.isArray(raw.edges) ? raw.edges : []) {
    const s = String(endId(l && l.source));
    const t = String(endId(l && l.target));
    if (!byId.has(s) || !byId.has(t)) continue;
    links.push(l);
    adj.get(s).push({ id: t, link: l });
    if (s !== t) adj.get(t).push({ id: s, link: l });
  }
  const graph = { nodes, links, byId, adj, directed: !!raw.directed, hyperedges: Array.isArray(raw.hyperedges) ? raw.hyperedges : [] };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, graph });
  return graph;
}

function degree(g, id) { return (g.adj.get(String(id)) || []).length; }
function labelOf(n) { return String(n.label || n.id); }

/** Counts, the best-connected nodes, and the largest communities (by name when graphify labelled them). */
function overview(g, { hubs = 10, communities = 8 } = {}) {
  const top = g.nodes
    .map((n) => ({ id: String(n.id), label: labelOf(n), degree: degree(g, n.id) }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, hubs);
  const comm = new Map();
  for (const n of g.nodes) {
    if (n.community === undefined || n.community === null) continue;
    const key = String(n.community);
    const c = comm.get(key) || { id: key, name: n.community_name ? String(n.community_name) : null, size: 0 };
    c.size += 1;
    comm.set(key, c);
  }
  const byType = {};
  for (const n of g.nodes) { const t = n.file_type || 'unknown'; byType[t] = (byType[t] || 0) + 1; }
  return {
    nodes: g.nodes.length,
    edges: g.links.length,
    communities: comm.size,
    byType,
    hubs: top,
    topCommunities: [...comm.values()].sort((a, b) => b.size - a.size || String(a.name || a.id).localeCompare(String(b.name || b.id))).slice(0, communities),
  };
}

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}
/** Atomic (tmp + rename), like every other brain writer. */
function writeMarker(dir, marker) {
  const p = path.join(dir, MARKER);
  fs.writeFileSync(p + '.tmp', JSON.stringify({ schema: 1, ...marker }, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
}

// ── queries (the graph_* MCP tools, spec §4.6) ────────────────────────────────
const MAX_BYTES = 50 * 1024;

function norm(s) { return String(s || '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function tokens(s) { return norm(s).split(' ').filter((t) => t.length >= 2); }

function nodeView(g, n) {
  return {
    id: String(n.id), label: labelOf(n), type: n.file_type || null, kind: n.node_kind || null, file: n.source_file || null,
    community: n.community_name != null ? String(n.community_name) : n.community != null ? String(n.community) : null,
    degree: degree(g, n.id),
  };
}
function edgeView(l) {
  return { source: String(endId(l.source)), target: String(endId(l.target)), relation: l.relation || null, confidence: l.confidence || null };
}

/**
 * A node by id, else by title or vault-relative path: exact, then case-insensitive, then normalized (no `.md`, no
 * punctuation), then the shortest title containing the name. A title beats a path, and on a path the page beats its
 * headings (graphify gives every heading of a note the note's source_file). Other ties go to the best-connected node.
 */
function resolve(g, name) {
  const q = String(name == null ? '' : name).trim();
  if (!q) return null;
  if (g.byId.has(q)) return g.byId.get(q);
  const lower = q.toLowerCase();
  const nq = norm(q);
  const rank = (n) => {
    const l = labelOf(n);
    const f = String(n.source_file || '');
    const page = n.node_kind === 'page' ? 0.5 : 0;
    if (l === q) return 8;
    if (f === q) return 6 + page;
    if (l.toLowerCase() === lower) return 5;
    if (f.toLowerCase() === lower) return 4 + page;
    if (nq && norm(l) === nq) return 3;
    if (nq && norm(path.basename(f)) === nq) return 2 + page;
    if (nq && (norm(l).includes(nq) || f.toLowerCase().includes(lower))) return 1;
    return 0;
  };
  let best = null;
  for (const n of g.nodes) {
    const r = rank(n);
    if (!r) continue;
    const c = { n, r, d: degree(g, n.id), len: labelOf(n).length };
    const better = !best || c.r > best.r
      || (c.r === best.r && (c.r >= 2 ? c.d > best.d || (c.d === best.d && c.len < best.len) : c.len < best.len || (c.len === best.len && c.d > best.d)));
    if (better) best = c;
  }
  return best ? best.n : null;
}

/** Nodes whose title (worth 2) or path (worth 1) holds the query's words; the whole phrase in the title adds 3. */
function search(g, q, limit = 5) {
  const toks = tokens(q);
  const phrase = norm(q);
  if (!toks.length) return [];
  const scored = [];
  for (const n of g.nodes) {
    const l = norm(labelOf(n));
    const f = norm(n.source_file || '');
    let s = 0;
    for (const t of toks) s += l.includes(t) ? 2 : f.includes(t) ? 1 : 0;
    if (!s) continue;
    if (l.includes(phrase)) s += 3;
    scored.push({ n, s, d: degree(g, n.id) });
  }
  scored.sort((a, b) => b.s - a.s || b.d - a.d || labelOf(a.n).localeCompare(labelOf(b.n)));
  return scored.slice(0, limit).map((x) => x.n);
}

/** Up to five best-matching seeds, then breadth-first out to `depth` hops, best-connected first, until `budget` nodes. */
function query(g, q, { depth = 1, budget = 40 } = {}) {
  const seeds = search(g, q, 5);
  const hops = new Map();
  const queue = [];
  let cut = false;
  for (const n of seeds) { if (hops.size >= budget) { cut = true; break; } hops.set(String(n.id), 0); queue.push(String(n.id)); }
  while (queue.length) {
    const id = queue.shift();
    const h = hops.get(id);
    if (h >= depth) continue;
    const next = [...(g.adj.get(id) || [])].sort((a, b) => degree(g, b.id) - degree(g, a.id));
    for (const { id: nid } of next) {
      if (hops.has(nid)) continue;
      if (hops.size >= budget) { cut = true; break; }
      hops.set(nid, h + 1);
      queue.push(nid);
    }
  }
  const nodes = [...hops].map(([id, n]) => ({ ...nodeView(g, g.byId.get(id)), hops: n }));
  const edges = g.links.filter((l) => hops.has(String(endId(l.source))) && hops.has(String(endId(l.target)))).map(edgeView);
  return { query: String(q), seeds: seeds.map((n) => String(n.id)), nodes, edges, truncated: cut };
}

/** The node's direct neighbours, best-connected first, optionally only along one relation. */
function neighbors(g, name, { relation, limit = 100 } = {}) {
  const n = resolve(g, name);
  if (!n) return null;
  const id = String(n.id);
  const rel = relation ? String(relation).toLowerCase() : null;
  const all = (g.adj.get(id) || []).filter((x) => !rel || String(x.link.relation || '').toLowerCase() === rel);
  const list = [...all].sort((a, b) => degree(g, b.id) - degree(g, a.id)).slice(0, limit);
  return {
    node: nodeView(g, n), total: all.length, truncated: all.length > list.length,
    neighbors: list.map((x) => ({
      ...nodeView(g, g.byId.get(x.id)), relation: x.link.relation || null, confidence: x.link.confidence || null,
      ...(g.directed ? { direction: String(endId(x.link.source)) === id ? 'out' : 'in' } : {}),
    })),
  };
}

/** The shortest chain of links between two nodes (breadth-first, at most `maxHops`), or path null when none exists. */
function shortestPath(g, fromName, toName, { maxHops = 8 } = {}) {
  const a = resolve(g, fromName);
  const b = resolve(g, toName);
  const missing = [!a && String(fromName), !b && String(toName)].filter(Boolean);
  if (missing.length) return { from: a ? nodeView(g, a) : null, to: b ? nodeView(g, b) : null, path: null, missing };
  const s = String(a.id);
  const t = String(b.id);
  const prev = new Map([[s, null]]);
  let frontier = [s];
  for (let h = 0; frontier.length && !prev.has(t) && h < maxHops; h++) {
    const next = [];
    for (const id of frontier) {
      for (const x of g.adj.get(id) || []) {
        if (prev.has(x.id)) continue;
        prev.set(x.id, { from: id, link: x.link });
        next.push(x.id);
      }
    }
    frontier = next;
  }
  if (!prev.has(t)) return { from: nodeView(g, a), to: nodeView(g, b), path: null, hops: null };
  const ids = [];
  const edges = [];
  for (let cur = t; cur !== null;) {
    ids.unshift(cur);
    const p = prev.get(cur);
    if (!p) break;
    edges.unshift(edgeView(p.link));
    cur = p.from;
  }
  return { from: nodeView(g, a), to: nodeView(g, b), hops: ids.length - 1, path: ids.map((id) => nodeView(g, g.byId.get(id))), edges };
}

/** Pretty JSON no larger than maxBytes: halve the longest list field until it fits, and say so with `truncated`. */
function fit(obj, maxBytes = MAX_BYTES) {
  let o = obj;
  let s = JSON.stringify(o, null, 2);
  while (Buffer.byteLength(s) > maxBytes) {
    const k = Object.keys(o).filter((x) => Array.isArray(o[x]) && o[x].length > 1).sort((x, y) => o[y].length - o[x].length)[0];
    if (!k) break;
    o = { ...o, [k]: o[k].slice(0, Math.ceil(o[k].length / 2)), truncated: true };
    s = JSON.stringify(o, null, 2);
  }
  return s;
}

/** The markdown "Graph pulse" block (/scan, `aos graph status`), or '' when there is no graph. */
function pulse(g) {
  if (!g || !g.nodes.length) return '';
  const o = overview(g, { hubs: 10, communities: 8 });
  const lines = ['## Graph pulse', `${o.nodes} nodes · ${o.edges} edges · ${o.communities} communities`];
  lines.push('**Hubs:** ' + o.hubs.map((h) => `${h.label} (${h.degree})`).join(' · '));
  if (o.topCommunities.length) lines.push('**Communities:** ' + o.topCommunities.map((c) => `${c.name || c.id}: ${c.size}`).join(' · '));
  return lines.join('\n');
}

module.exports = {
  DEFAULT_OUT, MARKER, MAX_BYTES, outDir, loadGraph, degree, overview, readMarker, writeMarker, pulse,
  nodeView, resolve, search, query, neighbors, shortestPath, fit,
};
