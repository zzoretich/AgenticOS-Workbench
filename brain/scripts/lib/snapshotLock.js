'use strict';
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// withLock(lockPath, fn, { retries, retryMs, staleMs }) — mkdir-based mutex.
// Breaks a lock whose dir mtime is older than staleMs (crash recovery).
async function withLock(lockPath, fn, opts = {}) {
  const retries = opts.retries ?? 50;
  const retryMs = opts.retryMs ?? 100;
  const staleMs = opts.staleMs ?? 60000;
  let held = false;
  for (let i = 0; i < retries && !held; i++) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) { fs.rmdirSync(lockPath); continue; }
      } catch { /* lock vanished; retry */ }
      await sleep(retryMs);
    }
  }
  if (!held) throw new Error(`could not acquire lock: ${lockPath}`);
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* already gone */ }
  }
}

module.exports = { withLock };
