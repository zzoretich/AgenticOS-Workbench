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
 * only: spendToday() skips the persona's duty:* rows (persona.perDayUsd), the reasoner's
 * reason:* rows (reasoner.perDayUsd) and prompt routines' routine:* rows (routines.perDayUsd).
 *
 * Roles (models.js) can override the chain: getProviderForRole('reasoner') always resolves the
 * claude provider — built with reasoner.model, reasoner.perCallUsd and reasoner.perDayUsd — even
 * while Ollama is up, because the reasoner is a Claude model. `provider: none` still wins: it
 * means nothing calls a model. Every other role gets the global provider.
 *
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
const { role, providerFor, thinkFor } = require('./models.js');
const { ProviderUnavailable, recordSpend, spendToday, reasonSpendToday, routineSpendToday, SPEND_PATH } = require('./spend-ledger.js');

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

/**
 * The two Claude budgets. `hookBudget` is what the auto chain hands out (claude.*, hook spend);
 * `reasonerBudget` is the reasoner role's (reasoner.*, reason:* spend). A budget carries the
 * model, both caps, the ledger sum that governs the daily cap, and the config key named in the
 * cap error so the message says which knob to turn.
 */
function hookBudget(cfg, deps = {}) {
  return {
    model: cfg.claude.model, perCallUsd: cfg.claude.perCallUsd, perDayUsd: cfg.claude.perDayUsd,
    spent: deps.spendToday || spendToday, capKey: 'claude.perDayUsd', label: 'daily hook cap', effort: undefined,
  };
}
function reasonerBudget(cfg, deps = {}) {
  const r = cfg.reasoner || {};
  return {
    model: role('reasoner', cfg).tag, perCallUsd: Number(r.perCallUsd) || 0.5, perDayUsd: Number(r.perDayUsd) || 5,
    spent: deps.reasonSpendToday || reasonSpendToday, capKey: 'reasoner.perDayUsd', label: 'daily reasoner cap',
    effort: thinkFor('reasoner', undefined, cfg),
  };
}

function makeClaude(reason, budget, deps = {}) {
  const call = deps.claudeCall || claudeCli.claudeCall;
  return {
    name: 'claude', reason, model: budget.model,
    capabilities: { chat: true, embed: false, structured: true },
    async chat(opts = {}) {
      if (budget.spent() >= budget.perDayUsd) {
        throw new ProviderUnavailable('PROVIDER_CAP', `${budget.label} of ${budget.perDayUsd} USD reached (${budget.capKey})`, 'claude');
      }
      const schema = opts.schema || (opts.format === 'json' ? { type: 'object' } : undefined);
      // `effort` is only meaningful for the reasoner: the caller's dial, else the budget's default.
      const effort = claudeCli.EFFORTS.includes(opts.think) ? opts.think : budget.effort;
      const r = await call({
        system: opts.system || '', prompt: messagesToPrompt(opts), schema,
        model: budget.model, maxBudgetUsd: budget.perCallUsd, effort,
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

/**
 * Is headless Claude usable? Binary + login probe, cached 24 h in state.claude. The probe runs
 * inside hooks (SessionEnd included), so it is capped well below loginProbe's own 60 s default:
 * a login that has not answered in 10 s is a "no" for this run, and the cache means the wait is
 * paid at most once a day. Mutates `state.claude`; the caller writes the state file.
 */
async function resolveClaudeLogin(state, now, iso, deps) {
  const resolveBin = deps.resolveClaudeBin || claudeCli.resolveClaudeBin;
  const probe = deps.loginProbe || claudeCli.loginProbe;
  if (isFresh(state.claude, CLAUDE_TTL_MS, now)) {
    return { loggedIn: !!state.claude.loggedIn, bin: state.claude.bin || null };
  }
  const bin = resolveBin();
  const loggedIn = bin ? await probe({ bin, timeoutMs: deps.probeTimeoutMs || 10_000 }) : false;
  state.claude = { loggedIn, checkedAt: iso, bin };
  return { loggedIn, bin };
}

async function resolveProvider({ mode, feature = 'unknown', deps = {} } = {}) {
  const cfg = loadConfig();
  const m = mode || cfg.provider || 'auto';
  const now = deps.now ? deps.now() : Date.now();
  const state = readState();
  const pingFn = deps.ping || ollama.ping;
  const iso = new Date(now).toISOString();
  const budget = hookBudget(cfg, deps);

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
      const { loggedIn, bin } = await resolveClaudeLogin(state, now, iso, deps);
      if (!loggedIn) chosen = makeNone(bin ? 'claude-not-logged-in' : 'no-provider');
      else if (budget.spent() >= budget.perDayUsd) chosen = makeNone('daily-cap');
      else chosen = makeClaude(m === 'claude' ? 'forced' : 'claude-logged-in', budget, deps);
    }
  }
  state.checkedAt = iso;
  state.name = chosen.name;
  state.reason = chosen.reason;
  state.feature = feature;
  writeState(state);
  return chosen;
}

/**
 * The provider for one role. Roles served by Ollama take the global chain; the reasoner takes
 * headless Claude with its own model and caps whatever the global answer is (Ollama being up
 * does not make a Claude model local). `provider: none` disables it like everything else. The
 * state file's `name`/`reason` keep describing the global provider — only the claude login
 * cache is shared — so the HUD and `aos status` are not misled by a reasoner resolution.
 */
async function resolveProviderForRole({ role: roleName, feature = 'unknown', deps = {} } = {}) {
  if (providerFor(roleName) !== 'claude') return resolveProvider({ feature, deps });
  const cfg = loadConfig();
  if ((cfg.provider || 'auto') === 'none') return makeNone('forced');
  const now = deps.now ? deps.now() : Date.now();
  const iso = new Date(now).toISOString();
  const state = readState();
  const budget = roleName === 'reasoner' ? reasonerBudget(cfg, deps) : hookBudget(cfg, deps);
  const { loggedIn, bin } = await resolveClaudeLogin(state, now, iso, deps);
  writeState(state);
  if (!loggedIn) return makeNone(bin ? 'claude-not-logged-in' : 'no-provider');
  if (budget.spent() >= budget.perDayUsd) return makeNone(`${roleName}-daily-cap`);
  return makeClaude(`role:${roleName}`, budget, deps);
}

let memo = null;
const roleMemo = new Map();
/** Memoized per process: the first call resolves, later calls share the promise. */
function getProvider(feature = 'unknown') {
  if (!memo) memo = resolveProvider({ feature });
  return memo;
}
/** Memoized per role and process. Ollama-served roles share getProvider()'s promise. */
function getProviderForRole(roleName, feature = 'unknown') {
  if (providerFor(roleName) !== 'claude') return getProvider(feature);
  if (!roleMemo.has(roleName)) roleMemo.set(roleName, resolveProviderForRole({ role: roleName, feature }));
  return roleMemo.get(roleName);
}
function resetProviderCache() { memo = null; roleMemo.clear(); }

module.exports = {
  resolveProvider, getProvider, resolveProviderForRole, getProviderForRole, resetProviderCache, STATE_PATH,
  ProviderUnavailable, recordSpend, spendToday, reasonSpendToday, routineSpendToday, SPEND_PATH,
};
