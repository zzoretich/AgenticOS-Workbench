'use strict';
/**
 * fsx.js — one set of file writes for the runtime's shared files (spec 2026-09-24-append-only-runs D1). Many writers
 * copied a `${file}.tmp` + rename pattern, so two processes writing one file shared a temp name and one of them lost:
 * its rename failed, or the last rename won with stale data. And a rewrite (read, change, rename) silently dropped
 * whatever another process appended in between.
 *
 *   writeAtomic(file, data)                 temp `<file>.<pid>.<random>.tmp` opened exclusively, then rename
 *   withLockSync(file, fn, opts)            run fn holding `<file>.lock` (owner-aware, like graph-build's lock)
 *   updateSync(file, fn, opts)              lock → read → fn(text | null) → write when it changed
 *   appendLineSync(file, line, opts)        one O_APPEND write; opts.lock waits for a rewrite to finish first
 *
 * The lock file holds { pid, id, until }. It is broken only when its owner's pid is gone or its `until` has passed,
 * and released only by the id that took it, so a slow holder never deletes a waiter's lock. `timeoutMs` bounds the
 * wait; on timeout `onBusy: 'throw'` (default) throws a LockBusy error and `onBusy: 'run'` runs fn without the lock,
 * for best-effort writers that must never block a hook for long. Synchronous by design: the writers are.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = { timeoutMs: 2000, staleMs: 30000, pollMs: 25, onBusy: 'throw' };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tempFor(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

/** Write `data` to `file` through a temp file no other writer can share, then rename over it. Throws on failure. */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempFor(file);
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}

/** Whether a lock file's owner still holds it: its pid is alive and its deadline has not passed. */
function lockHeld(owner, now = Date.now()) {
  return !!owner && pidAlive(owner.pid) && Date.parse(owner.until || '') > now;
}

class LockBusy extends Error {
  constructor(lockPath, owner) {
    super(`${lockPath} is held${owner && owner.pid ? ` by pid ${owner.pid}` : ''}`);
    this.code = 'LOCK_BUSY';
    this.owner = owner || null;
  }
}

/** Run fn holding `<file>.lock`; returns fn's result. See the header for opts. */
function withLockSync(file, fn, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lockPath = `${file}.lock`;
  const mine = { pid: process.pid, id: crypto.randomUUID(), until: new Date(Date.now() + o.staleMs).toISOString() };
  const deadline = Date.now() + o.timeoutMs;
  let taken = false;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(lockPath, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== null) {
      try { fs.writeSync(fd, JSON.stringify(mine)); } finally { fs.closeSync(fd); }
      taken = true;
      break;
    }
    const owner = readLock(lockPath);
    if (owner && !lockHeld(owner)) {
      // Its owner is gone or past its own deadline: break it, but only if it is still that same lock.
      const again = readLock(lockPath);
      if (again && again.id === owner.id) { try { fs.unlinkSync(lockPath); } catch { /* raced */ } }
      continue;
    }
    if (!owner) {
      // A lock being written right now, or an unreadable leftover: give a writer its moment, then treat it as stale.
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }
      if (age > o.staleMs) { try { fs.unlinkSync(lockPath); } catch { /* raced */ } continue; }
    }
    if (Date.now() >= deadline) {
      if (o.onBusy === 'run') break;
      throw new LockBusy(lockPath, owner);
    }
    sleepSync(o.pollMs);
  }
  try {
    return fn();
  } finally {
    if (taken) {
      const now = readLock(lockPath);
      if (now && now.id === mine.id) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
    }
  }
}

/** Lock, read `file` (null when missing), call fn(text) and write its result when it is a string that differs. */
function updateSync(file, fn, opts = {}) {
  return withLockSync(file, () => {
    let before = null;
    try { before = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const after = fn(before);
    if (typeof after === 'string' && after !== before) writeAtomic(file, after);
    return after;
  }, opts);
}

/** Append one line (a trailing newline is added). opts.lock: wait up to opts.timeoutMs for a rewrite to finish. */
function appendLineSync(file, line, opts = {}) {
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${String(line).replace(/\n+$/, '')}\n`);
  };
  if (!opts.lock) return write();
  return withLockSync(file, write, { timeoutMs: 1000, onBusy: 'run', ...opts });
}

module.exports = { writeAtomic, withLockSync, updateSync, appendLineSync, lockHeld, LockBusy, DEFAULTS };
