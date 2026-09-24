'use strict';
/**
 * runs-log.js — runs.jsonl stays append-only; costs are records of their own (spec 2026-09-24-append-only-runs D2, D3).
 *
 *   brain/_index/agent-runs/runs.jsonl    one row per closed run (telemetry-hook, headless runs): never rewritten,
 *                                         except by retention, under its lock
 *   brain/_index/agent-runs/costs.jsonl   { schema: 1, session_id, cost_usd, cost_source, tokens, at } per costing,
 *                                         appended by cost-sync
 *
 * cost-sync used to rewrite runs.jsonl to patch cost_usd into every row of a session, losing any row appended while it
 * worked and counting a session with two runs twice. Readers now take readRuns(): the rows with the costs laid over
 * them, a session's cost counted once, on its latest session row (the one that ended last). Its other session rows
 * read cost_usd 0 with cost_counted_on naming that row. A session with no cost record keeps the highest cost_usd its
 * rows carry (rows costed before this change), on the same one row. Rows of headless runs keep their own cost.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');
const fsx = require('./fsx.js');

const RUNS_DIR = path.join(PATHS.VAULT, 'brain', '_index', 'agent-runs');
const RUNS_FILE = path.join(RUNS_DIR, 'runs.jsonl');
const COSTS_FILE = path.join(RUNS_DIR, 'costs.jsonl');

function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object') out.push(o); } catch { /* a torn or foreign line */ }
  }
  return out;
}

/** The session a row belongs to: its session_id, else the id of a session row (sess-<uuid>, segment suffix dropped). */
function sessionOf(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.session_id) return String(row.session_id);
  const id = typeof row.id === 'string' ? row.id : '';
  const m = /^sess-(.+?)(?:-s\d+)?$/.exec(id);
  return m ? m[1] : '';
}

/** A session run (telemetry-hook; the Workbench's old sweep copied the same script), not a headless run with its own cost. */
function isSessionRow(row) {
  return row.script === 'session' || (!row.script && /^sess-/.test(String(row.id || '')));
}

/** The newest cost record per session. */
function newestCosts(costRows) {
  const out = new Map();
  for (const c of costRows) {
    if (!c || !c.session_id || typeof c.cost_usd !== 'number') continue;
    const cur = out.get(c.session_id);
    if (!cur || String(c.at || '') >= String(cur.at || '')) out.set(c.session_id, c);
  }
  return out;
}

const endOf = (r) => String(r.ended_at || r.started_at || '');

/** The rows with the cost records laid over them; see the header. Pure; returns new row objects. */
function applyCosts(runRows, costRows) {
  const rows = runRows.map((r) => ({ ...r }));
  const costs = newestCosts(costRows);
  const groups = new Map();
  for (const r of rows) {
    if (!isSessionRow(r)) continue;
    const sid = sessionOf(r);
    if (!sid) continue;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(r);
  }
  for (const [sid, group] of groups) {
    let carrier = group[0];
    for (const r of group) if (endOf(r) >= endOf(carrier)) carrier = r;
    const rec = costs.get(sid);
    let cost = null;
    if (rec) {
      cost = rec.cost_usd;
      carrier.cost_source = rec.cost_source || carrier.cost_source || null;
      if (rec.tokens != null) carrier.tokens = rec.tokens;
      carrier.cost_synced_at = rec.at || carrier.cost_synced_at || null;
    } else {
      for (const r of group) if (typeof r.cost_usd === 'number' && (cost == null || r.cost_usd > cost)) cost = r.cost_usd;
    }
    carrier.cost_usd = cost;
    for (const r of group) {
      if (r === carrier) continue;
      if (typeof cost === 'number') { r.cost_usd = 0; r.cost_counted_on = carrier.id || null; } else r.cost_usd = null;
    }
  }
  return rows;
}

/** runs.jsonl with costs.jsonl laid over it (applyCosts). */
function readRuns({ runsFile = RUNS_FILE, costsFile = COSTS_FILE } = {}) {
  return applyCosts(readJsonl(runsFile), readJsonl(costsFile));
}

/**
 * Append a cost record unless the newest one for the session already says the same (cost and source). Returns true
 * when it appended. Takes costs.jsonl's lock so retention cannot drop it mid-rewrite.
 */
function appendCost({ session_id: sid, cost_usd: cost, cost_source: source = null, tokens = null }, { costsFile = COSTS_FILE, now = new Date() } = {}) {
  if (!sid || typeof cost !== 'number' || !Number.isFinite(cost)) return false;
  return fsx.withLockSync(costsFile, () => {
    const cur = newestCosts(readJsonl(costsFile)).get(sid);
    if (cur && cur.cost_usd === cost && (cur.cost_source || null) === (source || null)) return false;
    fs.mkdirSync(path.dirname(costsFile), { recursive: true });
    fs.appendFileSync(costsFile, `${JSON.stringify({ schema: 1, session_id: sid, cost_usd: cost, cost_source: source, tokens, at: now.toISOString() })}\n`);
    return true;
  }, { timeoutMs: 2000, onBusy: 'run' });
}

module.exports = { RUNS_DIR, RUNS_FILE, COSTS_FILE, readJsonl, sessionOf, isSessionRow, newestCosts, applyCosts, readRuns, appendCost };
