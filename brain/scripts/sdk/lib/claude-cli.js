'use strict';
/**
 * claude-cli.js — the ONLY place the brain spawns `claude -p`.
 *
 * Recipe (measured 2026-09-04): every flag below is load-bearing.
 *   --setting-sources ""   the user's settings/hooks/CLAUDE.md are NOT loaded (without it a
 *                          call pulled ~45k tokens of context and fired the user's own hooks)
 *   --strict-mcp-config    no MCP servers
 *   --tools ""             no tools
 *   --no-session-persistence
 *   --max-budget-usd       hard per-call cap
 *   --output-format json   one JSON object on stdout: result, structured_output, total_cost_usd, usage, duration_api_ms
 * The child always gets AOS_HEADLESS=1 (hook scripts exit at once — lib/hook-entry.js) and
 * never inherits CLAUDECODE. `--bare` is deliberately absent: it skips OAuth and fails for
 * logged-in users.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { PATHS } = require('../../lib/paths.js');
const { ProviderUnavailable, recordSpend } = require('./spend-ledger.js');

const NOT_LOGGED_IN = /not logged in/i;
const DEFAULT_CANDIDATES = [path.join(os.homedir(), '.local', 'bin', 'claude')];

function defaultLookup() {
  try {
    const out = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

/** PATH (`command -v claude`) first, then ~/.local/bin/claude, else null. */
function resolveClaudeBin(opts = {}) {
  const found = (opts.lookup || defaultLookup)();
  if (found) return found;
  for (const c of opts.candidates || DEFAULT_CANDIDATES) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

function buildArgs({ prompt, model, system, schema, maxBudgetUsd }) {
  const args = ['-p', String(prompt ?? ''), '--model', String(model), '--tools', '', '--setting-sources', '',
    '--strict-mcp-config', '--no-session-persistence', '--system-prompt', String(system ?? '')];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  args.push('--max-budget-usd', String(maxBudgetUsd), '--output-format', 'json');
  return args;
}

function headlessEnv(base = process.env) {
  const env = { ...base, AOS_HEADLESS: '1' };
  delete env.CLAUDECODE;
  return env;
}

function runClaude({ bin, args, cwd, timeoutMs, spawnFn }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawnFn(bin, args, { cwd, env: headlessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const handleStreamError = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(e); };
    child.stdout.on('error', handleStreamError);
    child.stderr.on('error', handleStreamError);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`claude -p timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/**
 * One headless call. Resolves { text, structured, usd, usage, ms }; every successful call
 * AND every billed failure is appended to the spend ledger. "Not logged in" anywhere in the
 * output → ProviderUnavailable('PROVIDER_UNREACHABLE').
 */
async function claudeCall({
  system = '', prompt, schema, model = 'haiku', maxBudgetUsd = 0.05, timeoutMs = 120000,
  cwd = PATHS.VAULT, feature = 'unknown', bin, spawnFn,
} = {}) {
  const exe = bin || resolveClaudeBin();
  if (!exe) throw new ProviderUnavailable('PROVIDER_UNREACHABLE', 'claude CLI not found on PATH or in ~/.local/bin', 'claude');
  const args = buildArgs({ prompt, model, system, schema, maxBudgetUsd });
  const { code, stdout, stderr, ms } = await runClaude({ bin: exe, args, cwd, timeoutMs, spawnFn: spawnFn || spawn });
  if (NOT_LOGGED_IN.test(stdout + '\n' + stderr)) {
    throw new ProviderUnavailable('PROVIDER_UNREACHABLE', 'claude CLI: Not logged in (run `claude login`)', 'claude');
  }
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  const obj = parsed && typeof parsed === 'object' ? parsed : null;
  const usage = obj && obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  const usd = obj ? Number(obj.total_cost_usd) || 0 : 0;
  const apiMs = obj && typeof obj.duration_api_ms === 'number' ? obj.duration_api_ms : ms;
  const ledger = () => recordSpend({ feature, provider: 'claude', model, usd,
    inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, ms: apiMs });
  // A BILLED result is ledgered before success/failure is decided: a failed result can still
  // carry cost (subtype error_max_budget does), and spendToday() must not under-count it.
  // A cost-free result is ledgered only on the success path, so the non-JSON, non-zero-exit
  // and "Not logged in" paths — nothing to record — stay out of the ledger.
  if (usd > 0) ledger();
  if (code !== 0 || !obj) {
    throw new Error(`claude -p exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  if (obj.is_error) {
    throw new Error(`claude -p error (${obj.subtype || 'unknown'}): ${String(obj.result || '').slice(0, 300)}`);
  }
  if (usd === 0) ledger();
  return {
    text: typeof obj.result === 'string' ? obj.result : '',
    structured: obj.structured_output === undefined ? null : obj.structured_output,
    usd,
    usage,
    ms: apiMs,
  };
}

/** One cheap call; true iff it returns a result. Any failure (not logged in, no binary, timeout) → false. */
async function loginProbe(opts = {}) {
  const bin = opts.bin === undefined ? resolveClaudeBin(opts) : opts.bin;
  if (!bin) return false;
  try {
    await claudeCall({
      system: 'You are a liveness probe. Reply with exactly one word.',
      prompt: 'Reply with the word ok.',
      model: opts.model || 'haiku', maxBudgetUsd: 0.01, timeoutMs: opts.timeoutMs || 60000,
      feature: 'login-probe', bin, spawnFn: opts.spawnFn,
    });
    return true;
  } catch { return false; }
}

module.exports = { resolveClaudeBin, loginProbe, claudeCall, buildArgs, headlessEnv, NOT_LOGGED_IN };
