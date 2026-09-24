#!/usr/bin/env node
/**
 * telemetry-hook.js — feeds the agent-runs telemetry stream from the host's hooks
 * (Claude Code or Codex CLI). Wire the SAME script to multiple events; it branches
 * on `hook_event_name` from the stdin payload. Codex serialises tool_input and
 * tool_response as JSON strings where Claude Code passes objects; both are accepted.
 *
 *   SessionStart  -> open live/<id>.ndjson with a run_start header
 *   PreToolUse    -> append a tool_use_batch event
 *   PostToolUse   -> append a tool_result_batch event
 *   SessionEnd    -> reconstruct events from the live file, write the timeline
 *                    JSON + a runs.jsonl summary line, delete the live file
 *
 * The session_id is the run key — the live ndjson file's existence is the state,
 * so no separate state store is needed. Crashed runs (no SessionEnd) are retired
 * by the Obsidian plugin's orphan sweep. Best-effort throughout: never throws,
 * never blocks the session.
 *
 * Redaction (tool name + input length only) is ON by default: config telemetry.redact
 * (default true) or BRAIN_AGENT_REDACT=1. telemetry.enabled=false → the hook writes nothing.
 */

require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const path = require('path');
const { RUNS_DIR, LIVE_DIR, SUMMARY_LOG } = require('./sdk/lib/telemetry.js');
const host = require('./lib/host.js');
const { currentHost } = host;

const TRUNC = 300;
const { loadConfig } = require('./lib/config.js');
function telemetryConfig() {
  try { return loadConfig().telemetry || {}; } catch (_) { return {}; }
}
const TELEMETRY = telemetryConfig();
const redacted = process.env.BRAIN_AGENT_REDACT === '1' || TELEMETRY.redact !== false;

function truncate(s, n = TRUNC) {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/** Codex hook payloads carry tool_input / tool_response as JSON-encoded strings. */
function fromJsonString(v) {
  if (typeof v !== 'string') return v;
  try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : v; } catch { return v; }
}

function liveFileFor(sessionId) {
  return path.join(LIVE_DIR, `sess-${sessionId}.ndjson`);
}

// Build a tool event, capturing Task's subagent_type in a dedicated field so it
// survives input_summary truncation (Task prompts routinely exceed TRUNC chars).
function toolEvent(input) {
  const t = {
    name: input.tool_name || 'unknown',
    input_summary: redacted ? null : truncate(input.tool_input),
    input_length: (() => { try { return JSON.stringify(input.tool_input ?? null).length; } catch (_) { return null; } })(),
  };
  if (t.name === 'Task' || t.name === 'Agent') { // subagent spawn (Task in CLI, Agent in this harness)
    const ti = input.tool_input || {};
    const st = ti.subagent_type || ti.subagentType;
    if (st) t.subagent_type = st;
  }
  return t;
}

function ensureHeader(sessionId, extra = {}) {
  const lf = liveFileFor(sessionId);
  if (fs.existsSync(lf)) return lf;
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const header = {
    type: 'run_start',
    id: `sess-${sessionId}`,
    script: 'session',
    started_at: new Date().toISOString(),
    pid: process.pid,
    session_id: sessionId,
    host: currentHost(process.env, PAYLOAD),
    // Codex's hook payload names the model on every event; Claude Code's does not. Costing reads it back.
    model: typeof extra.model === 'string' && extra.model ? extra.model : null,
  };
  // Quitting the Codex TUI fires no SessionEnd for this thread: record the Codex process so reconcile-sessions can
  // finalize the run once it exits (spec 2026-09-23-codex-session-close-on-exit-design D1). null = not found.
  if (header.host === 'codex') {
    let hp = null;
    try { hp = require('./lib/host-process.js').findHostProcess('codex'); } catch (_) { hp = null; }
    header.host_pid = hp ? hp.pid : null;
    header.host_started = hp ? hp.started : null;
  }
  try { fs.writeFileSync(lf, JSON.stringify(header) + '\n'); } catch (_) {}
  return lf;
}

function appendEvent(sessionId, evt) {
  const lf = ensureHeader(sessionId);
  evt.ts = Date.now();
  try { fs.appendFileSync(lf, JSON.stringify(evt) + '\n'); } catch (_) {}
}

/**
 * Close a run: timeline JSON + a runs.jsonl summary line, then delete the live file. No live file → no-op,
 * which is what makes a late real SessionEnd after a reconcile harmless (codex-parity D3).
 *   opts.transcriptPath  the session transcript, for the model backfill (D6) when the header has none
 *   opts.endedAt         Date — a reconciled run ends when its transcript last changed, not now
 */
function endRun(sessionId, reason, opts = {}) {
  const lf = liveFileFor(sessionId);
  if (!fs.existsSync(lf)) return false;
  let lines;
  try { lines = fs.readFileSync(lf, 'utf8').split('\n').filter(Boolean); } catch { return; }

  let header = {};
  const events = [];
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'run_start') { header = obj; continue; }
    events.push(obj);
  }

  const startedAt = header.started_at ? new Date(header.started_at) : new Date();
  const endedAt = opts.endedAt instanceof Date && !Number.isNaN(opts.endedAt.getTime()) ? opts.endedAt : new Date();
  let model = header.model || null;
  if (!model) {
    try {
      const hostName = header.host || 'claude';
      const tp = (opts.transcriptPath && fs.existsSync(opts.transcriptPath)) ? opts.transcriptPath : host.findTranscript(hostName, sessionId);
      model = require('./lib/transcript.js').sessionModelFile(tp) || null;
    } catch (_) { model = null; }
  }

  // Aggregate tool usage + subagents
  let toolCount = 0;
  const subagents = new Set();
  for (const e of events) {
    if (e.type === 'tool_use_batch' && Array.isArray(e.tools)) {
      toolCount += e.tools.length;
      for (const t of e.tools) {
        if (t.name !== 'Task' && t.name !== 'Agent') continue;
        if (t.subagent_type) { subagents.add(t.subagent_type); continue; } // robust, untruncated
        if (t.input_summary) {                                            // legacy fallback
          const m = String(t.input_summary).match(/"subagent_type"\s*:\s*"([^"]+)"/);
          if (m) subagents.add(m[1]);
        }
      }
    }
  }

  const id = header.id || `sess-${sessionId}`;
  const summary = {
    id,
    script: 'session',
    session_id: sessionId,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    cost_usd: null,
    turns: null,
    status: reason === 'error' ? 'error' : 'ok',
    tool_count: toolCount,
    subagents: Array.from(subagents),
    end_reason: reason || null,
    host: header.host || 'claude',
    model,
  };

  const dayDir = path.join(RUNS_DIR, startedAt.toISOString().slice(0, 10));
  try {
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, `${id}.json`), JSON.stringify({ id, summary, events }, null, 2));
  } catch (_) {}
  try { fs.appendFileSync(SUMMARY_LOG, JSON.stringify(summary) + '\n'); } catch (_) {}
  try { fs.unlinkSync(lf); } catch (_) {}
  return true;
}

let PAYLOAD = null; // the parsed hook stdin, so the host can be resolved from transcript_path when AOS_HOST is unset (D1)
let raw = '';
if (require.main === module) {
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    PAYLOAD = input;
    input.tool_input = fromJsonString(input.tool_input);
    input.tool_response = fromJsonString(input.tool_response);
    const sessionId = input.session_id || input.sessionId || 'unknown';
    const event = input.hook_event_name || input.hookEventName || '';
    if (TELEMETRY.enabled === false) { process.exit(0); }

    switch (event) {
      case 'SessionStart':
        ensureHeader(sessionId, { model: input.model });
        break;
      case 'PreToolUse':
        appendEvent(sessionId, {
          type: 'tool_use_batch',
          tools: [toolEvent(input)],
        });
        break;
      case 'PostToolUse': {
        // Wired to PostToolUse only (PreToolUse would add latency before every
        // tool). PostToolUse has both input and response, so emit the pair.
        const resp = input.tool_response;
        const isErr = !!(resp && (resp.is_error || resp.error)) || input.tool_error === true;
        appendEvent(sessionId, {
          type: 'tool_use_batch',
          tools: [toolEvent(input)],
        });
        appendEvent(sessionId, {
          type: 'tool_result_batch',
          results: [{ tool: input.tool_name || 'unknown', is_error: isErr, output_summary: redacted ? null : truncate(resp) }],
        });
        break;
      }
      case 'SessionEnd':
        endRun(sessionId, input.reason, { transcriptPath: input.transcript_path || input.transcriptPath || '' });
        break;
      default:
        break;
    }
  } catch (_) { /* never block the session */ }
  process.exit(0);
});
}

module.exports = { ensureHeader, endRun, liveFileFor, LIVE_DIR };
