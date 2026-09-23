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
 * Semantic pass (D5, D6, D10, D11; `--semantic`): `graphify extract <vault> --backend claude-cli` with the claude shim
 * (bin/graph-shim/claude → graph-claude.js) first on PATH, one call per chunk, --allow-partial, under the same lock.
 * scan-vault spawns it detached at most every graph.semantic.everyHours; `aos graph build --semantic` runs it with
 * --force (not waiting for it to be due, and running even when the background pass is switched off).
 * Flags: --quiet (no stdout summary) · --semantic [--force].
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PATHS } = require('./lib/paths.js');
const { loadConfig } = require('./lib/config.js');
const { withReport } = require('./lib/pipeline-report.js');
const { withLock } = require('./lib/snapshotLock.js');
const G = require('./sdk/lib/graph.js');
const { graphSpendToday } = require('./sdk/lib/spend-ledger.js');

const LOCK = path.join(PATHS.INDEX, '.graph.lock');
const SHIM_DIR = path.join(__dirname, 'bin', 'graph-shim');
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

// ── semantic pass ─────────────────────────────────────────────────────────────
/** D11: "auto" follows the provider (an explicit ollama or none means no background calls to Anthropic); true/false override. */
function semanticState(cfg) {
  const v = cfg && cfg.graph && cfg.graph.semantic ? cfg.graph.semantic.enabled : 'auto';
  if (v === true) return { on: true, why: null };
  if (v === false) return { on: false, why: 'semantic off' };
  const p = (cfg && cfg.provider) || 'auto';
  if (p === 'none' || p === 'ollama') return { on: false, why: `provider ${p}` };
  return { on: true, why: null };
}

/**
 * Why the semantic pass will not run now — { status: 'disabled' | 'skipped', reason } — or null when it should.
 * `force` (the foreground command) skips the due check and overrides `semantic off`, never a provider opt-out.
 */
function semanticSkip(cfg, { vault = PATHS.VAULT, now = new Date(), force = false, claudeBin } = {}) {
  const why = skipReason(cfg);
  if (why) return { status: 'disabled', reason: why };
  const st = semanticState(cfg);
  if (!st.on && !(force && st.why === 'semantic off')) return { status: 'disabled', reason: st.why };
  const sem = cfg.graph.semantic || {};
  const m = G.readMarker(G.outDir(vault, cfg.graph)) || {};
  const last = Date.parse(m.lastSemanticRun || '');
  if (!force && last && now - last < (Number(sem.everyHours) || 24) * 3_600_000) return { status: 'skipped', reason: 'not due' };
  if (graphSpendToday(now) >= (Number(sem.perDayUsd) || 1)) return { status: 'skipped', reason: 'graph budget reached' };
  const bin = claudeBin === undefined ? require('./sdk/lib/claude-cli.js').resolveClaudeBin() : claudeBin;
  if (!bin) return { status: 'disabled', reason: 'no claude CLI' };
  return null;
}

function semantic({ report, cfg, g, vault, out, timeoutMs, claudeBin, spawn, now }) {
  const sem = g.semantic || {};
  fs.mkdirSync(out, { recursive: true });
  const graphFile = path.join(out, 'graph.json');
  if (fs.existsSync(graphFile)) fs.copyFileSync(graphFile, graphFile + '.prev');
  const startedAt = now().toISOString();
  // Stamped before the run: a crash or a kill still waits everyHours instead of retrying at every scan.
  G.writeMarker(out, { ...(G.readMarker(out) || {}), lastSemanticRun: startedAt });
  try { fs.chmodSync(path.join(SHIM_DIR, 'claude'), 0o755); } catch { /* read-only install: the mode it shipped with */ }
  const model = (cfg.claude && cfg.claude.model) || 'haiku';
  const env = {
    ...childEnv(process.env, out),
    PATH: `${SHIM_DIR}${path.delimiter}${process.env.PATH || ''}`,
    GRAPHIFY_CLAUDE_CLI_MODEL: model,            // graphify's own default is Opus; the shim forces this model anyway
    GRAPHIFY_MAX_RETRY_DEPTH: '0',               // one call per chunk: calls ≤ chunks
    AOS_GRAPH_CLAUDE_BIN: claudeBin,
    AOS_NODE: process.execPath,
    AOS_VAULT: vault,
    ...(process.env.ANTHROPIC_API_KEY ? { AOS_GRAPH_ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
  };
  const before = graphSpendToday();
  const t0 = Date.now();
  const r = spawn(g.bin, ['extract', vault, '--backend', 'claude-cli', '--token-budget', String(Number(sem.tokenBudget) || 20000), '--allow-partial'], {
    cwd: vault, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const usd = Math.round((graphSpendToday() - before) * 1e6) / 1e6;
  const fail = (msg) => {
    G.writeMarker(out, { ...(G.readMarker(out) || {}), lastSemanticRun: startedAt, lastSemanticError: msg });
    throw new Error(msg);
  };
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) fail(`graphify extract timed out after ${timeoutMs / 1000}s`);
  if (r.error) fail(`graphify could not start: ${r.error.message}`);
  if (r.status !== 0) fail(`graphify extract exited ${r.status}: ${lastLine(r.stderr) || lastLine(r.stdout) || 'no output'}`);
  const graph = G.loadGraph(graphFile);
  if (!graph) fail(`graphify extract left no readable ${graphFile}`);
  const o = G.overview(graph, { hubs: 0, communities: 0 });
  const concepts = graph.nodes.filter((n) => n.file_type === 'concept').length;
  const inferred = graph.links.filter((l) => l.confidence === 'INFERRED').length;
  const incomplete = /incomplete/i.test(r.stderr || '');
  // Why a run was partial, in graphify's words (the last warning or error line it printed): doctor and status show it.
  const partialWhy = incomplete ? (String(r.stderr || '').split('\n').map((l) => l.trim()).filter((l) => /incomplete|fail|error|budget|refus/i.test(l)).pop() || null) : null;
  const at = now().toISOString();
  const marker = {
    ...(G.readMarker(out) || {}), mode: 'semantic', builtAt: at, lastSemantic: at, lastSemanticRun: startedAt, lastSemanticError: null,
    semanticIncomplete: incomplete, semanticPartialWhy: partialWhy, semanticUsd: usd, nodes: o.nodes, edges: o.edges, communities: o.communities, concepts, inferred,
    ms: Date.now() - t0,
  };
  G.writeMarker(out, marker);
  report.provider = 'claude';
  Object.assign(report.counts, { nodes: o.nodes, edges: o.edges, concepts, inferred, usd, incomplete: incomplete ? 1 : 0 });
  report.wrote.push(path.relative(vault, graphFile));
  return { status: 'ok', out, ...marker };
}

/** The `graph-semantic` report body: fn(report) for withReport. */
async function buildSemantic({ report, cfg = loadConfig(), vault = PATHS.VAULT, force = false, spawn = spawnSync, now = () => new Date(), claudeBin } = {}) {
  const bin = claudeBin === undefined ? require('./sdk/lib/claude-cli.js').resolveClaudeBin() : claudeBin;
  const sk = semanticSkip(cfg, { vault, now: now(), force, claudeBin: bin });
  if (sk) { if (sk.status === 'disabled') report.disable(sk.reason); else report.skip(sk.reason); return sk; }
  const g = cfg.graph;
  const out = G.outDir(vault, g);
  const timeoutMs = Math.max(1, Number((g.semantic || {}).timeoutSec) || 1800) * 1000;
  try {
    return await withLock(LOCK, () => semantic({ report, cfg, g, vault, out, timeoutMs, claudeBin: bin, spawn, now }), { retries: 1, staleMs: timeoutMs + 60000 });
  } catch (e) {
    if (/could not acquire lock/.test(e.message)) { report.skip('build running'); return { status: 'skipped', reason: 'build running' }; }
    throw e;
  }
}

/** scan-vault's kick: the pass in a detached process, which records its own `graph-semantic` report. */
function spawnSemantic({ spawnFn = require('child_process').spawn } = {}) {
  if (process.env.AOS_NO_SPAWN === '1') return false;
  const child = spawnFn(process.execPath, [__filename, '--semantic', '--quiet'], { detached: true, stdio: 'ignore', env: { ...process.env, AOS_DETACHED: '1' } });
  child.unref();
  return true;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const semanticRun = args.includes('--semantic');
  const run = semanticRun
    ? withReport('graph-semantic', (report) => buildSemantic({ report, force: args.includes('--force') }))
    : withReport('graph-build', (report) => buildStructural({ report }));
  run
    .then((r) => {
      if (quiet) return;
      if (r.status !== 'ok') console.log(`graph: ${semanticRun ? 'semantic pass ' : ''}${r.status} (${r.reason})`);
      else if (semanticRun) console.log(`graph: semantic pass ${r.semanticIncomplete ? 'incomplete (the rest follows on the next runs)' : 'done'} · ${r.nodes} nodes · ${r.concepts} concepts · ${r.inferred} inferred edges · $${r.semanticUsd.toFixed(4)} in ${Math.round(r.ms / 1000)} s`);
      else console.log(`graph: ${r.nodes} nodes · ${r.edges} edges · ${r.communities} communities in ${r.ms} ms → ${path.relative(PATHS.VAULT, r.out)}`);
    })
    .catch((e) => { console.error('[graph-build]', e.message); process.exit(1); });
}

module.exports = { buildStructural, buildSemantic, semanticSkip, semanticState, spawnSemantic, skipReason, childEnv, LOCK, SHIM_DIR };
