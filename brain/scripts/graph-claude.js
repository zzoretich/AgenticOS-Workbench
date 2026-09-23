#!/usr/bin/env node
'use strict';
/**
 * graph-claude.js — the `claude` that graphify's claude-cli backend runs during the vault graph's semantic pass
 * (spec 2026-09-23-graphify D6, D10). bin/graph-shim/claude execs this; graph-build.js puts that dir first on
 * graphify's PATH. graphify builds `claude -p --output-format json --no-session-persistence [--model M]
 * [--json-schema S]` with the prompt on stdin; this:
 *   - passes --help / --version straight through (graphify probes --help for --json-schema support)
 *   - refuses (exit 1, nothing spawned) once today's graph: spend has reached graph.semantic.perDayUsd — the chunk
 *     stays uncached and graphify retries it at the next due run, so a large first pass drains across days
 *   - drops graphify's --model and appends the headless isolation flags (claude-cli.js ISOLATION_FLAGS), a short
 *     system prompt, the configured claude.model and --max-budget-usd graph.semantic.perCallUsd
 *   - runs the real CLI with AOS_HEADLESS=1 (our hooks stay out) and MAX_THINKING_TOKENS=0 (D12)
 *   - passes stdin and stdout through byte for byte, and ledgers one graph:semantic row from the JSON envelope
 * The real CLI comes from AOS_GRAPH_CLAUDE_BIN (graph-build.js resolves it), never from PATH, where this shim comes first.
 *
 * Under Codex (AOS_GRAPH_RUNNER=codex, spec 2026-09-23-codex-parity-gaps D3/D4) graphify still talks to this `claude`;
 * the answer comes from `codex exec` (sdk/lib/codex-cli.js: read-only, ephemeral, our hooks off) in an empty folder, on
 * codex.model at low effort, printed as the result envelope graphify reads (result, usage, modelUsage, stop_reason).
 * The same daily cap gates each call; Codex has no per-call cap, so the spend is estimated from its token counts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./lib/config.js');
const { recordSpend, graphSpendToday } = require('./sdk/lib/spend-ledger.js');
const { headlessEnv, ISOLATION_FLAGS } = require('./sdk/lib/claude-cli.js');

const SYSTEM = 'You extract knowledge-graph JSON from notes. Reply only with the JSON the user turn asks for.';
const PASS_THROUGH = new Set(['--help', '-h', '--version', '-v']);
// Under graphify's own per-call timeout (GRAPHIFY_API_TIMEOUT, 600 s), so the real CLI is killed before this shim is.
const CALL_TIMEOUT_MS = 570_000;

/** graphify's argv with its --model removed (the configured model wins) and the isolation flags appended. */
function rewriteArgs(argv, { model, perCallUsd }) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') { i++; continue; }
    if (argv[i].startsWith('--model=')) continue;
    kept.push(argv[i]);
  }
  return [...kept, ...ISOLATION_FLAGS, '--system-prompt', SYSTEM, '--model', String(model), '--max-budget-usd', String(perCallUsd)];
}

/** The real CLI's env: headless, no thinking, and an API key graph-build.js kept away from graphify put back. */
function childEnv(base) {
  const env = headlessEnv(base, { thinking: false });
  if (base.AOS_GRAPH_ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = base.AOS_GRAPH_ANTHROPIC_API_KEY;
  delete env.AOS_GRAPH_ANTHROPIC_API_KEY;
  delete env.AOS_GRAPH_CLAUDE_BIN;
  return env;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/** codexCall's result → the `claude -p --output-format json` result envelope graphify's claude-cli backend parses. */
function codexEnvelope(r) {
  const u = r.usage || {};
  const cached = num(u.cachedInputTokens);
  return {
    type: 'result', subtype: 'success', is_error: false, result: String(r.text || ''),
    usage: { input_tokens: Math.max(0, num(u.inputTokens) - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: num(u.outputTokens) },
    modelUsage: { [r.model || 'codex-default']: {} }, stop_reason: 'end_turn', total_cost_usd: num(r.usd), duration_api_ms: num(r.ms),
  };
}

const CODEX_HELP = 'claude (AgenticOS graph shim, answering through codex exec)\nUsage: claude -p [--output-format json] [--model <m>] < prompt\n';

/** The Codex leg: one codex exec per graphify call, ledgered by codexCall as graph:semantic. Resolves the exit code. */
async function codexLeg(argv, { env, readStdin, out, err, codexCall, mkTemp }) {
  if (argv.some((a) => PASS_THROUGH.has(a))) { out.write(argv.includes('--version') || argv.includes('-v') ? '0.0.0 (graph shim, codex)\n' : CODEX_HELP); return 0; }
  const cfg = loadConfig();
  const sem = (cfg.graph && cfg.graph.semantic) || {};
  const cap = Number(sem.perDayUsd) || 1;
  const spent = graphSpendToday();
  if (spent >= cap) {
    err.write(`graph-claude: today's graph budget is spent ($${spent.toFixed(4)} of $${cap}); the rest waits for the next run\n`);
    return 1;
  }
  let input = '';
  try { input = String(readStdin()); } catch { input = ''; }
  const cwd = mkTemp();
  try {
    const r = await codexCall({
      system: SYSTEM, prompt: input, model: (cfg.codex && typeof cfg.codex.model === 'string' && cfg.codex.model) || null,
      effort: 'low', timeoutMs: CALL_TIMEOUT_MS, cwd, feature: 'graph:semantic', bin: env.AOS_GRAPH_CODEX_BIN,
    });
    out.write(JSON.stringify(codexEnvelope(r)));
    return 0;
  } catch (e) {
    err.write(`graph-claude: codex exec failed: ${e.message}\n`);
    return 1;
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function main(argv = process.argv.slice(2), io = {}) {
  const { env = process.env, spawn = spawnSync, readStdin = () => fs.readFileSync(0), out = process.stdout, err = process.stderr } = io;
  if (env.AOS_GRAPH_RUNNER === 'codex') {
    if (!env.AOS_GRAPH_CODEX_BIN) { err.write('graph-claude: AOS_GRAPH_CODEX_BIN is not set (run through graph-build.js)\n'); return 127; }
    return codexLeg(argv, {
      env, readStdin, out, err,
      codexCall: io.codexCall || require('./sdk/lib/codex-cli.js').codexCall,
      mkTemp: io.mkTemp || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-graph-codex-'))),
    });
  }
  const real = env.AOS_GRAPH_CLAUDE_BIN;
  if (!real) { err.write('graph-claude: AOS_GRAPH_CLAUDE_BIN is not set (run through graph-build.js)\n'); return 127; }
  if (argv.some((a) => PASS_THROUGH.has(a))) {
    const r = spawn(real, argv, { env: childEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.stdout) out.write(r.stdout);
    if (r.stderr) err.write(r.stderr);
    return typeof r.status === 'number' ? r.status : 1;
  }
  const cfg = loadConfig();
  const sem = (cfg.graph && cfg.graph.semantic) || {};
  const cap = Number(sem.perDayUsd) || 1;
  const spent = graphSpendToday();
  if (spent >= cap) {
    err.write(`graph-claude: today's graph budget is spent ($${spent.toFixed(4)} of $${cap}); the rest waits for the next run\n`);
    return 1;
  }
  const model = (cfg.claude && cfg.claude.model) || 'haiku';
  let input = '';
  try { input = readStdin(); } catch { input = ''; }
  const started = Date.now();
  const r = spawn(real, rewriteArgs(argv, { model, perCallUsd: Number(sem.perCallUsd) || 0.25 }), {
    env: childEnv(env), input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CALL_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (r.stdout) out.write(r.stdout);
  if (r.stderr) err.write(r.stderr);
  if (r.error) { err.write(`graph-claude: ${r.error.message}\n`); return 1; }
  let o = null;
  try { o = JSON.parse(r.stdout); } catch { o = null; }
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const u = (o.usage && typeof o.usage === 'object') ? o.usage : {};
    recordSpend({
      feature: 'graph:semantic', provider: 'claude', model, usd: Number(o.total_cost_usd) || 0,
      inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
      outputTokens: u.output_tokens == null ? null : Number(u.output_tokens),
      ms: typeof o.duration_api_ms === 'number' ? o.duration_api_ms : Date.now() - started,
    });
  }
  return typeof r.status === 'number' ? r.status : 1;
}

if (require.main === module) Promise.resolve(main()).then((code) => { process.exitCode = code; });

module.exports = { main, rewriteArgs, childEnv, codexEnvelope, SYSTEM };
