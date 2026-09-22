'use strict';
/**
 * hostSessions.js — sessions per working directory, for both hosts (workspace hub spec D2).
 *
 *   Claude Code  <claude config dir>/projects/<slug>/*.jsonl — the slug encodes the cwd (projects.js
 *                decodeRuntimeCwd); one file is one session; lastAt is the newest mtime.
 *   Codex CLI    <codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions/ — the first
 *                line is session_meta with payload.cwd and a timestamp; nothing else is read.
 *
 * attachSessions() pins those counts to the workspace whose absolute path contains the cwd (longest
 * path-segment prefix wins) and returns the cwds that belong to no workspace, minus the places that
 * are infrastructure rather than projects: the home directory itself, the host config dirs, and the
 * vault outside workspaces/ (a session started in the vault root is the brain at work, not a stray
 * project). Cheap by design: directory listings and one line per rollout, no cache.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VAULT, PATHS, safeStat, listDir, iso } = require('./util');
const { decodeRuntimeCwd } = require('./projects');

const RUNTIME_CWD_RE = /^[A-Z]--|^-(Users|home|var|tmp|opt|etc|root|mnt)-/;
const FIRST_LINE_BYTES = 64 * 1024;

function defaultCodexDirs() {
  try {
    const d = require('../lib/host.js').hostDirs('codex');
    return { sessions: d.sessions, archived: d.archived };
  } catch { return { sessions: null, archived: null }; }
}

function bump(out, cwd, host, n, lastMs) {
  const e = out[cwd] || (out[cwd] = { claude: 0, codex: 0, lastAt: null, _last: 0 });
  e[host] += n;
  if (lastMs && lastMs > e._last) { e._last = lastMs; e.lastAt = iso(lastMs); }
}

function claudeByCwd(projectsDir, out) {
  for (const name of listDir(projectsDir)) {
    if (!RUNTIME_CWD_RE.test(name)) continue;
    const cwd = decodeRuntimeCwd(name);
    if (!cwd) continue;
    const dir = path.join(projectsDir, name);
    let count = 0;
    let last = 0;
    for (const f of listDir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const st = safeStat(path.join(dir, f));
      if (!st || !st.isFile()) continue;
      count++;
      if (st.mtimeMs > last) last = st.mtimeMs;
    }
    if (count) bump(out, cwd, 'claude', count, last);
  }
}

/** The first line of a file without reading the rest of it. */
function firstLine(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(FIRST_LINE_BYTES);
    const n = fs.readSync(fd, buf, 0, FIRST_LINE_BYTES, 0);
    const text = buf.slice(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch { return ''; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

function walkRollouts(dir, depth, onFile) {
  for (const name of listDir(dir)) {
    const full = path.join(dir, name);
    const st = safeStat(full);
    if (!st) continue;
    if (st.isDirectory()) { if (depth > 0) walkRollouts(full, depth - 1, onFile); continue; }
    if (st.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) onFile(full, st);
  }
}

function codexByCwd(sessionsDir, archivedDir, out) {
  const take = (file, st) => {
    let j;
    try { j = JSON.parse(firstLine(file)); } catch { return; }
    const p = j && typeof j === 'object' ? (j.payload && typeof j.payload === 'object' ? j.payload : j) : null;
    const cwd = p && typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
    if (!cwd) return;
    const ts = Date.parse((j && j.timestamp) || (p && p.timestamp) || '') || st.mtimeMs;
    bump(out, cwd, 'codex', 1, ts);
  };
  if (sessionsDir) walkRollouts(sessionsDir, 3, take);
  if (archivedDir) walkRollouts(archivedDir, 0, take);
}

/** { byCwd: { [cwd]: { claude, codex, lastAt } }, scannedAt } */
function collectHostSessions(opts = {}) {
  const codex = defaultCodexDirs();
  const claudeProjectsDir = opts.claudeProjectsDir === undefined ? PATHS.PROJECTS : opts.claudeProjectsDir;
  const codexSessionsDir = opts.codexSessionsDir === undefined ? codex.sessions : opts.codexSessionsDir;
  const codexArchivedDir = opts.codexArchivedDir === undefined ? codex.archived : opts.codexArchivedDir;
  const out = {};
  if (claudeProjectsDir) claudeByCwd(claudeProjectsDir, out);
  codexByCwd(codexSessionsDir, codexArchivedDir, out);
  const byCwd = {};
  for (const [cwd, e] of Object.entries(out)) byCwd[cwd] = { claude: e.claude, codex: e.codex, lastAt: e.lastAt };
  return { byCwd, scannedAt: new Date().toISOString() };
}

function insideDir(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/**
 * Give each workspace its `sessions` and return the cwds that belong to no workspace.
 * `ignore` lists infrastructure directories (exact match); the vault outside workspaces/ is ignored too.
 */
function attachSessions(workspaces, byCwd, opts = {}) {
  const vault = opts.vault === undefined ? VAULT : opts.vault;
  const workspacesRoot = opts.workspacesRoot || (vault ? path.join(vault, 'workspaces') : null);
  const ignore = new Set((opts.ignore || defaultIgnore()).filter(Boolean).map((p) => path.resolve(p)));
  const list = Array.isArray(workspaces) ? workspaces : [];
  for (const ws of list) ws.sessions = { claude: 0, codex: 0, total: 0, lastAt: null };
  const outside = [];
  for (const [cwd, e] of Object.entries(byCwd || {})) {
    let best = null;
    for (const ws of list) {
      if (!ws.absPath || !insideDir(cwd, ws.absPath)) continue;
      if (!best || ws.absPath.length > best.absPath.length) best = ws;
    }
    if (best) {
      const s = best.sessions;
      s.claude += e.claude || 0;
      s.codex += e.codex || 0;
      s.total = s.claude + s.codex;
      if (e.lastAt && (!s.lastAt || e.lastAt > s.lastAt)) s.lastAt = e.lastAt;
      continue;
    }
    if (ignore.has(path.resolve(cwd))) continue;
    if (vault && insideDir(cwd, vault) && !(workspacesRoot && insideDir(cwd, workspacesRoot))) continue;
    outside.push({ cwd, claude: e.claude || 0, codex: e.codex || 0, total: (e.claude || 0) + (e.codex || 0), lastAt: e.lastAt || null });
  }
  outside.sort((a, b) => (String(b.lastAt || '') > String(a.lastAt || '') ? 1 : String(b.lastAt || '') < String(a.lastAt || '') ? -1 : b.total - a.total));
  return outside;
}

function defaultIgnore() {
  const dirs = [os.homedir(), PATHS.CLAUDE_CONFIG_DIR];
  try { dirs.push(require('../lib/host.js').hostDirs('codex').configDir); } catch { /* no codex dirs */ }
  return dirs;
}

module.exports = { collectHostSessions, attachSessions, firstLine, insideDir, RUNTIME_CWD_RE };
