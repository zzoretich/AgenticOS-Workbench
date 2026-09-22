#!/usr/bin/env node
/**
 * heartbeat-writer.js — derive per-agent heartbeats from the agent-runs
 * telemetry stream and write brain/agents/<name>/heartbeat.json, the data
 * source the agentic-os "Staff Roster" view renders.
 *
 * Sources (newest wins; a live/running run always beats a completed one):
 *   - brain/_index/agent-runs/live/*.ndjson  → in-flight runs  (status "running")
 *   - brain/_index/agent-runs/runs.jsonl     → completed runs
 *
 * Agent identity per run:
 *   - record.script, when it names a defined agent (not the generic "session")
 *   - each name in record.subagents[]  (subagent_type spawned via the Task tool)
 *
 * "All agents": every persona in <claude-config-dir>/agents/*.md gets a heartbeat (idle, "no
 * recorded runs yet") unless telemetry has something fresher. Subagents seen in
 * telemetry without a persona file get a heartbeat too.
 *
 * Orchestrators: config `roster.orchestrators` ({ name: { nickname, trigger, match } }) names
 * agents whose runs roll up their spawned specialists under one card. Empty by default.
 *
 * Best-effort: never throws, never blocks. Writes only when content changes
 * (keeps file mtimes — and the roster's freshness badges — honest).
 *
 * Run manually, or via the SessionEnd / Stop hooks (see settings.json).
 */

const { PATHS } = require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const path = require('path');
const brain = require('./sdk/lib/brain.js');
const { RUNS_DIR, LIVE_DIR, SUMMARY_LOG } = require('./sdk/lib/telemetry.js');
const { withReport } = require('./lib/pipeline-report.js');

const VAULT = brain.PATHS.VAULT;
const AGENTS_MD_DIR = path.join(brain.PATHS.CLAUDE_CONFIG_DIR, 'agents');
const HB_DIR = path.join(VAULT, 'brain', 'agents');
const { loadConfig } = require('./lib/config.js');
const SEED_IDLE = !process.argv.includes('--no-seed');
function claudeHostEnabled() {
  try { const h = require('./lib/paths.js').readUserConfig().hosts; return !(h && h.claude && h.claude.enabled === false); } catch { return true; }
}

/** roster.orchestrators → [{ name, nickname, trigger, re }] */
function buildRoster(orchestrators) {
  return Object.entries(orchestrators || {}).map(([name, o]) => ({
    name,
    nickname: (o && o.nickname) || name,
    trigger: (o && o.trigger) || `/${name.toLowerCase()}`,
    re: new RegExp((o && o.match) || name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  }));
}
function orchestratorFor(roster, rec) {
  const hay = `${rec.prompt || ''} ${rec.script || ''}`;
  return roster.find(o => o.re.test(hay)) || null;
}
const ROSTER = buildRoster((loadConfig().roster || {}).orchestrators); // `"roster": null` in brain/config.json must not crash the hook at load
const NICKNAMES = Object.fromEntries(ROSTER.map(o => [o.name, o.nickname]));

/** next_fire for an agent that is also a scheduled routine (rows = routines-store.overview()): its next fire as ISO, else null. */
function nextFireFor(name, rows) {
  const r = (rows || []).find(x => x && x.slug === name && x.enabled && Array.isArray(x.next) && x.next.length);
  if (!r) return null;
  const d = r.next[0] instanceof Date ? r.next[0] : new Date(r.next[0]);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
/** The routine rows, or [] when the store cannot be read — never a reason to fail the hook. */
function routineRows() {
  try { return require('./lib/routines-store.js').overview(); } catch { return []; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function definedAgents() {
  // <claude config dir>/agents is Claude Code's; a Codex-only install (hosts.claude.enabled === false) has none (codex-parity D7).
  if (!claudeHostEnabled()) return [];
  try {
    return fs.readdirSync(AGENTS_MD_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch { return []; }
}

function mapStatus(s) {
  if (!s || s === 'success') return 'ok';
  return s; // ok | running | error | crashed | …
}

function timelineRel(rec) {
  const day = (rec.started_at || '').slice(0, 10);
  if (!day || !rec.id) return null;
  const rel = `brain/_index/agent-runs/${day}/${rec.id}.json`;
  return fs.existsSync(path.join(VAULT, rel)) ? rel : null;
}

function subagentNamesFrom(events) {
  const out = new Set();
  for (const e of events || []) {
    if (e.type !== 'tool_use_batch' || !Array.isArray(e.tools)) continue;
    for (const t of e.tools) {
      if (t.name !== 'Task' && t.name !== 'Agent') continue; // subagent spawn (Task in CLI, Agent here)
      if (t.subagent_type) { out.add(t.subagent_type); continue; }      // robust field
      if (t.input_summary) {                                            // legacy fallback
        const m = String(t.input_summary).match(/"subagent_type"\s*:\s*"([^"]+)"/);
        if (m) out.add(m[1]);
      }
    }
  }
  return [...out];
}

// Entry point: extracted mechanically from what was previously flat top-level
// script code (zero logic changes) so it can be run under withReport(report).
function main(report) {
// ── merge: newest started_at wins; a "running" hb always beats a completed one ──
const state = {};
function consider(name, hb) {
  if (!name) return;
  const prev = state[name];
  if (!prev) { state[name] = hb; return; }
  const prevRun = prev.status === 'running';
  const curRun = hb.status === 'running';
  if (curRun !== prevRun) { if (curRun) state[name] = hb; return; }
  const pt = Date.parse(prev._sort || prev.started_at || 0) || 0;
  const ct = Date.parse(hb._sort || hb.started_at || 0) || 0;
  if (ct >= pt) state[name] = hb;
}

// ── 1. completed runs from runs.jsonl ──────────────────────────────────────
for (const rec of readJsonl(SUMMARY_LOG)) {
  const orch = orchestratorFor(ROSTER, rec);
  const status = mapStatus(rec.status);
  const errored = status !== 'ok' && status !== 'running';
  const tl = timelineRel(rec);
  const durSec = rec.duration_ms ? Math.round(rec.duration_ms / 1000) : null;
  const subs = Array.isArray(rec.subagents) ? rec.subagents : [];
  const childTrigger = orch ? orch.trigger : (rec.script && rec.script !== 'session' ? rec.script : 'session');
  const sortKey = rec.ended_at || rec.started_at;

  // a run whose script *is* an agent → that agent ran directly
  if (rec.script && rec.script !== 'session') {
    consider(rec.script, {
      status, started_at: rec.started_at, completed_at: rec.ended_at,
      errored_at: errored ? rec.ended_at : null, duration_sec: durSec,
      trigger: 'sdk', last_brief: tl, next_fire: null,
      summary: rec.reply ? String(rec.reply).slice(0, 140) : `ran — ${rec.status || 'ok'}`,
      runs: 1, last_run_id: rec.id, source: 'runs.jsonl', _sort: sortKey,
    });
  }

  // specialists spawned during the run
  for (const sub of subs) {
    consider(sub, {
      status, started_at: rec.started_at, completed_at: rec.ended_at,
      errored_at: errored ? rec.ended_at : null, duration_sec: durSec,
      trigger: childTrigger, last_brief: tl, next_fire: null,
      summary: `spawned by ${rec.script || 'session'}${orch ? ' via ' + orch.trigger : ''}`,
      last_run_id: rec.id, source: 'runs.jsonl', _sort: sortKey,
    });
  }

  // orchestrator roll-up
  if (orch && subs.length) {
    consider(orch.name, {
      status, started_at: rec.started_at, completed_at: rec.ended_at,
      errored_at: errored ? rec.ended_at : null, duration_sec: durSec,
      trigger: orch.trigger, last_brief: tl, next_fire: null,
      summary: `orchestrated ${subs.length} specialist${subs.length > 1 ? 's' : ''}: ` +
               `${subs.slice(0, 4).join(', ')}${subs.length > 4 ? '…' : ''}`,
      last_run_id: rec.id, source: 'runs.jsonl', _sort: sortKey,
    });
  }
}

// ── 2. in-flight runs from live/*.ndjson → status "running" ─────────────────
let liveFiles = [];
try { liveFiles = fs.readdirSync(LIVE_DIR).filter(f => f.endsWith('.ndjson')); } catch { /* none */ }
const nowIso = new Date().toISOString();
for (const lf of liveFiles) {
  const recs = readJsonl(path.join(LIVE_DIR, lf));
  const header = recs.find(r => r.type === 'run_start') || {};
  const orch = orchestratorFor(ROSTER, { prompt: header.prompt, script: header.script });
  const subs = subagentNamesFrom(recs);
  const childTrigger = orch ? orch.trigger : (header.script && header.script !== 'session' ? header.script : 'session');
  for (const sub of subs) {
    consider(sub, {
      status: 'running', started_at: header.started_at, completed_at: null,
      errored_at: null, duration_sec: null, trigger: childTrigger,
      last_brief: null, next_fire: null,
      summary: `running — spawned by ${header.script || 'session'}${orch ? ' via ' + orch.trigger : ''}`,
      source: 'live', _sort: nowIso,
    });
  }
  if (orch && subs.length) {
    consider(orch.name, {
      status: 'running', started_at: header.started_at, completed_at: null,
      errored_at: null, duration_sec: null, trigger: orch.trigger,
      last_brief: null, next_fire: null,
      summary: `orchestrating ${subs.length} specialist${subs.length > 1 ? 's' : ''}: ${subs.slice(0, 4).join(', ')}`,
      source: 'live', _sort: nowIso,
    });
  }
}

// ── 3. seed every defined agent that has no telemetry (idle roster) ─────────
if (SEED_IDLE) {
  for (const name of definedAgents()) {
    if (state[name]) continue;
    // Make configured orchestrators recognizable on the roster before their first run.
    const o = ROSTER.find(r => r.name === name);
    if (o) {
      state[name] = {
        status: null, started_at: null, completed_at: null, errored_at: null,
        duration_sec: null, trigger: o.trigger, last_brief: null, next_fire: null,
        summary: `${o.nickname} orchestrator — idle · run ${o.trigger} to dispatch`,
        source: 'seed',
      };
      continue;
    }
    state[name] = {
      status: null, started_at: null, completed_at: null, errored_at: null,
      duration_sec: null, trigger: null, last_brief: null, next_fire: null,
      summary: 'no recorded runs yet', source: 'seed',
    };
  }
}

// ── 4. write brain/agents/<name>/heartbeat.json (only when changed) ─────────
fs.mkdirSync(HB_DIR, { recursive: true });
let wrote = 0, skipped = 0;
const rows = routineRows();
for (const [rawName, hb] of Object.entries(state)) {
  delete hb._sort;
  if (NICKNAMES[rawName]) hb.display_name = NICKNAMES[rawName];
  if (!hb.next_fire) hb.next_fire = nextFireFor(rawName, rows);   // an agent that is also a routine (brain/routines/<name>.md)
  const name = rawName.replace(/[\/:]+/g, '-').trim();
  if (!name) continue;
  const dir = path.join(HB_DIR, name);
  const file = path.join(dir, 'heartbeat.json');
  const next = JSON.stringify(hb, null, 2);
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur === next) { skipped++; continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, next);
    wrote++;
  } catch (err) {
    process.stderr.write(`[heartbeat-writer] ${name}: ${err.message}\n`);
  }
}
if (report) report.counts.agents = wrote;
process.stdout.write(`[heartbeat-writer] ${Object.keys(state).length} agents · wrote ${wrote} · unchanged ${skipped} → ${HB_DIR}\n`);
}

if (require.main === module) {
  // Hook mode (Stop / SessionEnd): hand the work to a detached child and return now.
  if (require('./lib/detach.js').respawnDetached()) { require('./lib/hook-entry.js').finishStop(); process.exit(0); }
  withReport('heartbeat-writer', async (report) => { await main(report); })
    .catch(() => { /* best-effort: never fail the hook */ });
}
module.exports = { main, buildRoster, orchestratorFor, nextFireFor };
