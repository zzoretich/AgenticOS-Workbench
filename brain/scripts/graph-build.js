#!/usr/bin/env node
'use strict';
/**
 * graph-build.js — keeps the vault knowledge graph current (spec 2026-09-23-graphify D5, D7, D8).
 * Structural pass: `graphify update <vault>` with GRAPHIFY_OUT=<vault>/<graph.out> — no model, no network, about
 * a second or two for a few hundred notes. scan-vault runs it inline as its `graph-build` stage (scan-vault is itself
 * detached when a hook fires it); `aos graph build` runs this file directly.
 *   - one lock (brain/_index/.graph.lock): two scans never run graphify on the same out dir at once
 *   - graph.json → graph.json.prev before every run; graphify's own dated backups are off (GRAPHIFY_NO_BACKUP=1)
 *   - "Cannot read … for incremental merge" (a torn graph.json) → delete it and rebuild once (--force does not help)
 *   - the child env drops API-key variables, so graphify's backend auto-detect can never select a paid backend
 * Always the vault root, passed explicitly: another root re-keys every node path (spike, spec §4.7).
 * Flags: --quiet (no stdout summary).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PATHS } = require('./lib/paths.js');
const { loadConfig } = require('./lib/config.js');
const { withReport } = require('./lib/pipeline-report.js');
const { withLock } = require('./lib/snapshotLock.js');
const G = require('./sdk/lib/graph.js');

const LOCK = path.join(PATHS.INDEX, '.graph.lock');
const SECRET_ENV = /(_API_KEY|_API_TOKEN)$|^(AWS|AZURE)_/;

function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }

/** Why the structural pass will not run for this config ('graph off' | 'graphify missing'), or null. */
function skipReason(cfg) {
  const g = (cfg && cfg.graph) || {};
  if (g.enabled === false) return 'graph off';
  if (!g.bin || !isExecutable(g.bin)) return 'graphify missing';
  return null;
}

/** The env graphify runs with: the caller's, minus credential variables, plus the output dir and no dated backups. */
function childEnv(base, out) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!SECRET_ENV.test(k)) env[k] = v;
  env.GRAPHIFY_OUT = out;
  env.GRAPHIFY_NO_BACKUP = '1';
  return env;
}

function lastLine(s) { return String(s || '').trim().split('\n').filter(Boolean).pop() || ''; }

function structural({ report, g, vault, out, timeoutMs, spawn, now }) {
  fs.mkdirSync(out, { recursive: true });
  const graphFile = path.join(out, 'graph.json');
  if (fs.existsSync(graphFile)) fs.copyFileSync(graphFile, graphFile + '.prev');
  const env = childEnv(process.env, out);
  const t0 = Date.now();
  const update = () => spawn(g.bin, ['update', vault], { cwd: vault, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  let r = update();
  if (r.status !== 0 && /for incremental merge/.test(r.stderr || '')) {
    fs.rmSync(graphFile, { force: true });
    report.counts.recovered = 1;
    r = update();
  }
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) throw new Error(`graphify update timed out after ${timeoutMs / 1000}s`);
  if (r.error) throw new Error(`graphify could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const msg = lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.status}`;
    if (/nothing to rebuild/i.test(msg)) { report.skip('nothing to graph'); return { status: 'skipped', reason: 'nothing to graph' }; }
    throw new Error(`graphify update exited ${r.status}: ${msg}`);
  }
  const graph = G.loadGraph(graphFile);
  if (!graph) throw new Error(`graphify update left no readable ${graphFile}`);
  const o = G.overview(graph, { hubs: 0, communities: 0 });
  const prev = G.readMarker(out) || {};
  const at = now().toISOString();
  const marker = {
    mode: prev.lastSemantic ? 'semantic' : 'structural', builtAt: at, lastStructural: at,
    lastSemantic: prev.lastSemantic || null, nodes: o.nodes, edges: o.edges, communities: o.communities, ms: Date.now() - t0,
  };
  G.writeMarker(out, marker);
  Object.assign(report.counts, { nodes: o.nodes, edges: o.edges, communities: o.communities });
  report.wrote.push(path.relative(vault, graphFile));
  return { status: 'ok', out, ...marker };
}

/** The `graph-build` stage body: fn(report) for withReport. Resolves to { status, reason? | out, nodes, edges, … }. */
async function buildStructural({ report, cfg = loadConfig(), vault = PATHS.VAULT, spawn = spawnSync, now = () => new Date() } = {}) {
  const why = skipReason(cfg);
  if (why) { report.disable(why); return { status: 'disabled', reason: why }; }
  const g = cfg.graph;
  const out = G.outDir(vault, g);
  const timeoutMs = Math.max(1, Number(g.timeoutSec) || 120) * 1000;
  try {
    return await withLock(LOCK, () => structural({ report, g, vault, out, timeoutMs, spawn, now }), { retries: 1, staleMs: timeoutMs + 60000 });
  } catch (e) {
    if (/could not acquire lock/.test(e.message)) { report.skip('build running'); return { status: 'skipped', reason: 'build running' }; }
    throw e;
  }
}

if (require.main === module) {
  const quiet = process.argv.includes('--quiet');
  withReport('graph-build', (report) => buildStructural({ report }))
    .then((r) => {
      if (quiet) return;
      if (r.status === 'ok') console.log(`graph: ${r.nodes} nodes · ${r.edges} edges · ${r.communities} communities in ${r.ms} ms → ${path.relative(PATHS.VAULT, r.out)}`);
      else console.log(`graph: ${r.status} (${r.reason})`);
    })
    .catch((e) => { console.error('[graph-build]', e.message); process.exit(1); });
}

module.exports = { buildStructural, skipReason, childEnv, LOCK };
