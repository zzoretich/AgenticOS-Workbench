#!/usr/bin/env node
/**
 * consolidate-memory.js — scan brain/memory/** + brain/patterns/** for duplicate/
 * overlapping content and propose merges/deletes/renames. Local qwen (no SDK).
 *
 * SAFE BY DESIGN: never edits or deletes source files. Only writes a review draft
 * at brain/_index/memory-consolidation.md.
 *
 * Usage: node brain/scripts/sdk/consolidate-memory.js [--print]
 */

const fs = require('fs');
const path = require('path');
const brain = require('./lib/brain.js');
const { reason } = require('./lib/qwen.js');

const PRINT = process.argv.slice(2).includes('--print');
const log = (...a) => console.error(...a);

function truncate(text, max = 600) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

async function main() {
  const mems = brain.listMemories();
  const pats = brain.listPatterns();
  const all = [
    ...mems.map(m => ({ path: m.path, type: m.type, content: brain.readIfExists(m.absPath) || '' })),
    ...pats.map(p => ({ path: p.path, type: 'pattern', content: brain.readIfExists(p.absPath) || '' })),
  ];
  if (all.length < 2) { log('[consolidate] not enough memory files.'); process.exit(0); }

  const blob = all.map(f => `\n=== ${f.path} (${f.type}) ===\n${truncate(f.content)}`).join('\n');
  const now = new Date().toISOString();

  const system = [
    "You are a memory-system janitor. Surface redundancy, overlap, and decay in the user's second-brain memories. You DO NOT edit files — you propose actions the user will review.",
    'Output a single markdown document in this exact shape:',
    '', '---', 'type: memory-consolidation-draft', `generated: ${now}`, 'tags: [consolidation, draft]', '---', '',
    '# Memory Consolidation Draft', '',
    '## Summary', '- total files reviewed: N', '- merge candidates: N', '- delete candidates: N', '- rename/reorganize candidates: N', '',
    '## Merge candidates', '### <suggested merged name>', '- **Merge**: `path/a.md` + `path/b.md` → keep `path/a.md`', '- **Why**: 1 sentence on the overlap.', '- **Delta**: what each brings that must be preserved.', '',
    '## Delete candidates', '- `path/file.md` — 1-line reason (stale, subsumed, contradicted)', '',
    '## Rename / reorganize', '- `path/old.md` → `path/new.md` — reason', '',
    '## Leave alone (high-signal)', '- `path/file.md` — 1-line reason', '',
    'Rules: specific paths, no hedging. Empty section -> "(none)". Never suggest deleting the user profile or active feedback rules unless literally empty/duplicated.',
  ].join('\n');

  const prompt = ['Review these memory files and produce the consolidation draft.', '', `Total files: ${all.length}`, '', blob].join('\n');

  log(`[consolidate] reviewing ${all.length} files via qwen…`);
  let text;
  try { text = await reason(prompt, { system, effort: 'medium', numPredict: 3072 }); }
  catch (e) { log('[consolidate] qwen error:', e.message); process.exit(1); }
  if (!text) { log('[consolidate] empty response; aborting.'); process.exit(1); }

  const output = text.includes('type: memory-consolidation-draft')
    ? text
    : `---\ntype: memory-consolidation-draft\ngenerated: ${now}\ntags: [consolidation, draft]\n---\n\n${text}`;
  const outPath = path.join(brain.PATHS.VAULT, 'brain/_index/memory-consolidation.md');
  fs.writeFileSync(outPath, output);
  log(`[consolidate] wrote ${path.relative(brain.PATHS.VAULT, outPath)}`);
  if (PRINT) process.stdout.write(output + '\n');
}

main().catch(err => { console.error('[consolidate] fatal:', err?.stack || err); process.exit(1); });
