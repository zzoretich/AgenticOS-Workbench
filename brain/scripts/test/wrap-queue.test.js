'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wqueue-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
process.env.BRAIN_VAULT = TMP;
const q = require('../lib/wrap-queue.js');

// A real file on disk, because claim() drops entries whose transcript is gone.
const T1 = path.join(TMP, 't1.jsonl');
const T2 = path.join(TMP, 't2.jsonl');
const T3 = path.join(TMP, 't3.jsonl');
for (const f of [T1, T2, T3]) fs.writeFileSync(f, '{}\n');

beforeEach(() => { try { fs.unlinkSync(q.QUEUE_PATH); } catch {} });

const err = (msg, code) => Object.assign(new Error(msg), code ? { code } : {});

test('isRetryable: the two shapes the 2026-08-14 outage produced', () => {
  assert.equal(q.isRetryable(err('connect ECONNREFUSED 127.0.0.1:11434', 'ECONNREFUSED')), true);
  assert.equal(q.isRetryable(err('socket hang up')), true);
  assert.equal(q.isRetryable(err('ollama timeout')), true);
});

test('isRetryable: model and logic failures are NOT spooled', () => {
  // These already get an in-run harder-framed retry; spooling them would spin.
  assert.equal(q.isRetryable(err('no JSON object found in reply')), false);
  assert.equal(q.isRetryable(err('Bad control character in string literal')), false);
  // A missing model tag needs a human to pull it, not another attempt.
  assert.equal(q.isRetryable(err('ollama HTTP 404: model "qwen3.5:4b" not found')), false);
  assert.equal(q.isRetryable(null), false);
});

test('enqueue then claim returns the entry with attempts spent', async () => {
  await q.enqueue({ sessionId: 's1', transcriptPath: T1 });
  assert.equal(q.peek().length, 1);
  const due = await q.claim();
  assert.equal(due.length, 1);
  assert.equal(due[0].sessionId, 's1');
  assert.equal(due[0].attempts, 1, 'attempt is counted before the caller runs it');
  assert.equal(q.peek()[0].attempts, 1, 'and persisted, so a crash mid-retry cannot loop');
});

test('resolve removes a session after a successful retry', async () => {
  await q.enqueue({ sessionId: 's1', transcriptPath: T1 });
  await q.enqueue({ sessionId: 's2', transcriptPath: T2 });
  await q.resolve('s1');
  assert.deepEqual(q.peek().map((r) => r.sessionId), ['s2']);
});

test('re-enqueueing a spooled session preserves its attempt count', async () => {
  await q.enqueue({ sessionId: 's1', transcriptPath: T1 });
  await q.claim();                                   // attempts -> 1
  await q.enqueue({ sessionId: 's1', transcriptPath: T1 }); // failed again
  assert.equal(q.peek().length, 1, 'no duplicate row');
  assert.equal(q.peek()[0].attempts, 1, 'attempts must not reset to 0');
});

test('an entry is dropped once it exhausts MAX_ATTEMPTS', async () => {
  await q.enqueue({ sessionId: 's1', transcriptPath: T1 });
  for (let i = 0; i < q.MAX_ATTEMPTS; i++) {
    const due = await q.claim();
    assert.equal(due.length, 1, `attempt ${i + 1} should still be due`);
    await q.enqueue({ sessionId: 's1', transcriptPath: T1 }); // keeps failing
  }
  assert.deepEqual(await q.claim(), [], 'exhausted entry is no longer returned');
  assert.deepEqual(q.peek(), [], 'and is dropped from the spool');
});

test('entries older than the age limit are dropped, not retried', async () => {
  const stale = new Date(Date.now() - q.MAX_AGE_MS - 60_000).toISOString();
  fs.writeFileSync(q.QUEUE_PATH,
    JSON.stringify({ sessionId: 'old', transcriptPath: T1, queuedAt: stale, attempts: 0 }) + '\n');
  assert.deepEqual(await q.claim(), [], 'week-old working memory is worthless');
  assert.deepEqual(q.peek(), []);
});

test('an entry whose transcript no longer exists is dropped', async () => {
  const gone = path.join(TMP, 'deleted.jsonl');
  fs.writeFileSync(gone, '{}\n');
  await q.enqueue({ sessionId: 'g1', transcriptPath: gone });
  fs.unlinkSync(gone);
  assert.deepEqual(await q.claim(), []);
  assert.deepEqual(q.peek(), []);
});

test('the spool is capped, dropping oldest first', async () => {
  for (let i = 0; i < q.QUEUE_MAX + 4; i++) {
    await q.enqueue({ sessionId: `s${i}`, transcriptPath: T1 });
  }
  const ids = q.peek().map((r) => r.sessionId);
  assert.equal(ids.length, q.QUEUE_MAX);
  assert.equal(ids[ids.length - 1], `s${q.QUEUE_MAX + 3}`, 'newest retained');
  assert.ok(!ids.includes('s0'), 'oldest dropped');
});

test('claim honours exclude, so the live session is not run twice', async () => {
  await q.enqueue({ sessionId: 'live', transcriptPath: T1 });
  await q.enqueue({ sessionId: 'other', transcriptPath: T2 });
  const due = await q.claim({ exclude: 'live' });
  assert.deepEqual(due.map((r) => r.sessionId), ['other']);
  assert.ok(q.peek().some((r) => r.sessionId === 'live'), 'excluded entry stays spooled');
});

test('claim returns oldest first so SESSION.md ends on the newest session', async () => {
  await q.enqueue({ sessionId: 'a', transcriptPath: T1 });
  await q.enqueue({ sessionId: 'b', transcriptPath: T2 });
  await q.enqueue({ sessionId: 'c', transcriptPath: T3 });
  assert.deepEqual((await q.claim()).map((r) => r.sessionId), ['a', 'b', 'c']);
});

test('a torn line is skipped without losing the rest of the spool', async () => {
  fs.writeFileSync(q.QUEUE_PATH,
    JSON.stringify({ sessionId: 'ok1', transcriptPath: T1, queuedAt: new Date().toISOString(), attempts: 0 }) + '\n' +
    '{"sessionId":"trunc","transcriptPa\n' +
    JSON.stringify({ sessionId: 'ok2', transcriptPath: T2, queuedAt: new Date().toISOString(), attempts: 0 }) + '\n');
  assert.deepEqual((await q.claim()).map((r) => r.sessionId), ['ok1', 'ok2']);
});

test('enqueue ignores an incomplete hook payload', async () => {
  assert.equal(await q.enqueue({ sessionId: '', transcriptPath: T1 }), 0);
  assert.equal(await q.enqueue({ sessionId: 's1', transcriptPath: '' }), 0);
  assert.deepEqual(q.peek(), []);
});
