#!/usr/bin/env node
'use strict';
/**
 * record-spend.js — duty spend → provider ledger, plus the daily-cap check run-duty.sh
 * consults before starting a duty. Contract §1/§6: persona.perDayUsd gates duties by
 * summing only ledger rows whose feature starts with "duty:"; persona.perDutyUsd is one
 * run's --max-budget-usd; claude.perDayUsd belongs to background hook calls, not duties.
 *
 *   node persona/record-spend.js --check
 *       prints {allowed, spentToday, perDayUsd, perDutyUsd}; exit 0 when allowed, 3 when capped
 *   node persona/record-spend.js --file <claude-json> --feature duty:<name> --model <model>
 *       parses `claude -p --output-format json` output and appends one ledger row
 *
 * Rows go through sdk/lib/provider.js recordSpend when that module loads; otherwise they are
 * appended to <vault>/brain/_index/provider-spend.jsonl with the same row shape. The duty sum
 * is always read from that file with dutySpendFrom(): provider.spendToday() sums the hook rows
 * only (it excludes duty:* by default — contract §3), so it cannot serve as the duty cap.
 */
const fs = require('fs');
const path = require('path');

/** Last line that parses as a JSON object (claude may print stray lines first). */
function parseClaudeJson(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && typeof o === 'object') return o; } catch { /* try the previous line */ }
  }
  return null;
}

function rowFrom(json, { feature, model, provider = 'claude' }) {
  const usage = (json && json.usage) || {};
  return {
    ts: new Date().toISOString(),
    feature, provider, model,
    usd: Number(json && json.total_cost_usd) || 0,
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    ms: Number(json && (json.duration_api_ms || json.duration_ms)) || 0,
  };
}

function check({ spendToday, perDayUsd }) {
  const spentToday = spendToday();
  return { allowed: spentToday < perDayUsd, spentToday, perDayUsd };
}

/** USD sum of ledger rows whose feature starts with "duty:" and whose ts is on `day` (local calendar day). */
function dutySpendFrom(text, day = new Date()) {
  const key = day.toDateString();
  let sum = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.feature !== 'string' || !r.feature.startsWith('duty:')) continue;
    if (new Date(r.ts).toDateString() !== key) continue;
    sum += Number(r.usd) || 0;
  }
  return sum;
}

function provider() {
  try { return require('../sdk/lib/provider.js'); } catch { return null; }   // Plan 2 module; absent → local fallback
}
function ledgerPath() {
  const p = provider();
  if (p && typeof p.SPEND_PATH === 'string') return p.SPEND_PATH;
  return path.join(require('../lib/paths.js').PATHS.INDEX, 'provider-spend.jsonl');
}
/** Appends one row and returns the row as written — provider.recordSpend re-stamps `ts`, so the printed row
 *  must be its return value, not the input (execution amendment 2026-09-15, A27). */
function recordSpend(row) {
  const p = provider();
  if (p && typeof p.recordSpend === 'function') return p.recordSpend(row) || row;
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}
function dutySpendToday() {
  try { return dutySpendFrom(fs.readFileSync(ledgerPath(), 'utf8')); } catch { return 0; }   // no ledger yet
}
function caps() {
  let persona = {};
  try { persona = require('../lib/config.js').loadConfig().persona || {}; } catch { /* contract defaults below */ }
  return { perDayUsd: Number(persona.perDayUsd) || 6, perDutyUsd: Number(persona.perDutyUsd) || 2 };
}

function main(argv) {
  const arg = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
  if (argv.includes('--check')) {
    const { perDayUsd, perDutyUsd } = caps();
    const r = { ...check({ spendToday: dutySpendToday, perDayUsd }), perDutyUsd };
    process.stdout.write(JSON.stringify(r) + '\n');
    return r.allowed ? 0 : 3;
  }
  const file = arg('--file');
  if (!file) { process.stderr.write('usage: record-spend.js --check | --file <json> --feature duty:<name> --model <model>\n'); return 2; }
  const json = parseClaudeJson(fs.readFileSync(file, 'utf8'));
  const row = rowFrom(json, { feature: arg('--feature') || 'duty:unknown', model: arg('--model') || 'unknown' });
  const written = recordSpend(row);   // execution amendment 2026-09-15 (A27): print what the ledger wrote
  process.stdout.write(JSON.stringify(written) + '\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseClaudeJson, rowFrom, check, dutySpendFrom };
