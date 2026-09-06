'use strict';
/**
 * provider.js — the one model abstraction. Every script asks for a provider and never
 * for Ollama or Claude directly.
 *
 *   ollama  → config.ollama.{host,port}, default 127.0.0.1:11434 (chat + embed)
 *   claude  → headless `claude -p --model <cfg>` via claude-cli.js (chat only; capped + ledgered)
 *   none    → chat/embed throw ProviderUnavailable('PROVIDER_NONE'); callers fall back to heuristics
 *
 * `auto` (the default): Ollama ping (2 s, cached 60 s) → claude if the binary resolves and a
 * login probe succeeds (cached 24 h) → none. A claude provider whose day is over budget
 * resolves to none with reason 'daily-cap' — "budget" is claude.perDayUsd against hook spend
 * only: spendToday() skips the persona's duty:* rows, which persona.perDayUsd governs.
 * State lives in brain/_index/provider-state.json, spend in
 * brain/_index/provider-spend.jsonl (spend-ledger.js).
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../lib/paths.js');
const { loadConfig } = require('../../lib/config.js');
const ollama = require('./ollama.js');
const embedModule = require('./embed.js');
const claudeCli = require('./claude-cli.js');
const { ProviderUnavailable, recordSpend, spendToday, SPEND_PATH } = require('./spend-ledger.js');

const STATE_PATH = path.join(PATHS.INDEX, 'provider-state.json');
const OLLAMA_TTL_MS = 60_000;
const CLAUDE_TTL_MS = 24 * 60 * 60 * 1000;

function readState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); return s && typeof s === 'object' ? s : {}; }
  catch { return {}; }
}
function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
    fs.renameSync(tmp, STATE_PATH);
  } catch { /* state is a cache; losing it only costs a re-probe */ }
}
function isFresh(entry, ttlMs, now) {
  return !!(entry && entry.checkedAt && (now - Date.parse(entry.checkedAt)) < ttlMs);
}

/** ollama.chat opts → one prompt string for `claude -p`. */
function messagesToPrompt(opts) {
  if (opts.prompt != null && opts.prompt !== '') return String(opts.prompt);
  return (Array.isArray(opts.messages) ? opts.messages : []).map((m) => `${m.role}: ${m.content}`).join('\n');
}

/** cfg.ollama ({ host, port }) rides along on every call so config, not just env, picks the address. */
function makeOllama(reason, cfg) {
  const net = (cfg && cfg.ollama) || {};
  return {
    name: 'ollama', reason,
    capabilities: { chat: true, embed: true, structured: true },
    chat: (opts = {}) => ollama.chat({ ...net, ...opts }),
    // postEmbed is the raw HTTP path; embed.js's default postFn routes back through getProvider().
    embed: (texts, opts = {}) => embedModule.embed(texts, { ...net, ...opts, postFn: opts.postFn || embedModule.postEmbed }),
    ping: () => ollama.ping(2000, net),
  };
}

function makeClaude(reason, cfg, deps) {
  const call = deps.claudeCall || claudeCli.claudeCall;
  const spent = deps.spendToday || spendToday;
  return {
    name: 'claude', reason,
    capabilities: { chat: true, embed: false, structured: true },
    async chat(opts = {}) {
      if (spent() >= cfg.claude.perDayUsd) {
        throw new ProviderUnavailable('PROVIDER_CAP', `daily hook cap of ${cfg.claude.perDayUsd} USD reached (claude.perDayUsd; duty:* spend excluded)`, 'claude');
      }
      const schema = opts.schema || (opts.format === 'json' ? { type: 'object' } : undefined);
      const r = await call({
        system: opts.system || '', prompt: messagesToPrompt(opts), schema,
        model: cfg.claude.model, maxBudgetUsd: cfg.claude.perCallUsd,
        timeoutMs: opts.timeoutMs || 120000, feature: opts.feature || 'unknown',
      });
      if (schema && r.structured != null) return JSON.stringify(r.structured);
      return r.text;
    },
    embed: () => Promise.reject(new ProviderUnavailable('PROVIDER_NONE', 'the claude provider has no embeddings', 'claude')),
    ping: async () => true,
  };
}

function makeNone(reason) {
  const refuse = () => Promise.reject(new ProviderUnavailable('PROVIDER_NONE', `no model provider (${reason})`, 'none'));
  return {
    name: 'none', reason,
    capabilities: { chat: false, embed: false, structured: false },
    chat: refuse, embed: refuse, ping: async () => false,
  };
}

async function resolveProvider({ mode, feature = 'unknown', deps = {} } = {}) {
  const cfg = loadConfig();
  const m = mode || cfg.provider || 'auto';
  const now = deps.now ? deps.now() : Date.now();
  const state = readState();
  const pingFn = deps.ping || ollama.ping;
  const resolveBin = deps.resolveClaudeBin || claudeCli.resolveClaudeBin;
  const probe = deps.loginProbe || claudeCli.loginProbe;
  const spent = deps.spendToday || spendToday;
  const iso = new Date(now).toISOString();

  let chosen;
  if (m === 'ollama') chosen = makeOllama('forced', cfg);
  else if (m === 'none') chosen = makeNone('forced');
  else {
    let ollamaOk = false;
    if (m === 'auto') {
      if (isFresh(state.ollama, OLLAMA_TTL_MS, now)) ollamaOk = !!state.ollama.reachable;
      else {
        ollamaOk = await pingFn(2000, cfg.ollama);
        state.ollama = { reachable: ollamaOk, checkedAt: iso };
      }
    }
    if (ollamaOk) chosen = makeOllama('ollama-reachable', cfg);
    else {
      let loggedIn = false;
      let bin = null;
      if (isFresh(state.claude, CLAUDE_TTL_MS, now)) {
        loggedIn = !!state.claude.loggedIn;
        bin = state.claude.bin || null;
      } else {
        bin = resolveBin();
        // The probe runs inside hooks (SessionEnd included), so it is capped well below
        // loginProbe's own 60 s default: a login that has not answered in 10 s is a "no"
        // for this run, and the 24 h cache means the wait is paid at most once a day.
        loggedIn = bin ? await probe({ bin, timeoutMs: deps.probeTimeoutMs || 10_000 }) : false;
        state.claude = { loggedIn, checkedAt: iso, bin };
      }
      if (!loggedIn) chosen = makeNone(bin ? 'claude-not-logged-in' : 'no-provider');
      else if (spent() >= cfg.claude.perDayUsd) chosen = makeNone('daily-cap');
      else chosen = makeClaude(m === 'claude' ? 'forced' : 'claude-logged-in', cfg, deps);
    }
  }
  state.checkedAt = iso;
  state.name = chosen.name;
  state.reason = chosen.reason;
  state.feature = feature;
  writeState(state);
  return chosen;
}

let memo = null;
/** Memoized per process: the first call resolves, later calls share the promise. */
function getProvider(feature = 'unknown') {
  if (!memo) memo = resolveProvider({ feature });
  return memo;
}
function resetProviderCache() { memo = null; }

module.exports = {
  resolveProvider, getProvider, resetProviderCache, STATE_PATH,
  ProviderUnavailable, recordSpend, spendToday, SPEND_PATH,
};
