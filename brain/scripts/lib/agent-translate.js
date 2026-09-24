'use strict';
/**
 * agent-translate.js — one user agent, rewritten for the other session host (spec 2026-09-23-universal-agents D1, D4).
 * Pure: text in, text out, no file access; lib/agents.js decides what to mirror and where.
 *
 *   readClaude(text)       a Claude Code agent (<claude config dir>/agents/<name>.md: YAML frontmatter, the body is the
 *                          system prompt) → { ok, name, description, tools, model, keys, body }
 *   readCodex(text)        a Codex agent (<codex home>/agents/<name>.toml: `name`, `description`,
 *                          `developer_instructions`, optional config keys) → { ok, name, description, instructions,
 *                          sandbox, model, keys }
 *   toCodex(agent, ctx)    Claude Code → Codex: name, description, the body as developer_instructions behind a host note;
 *                          a tool list without a writing tool → sandbox_mode = "read-only"
 *   toClaude(agent, ctx)   Codex → Claude Code: name, description, developer_instructions as the body behind a host note;
 *                          sandbox_mode = "read-only" → a read-only tool list
 * Models, effort, colours, MCP servers and hooks are never carried (a Claude alias never goes to Codex, an OpenAI model
 * means nothing to Claude Code); a comment in the mirror names what was left out.
 *
 * Ownership (D1): the mirror carries `# aos-mirror: {json}` as a comment — in the frontmatter of a .md, among the leading
 * comments of a .toml. `writtenHash` hashes the file without that line, so an edit anywhere else shows as a mismatch.
 * parseToml / tomlString are the TOML subset agent files use: no dependency, nothing a Codex agent file needs is missing.
 */
const crypto = require('crypto');
const ST = require('./skill-translate.js');

const DESC_MAX = ST.DESC_MAX;
const MARK_RE = /^# aos-mirror: (\{.*\})[ \t]*$/;
const WRITERS = /^(Write|Edit|MultiEdit|NotebookEdit|Bash)\b/;
const READ_ONLY_TOOLS = 'Read, Grep, Glob, WebFetch, WebSearch';
/** Names a host already gives its own agent: a mirror under one of them would replace or shadow it (D3). */
const RESERVED = {
  codex: ['default', 'worker', 'explorer'],
  claude: ['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude-code-guide', 'output-style-setup'],
};

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

// ── TOML subset ──────────────────────────────────────────────────────────────

/**
 * { top, tables, dotted }: top-level keys with their values (strings of all four kinds, arrays, inline tables,
 * booleans; any other scalar as its number or raw text), the table headers seen, and top-level dotted keys. Keys under a
 * table are parsed and dropped. Throws on anything malformed.
 */
function parseToml(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let i = 0;
  const top = {};
  const tables = [];
  const dotted = [];
  let table = null;
  const fail = (m, at = i) => { throw new Error(`line ${s.slice(0, at).split('\n').length}: ${m}`); };
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const comment = () => { if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++; };
  const blank = () => { for (;;) { ws(); comment(); if (s[i] === '\n') { i++; continue; } return; } };
  const eol = () => { ws(); comment(); if (i < s.length && s[i] !== '\n') fail('expected the end of the line'); i++; };

  function escape() {
    const c = s[i++];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (c in simple) return simple[c];
    const len = c === 'u' ? 4 : c === 'U' ? 8 : c === 'x' ? 2 : 0;
    const hex = s.slice(i, i + len);
    if (!len || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail(`bad escape \\${c}`);
    i += len;
    return String.fromCodePoint(parseInt(hex, 16));
  }

  function basic() {
    let out = '';
    for (;;) {
      const c = s[i];
      if (c === undefined || c === '\n') fail('unterminated string');
      i++;
      if (c === '"') return out;
      out += c === '\\' ? escape() : c;
    }
  }

  function literal() {
    const end = s.indexOf("'", i);
    const nl = s.indexOf('\n', i);
    if (end < 0 || (nl >= 0 && nl < end)) fail('unterminated string');
    const out = s.slice(i, end);
    i = end + 1;
    return out;
  }

  /** After the opening quotes: a newline right there is trimmed; the closing run may carry one or two extra quotes. */
  function multiline(q, escapes) {
    if (s[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= s.length) fail('unterminated multi-line string');
      if (s.startsWith(q.repeat(3), i)) {
        let n = 3;
        while (s[i + n] === q && n < 5) n++;
        out += q.repeat(n - 3);
        i += n;
        return out;
      }
      const c = s[i++];
      if (escapes && c === '\\') {
        if (/^[ \t]*\n/.test(s.slice(i, i + 200))) { while (/[ \t\n]/.test(s[i] || '')) i++; continue; }
        out += escape();
        continue;
      }
      out += c;
    }
  }

  function keyPart() {
    if (s[i] === '"') { i++; return basic(); }
    if (s[i] === "'") { i++; return literal(); }
    const m = s.slice(i).match(/^[A-Za-z0-9_-]+/);
    if (!m) fail('expected a key');
    i += m[0].length;
    return m[0];
  }

  function keyPath() {
    const parts = [keyPart()];
    for (;;) { ws(); if (s[i] !== '.') return parts; i++; ws(); parts.push(keyPart()); }
  }

  function array() {
    const out = [];
    for (;;) {
      blank();
      if (s[i] === ']') { i++; return out; }
      out.push(value());
      blank();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return out; }
      fail('expected , or ] in an array');
    }
  }

  function inlineTable() {
    const out = {};
    ws();
    if (s[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      const k = keyPath().join('.');
      ws();
      if (s[i] !== '=') fail('expected = in an inline table');
      i++;
      ws();
      out[k] = value();
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return out; }
      fail('expected , or } in an inline table');
    }
  }

  function value() {
    if (s.startsWith('"""', i)) { i += 3; return multiline('"', true); }
    if (s.startsWith("'''", i)) { i += 3; return multiline("'", false); }
    if (s[i] === '"') { i++; return basic(); }
    if (s[i] === "'") { i++; return literal(); }
    if (s[i] === '[') { i++; return array(); }
    if (s[i] === '{') { i++; return inlineTable(); }
    const m = s.slice(i).match(/^[^\s,\]}#]+/);
    if (!m) fail('expected a value');
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    const n = Number(m[0].replace(/_/g, ''));
    return Number.isFinite(n) && /^[+-]?[\d_.eE+-]+$/.test(m[0]) ? n : m[0];
  }

  for (;;) {
    blank();
    if (i >= s.length) break;
    if (s[i] === '[') {
      const double = s[i + 1] === '[';
      i += double ? 2 : 1;
      ws();
      const name = keyPath().join('.');
      ws();
      if (s[i] !== ']' || (double && s[i + 1] !== ']')) fail('unclosed table header');
      i += double ? 2 : 1;
      table = name;
      tables.push(name);
      eol();
      continue;
    }
    const start = i;
    const key = keyPath();
    ws();
    if (s[i] !== '=') fail('expected =');
    i++;
    ws();
    const v = value();
    eol();
    if (table !== null) continue;
    if (key.length > 1) { dotted.push(key.join('.')); continue; }
    if (Object.prototype.hasOwnProperty.call(top, key[0])) fail(`duplicate key ${key[0]}`, start);
    top[key[0]] = v;
  }
  return { top, tables, dotted };
}

function tomlEscape(c) {
  const code = c.charCodeAt(0);
  if (code === 8) return '\\b';
  if (code === 12) return '\\f';
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/** A TOML basic string; with multiline and a newline in the text, a multi-line basic string with every quote escaped. */
function tomlString(s, { multiline = false } = {}) {
  const t = String(s).replace(/\r\n?/g, '\n');
  const ctrl = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
  if (multiline && t.includes('\n')) {
    return `"""\n${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(ctrl, tomlEscape)}"""`;
  }
  return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(ctrl, tomlEscape)}"`;
}

// ── reading each host's agent ────────────────────────────────────────────────

/** The top-level keys of a YAML frontmatter block, `tools` as a list and `model` as text. Comments are skipped. */
function frontKeys(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const keys = [];
  let tools = null;
  let model = null;
  for (let j = 0; j < lines.length; j++) {
    const kv = lines[j].match(/^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/);
    if (!kv) continue;
    keys.push(kv[1]);
    if (kv[1] === 'model') model = kv[2].trim().replace(/^["']|["']$/g, '') || null;
    if (kv[1] !== 'tools') continue;
    const inline = kv[2].trim();
    const items = [];
    if (inline) items.push(...inline.replace(/^\[|\]$/g, '').split(','));
    else for (let k = j + 1; k < lines.length && /^[ \t]+-/.test(lines[k]); k++) items.push(lines[k].replace(/^[ \t]+-[ \t]*/, ''));
    tools = items.map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return { keys, tools, model };
}

function readClaude(text) {
  const p = ST.parse(text);
  if (!p.has) return { ok: false, reason: 'no YAML frontmatter (an agent needs a name and a description)' };
  const { keys, tools, model } = frontKeys(p.raw);
  return { ok: true, name: p.fm.name || '', description: p.fm.description || '', tools, model, keys, body: p.body };
}

function readCodex(text) {
  let t;
  try { t = parseToml(text); } catch (e) { return { ok: false, reason: `not valid TOML (${e.message})` }; }
  const str = (k) => (typeof t.top[k] === 'string' ? t.top[k] : '');
  const keys = [...new Set([...Object.keys(t.top), ...t.dotted, ...t.tables].map((k) => k.split('.')[0]))];
  return { ok: true, name: str('name'), description: str('description'), instructions: str('developer_instructions'), sandbox: str('sandbox_mode'), model: str('model'), keys };
}

/** A Claude Code tool list that cannot write: no Write, Edit, MultiEdit, NotebookEdit or Bash (Bash can write). */
function isReadOnlyTools(tools) {
  return Array.isArray(tools) && tools.length > 0 && !tools.some((t) => WRITERS.test(String(t).trim()));
}

// ── the marker ───────────────────────────────────────────────────────────────

/**
 * { meta, unmarked } for a mirror we wrote, else null. Only looked for where we put it: inside the frontmatter of a .md,
 * among the comment lines before the first key of a .toml — never in an agent's body.
 */
function readMarker(text, kind) {
  const lines = String(text || '').split('\n');
  let from = 0;
  let to = lines.length;
  if (kind === 'md') {
    if (!/^---[ \t]*\r?$/.test(lines[0] || '')) return null;
    from = 1;
    to = lines.findIndex((l, n) => n > 0 && /^---[ \t]*\r?$/.test(l));
    if (to < 0) return null;
  }
  for (let n = from; n < to; n++) {
    const line = lines[n].replace(/\r$/, '');
    if (kind === 'toml' && line.trim() && !line.startsWith('#')) return null;
    const m = line.match(MARK_RE);
    if (!m) continue;
    let meta;
    try { meta = JSON.parse(m[1]); } catch { return null; }
    if (!meta || typeof meta !== 'object') return null;
    return { meta, unmarked: [...lines.slice(0, n), ...lines.slice(n + 1)].join('\n') };
  }
  return null;
}

/** True when the file is still what we wrote: the marker's writtenHash matches the file without the marker line. */
function isPristine(text, kind) {
  const m = readMarker(text, kind);
  return !!m && sha(m.unmarked) === m.meta.writtenHash;
}

/** Puts the marker line in place: `at` is the index of the line it goes before. */
function mark(lines, at, meta) {
  const unmarked = lines.join('\n');
  const full = { schema: 1, ...meta, writtenHash: sha(unmarked) };
  return [...lines.slice(0, at), `# aos-mirror: ${JSON.stringify(full)}`, ...lines.slice(at)].join('\n');
}

// ── translations ─────────────────────────────────────────────────────────────

const CODEX_NOTE = '> Host: Codex. This agent was written for Claude Code, and AgenticOS mirrors it here. Where it names Claude Code tools, use your own: Read, Grep and Glob → read and search with the shell; Edit and Write → apply_patch; Bash → the shell; Task or Agent → spawn_agent; WebFetch and WebSearch → web search where it is enabled.';
const CLAUDE_NOTE = '> Host: Claude Code. This agent was written for Codex, and AgenticOS mirrors it here. Where it names Codex tools, use your own: the shell → Bash; apply_patch → Edit and Write; spawn_agent → the Agent tool.';
const NO_NAMES = new Map();

function bodyToCodex(body) {
  let s = String(body || '');
  s = s.replace(/ with the (?:Read|Edit|Write|Glob|Grep) tool\b/g, '');
  s = s.replace(/\ban AskUserQuestion(?: tool)?(?: call)?\b/g, 'a question');
  s = s.replace(/\bAskUserQuestion(?: tool)?(?: call)?\b/g, 'question');
  return ST.claudeWording(s, { names: NO_NAMES });
}

/** Keys the source has that the mirror does not carry, for the comment that says so. */
function leftOut(keys, carried) {
  return [...new Set(keys)].filter((k) => !carried.includes(k));
}

/**
 * Claude Code agent → Codex agent file. ctx: { source, sourceHash, id }. { ok: true, name, content, readOnly } or
 * { ok: false, reason }.
 */
function toCodex(a, ctx) {
  if (!a || !a.ok) return { ok: false, reason: (a && a.reason) || 'unreadable' };
  if (!a.name) return { ok: false, reason: 'no name in the frontmatter (Claude Code does not load it either)' };
  const name = ST.codexName(a.name);
  if (!name) return { ok: false, reason: 'no name Codex accepts (letters, digits, hyphens)' };
  if (RESERVED.codex.includes(name)) return { ok: false, reason: `"${name}" would replace Codex's built-in ${name} agent; rename it to share it` };
  const description = ST.clip(ST.claudeWording(a.description, { names: NO_NAMES }), DESC_MAX);
  if (!description) return { ok: false, reason: 'no description in the frontmatter (Claude Code does not load it either)' };
  const body = bodyToCodex(a.body).trim();
  if (!body) return { ok: false, reason: 'no instructions: the body under the frontmatter is empty' };
  const readOnly = isReadOnlyTools(a.tools);
  const skipped = leftOut(a.keys || [], ['name', 'description']);
  const head = [`# Mirrored by AgenticOS from ${ctx.source}. Edit that file, not this one: the sync rewrites this copy.`];
  if (skipped.length) head.push(`# Left out (Claude Code only): ${skipped.join(', ')}. Codex runs it on your default model${readOnly ? '; its tool list cannot write, so it runs read-only' : ''}.`);
  const lines = [
    ...head,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    ...(readOnly ? ['sandbox_mode = "read-only"'] : []),
    `developer_instructions = ${tomlString(`${CODEX_NOTE}\n\n${body}\n`, { multiline: true })}`,
    '',
  ];
  return { ok: true, name, readOnly, content: mark(lines, head.length, { id: ctx.id || name, from: 'claude', source: ctx.source, sourceHash: ctx.sourceHash }) };
}

/** Codex agent → Claude Code agent file. ctx: { source, sourceHash, id }. */
function toClaude(a, ctx) {
  if (!a || !a.ok) return { ok: false, reason: (a && a.reason) || 'unreadable' };
  if (!a.name) return { ok: false, reason: 'no `name` (Codex ignores the file too)' };
  const name = ST.codexName(a.name);
  if (!name) return { ok: false, reason: 'no name Claude Code accepts (lowercase letters, digits, hyphens)' };
  if (RESERVED.claude.includes(name)) return { ok: false, reason: `"${name}" would shadow Claude Code's built-in ${name} agent; rename it to share it` };
  if (!a.description) return { ok: false, reason: 'no `description` (Codex ignores the file too)' };
  const body = ST.codexWording(a.instructions, { names: NO_NAMES }).trim();
  if (!body) return { ok: false, reason: 'no `developer_instructions` (Codex ignores the file too)' };
  const readOnly = a.sandbox === 'read-only';
  const skipped = leftOut(a.keys || [], ['name', 'description', 'developer_instructions', 'sandbox_mode']);
  const description = ST.clip(ST.codexWording(a.description, { names: NO_NAMES }), DESC_MAX);
  const head = [
    '---',
    `name: ${name}`,
    `description: ${ST.yamlScalar(description)}`,
    ...(readOnly ? [`tools: ${READ_ONLY_TOOLS}`] : []),
    `# Mirrored by AgenticOS from ${ctx.source}. Edit that file, not this one: the sync rewrites this copy.`,
    ...(skipped.length ? [`# Left out (Codex only): ${skipped.join(', ')}. Claude Code runs it on the session's model.`] : []),
  ];
  const lines = [...head, '---', '', CLAUDE_NOTE, '', body, ''];
  return { ok: true, name, readOnly, content: mark(lines, head.length, { id: ctx.id || name, from: 'codex', source: ctx.source, sourceHash: ctx.sourceHash }) };
}

/** Same agent written by hand on both hosts: the instructions agree once the host wording is set aside. */
function sameInstructions(claudeAgent, codexAgent) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return !!(claudeAgent.ok && codexAgent.ok) && norm(bodyToCodex(claudeAgent.body)) === norm(codexAgent.instructions);
}

module.exports = {
  RESERVED, READ_ONLY_TOOLS, sha, parseToml, tomlString, frontKeys, readClaude, readCodex, isReadOnlyTools,
  readMarker, isPristine, toCodex, toClaude, sameInstructions,
};
