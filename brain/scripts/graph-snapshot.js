#!/usr/bin/env node
// Emits a markdown "Graph pulse" block for /scan from graphify-out/graph.json.
// Silent no-op (exit 0) if the graph is missing or unreadable.
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./lib/paths.js');
const graphPath = path.join(PATHS.VAULT, 'graphify-out', 'graph.json');
let g;
try { g = JSON.parse(fs.readFileSync(graphPath, 'utf8')); } catch { process.exit(0); }
const nodes = g.nodes || [];
const links = g.links || g.edges || [];
if (!nodes.length) process.exit(0);
const deg = new Map();
for (const l of links) {
  const s = typeof l.source === 'object' ? l.source.id : l.source;
  const t = typeof l.target === 'object' ? l.target.id : l.target;
  deg.set(s, (deg.get(s) || 0) + 1);
  deg.set(t, (deg.get(t) || 0) + 1);
}
const top = nodes
  .map(n => ({ label: n.label || n.id, d: deg.get(n.id) || 0 }))
  .sort((a, b) => b.d - a.d).slice(0, 10);
const comm = new Map();
for (const n of nodes) {
  const c = n.community_name || n.community;
  if (c !== undefined && c !== null) comm.set(c, (comm.get(c) || 0) + 1);
}
const commTop = [...comm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('## Graph pulse');
console.log(`${nodes.length} nodes · ${links.length} edges`);
console.log('**God nodes:** ' + top.map(n => `${n.label} (${n.d})`).join(' · '));
if (commTop.length) console.log('**Communities:** ' + commTop.map(([c, n]) => `${c}: ${n}`).join(' · '));
