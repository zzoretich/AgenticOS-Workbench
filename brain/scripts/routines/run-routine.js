#!/usr/bin/env node
'use strict';
/**
 * run-routine.js — the single entrypoint every scheduled routine runs through (spec D5).
 *
 *   node brain/scripts/routines/run-routine.js <slug> [--manual] [--dry-run]
 *
 * Loads <vault>/brain/routines/<slug>.md, then by kind:
 *   duty     sh <vault>/brain/scripts/persona/run-duty.sh <slug>   (its own kill switch, caps, journal, contract);
 *            `budgetUsd` and `tools` in the routine file become PERSONA_MAX_USD and PERSONA_TOOLS for that run
 *   prompt   <claude> -p <body> --model … --effort … --allowedTools <routines.tools> --max-budget-usd …
 *            gated by routines.perDayUsd over today's routine:* ledger rows; the run is ledgered as routine:<slug>
 *   command  argv[0] argv.slice(1) — spawned directly (no shell), cwd = vault; `{{NODE}}` in an argv entry expands to
 *            this process.execPath and `{{VAULT}}` to the vault, so a template routine needs no per-machine rendering
 * Always: one entry in brain/_index/routines.json (lastRunAt, lastExit, lastCostUsd, lastDurationMs, failStreak,
 * lastTrigger, lastError), one pipelines.json row named routine:<slug>, and stdout/stderr appended to
 * <log dir>/routine-<slug>.log. The exit code mirrors the child's. A disabled routine (or routines.enabled=false)
 * exits 0 without running and records a skip. This is not a hook: it runs under launchd/cron, so no hook-entry
 * prologue — but the prompt child gets AOS_HEADLESS=1 exactly like every other `claude -p` the brain spawns.
 * Every external call is injectable for tests (deps).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TRIGGERS = ['scheduled', 'manual'];
const DEFAULT_TIMEOUT_SEC = 1800;
const TAIL_CHARS = 400;

function tail(text, n = TAIL_CHARS) { const s = String(text || '').trim(); return s.length > n ? s.slice(-n) : s; }
function n(v, d) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d; }

function defaultDeps() {
  const { PATHS } = require('../lib/paths.js');
  const store = require('../lib/routines-store.js');
  const { loadConfig } = require('../lib/config.js');
  const { withReport } = require('../lib/pipeline-report.js');
  const ledger = require('../sdk/lib/spend-ledger.js');
  const { resolveClaudeBin } = require('../sdk/lib/claude-cli.js');
  const { parseClaudeJson, rowFrom } = require('../persona/record-spend.js');
  return {
    vault: PATHS.VAULT,
    store,
    config: loadConfig,
    withReport,
    spawn: (cmd, args, opts) => spawnSync(cmd, args, opts),
    recordSpend: ledger.recordSpend,
    routineSpendToday: ledger.routineSpendToday,
    claudeBin: () => resolveClaudeBin(),
    parseClaudeJson, rowFrom,
    now: () => new Date(),
    env: process.env,
    logDir: process.env.AOS_ROUTINE_LOG_DIR || process.env.PERSONA_LOG_DIR || path.join(PATHS.VAULT, 'persona', 'journal', 'logs'),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
}

function headlessEnv(base) {
  const env = { ...base, AOS_HEADLESS: '1' };
  delete env.CLAUDECODE;
  return env;
}

/** The `claude -p` argv for a prompt routine; shared by the real run and --dry-run. */
function promptArgs(routine, cfg) {
  const rc = cfg.routines || {};
  const model = routine.model || (cfg.claude && cfg.claude.model) || 'haiku';
  const effort = routine.effort || 'medium';
  const budget = routine.budgetUsd !== undefined ? routine.budgetUsd : n(rc.perRunUsd, 2);
  const tools = typeof rc.tools === 'string' ? rc.tools : 'Read,Glob,Grep';
  return ['-p', routine.body, '--model', model, '--effort', effort, '--allowedTools', tools,
    '--max-budget-usd', String(budget), '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence'];
}

/** `{{NODE}}` → the running node, `{{VAULT}}` → the vault. Only these two; anything else is literal. */
function expandArgv(a, deps) {
  return String(a).split('{{NODE}}').join(deps.node || process.execPath).split('{{VAULT}}').join(deps.vault);
}

/** Plan the child process for a routine: { cmd, args, env, feature } — or { skip: reason }. */
function plan(routine, cfg, deps) {
  const rc = cfg.routines || {};
  if (rc.enabled === false) return { skip: 'routines disabled in config' };
  if (!routine.enabled) return { skip: 'routine disabled' };
  if (routine.kind === 'duty') {
    // A duty's own budget and allowlist (tick.md: 0.05 USD, read-only tools) reach run-duty.sh as the env overrides it
    // already honours; `{{NODE}}`/`{{VAULT}}` in tools expand like argv so the template file works on every machine.
    const env = { ...deps.env };
    if (routine.budgetUsd !== undefined) env.PERSONA_MAX_USD = String(routine.budgetUsd);
    if (typeof routine.tools === 'string' && routine.tools.trim()) env.PERSONA_TOOLS = expandArgv(routine.tools, deps);
    return { cmd: 'sh', args: [path.join(deps.vault, 'brain', 'scripts', 'persona', 'run-duty.sh'), routine.slug], env, feature: `duty:${routine.slug}` };
  }
  if (routine.kind === 'prompt') {
    const perDay = n(rc.perDayUsd, 6);
    const spent = deps.routineSpendToday();
    if (spent >= perDay) return { skip: `daily cap reached (${spent.toFixed(2)} of ${perDay} USD)` };
    const bin = deps.claudeBin();
    if (!bin) return { error: 'no claude binary found (set claude.bin in agenticos.json or install claude)' };
    return { cmd: bin, args: promptArgs(routine, cfg), env: headlessEnv(deps.env), feature: `routine:${routine.slug}` };
  }
  const argv = routine.argv.map(a => expandArgv(a, deps));
  return { cmd: argv[0], args: argv.slice(1), env: { ...deps.env }, feature: null };
}

/** Runs one routine end to end. Returns the exit code. */
async function runRoutine(slug, { trigger = 'scheduled', dryRun = false, deps = defaultDeps() } = {}) {
  if (!TRIGGERS.includes(trigger)) trigger = 'scheduled';
  const routine = deps.store.read(slug);
  if (!routine) { deps.stderr(`run-routine: no routine "${slug}" under brain/routines/\n`); return 2; }
  if (routine.errors.length) { deps.stderr(`run-routine: "${slug}" is invalid: ${routine.errors.join('; ')}\n`); return 2; }
  const cfg = deps.config();
  const p = plan(routine, cfg, deps);
  if (p.error) { deps.stderr(`run-routine: ${p.error}\n`); return 1; }
  if (p.skip) {
    deps.stdout(`run-routine: ${slug} skipped — ${p.skip}\n`);
    deps.store.patchState(slug, (cur) => ({ ...cur, lastSkippedAt: deps.now().toISOString(), lastSkipReason: p.skip }));
    return 0;
  }
  if (dryRun) {
    deps.stdout([p.cmd, ...p.args.map(a => (a === routine.body && routine.kind === 'prompt' ? `<${slug} body>` : a))].join('\n') + '\n');
    return 0;
  }

  const started = deps.now();
  const startedIso = started.toISOString();
  fs.mkdirSync(deps.logDir, { recursive: true });
  const logFile = path.join(deps.logDir, `routine-${slug}.log`);
  const timeoutMs = n(routine.timeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;

  let exit = 1, costUsd = null, lastError = null;
  const run = async (report) => {
    report.provider = routine.kind === 'prompt' ? 'claude' : routine.kind === 'duty' ? 'persona' : 'local';
    let res;
    try {
      res = deps.spawn(p.cmd, p.args, { cwd: deps.vault, env: p.env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    } catch (e) { res = { status: 1, stdout: '', stderr: e.message, error: e }; }
    const stdout = String(res.stdout || ''), stderr = String(res.stderr || '');
    if (res.error && res.error.code === 'ENOENT') exit = 127;
    else if (res.signal) exit = 124;   // timeout (SIGTERM) or killed
    else exit = typeof res.status === 'number' ? res.status : 1;
    if (res.signal === 'SIGTERM' && timeoutMs) lastError = `timed out after ${routine.timeoutSec || DEFAULT_TIMEOUT_SEC}s`;
    else if (exit !== 0) lastError = tail(stderr) || (res.error && res.error.message) || `exit ${exit}`;

    if (routine.kind === 'prompt') {
      const json = deps.parseClaudeJson(stdout);
      const row = deps.rowFrom(json, { feature: p.feature, model: p.args[p.args.indexOf('--model') + 1] });
      deps.recordSpend(row);
      costUsd = row.usd;
      if (json && json.is_error) { exit = exit || 1; lastError = lastError || tail(json.result); }
    }
    const stamp = `[${startedIso}] routine=${slug} kind=${routine.kind} trigger=${trigger} exit=${exit}${costUsd != null ? ` usd=${costUsd}` : ''}`;
    fs.appendFileSync(logFile, `${stamp}\n${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr ? `--- stderr ---\n${stderr}${stderr.endsWith('\n') ? '' : '\n'}` : ''}`);
    report.counts.exit = exit;
    if (costUsd != null) report.counts.usd = costUsd;
    if (exit !== 0) { report.status = 'error'; report.reason = lastError; }
  };
  try { await deps.withReport(`routine:${slug}`, run); } catch (e) { exit = exit || 1; lastError = lastError || e.message; }

  const ended = deps.now();
  deps.store.patchState(slug, (cur) => ({
    ...cur,
    lastRunAt: startedIso,
    lastExit: exit,
    lastCostUsd: costUsd,
    lastDurationMs: Math.max(0, ended - started),
    failStreak: exit === 0 ? 0 : (Number(cur.failStreak) || 0) + 1,
    lastTrigger: trigger,
    lastError: exit === 0 ? null : lastError,
  }));
  if (exit !== 0) deps.stderr(`run-routine: ${slug} failed (exit ${exit})${lastError ? `: ${lastError}` : ''}\n`);
  return exit;
}

function main(argv) {
  const slug = argv.find(a => !a.startsWith('--'));
  if (!slug) { process.stderr.write('usage: run-routine.js <slug> [--manual] [--dry-run]\n'); return Promise.resolve(2); }
  return runRoutine(slug, { trigger: argv.includes('--manual') ? 'manual' : 'scheduled', dryRun: argv.includes('--dry-run') });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`run-routine: ${e.message}\n`); process.exit(1); });
module.exports = { runRoutine, plan, promptArgs, expandArgv, main, TRIGGERS };
