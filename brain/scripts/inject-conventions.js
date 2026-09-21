#!/usr/bin/env node
/**
 * SessionStart hook (Codex host) — prints <vault>/AGENTICOS.md as session context.
 *
 * Under Claude Code the conventions reach the model through one `@<vault>/AGENTICOS.md` line
 * in CLAUDE.md. Codex's AGENTS.md has no include syntax, so `aos init --host codex` wires this
 * hook instead; plain stdout from a SessionStart hook becomes developer context. It runs on
 * every SessionStart source (startup, resume, clear, compact) on purpose: re-injection after
 * compaction is what keeps the vocabulary alive in a long session.
 *
 * Never fails a session: no file or an empty file → no output, exit 0. Output is capped well
 * under Codex's default additionalContext budget.
 */
const { PATHS } = require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const path = require('path');

const MAX_CHARS = 9000;

function conventionsBlock(vault = PATHS.VAULT) {
  let body = '';
  try { body = fs.readFileSync(path.join(vault, 'AGENTICOS.md'), 'utf8').trim(); } catch { return ''; }
  if (!body) return '';
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + '\n…(truncated; read AGENTICOS.md in the vault for the rest)';
  return `<agenticos-conventions>\n${body}\n</agenticos-conventions>\n`;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const block = conventionsBlock();
      if (block) process.stdout.write(block);
    } catch (_) { /* never block the session */ }
    process.exit(0);
  });
}

module.exports = { conventionsBlock, MAX_CHARS };
