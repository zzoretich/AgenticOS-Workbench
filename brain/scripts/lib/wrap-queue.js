'use strict';
/**
 * wrap-queue.js — retry spool for auto-wrap's SessionEnd extraction.
 *
 * auto-wrap fires exactly once per session end. Before this spool existed it
 * threw a session's whole extraction away whenever the local model server
 * happened to be unavailable at that instant — even though the transcript was
 * still sitting on disk, fully re-readable.
 *
 * Live loss 2026-08-14: the Mac rebooted mid-generation. One run died with
 * "socket hang up" 65s in, three more inside the next 11 seconds died with
 * ECONNREFUSED, and four sessions' facts/decisions/candidates were gone for
 * good. The 2026-08-11 incident recorded in ollama-serve.sh's header was the
 * same shape ("10 consecutive auto-wrap runs failed before it was noticed") and
 * produced a fix for the SERVER's uptime — KeepAlive — while nothing re-ran the
 * work that had already died. This closes that half.
 *
 * Scope is deliberately narrow: only connection-class failures are spooled.
 * Model-shaped failures (drifted JSON, unparseable reply) already get an in-run
 * harder-framed retry in auto-wrap's extractSessionKnowledge, and re-queueing
 * them would spin on a prompt problem no amount of retrying fixes.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');
const { withLock } = require('./snapshotLock.js');

const QUEUE_PATH = path.join(PATHS.INDEX, 'auto-wrap-pending.jsonl');
const LOCK_PATH = path.join(PATHS.INDEX, '.auto-wrap-pending.lock');
// Today's incident fired three workers in 11 seconds, so every mutation is
// locked. Short retries: contention here is milliseconds of file rewriting.
const LOCK_OPTS = { retries: 40, retryMs: 50, staleMs: 30000 };

const QUEUE_MAX = 10;      // a long outage must not grow this without bound
const MAX_ATTEMPTS = 3;    // a transcript that fails 3x is not an infra problem
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // week-old working memory is worthless

const RETRYABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH', 'EPIPE',
]);
// 'socket hang up' and 'ollama timeout' carry no .code — they are the exact two
// strings today's failures surfaced, so match on message as well as code.
const RETRYABLE_PATTERNS = /socket hang up|ollama timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed/i;

/**
 * Infra failure (worth retrying) vs model/logic failure (not). An `ollama HTTP
 * 404` for a missing model tag is deliberately NOT retryable: pulling the model
 * is a human's job and re-queueing would just burn attempts.
 */
function isRetryable(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  return RETRYABLE_PATTERNS.test(String((err && err.message) || err));
}

function readRows() {
  let raw;
  try { raw = fs.readFileSync(QUEUE_PATH, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.sessionId && r.transcriptPath) rows.push(r);
    } catch { /* skip a torn line rather than losing the whole spool */ }
  }
  return rows;
}

function writeRows(rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  const tmp = QUEUE_PATH + '.tmp';
  fs.writeFileSync(tmp, body ? body + '\n' : '');
  fs.renameSync(tmp, QUEUE_PATH); // atomic, so a concurrent reader never sees half a spool
}

/**
 * Spools one session for a later attempt. Re-queueing an already-spooled session
 * PRESERVES its attempt count — resetting it would let a permanently failing
 * transcript retry forever.
 */
async function enqueue({ sessionId, transcriptPath }) {
  if (!sessionId || !transcriptPath) return 0;
  let size = 0;
  await withLock(LOCK_PATH, async () => {
    const rows = readRows();
    const prior = rows.find((r) => r.sessionId === sessionId);
    const next = rows.filter((r) => r.sessionId !== sessionId);
    next.push({
      sessionId,
      transcriptPath,
      queuedAt: (prior && prior.queuedAt) || new Date().toISOString(),
      attempts: (prior && prior.attempts) || 0,
    });
    const kept = next.slice(-QUEUE_MAX); // drop oldest; freshest are worth most
    writeRows(kept);
    size = kept.length;
  }, LOCK_OPTS);
  return size;
}

/**
 * Returns the entries due for a retry, oldest first, with their attempt counts
 * already incremented AND PERSISTED. Persisting before the caller runs them is
 * what makes a crash mid-retry safe: the attempt is spent either way, so a
 * transcript that reliably kills the worker cannot loop forever.
 *
 * Entries are dropped here — not returned — when they are older than a week,
 * out of attempts, or their transcript no longer exists on disk.
 */
async function claim({ exclude } = {}) {
  const due = [];
  await withLock(LOCK_PATH, async () => {
    const now = Date.now();
    const live = [];
    for (const r of readRows()) {
      // Excluded (the caller runs it itself) — keep it spooled UNCHANGED. Not
      // bumped, because the drain is not attempting it; and not dropped, because
      // losing the row would reset attempts on re-enqueue and defeat the
      // exhaustion guard for exactly the session that keeps failing.
      if (exclude && r.sessionId === exclude) { live.push(r); continue; }
      const age = now - new Date(r.queuedAt || 0).getTime();
      if (!Number.isFinite(age) || age > MAX_AGE_MS) continue;
      if ((r.attempts || 0) >= MAX_ATTEMPTS) continue;
      if (!fs.existsSync(r.transcriptPath)) continue;
      const bumped = { ...r, attempts: (r.attempts || 0) + 1 };
      due.push(bumped);
      live.push(bumped);
    }
    writeRows(live);
  }, LOCK_OPTS);
  return due;
}

/** Removes a session from the spool after a successful retry. */
async function resolve(sessionId) {
  if (!sessionId) return;
  await withLock(LOCK_PATH, async () => {
    writeRows(readRows().filter((r) => r.sessionId !== sessionId));
  }, LOCK_OPTS);
}

/** Unlocked read for tests, status lines, and the flag-closer digest. */
function peek() { return readRows(); }

module.exports = {
  isRetryable, enqueue, claim, resolve, peek,
  QUEUE_PATH, QUEUE_MAX, MAX_ATTEMPTS, MAX_AGE_MS,
};
