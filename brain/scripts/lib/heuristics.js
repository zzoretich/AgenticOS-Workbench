'use strict';
/**
 * heuristics.js — what the pipelines do when there is no model (provider "none")
 * or when a feature is switched off under the claude provider. Pure functions.
 */
const fs = require('fs');
const path = require('path');

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const HEAD_CHARS = 4000;
const EXT_LABEL = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.md': 'Markdown', '.json': 'JSON', '.sh': 'shell script', '.css': 'stylesheet',
  '.html': 'HTML', '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join(' ');
  if (content && typeof content === 'object') return content.text || '';
  return '';
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* not a JSON line */ }
  }
  return out;
}

/** Key Context bullets from a raw JSONL transcript: last prompts, files touched, slash commands. */
function workingMemoryFromTranscript(transcriptText, { maxPrompts = 6, maxFiles = 8 } = {}) {
  const prompts = [];
  const files = [];
  const commands = [];
  for (const e of parseJsonl(transcriptText)) {
    const role = e.type || e.role;
    const content = (e.message && e.message.content) ?? e.content ?? '';
    if (role === 'user') {
      if (e.isMeta) continue;
      const text = textOf(content).trim();
      const cmd = text.match(/^<command-name>(\/[^<\s]+)<\/command-name>/);
      if (cmd) { if (!commands.includes(cmd[1])) commands.push(cmd[1]); continue; }
      if (!text || /^<(command-message|local-command)/.test(text)) continue;
      prompts.push(text.replace(/\s+/g, ' ').slice(0, 120));
    } else if (role === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_use' && FILE_TOOLS.has(b.name) && b.input && typeof b.input.file_path === 'string') {
          if (!files.includes(b.input.file_path)) files.push(b.input.file_path);
        }
      }
    }
  }
  const keyContext = prompts.slice(-maxPrompts).map((p) => `Asked: ${p}`);
  const touched = files.slice(-maxFiles);
  if (touched.length) keyContext.push(`Files touched: ${touched.map((f) => path.basename(f)).join(', ')}`);
  if (commands.length) keyContext.push(`Commands: ${commands.join(' ')}`);
  return { keyContext };
}

function clip(s) {
  return String(s).replace(/\s*\*\/\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** First H1/H2 (markdown) · first doc/JSDoc line · first line comment · package.json description · '<ext> file'. */
function describeFileHeuristic(absPath, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const fallback = `${EXT_LABEL[ext] || (ext ? ext.slice(1) : 'unknown')} file`;
  let raw;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch { return fallback; }
  if (path.basename(relPath) === 'package.json') {
    try {
      const d = JSON.parse(raw).description;
      if (typeof d === 'string' && d.trim()) return clip(d);
    } catch { /* not JSON */ }
    return fallback;
  }
  const head = raw.slice(0, HEAD_CHARS);
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    const h = head.match(/^#{1,2}\s+(.+)$/m);
    if (h) return clip(h[1]);
  }
  const jsdoc = head.match(/\/\*\*[ \t]*([^\n*][^\n]*?)[ \t]*(?:\*\/|$)/m) || head.match(/\/\*\*[^\n]*\n[ \t]*\*[ \t]*([^\n]+)/);
  if (jsdoc && clip(jsdoc[1])) return clip(jsdoc[1]);
  const line = head.match(/^[ \t]*(?:\/\/|#)(?!!)[ \t]*([^\n]{6,})$/m);
  if (line) return clip(line[1]);
  return fallback;
}

/** e.g. 'Stalled 12d · 3 objectives open · next step unset' */
function insightHeuristic(ws = {}) {
  const parts = [];
  const age = ws.lastEvent && ws.lastEvent.ageDays != null ? ws.lastEvent.ageDays : null;
  if (age == null) parts.push('No activity recorded');
  else if (age > 7) parts.push(`Stalled ${age}d`);
  else if (age > 3) parts.push(`Quiet ${age}d`);
  else parts.push(age === 0 ? 'Active today' : `Active ${age}d ago`);
  const n = Array.isArray(ws.objectives) ? ws.objectives.length : 0;
  parts.push(`${n} objective${n === 1 ? '' : 's'} ${n ? 'open' : 'listed'}`);
  const subs = Array.isArray(ws.subprojects) ? ws.subprojects.length : 0;
  if (subs) parts.push(`${subs} subproject${subs === 1 ? '' : 's'}`);
  parts.push(ws.next && ws.next.text ? `next: ${String(ws.next.text).slice(0, 60)}` : 'next step unset');
  return parts.join(' · ');
}

module.exports = { workingMemoryFromTranscript, describeFileHeuristic, insightHeuristic };
