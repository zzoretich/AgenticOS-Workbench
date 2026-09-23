'use strict';
/**
 * codex-cli.js — the ONLY place the brain spawns `codex exec`. The Codex twin of claude-cli.js.
 *
 * Recipe (measured 2026-09-21 against codex-cli 0.144.5; the spike results live in the design plan):
 *   exec -                    the prompt arrives on stdin, which is then CLOSED: an open non-TTY stdin
 *                             makes `codex exec` block on "Reading additional input" forever
 *   --ephemeral               no rollout on disk, so nothing to sweep, wrap or cost twice
 *   --skip-git-repo-check     the vault is not a git checkout the CLI has to trust
 *   -s read-only              a background question never edits anything
 *   -c features.hooks=false   our own SessionStart/Stop hooks must not re-enter the pipeline
 *   --json                    JSONL on stdout: thread.started, turn.started, item.*, turn.completed{usage}
 *   -o <file>                 the final message verbatim (stdout carries only events)
 *   -m <model>                only when codex.model is set; otherwise the user's Codex default
 *   --output-schema <file>    structured replies; the final message is then JSON
 * There is no per-call budget flag and no system-prompt flag: the system text is prepended to the
 * prompt, the daily cap is checked before the call (provider.js) and the spend is estimated afterwards
 * from the usage block through codex-pricing.js (Codex reports tokens, never dollars). The child always
 * gets AOS_HEADLESS=1 and never inherits CLAUDECODE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { PATHS } = require('../../lib/paths.js');
const { loadConfig } = require('../../lib/config.js');
const { hostDirs } = require('../../lib/host.js');
const { ProviderUnavailable, recordSpend } = require('./spend-ledger.js');
const { priceUsd } = require('./codex-pricing.js');

const NOT_LOGGED_IN = /not logged in|run `?codex login/i;
const DEFAULT_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex')];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function defaultLookup() {
  try {
    const out = execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

function isExecutableFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** agenticos.json `hosts.codex.bin` (else the legacy `codex.bin`), read through loadConfig(); null when unset. */
function recordedBin() {
  let cfg = null;
  try { cfg = loadConfig(); } catch { return null; }
  const h = cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.bin;
  const c = cfg && cfg.codex && cfg.codex.bin;
  const b = h || c;
  return typeof b === 'string' && b ? b : null;
}

/** agenticos.json `hosts.codex.home` (what `aos init` recorded), or null: headless calls use the same Codex home. */
function recordedHome() {
  let cfg = null;
  try { cfg = loadConfig(); } catch { return null; }
  const h = cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.home;
  return typeof h === 'string' && h ? h : null;
}

/** Recorded path (while it is still an executable file) → PATH (`command -v codex`) → the usual install
 *  locations, else null. opts.recorded / opts.lookup / opts.candidates override the probes (tests). */
function resolveCodexBin(opts = {}) {
  const recorded = opts.recorded === undefined ? recordedBin() : opts.recorded;
  if (recorded && isExecutableFile(recorded)) return recorded;
  const found = (opts.lookup || defaultLookup)();
  if (found) return found;
  for (const c of opts.candidates || DEFAULT_CANDIDATES) {
    if (isExecutableFile(c)) return c;
  }
  return null;
}

/** The `model = "…"` line at the top of <codex home>/config.toml, for pricing when no model is passed. */
function defaultModelFromConfig(configToml) {
  let text = '';
  try {
    text = fs.readFileSync(configToml || path.join(hostDirs('codex').configDir, 'config.toml'), 'utf8');
  } catch { return null; }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break; // a table header ends the top-level scope
    const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

function buildArgs({ model, effort, schemaFile, outFile }) {
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'features.hooks=false', '--json', '-o', String(outFile)];
  if (model) args.push('-m', String(model));
  if (EFFORTS.includes(effort)) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (schemaFile) args.push('--output-schema', String(schemaFile));
  args.push('-');
  return args;
}

/** Headless, never CLAUDECODE, and the recorded Codex home unless the environment names one already. */
function headlessEnv(base = process.env, codexHome = recordedHome()) {
  const env = { ...base, AOS_HEADLESS: '1' };
  delete env.CLAUDECODE;
  if (codexHome && !env.CODEX_HOME) env.CODEX_HOME = codexHome;
  return env;
}

function runCodex({ bin, args, input, cwd, timeoutMs, spawnFn }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawnFn(bin, args, { cwd, env: headlessEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* gone */ } reject(e); };
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    if (child.stdin) {
      child.stdin.on('error', () => { /* the child may exit before reading; the close handler decides */ });
      child.stdin.end(String(input ?? ''));
    }
    const timer = setTimeout(() => fail(new Error(`codex exec timeout after ${timeoutMs}ms`)), timeoutMs);
    child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/** The `--json` event stream → { usage, lastMessage, errors }. */
function parseEvents(stdout) {
  let usage = null;
  let lastMessage = '';
  const errors = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      usage = {
        inputTokens: ev.usage.input_tokens || 0,
        cachedInputTokens: ev.usage.cached_input_tokens || 0,
        outputTokens: ev.usage.output_tokens || 0,
        reasoningOutputTokens: ev.usage.reasoning_output_tokens || 0,
      };
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
      lastMessage = ev.item.text;
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      errors.push(String((ev.error && ev.error.message) || ev.message || ev.type));
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'error' && ev.item.message) {
      errors.push(String(ev.item.message));
    }
  }
  return { usage, lastMessage, errors };
}

// ── structured output ─────────────────────────────────────────────────────────
// `--output-schema` goes to the Responses API in strict mode (codex_output_schema, strict: true): every object must set
// additionalProperties:false and list every property as required, or the call fails with 400 invalid_json_schema
// (measured live against codex-cli 0.156.1, spec 2026-09-23-codex-parity-gaps D2). The callers' schemas are ordinary
// JSON Schema, so they are converted here, once, for every caller.

/** A schema that only says "some JSON object" (format:'json'): strict mode cannot express it, so it is asked for in words. */
function isLooseSchema(schema) {
  return !!schema && typeof schema === 'object' && schema.type === 'object' && !schema.properties && !schema.items;
}

function nullable(s) {
  if (typeof s.type === 'string') {
    const out = { ...s, type: [s.type, 'null'] };
    if (Array.isArray(s.enum) && !s.enum.includes(null)) out.enum = [...s.enum, null];
    return out;
  }
  if (Array.isArray(s.type)) return s.type.includes('null') ? s : { ...s, type: [...s.type, 'null'] };
  return { anyOf: [s, { type: 'null' }] };
}

/** An ordinary JSON Schema → the strict form: additionalProperties:false everywhere, every property required, an
 *  originally optional one nullable instead (dropNulls takes those nulls out again). */
function strictSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
  const out = { ...s };
  if (out.type === 'object' || out.properties) {
    const props = out.properties || {};
    const req = new Set(Array.isArray(out.required) ? out.required : []);
    out.properties = {};
    for (const [k, v] of Object.entries(props)) out.properties[k] = req.has(k) ? strictSchema(v) : nullable(strictSchema(v));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictSchema(out.items);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(out[k])) out[k] = out[k].map(strictSchema);
  return out;
}

/** The reply to a strict schema with the nulls of originally optional properties removed: the caller sees its own shape. */
function dropNulls(value, schema) {
  if (!schema || typeof schema !== 'object' || value == null) return value;
  if (Array.isArray(value)) return schema.items ? value.map((v) => dropNulls(v, schema.items)) : value;
  if (typeof value !== 'object' || !schema.properties) return value;
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !req.has(k)) continue;
    out[k] = schema.properties[k] ? dropNulls(v, schema.properties[k]) : v;
  }
  return out;
}

/** The first JSON object in a reply: the whole text, a fenced block, or the span from the first "{" to the last "}". */
function parseJsonObject(text) {
  const t = String(text || '').trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a !== -1 && b > a) tries.push(t.slice(a, b + 1));
  for (const x of tries) { try { const v = JSON.parse(x); if (v && typeof v === 'object') return v; } catch { /* next */ } }
  return null;
}

const JSON_ONLY = 'Reply with one JSON object only: no prose before or after it, no code fences.';

/**
 * One headless call. Resolves { text, structured, usd, usage, ms, model }; every call that returned a
 * usage block is appended to the spend ledger (provider 'codex'), success or not. "Not logged in" on a
 * failed call → ProviderUnavailable('PROVIDER_UNREACHABLE').
 */
async function codexCall({
  system = '', prompt, schema, model = null, timeoutMs = 120000,
  cwd = PATHS.VAULT, feature = 'unknown', bin, spawnFn, effort, pricingModel,
} = {}) {
  const exe = bin || resolveCodexBin();
  if (!exe) throw new ProviderUnavailable('PROVIDER_UNREACHABLE', 'codex CLI not found on PATH or in the usual install locations', 'codex');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-codex-'));
  const outFile = path.join(tmp, 'last-message.txt');
  let schemaFile = null;
  try {
    const loose = isLooseSchema(schema);
    if (schema && !loose) {
      schemaFile = path.join(tmp, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(schema)));
    }
    const args = buildArgs({ model, effort, schemaFile, outFile });
    const body = loose ? `${prompt ?? ''}\n\n${JSON_ONLY}` : String(prompt ?? '');
    const input = system ? `${system}\n\n---\n\n${body}` : body;
    const { code, stdout, stderr, ms } = await runCodex({ bin: exe, args, input, cwd, timeoutMs, spawnFn: spawnFn || spawn });
    const { usage, lastMessage, errors } = parseEvents(stdout);
    let text = '';
    try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = lastMessage; }
    text = String(text || '').trim();
    const priced = pricingModel || model || defaultModelFromConfig() || null;
    const usd = usage ? priceUsd(priced, usage) : 0;
    if (usage) {
      recordSpend({ feature, provider: 'codex', model: priced || 'codex-default', usd,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ms });
    }
    if (code !== 0 && NOT_LOGGED_IN.test(stdout + '\n' + stderr)) {
      throw new ProviderUnavailable('PROVIDER_UNREACHABLE', 'codex CLI: not logged in (run `codex login`)', 'codex');
    }
    if (code !== 0) {
      throw new Error(`codex exec exited ${code}: ${(errors.join(' | ') || stderr || stdout).trim().slice(0, 300)}`);
    }
    let structured = null;
    if (schema && text) {
      structured = parseJsonObject(text);
      if (structured && !loose) structured = dropNulls(structured, schema);
    }
    return { text, structured, usd, usage: usage || {}, ms, model: priced };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** `codex login status` → true iff it reports a login. No model call, no cost. Any failure → false. */
function loginProbe(opts = {}) {
  const bin = opts.bin === undefined ? resolveCodexBin(opts) : opts.bin;
  if (!bin) return Promise.resolve(false);
  const exec = opts.execFn || execFile;
  return new Promise((resolve) => {
    try {
      exec(bin, ['login', 'status'], { timeout: opts.timeoutMs || 10000, env: headlessEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`;
        if (err || NOT_LOGGED_IN.test(out)) return resolve(false);
        resolve(/logged in/i.test(out));
      });
    } catch { resolve(false); }
  });
}

module.exports = { resolveCodexBin, loginProbe, codexCall, buildArgs, headlessEnv, parseEvents, defaultModelFromConfig, strictSchema, dropNulls, parseJsonObject, isLooseSchema, NOT_LOGGED_IN, EFFORTS };
