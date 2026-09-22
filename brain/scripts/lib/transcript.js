'use strict';
/**
 * transcript.js — one reader for both hosts' session transcripts.
 *
 *   Claude Code  projects/<slug>/<id>.jsonl: one entry per message; `type` or `role` is
 *                user|assistant; `message.content` is a string or content blocks, and an
 *                assistant `tool_use` block names the tool and carries its input.
 *   Codex CLI    sessions/YYYY/MM/DD/rollout-*.jsonl: `{ timestamp, type, payload }` records.
 *                Messages are response_item/message with role user|assistant|developer
 *                (developer = injected context, skipped). Codex's code mode wraps tool calls in
 *                scripts, so tool activity is read from the event_msg records instead:
 *                patch_apply_end (edits, one per changed path), exec_command_end (shell) and
 *                mcp_tool_call_end (MCP). Token usage is event_msg/token_count.
 *
 * Output is host-neutral: { format, turns, toolUses, usage, userTurns, meta }.
 *   turns     [{ role, text, meta }]  meta = Claude's isMeta envelopes (kept for turn counting)
 *   toolUses  [{ name, kind, filePath }]  kind ∈ edit | read | bash | mcp | other
 *   usage     { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens } | null
 */
const fs = require('fs');

const FILE_TOOLS = { Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read' };
// Codex injects these as user-role messages; they are not the user's words.
const CODEX_ENVELOPE_RE = /^<(environment_context|permissions instructions|user_instructions|app_instructions|skill|turn_aborted)\b/;

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* not a JSON line */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join(' ');
  if (content && typeof content === 'object') return content.text || '';
  return '';
}

function kindOf(name) {
  if (FILE_TOOLS[name]) return FILE_TOOLS[name];
  if (name === 'Bash') return 'bash';
  if (/^mcp__/.test(String(name))) return 'mcp';
  return 'other';
}

/** 'codex' when the first records carry Codex's { type, payload } envelope; 'claude' otherwise. */
function detectFormat(entries) {
  for (const e of entries.slice(0, 10)) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'session_meta') return 'codex';
    if (e.payload && typeof e.payload === 'object' && (e.type === 'response_item' || e.type === 'event_msg' || e.type === 'turn_context')) return 'codex';
  }
  return 'claude';
}

function parseClaude(entries) {
  const turns = [];
  const toolUses = [];
  let userTurns = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const role = e.type || e.role;
    if (role === 'user') userTurns++;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = (e.message && e.message.content) ?? e.content ?? '';
    if (role === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        const filePath = b.input && typeof b.input.file_path === 'string' ? b.input.file_path : null;
        toolUses.push({ name: b.name, kind: kindOf(b.name), filePath });
      }
    }
    turns.push({ role, text: textOf(content), meta: !!e.isMeta });
  }
  return { format: 'claude', turns, toolUses, usage: null, userTurns, meta: null };
}

function parseCodex(entries) {
  const turns = [];
  const toolUses = [];
  let usage = null;
  let userTurns = 0;
  let meta = null;
  for (const r of entries) {
    if (!r || typeof r !== 'object' || !r.payload || typeof r.payload !== 'object') continue;
    const p = r.payload;
    if (r.type === 'session_meta') {
      meta = { id: p.id || p.session_id || null, cwd: p.cwd || null, cliVersion: p.cli_version || null, source: p.source || null };
      continue;
    }
    if (r.type === 'response_item' && p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') continue;
      const text = textOf(p.content);
      if (p.role === 'user' && CODEX_ENVELOPE_RE.test(text.trim())) continue;
      if (p.role === 'user') userTurns++;
      turns.push({ role: p.role, text, meta: false });
      continue;
    }
    if (r.type !== 'event_msg') continue;
    switch (p.type) {
      case 'patch_apply_end':
        for (const f of Object.keys(p.changes || {})) toolUses.push({ name: 'apply_patch', kind: 'edit', filePath: f });
        break;
      case 'exec_command_end':
        toolUses.push({ name: 'Bash', kind: 'bash', filePath: null });
        break;
      case 'mcp_tool_call_end': {
        const inv = p.invocation || {};
        toolUses.push({ name: `mcp__${inv.server || 'unknown'}__${inv.tool || 'unknown'}`, kind: 'mcp', filePath: null });
        break;
      }
      case 'token_count': {
        const u = p.info && p.info.total_token_usage;
        if (u) {
          usage = {
            inputTokens: u.input_tokens || 0,
            cachedInputTokens: u.cached_input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            reasoningOutputTokens: u.reasoning_output_tokens || 0,
            totalTokens: u.total_tokens || 0,
          };
        }
        break;
      }
      default:
        break;
    }
  }
  return { format: 'codex', turns, toolUses, usage, userTurns, meta };
}

/** Parsed JSONL entries of either host → the host-neutral shape. */
function parseEntries(entries, { format } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  return (format || detectFormat(list)) === 'codex' ? parseCodex(list) : parseClaude(list);
}

function readTurns(text, opts) { return parseEntries(parseJsonl(text), opts); }

function readTranscriptFile(transcriptPath, opts) {
  if (!transcriptPath) return parseEntries([], opts);
  let text = '';
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return parseEntries([], opts); }
  return readTurns(text, opts);
}

/**
 * The model that answered in a session, from the transcript (codex-parity D6): Claude Code writes
 * `message.model` on every assistant entry; Codex names it in turn_context.payload.model (and, on
 * newer CLIs, session_meta.payload.model). null when neither is present. Fixture-tested on both.
 */
function sessionModel(entries, { format } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const fmt = format || detectFormat(list);
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (fmt === 'codex') {
      const p = e.payload && typeof e.payload === 'object' ? e.payload : null;
      if (p && (e.type === 'turn_context' || e.type === 'session_meta') && typeof p.model === 'string' && p.model) return p.model;
      continue;
    }
    if ((e.type === 'assistant' || e.role === 'assistant') && e.message && typeof e.message.model === 'string' && e.message.model) return e.message.model;
  }
  return null;
}

function sessionModelFile(transcriptPath, opts) {
  if (!transcriptPath) return null;
  try { return sessionModel(parseJsonl(fs.readFileSync(transcriptPath, 'utf8')), opts); } catch { return null; }
}

/** "role: text" lines, one per spoken turn — the shape the extractors and summarizers consume. */
function flattenTurns(parsed, { maxChars = 0 } = {}) {
  const out = [];
  for (const t of parsed.turns) {
    if (t.meta) continue;
    const text = String(t.text || '').trim();
    if (!text) continue;
    out.push(`${t.role}: ${maxChars > 0 ? text.slice(0, maxChars) : text}`);
  }
  return out.join('\n');
}

module.exports = { parseJsonl, textOf, detectFormat, parseEntries, readTurns, readTranscriptFile, flattenTurns, sessionModel, sessionModelFile, FILE_TOOLS };
