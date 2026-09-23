'use strict';
/**
 * graph.js — read side of the vault knowledge graph that graphify writes (spec 2026-09-23-graphify D4, D8).
 * graph.json is networkx node-link data: { nodes: [{id, label, file_type, source_file, community, community_name}],
 * links: [{source, target, relation, confidence, weight, source_file}], hyperedges }. Undirected by default.
 * Pure: no paths.js import, so cli/graph-cmd.js can require it from the vendored copy by absolute path.
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

/** The markdown "Graph pulse" block (/scan, `aos graph status`), or '' when there is no graph. */
function pulse(g) {
  if (!g || !g.nodes.length) return '';
  const o = overview(g, { hubs: 10, communities: 8 });
  const lines = ['## Graph pulse', `${o.nodes} nodes · ${o.edges} edges · ${o.communities} communities`];
  lines.push('**Hubs:** ' + o.hubs.map((h) => `${h.label} (${h.degree})`).join(' · '));
  if (o.topCommunities.length) lines.push('**Communities:** ' + o.topCommunities.map((c) => `${c.name || c.id}: ${c.size}`).join(' · '));
  return lines.join('\n');
}

module.exports = { DEFAULT_OUT, MARKER, outDir, loadGraph, degree, overview, readMarker, writeMarker, pulse };
