'use strict';
/**
 * fileMap.js — per-workspace file map with qwen one-line descriptions.
 * The map file IS the cache: a file is re-described only when {mtime,size}
 * differ from its cached row. Budget-capped per run; the remainder is
 * `pending` (Fix Queue: "N unmapped → map now"). qwen failures degrade to
 * pending, never throw — the scan must not die on an Ollama hiccup.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../lib/paths.js');
const { summarize } = require('../sdk/lib/qwen.js');

const MAPS_DIR = path.join(PATHS.INDEX, 'workspace-maps');
const WORKSPACES_DIR = path.join(PATHS.VAULT, 'workspaces');
const IGNORED_DIRS = new Set(['node_modules', '.git', '.obsidian', 'dist', 'build', '__pycache__', '.venv']);
const IGNORED_FILES = new Set(['.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock']);
const IGNORED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.pptx', '.xlsx', '.docx', '.bin', '.dylib', '.node']);
const MAX_SIZE = 1024 * 1024;
const HEAD_CHARS = 4000;

function listWorkspaces() {
  try {
    return fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch { return []; }
}

function walkFiles(absRoot, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(absRoot, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      walkFiles(absRoot, r, out);
    } else if (e.isFile()) {
      if (IGNORED_FILES.has(e.name) || IGNORED_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(path.join(absRoot, r)); } catch { continue; }
      if (st.size > MAX_SIZE) continue;
      out.push({ path: r, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function readMap(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, `${name}.json`), 'utf8'));
    if (parsed && Array.isArray(parsed.files)) return parsed;
  } catch { /* missing or corrupt — rebuild */ }
  return { workspace: name, generatedAt: null, files: [], pending: 0 };
}

function writeMap(name, map) {
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  const p = path.join(MAPS_DIR, `${name}.json`);
  fs.writeFileSync(p + '.tmp', JSON.stringify(map, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
}

async function describe(absPath, relPath, chatFn) {
  let head = '';
  try { head = fs.readFileSync(absPath, 'utf8').slice(0, HEAD_CHARS); } catch { return null; }
  try {
    const line = await summarize(`FILE: ${relPath}\n---\n${head}`, {
      style: 'prose', maxWords: 14, chatFn,
      focus: 'in one line, what this file does or is for',
    });
    const clean = String(line).split('\n')[0].replace(/^["'`\s]+|["'`\s]+$/g, '').slice(0, 120);
    return clean || null;
  } catch { return null; }
}

async function collectFileMaps(opts = {}) {
  const { budget = 40, workspaces = null, chatFn = undefined, report = null } = opts;
  const names = workspaces || listWorkspaces();
  let remaining = budget;
  let describedTotal = 0, pendingTotal = 0;
  const perWorkspace = {};

  for (const name of names) {
    const absRoot = path.join(WORKSPACES_DIR, name);
    const prev = readMap(name);
    const prevByPath = new Map(prev.files.map((f) => [f.path, f]));
    const current = walkFiles(absRoot);

    const rows = current.map((f) => {
      const old = prevByPath.get(f.path);
      if (!old) return { ...f, desc: null, descAt: null, status: 'new' };
      if (old.mtime !== f.mtime || old.size !== f.size)
        return { ...f, desc: old.desc, descAt: old.descAt, status: 'changed' };
      // Stats match this scan, but a prior scan may have left this row 'changed'
      // and budget-starved before it could be re-described. Stay 'changed' (never
      // launder back to 'fresh') until it's actually re-described — otherwise the
      // stale desc gets permanently mislabeled as fresh and the re-describe
      // obligation is silently lost.
      return { ...f, desc: old.desc, descAt: old.descAt, status: old.status === 'changed' ? 'changed' : (old.desc ? 'fresh' : 'new') };
    });

    // Spend budget oldest-mtime-first so stable files converge across scans.
    const todo = rows.filter((r) => r.status === 'new' || r.status === 'changed')
      .sort((a, b) => a.mtime - b.mtime);
    let described = 0;
    for (const row of todo) {
      if (remaining <= 0) break;
      remaining--;
      const line = await describe(path.join(absRoot, row.path), row.path, chatFn);
      if (line) { row.desc = line; row.descAt = new Date().toISOString(); row.status = 'fresh'; described++; }
    }

    const pending = rows.filter((r) => r.desc === null || r.status === 'changed' || r.status === 'new').length;
    writeMap(name, { workspace: name, generatedAt: new Date().toISOString(), files: rows, pending });
    perWorkspace[name] = { mapped: rows.length - pending, pending, described };
    describedTotal += described; pendingTotal += pending;
  }

  if (report) {
    report.counts.fileMapDescribed = describedTotal;
    report.counts.fileMapPending = pendingTotal;
    for (const n of names) report.wrote.push(`brain/_index/workspace-maps/${n}.json`);
  }
  return { perWorkspace, described: describedTotal, pending: pendingTotal };
}

async function describeOneFile(workspaceName, relPath, opts = {}) {
  const absRoot = path.join(WORKSPACES_DIR, workspaceName);
  const line = await describe(path.join(absRoot, relPath), relPath, opts.chatFn);
  if (!line) return null;
  const map = readMap(workspaceName);
  let row = map.files.find((f) => f.path === relPath);
  if (row) {
    // Existing row: mtime/size refresh is best-effort — a stat hiccup shouldn't
    // block persisting the new description.
    try { const st = fs.statSync(path.join(absRoot, relPath)); row.mtime = st.mtimeMs; row.size = st.size; } catch {}
  } else {
    // No row yet (new file, or workspace has no map): mtime/size are required to
    // create a valid row, so a stat failure means we cannot persist — fail loud
    // (null) rather than silently drop the description on the floor.
    let st;
    try { st = fs.statSync(path.join(absRoot, relPath)); } catch { return null; }
    row = { path: relPath, mtime: st.mtimeMs, size: st.size };
    map.files.push(row);
  }
  row.desc = line; row.descAt = new Date().toISOString(); row.status = 'fresh';
  map.pending = map.files.filter((r) => r.desc === null || r.status === 'changed' || r.status === 'new').length;
  map.generatedAt = new Date().toISOString();
  writeMap(workspaceName, map);
  return line;
}

module.exports = { collectFileMaps, describeOneFile, listWorkspaces, MAPS_DIR };
