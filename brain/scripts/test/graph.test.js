'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../sdk/lib/graph.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-lib-'));
const node = (id, label, community, community_name, file_type = 'document') => ({ id, label, file_type, source_file: `${id}.md`, community, community_name });
const FIXTURE = {
  directed: false, multigraph: false, graph: {},
  nodes: [node('a', 'Alpha', 0, 'Core'), node('b', 'Beta', 0, 'Core'), node('c', 'Gamma', 1, 'Edge'), node('d', 'Delta', 1, 'Edge', 'code'), { id: 'e', label: 'Lonely' }],
  links: [
    { source: 'a', target: 'b', relation: 'references' },
    { source: 'a', target: 'c', relation: 'references' },
    { source: { id: 'c' }, target: { id: 'd' }, relation: 'references' },   // object endpoints (older networkx dumps)
    { source: 'a', target: 'ghost', relation: 'references' },               // dangling: dropped
  ],
  hyperedges: [],
};
function write(name, obj) { const p = path.join(TMP, name); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; }

test('loadGraph indexes nodes and undirected adjacency, and drops links to unknown nodes', () => {
  const g = G.loadGraph(write('g1.json', FIXTURE));
  assert.equal(g.nodes.length, 5);
  assert.equal(g.links.length, 3);
  assert.deepEqual(g.adj.get('a').map((x) => x.id).sort(), ['b', 'c']);
  assert.deepEqual(g.adj.get('c').map((x) => x.id).sort(), ['a', 'd']);
  assert.equal(G.degree(g, 'e'), 0);
  assert.equal(g.byId.get('d').file_type, 'code');
});

test('loadGraph accepts `edges` for `links`, and returns null for missing, corrupt or non node-link files', () => {
  const { links, ...rest } = FIXTURE;
  assert.equal(G.loadGraph(write('g2.json', { ...rest, edges: links })).links.length, 3);
  assert.equal(G.loadGraph(path.join(TMP, 'nope.json')), null);
  assert.equal(G.loadGraph(write('g3.json', '{"nodes": [')), null);
  assert.equal(G.loadGraph(write('g4.json', { vertices: [] })), null);
});

test('loadGraph re-reads only when the file changes', () => {
  const p = write('g5.json', FIXTURE);
  const first = G.loadGraph(p);
  assert.equal(G.loadGraph(p), first, 'cached while unchanged');
  write('g5.json', { ...FIXTURE, nodes: FIXTURE.nodes.slice(0, 2), links: [] });
  const second = G.loadGraph(p);
  assert.notEqual(second, first);
  assert.equal(second.nodes.length, 2);
  fs.rmSync(p);
  assert.equal(G.loadGraph(p), null, 'a deleted graph is not served from the cache');
});

test('overview: counts, hubs by degree then label, communities by size with names, node types', () => {
  const o = G.overview(G.loadGraph(write('g6.json', FIXTURE)), { hubs: 3, communities: 5 });
  assert.equal(o.nodes, 5);
  assert.equal(o.edges, 3);
  assert.equal(o.communities, 2);
  assert.deepEqual(o.hubs, [{ id: 'a', label: 'Alpha', degree: 2 }, { id: 'c', label: 'Gamma', degree: 2 }, { id: 'b', label: 'Beta', degree: 1 }]);
  assert.deepEqual(o.topCommunities, [{ id: '0', name: 'Core', size: 2 }, { id: '1', name: 'Edge', size: 2 }]);
  assert.deepEqual(o.byType, { document: 3, code: 1, unknown: 1 });
});

test('pulse renders the Graph pulse block, and nothing for no graph', () => {
  assert.equal(G.pulse(null), '');
  const block = G.pulse(G.loadGraph(write('g7.json', FIXTURE)));
  assert.match(block, /^## Graph pulse\n5 nodes · 3 edges · 2 communities\n\*\*Hubs:\*\* Alpha \(2\) · Gamma \(2\)/);
  assert.match(block, /\*\*Communities:\*\* Core: 2 · Edge: 2$/);
});

test('outDir defaults to brain/graphify-out; the marker round-trips with schema 1', () => {
  assert.equal(G.outDir('/v'), path.resolve('/v', 'brain', 'graphify-out'));
  assert.equal(G.outDir('/v', { out: 'x/y' }), path.resolve('/v', 'x', 'y'));
  const dir = fs.mkdtempSync(path.join(TMP, 'm-'));
  assert.equal(G.readMarker(dir), null);
  G.writeMarker(dir, { mode: 'structural', nodes: 5 });
  assert.deepEqual(G.readMarker(dir), { schema: 1, mode: 'structural', nodes: 5 });
  assert.ok(!fs.existsSync(path.join(dir, `${G.MARKER}.tmp`)));
});
