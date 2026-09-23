'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// The graph_* tools (spec 2026-09-23-graphify D4) over a real stdio MCP connection, against a vault graph fixture.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-tools-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
const OUT = path.join(TMP, 'brain', 'graphify-out');
const SERVER = path.join(__dirname, '..', 'sdk', 'mcp-server.js');
const GRAPH = {
  directed: false, nodes: [
    { id: 'memory_index', label: 'MEMORY.md', file_type: 'document', source_file: 'MEMORY.md', community: 0, community_name: 'Index' },
    { id: 'proj_atlas', label: 'Atlas Project', file_type: 'document', source_file: 'brain/memory/projects/atlas.md', community: 1, community_name: 'Projects' },
    { id: 'release', label: 'Release workflow', file_type: 'document', source_file: 'brain/patterns/release-workflow.md', community: 1, community_name: 'Projects' },
  ],
  links: [
    { source: 'memory_index', target: 'proj_atlas', relation: 'references', confidence: 'EXTRACTED' },
    { source: 'proj_atlas', target: 'release', relation: 'references', confidence: 'EXTRACTED' },
  ],
};

async function call(name, args = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') } });
  const client = new Client({ name: 'graph-tools-test', version: '0.0.0' });
  await client.connect(transport);
  try { return (await client.callTool({ name, arguments: args })).content[0].text; } finally { await client.close(); }
}

test('without a graph every tool says how to build one', async () => {
  for (const [name, args] of [['graph_overview', {}], ['graph_query', { q: 'atlas' }], ['graph_neighbors', { node: 'x' }], ['graph_path', { from: 'a', to: 'b' }]]) {
    assert.match(await call(name, args), /^No vault graph yet\. `aos graph build` builds it/, name);
  }
});

test('graph_overview, graph_query, graph_neighbors and graph_path read the vault graph', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify(GRAPH));
  fs.writeFileSync(path.join(OUT, '.aos-graph.json'), JSON.stringify({ schema: 1, mode: 'structural', builtAt: '2026-09-23T10:00:00.000Z', lastSemantic: null }));

  const o = JSON.parse(await call('graph_overview'));
  assert.equal(o.nodes, 3);
  assert.equal(o.edges, 2);
  assert.equal(o.mode, 'structural');
  assert.equal(o.graph, path.join('brain', 'graphify-out'));
  assert.equal(o.hubs[0].id, 'proj_atlas');

  const q = JSON.parse(await call('graph_query', { q: 'atlas' }));
  assert.deepEqual(q.seeds, ['proj_atlas']);
  assert.deepEqual(q.nodes.map((n) => n.id).sort(), ['memory_index', 'proj_atlas', 'release']);
  assert.match(await call('graph_query', { q: 'zebra' }), /^No graph node matches "zebra"/);

  const n = JSON.parse(await call('graph_neighbors', { node: 'brain/memory/projects/atlas.md' }));
  assert.equal(n.node.id, 'proj_atlas');
  assert.equal(n.total, 2);
  assert.match(await call('graph_neighbors', { node: 'zebra' }), /^No graph node matches "zebra"/);

  const p = JSON.parse(await call('graph_path', { from: 'MEMORY.md', to: 'Release workflow' }));
  assert.equal(p.hops, 2);
  assert.deepEqual(p.path.map((x) => x.id), ['memory_index', 'proj_atlas', 'release']);
  assert.match(await call('graph_path', { from: 'MEMORY.md', to: 'zebra' }), /^No graph node matches "zebra"/);
});

test('the four graph tools are advertised read-only', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') } });
  const client = new Client({ name: 'graph-tools-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const name of ['graph_overview', 'graph_query', 'graph_neighbors', 'graph_path']) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} listed`);
      assert.equal(t.annotations.readOnlyHint, true, name);
    }
  } finally { await client.close(); }
});
