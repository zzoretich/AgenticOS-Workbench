#!/usr/bin/env node
// Emits a markdown "Graph pulse" block (hubs by degree, largest communities) from the vault graph at
// <vault>/<graph.out>/graph.json (default brain/graphify-out). Silent no-op (exit 0) if the graph is missing or unreadable.
const path = require('path');
const { PATHS } = require('./lib/paths.js');
const { loadConfig } = require('./lib/config.js');
const G = require('./sdk/lib/graph.js');

const block = G.pulse(G.loadGraph(path.join(G.outDir(PATHS.VAULT, loadConfig().graph), 'graph.json')));
if (block) console.log(block);
