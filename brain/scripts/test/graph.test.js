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

// ── queries (graph_* MCP tools) ───────────────────────────────────────────────
const QG = {
  directed: false, nodes: [
    { id: 'memory_index', label: 'MEMORY.md', source_file: 'MEMORY.md', community: 0, community_name: 'Index' },
    { id: 'proj_atlas', label: 'Atlas Project', source_file: 'brain/memory/projects/atlas.md', community: 1, community_name: 'Projects' },
    { id: 'proj_beacon', label: 'Beacon Project', source_file: 'brain/memory/projects/beacon.md', community: 1, community_name: 'Projects' },
    { id: 'release', label: 'Release workflow', source_file: 'brain/patterns/release-workflow.md', community: 2, community_name: 'Patterns' },
    { id: 'why_atlas', label: 'Why', source_file: 'brain/memory/projects/atlas.md', community: 1 },
    { id: 'concept_ci', label: 'continuous integration', file_type: 'concept', community: 2 },
    { id: 'island', label: 'Island note', source_file: 'island.md' },
  ],
  links: [
    { source: 'memory_index', target: 'proj_atlas', relation: 'references', confidence: 'EXTRACTED' },
    { source: 'memory_index', target: 'proj_beacon', relation: 'references', confidence: 'EXTRACTED' },
    { source: 'memory_index', target: 'release', relation: 'references', confidence: 'EXTRACTED' },
    { source: 'proj_atlas', target: 'why_atlas', relation: 'contains', confidence: 'EXTRACTED' },
    { source: 'release', target: 'concept_ci', relation: 'uses', confidence: 'INFERRED' },
    { source: 'proj_beacon', target: 'concept_ci', relation: 'uses', confidence: 'INFERRED' },
  ],
};
const qg = () => G.loadGraph(write('q.json', QG));

test('resolve: id, exact title, case-insensitive title, path, file stem, then the shortest containing title', () => {
  const g = qg();
  assert.equal(G.resolve(g, 'proj_atlas').id, 'proj_atlas');
  assert.equal(G.resolve(g, 'Atlas Project').id, 'proj_atlas');
  assert.equal(G.resolve(g, 'atlas project').id, 'proj_atlas');
  assert.equal(G.resolve(g, 'brain/memory/projects/beacon.md').id, 'proj_beacon');
  assert.equal(G.resolve(g, 'release-workflow').id, 'release', 'the file stem, normalized');
  assert.equal(G.resolve(g, 'atlas').id, 'proj_atlas', 'the title holds it; the path match on "Why" loses on length');
  assert.equal(G.resolve(g, 'memory').id, 'memory_index');
  assert.equal(G.resolve(g, 'nothing like this'), null);
  assert.equal(G.resolve(g, '  '), null);
  // graphify gives a note's headings its source_file too: on a path the page wins even when a heading is better connected.
  const pg = G.loadGraph(write('pg.json', { nodes: [
    { id: 'guide', label: 'guide.md', source_file: 'guide.md', node_kind: 'page' },
    { id: 'guide_h', label: 'Guide overview', source_file: 'guide.md', node_kind: 'heading' },
    { id: 'a', label: 'A' }, { id: 'b', label: 'B' },
  ], links: [{ source: 'guide', target: 'guide_h' }, { source: 'guide_h', target: 'a' }, { source: 'guide_h', target: 'b' }] }));
  assert.equal(G.resolve(pg, 'guide.md').id, 'guide');
  assert.equal(G.resolve(pg, 'GUIDE.MD').id, 'guide');
  assert.equal(G.resolve(pg, 'Guide overview').id, 'guide_h', 'a title still beats a path');
  assert.equal(G.nodeView(pg, pg.byId.get('guide')).kind, 'page');
});

test('query: seeds by words, one hop by default, best-connected first, induced edges, budget cut', () => {
  const g = qg();
  const r = G.query(g, 'atlas project');
  assert.deepEqual(r.seeds.slice(0, 2), ['proj_atlas', 'proj_beacon'], 'both titles hold "project"; the whole phrase ranks Atlas first');
  const ids = r.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['concept_ci', 'memory_index', 'proj_atlas', 'proj_beacon', 'why_atlas']);
  assert.equal(r.nodes.find((n) => n.id === 'memory_index').hops, 1);
  assert.ok(r.edges.every((e) => ids.includes(e.source) && ids.includes(e.target)));
  assert.ok(r.edges.some((e) => e.confidence === 'INFERRED' && e.relation === 'uses'));
  assert.equal(r.truncated, false);
  const cut = G.query(g, 'atlas', { depth: 2, budget: 3 });
  assert.equal(cut.nodes.length, 3);
  assert.equal(cut.truncated, true);
  assert.ok(G.query(g, 'atlas', { depth: 0 }).nodes.every((n) => n.hops === 0), 'depth 0 is the seeds only');
  assert.deepEqual(G.query(g, 'zzz').seeds, []);
});

test('neighbors: by title, with relation filter, limit and total', () => {
  const g = qg();
  const r = G.neighbors(g, 'MEMORY.md');
  assert.equal(r.node.id, 'memory_index');
  assert.equal(r.total, 3);
  assert.deepEqual(r.neighbors.map((n) => n.relation), ['references', 'references', 'references']);
  assert.ok(!('direction' in r.neighbors[0]), 'undirected graphs have no direction');
  assert.equal(G.neighbors(g, 'Beacon Project', { relation: 'USES' }).neighbors[0].id, 'concept_ci');
  const lim = G.neighbors(g, 'memory_index', { limit: 1 });
  assert.equal(lim.neighbors.length, 1);
  assert.equal(lim.truncated, true);
  assert.equal(G.neighbors(g, 'no such note'), null);
});

test('shortestPath: the chain of links with its edges, null when unconnected, the missing names', () => {
  const g = qg();
  const r = G.shortestPath(g, 'Atlas Project', 'continuous integration');
  assert.equal(r.hops, 3);
  assert.deepEqual(r.path.map((n) => n.id), ['proj_atlas', 'memory_index', r.path[2].id, 'concept_ci']);
  assert.equal(r.edges.length, 3);
  assert.equal(G.shortestPath(g, 'proj_atlas', 'proj_atlas').hops, 0);
  assert.equal(G.shortestPath(g, 'Atlas Project', 'Island note').path, null);
  assert.equal(G.shortestPath(g, 'Atlas Project', 'continuous integration', { maxHops: 2 }).path, null);
  assert.deepEqual(G.shortestPath(g, 'nope', 'Atlas Project').missing, ['nope']);
});

test('fit keeps pretty JSON under the byte cap by halving the longest list and says truncated', () => {
  const big = { query: 'x', nodes: Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, label: 'x'.repeat(40) })), edges: [] };
  const s = G.fit(big, 10 * 1024);
  assert.ok(Buffer.byteLength(s) <= 10 * 1024);
  const o = JSON.parse(s);
  assert.equal(o.truncated, true);
  assert.ok(o.nodes.length > 0 && o.nodes.length < 2000);
  assert.equal(JSON.parse(G.fit({ a: [1, 2] })).truncated, undefined, 'small results pass through untouched');
});
