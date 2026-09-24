'use strict';
/**
 * wrap-offsets.js — how much of each session's transcript auto-wrap has already extracted (spec
 * 2026-09-24-no-duplicate-sessions D3). One session can reach auto-wrap more than once: a reconcile ends it while it
 * sits idle, then a later real SessionEnd, a resume or a spooled retry wraps it again. Each pass used to re-read the
 * same last 50,000 characters and write the same memories a second time.
 *
 *   <vault>/brain/_index/agent-runs/wrap-offsets.json   { schema: 1, sessions: { <session id>: { chars, at } } }
 *
 * `chars` is the length of the flattened transcript (transcript.js flattenTurns) already wrapped. A transcript is
 * append-only and so is its flattening, so that prefix never changes; a transcript shorter than its offset started
 * over and is read whole. The newest 500 sessions are kept. Never throws: a store it cannot read or write means one
 * more full wrap, never a lost session.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');

const FILE = path.join(PATHS.VAULT, 'brain', '_index', 'agent-runs', 'wrap-offsets.json');
const KEEP = 500;

function load(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.sessions && typeof j.sessions === 'object' && !Array.isArray(j.sessions)) return j;
  } catch { /* missing or unreadable: start empty */ }
  return { schema: 1, sessions: {} };
}

/** Characters of the session's flattened transcript already wrapped; 0 when none (or no session id). */
function wrappedChars(sessionId, { file = FILE } = {}) {
  if (!sessionId) return 0;
  const s = load(file).sessions[sessionId];
  return s && Number.isInteger(s.chars) && s.chars > 0 ? s.chars : 0;
}

/** The part of `text` no wrap has seen: after `chars`, or all of it when the text is shorter (it started over). */
function unwrappedPart(text, chars) {
  const t = String(text || '');
  return chars > 0 && chars <= t.length ? t.slice(chars) : t;
}

/** Whether a flattened part holds a user line ("user: …"); without one there is nothing new to extract. */
function hasNewDialogue(part) {
  return /(^|\n)user: \S/.test(String(part || ''));
}

/** Record that the first `chars` characters of the session's flattened transcript are wrapped. */
function markWrapped(sessionId, chars, { file = FILE, now = new Date() } = {}) {
  if (!sessionId || !Number.isInteger(chars) || chars < 0) return false;
  const state = load(file);
  state.schema = 1;
  state.sessions[sessionId] = { chars, at: now.toISOString() };
  const ids = Object.keys(state.sessions);
  if (ids.length > KEEP) {
    ids.sort((a, b) => String(state.sessions[a].at).localeCompare(String(state.sessions[b].at)));
    for (const id of ids.slice(0, ids.length - KEEP)) delete state.sessions[id];
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

module.exports = { FILE, KEEP, wrappedChars, unwrappedPart, hasNewDialogue, markWrapped };
