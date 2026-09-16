'use strict';
/**
 * memory-writer.js — script-side port of the Obsidian plugin's memory writer
 * (src/data/memoryWriter.ts). slugify/deriveTitle/deriveDescription and the
 * section-aware MEMORY.md index insertion are ported verbatim (JS-ified);
 * the two writers must stay behaviorally identical.
 *
 * P4 additions on top of the port: `source`, `session`, `reviewed: false`
 * frontmatter keys, emitted only when `source` is provided.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');

const VAULT = PATHS.VAULT;
const INDEX_PATH = path.join(VAULT, 'MEMORY.md');

// Ported from memoryWriter.ts TYPE_HEADING (line 5).
const TYPE_HEADING = { user: 'User', feedback: 'Feedback', projects: 'Project', reference: 'Reference' };

// Ported verbatim from memoryWriter.ts slugify (line 31).
function slugify(text, maxWords = 6) {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~#>\[\]\(\)]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, maxWords)
      .join('-')
      .slice(0, 80) || 'untitled'
  );
}

// Ported verbatim from memoryWriter.ts deriveTitle (line 43).
function deriveTitle(text, maxChars = 60) {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

// Ported verbatim from memoryWriter.ts deriveDescription (line 49).
function deriveDescription(text, maxChars = 90) {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

// Faithful port of appendToMemoryIndex's insertion logic (memoryWriter.ts
// lines 120-139): section-aware if a matching `## ` heading exists, else
// append a new section at EOF. Pure string transform — I/O lives in writeMemory.
function insertIndexLine(raw, heading, entry) {
  const lines = raw.split('\n');
  // Prefix match, case-sensitive, no word-boundary: "## Project" must match a
  // real "## Projects" heading; "## Feedback" must match "## Feedback (how to
  // work)". First matching heading wins. IDENTICAL rule in memoryWriter.ts —
  // behavioral parity between the two writers is a standing P4 contract.
  const headingIdx = lines.findIndex((l) => l.trim().startsWith(heading));

  if (headingIdx === -1) {
    // append new section at end
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push(heading);
    lines.push(entry);
  } else {
    // find end of this section (next ## heading or EOF)
    let insertAt = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { insertAt = i; break; }
    }
    // trim trailing blanks before next section
    while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, entry);
  }

  return lines.join('\n');
}

function writeMemory({ type, slug, title, description, body, source, session }) {
  const resolvedTitle = title || deriveTitle(description);
  const s = slug || slugify(title || description || 'memory');
  const rel = `brain/memory/${type}/${s}.md`;
  const abs = path.join(VAULT, rel);

  if (fs.existsSync(abs)) throw new Error(`memory already exists: ${rel}`);

  const today = new Date().toISOString().slice(0, 10);
  const autoKeys = source ? `source: ${source}\nsession: ${session ?? 'unknown'}\nreviewed: false\n` : '';
  const doc = `---\ntype: memory\ntags: [memory/${type}, status/active]\ncreated: ${today}\nupdated: ${today}\n${autoKeys}---\n\n# ${resolvedTitle}\n\n${body.trim()}\n`;

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, doc);

  const heading = `## ${TYPE_HEADING[type]}`;
  const entry = `- [${resolvedTitle}](${rel}) — ${description}`;
  let idx;
  try { idx = fs.readFileSync(INDEX_PATH, 'utf8'); } catch { idx = '# Index\n'; }
  fs.writeFileSync(INDEX_PATH, insertIndexLine(idx, heading, entry));

  return { memoryPath: rel, slug: s, indexUpdated: true };
}

module.exports = { slugify, deriveTitle, deriveDescription, writeMemory };
