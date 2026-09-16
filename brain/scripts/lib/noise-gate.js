'use strict';
/** noise-gate.js — guards the permanent memory store. Stricter beats sorrier. */
const { slugify } = require('./memory-writer.js');

const JUNK_PATTERNS = [
  /log was empty/i, /transcript (was |is )?empty/i, /nothing (of note|significant|notable)/i,
  /no (significant|notable) (activity|changes|work)/i, /^\s*(ok|none|n\/a)\s*$/i,
];
const TYPES = new Set(['user', 'feedback', 'projects', 'reference']);
const MAX_BODY_CHARS = 1200;
const MIN_DESC_CHARS = 15;

function isJunkSummary(text) {
  const t = String(text ?? '').trim();
  return JUNK_PATTERNS.some((p) => p.test(t)) || t.length < 20;
}

function tokens(s) { return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)); }

function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function gateCandidate(cand, { existingTitles, revertedSlugs }) {
  if (!cand || !TYPES.has(cand.type)) return { ok: false, reason: `invalid type: ${cand?.type}` };
  if (!cand.title || !cand.body) return { ok: false, reason: 'missing title or body' };
  if ((cand.description ?? '').length < MIN_DESC_CHARS) return { ok: false, reason: 'description too thin' };
  if (cand.body.length > MAX_BODY_CHARS) return { ok: false, reason: `body over-long (${cand.body.length} chars)` };
  if (revertedSlugs.has(slugify(cand.title))) return { ok: false, reason: 'slug was previously reverted' };
  for (const t of existingTitles) {
    if (jaccard(cand.title, t) >= 0.6) return { ok: false, reason: `near-duplicate of existing: "${t}"` };
  }
  return { ok: true };
}

module.exports = { isJunkSummary, jaccard, gateCandidate };
