const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { VAULT, PATHS } = require('../lib/paths.js');

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function exists(p) {
  return safeStat(p) !== null;
}

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

function countLines(p) {
  try {
    const s = safeStat(p);
    if (!s || s.size > 50 * 1024 * 1024) return null;
    const buf = fs.readFileSync(p);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
  } catch { return null; }
}

function readText(p, maxBytes = 2 * 1024 * 1024) {
  try {
    const s = safeStat(p);
    if (!s || s.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

function readJson(p) {
  const t = readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function walkSize(dir, opts = {}) {
  const { maxDepth = 10, skipNames = new Set() } = opts;
  let bytes = 0;
  let files = 0;
  let newestMtime = 0;
  function walk(p, depth) {
    if (depth > maxDepth) return;
    const s = safeStat(p);
    if (!s) return;
    if (s.isFile()) {
      bytes += s.size;
      files++;
      if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs;
      return;
    }
    if (!s.isDirectory()) return;
    for (const name of listDir(p)) {
      if (skipNames.has(name)) continue;
      walk(path.join(p, name), depth + 1);
    }
  }
  walk(dir, 0);
  return { bytes, files, newestMtime: newestMtime ? new Date(newestMtime).toISOString() : null };
}

function humanSize(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

function iso(ms) {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

// Parse a leading `---`…`---` YAML frontmatter block into a flat {key: value} map.
// Strings only; tolerant of missing/malformed files. Returns {} when absent.
function readFrontmatter(absPath) {
  const t = readText(absPath, 256 * 1024);
  if (!t) return {};
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, '');
    out[kv[1]] = v;
  }
  return out;
}

// Most recent commit touching a path. Uses the dir's own repo if it has one,
// else the vault repo scoped to relPath. Returns { iso, subject, hash } or null.
function lastCommit(absDir, relPath) {
  const fmt = '%cI%x00%s%x00%h';
  try {
    const ownRepo = exists(path.join(absDir, '.git'));
    const args = ownRepo
      ? ['-C', absDir, 'log', '-1', `--format=${fmt}`]
      : ['-C', VAULT, 'log', '-1', `--format=${fmt}`, '--', relPath];
    const out = execFileSync('git', args, { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return null;
    const [ci, subject, hash] = out.split('\x00');
    if (!ci) return null;
    return { iso: ci, subject: subject || null, hash: hash || null };
  } catch { return null; }
}

module.exports = {
  VAULT, PATHS,
  safeStat, exists, listDir,
  countLines, readText, readJson,
  walkSize, humanSize, iso, nowIso,
  readFrontmatter, lastCommit,
};
