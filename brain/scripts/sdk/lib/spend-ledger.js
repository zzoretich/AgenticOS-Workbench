'use strict';
/**
 * spend-ledger.js — the provider layer's shared money + error primitives.
 *   ProviderUnavailable  typed error every provider throws instead of a bare string
 *   recordSpend/spendToday  append-only USD ledger at brain/_index/provider-spend.jsonl
 * Lives apart from provider.js so claude-cli.js can ledger without a require cycle.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../../lib/paths.js');

const SPEND_PATH = path.join(PATHS.INDEX, 'provider-spend.jsonl');

class ProviderUnavailable extends Error {
  /** @param {'PROVIDER_NONE'|'PROVIDER_UNREACHABLE'|'PROVIDER_CAP'} code */
  constructor(code, message, provider = 'none') {
    super(message || code);
    this.name = 'ProviderUnavailable';
    this.code = code;
    this.provider = provider;
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function readRows() {
  let raw;
  try { raw = fs.readFileSync(SPEND_PATH, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line — skip */ }
  }
  return rows;
}

function recordSpend({ feature, provider, model, usd, inputTokens, outputTokens, ms }) {
  const row = {
    ts: new Date().toISOString(),
    feature: feature || 'unknown',
    provider: provider || 'claude',
    model: model || null,
    usd: Number(usd) || 0,
    inputTokens: inputTokens == null ? null : Number(inputTokens),
    outputTokens: outputTokens == null ? null : Number(outputTokens),
    ms: ms == null ? null : Number(ms),
  };
  fs.mkdirSync(path.dirname(SPEND_PATH), { recursive: true });
  fs.appendFileSync(SPEND_PATH, JSON.stringify(row) + '\n');
  return row;
}

/**
 * USD spent on the local calendar day of `now` (default: now) by the rows the hook cap
 * (`claude.perDayUsd`) governs. Rows whose `feature` matches `exclude` are skipped — by
 * default the persona's `duty:*` runs, which the persona layer gates separately against
 * `persona.perDayUsd` (up to $2 each would otherwise blow the $0.50 hook cap on the first
 * duty of the day). The Obsidian Chat tab's `chat` rows stay counted. `exclude: null`
 * sums every row.
 */
function spendToday(now = new Date(), { exclude = /^duty:/ } = {}) {
  const day = localDay(now);
  let sum = 0;
  for (const r of readRows()) {
    const t = new Date(r.ts);
    if (Number.isNaN(t.getTime()) || localDay(t) !== day) continue;
    if (exclude && exclude.test(String(r.feature || ''))) continue;
    sum += Number(r.usd) || 0;
  }
  return Math.round(sum * 1e6) / 1e6;
}

module.exports = { ProviderUnavailable, recordSpend, spendToday, SPEND_PATH };
