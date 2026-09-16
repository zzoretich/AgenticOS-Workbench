'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { VAULT, safeStat, listDir, exists, readText, walkSize, lastCommit } = require('./util');
const { normalizeStatus, firstBodyLine } = require('./projects');

const NOISE_DIRS = new Set([
  'node_modules', 'assets', 'images', 'img', 'scripts', 'bin', 'docs',
  'tests', 'test', 'src', 'dist', 'build', 'archive', '.git', '.obsidian',
  'coverage', 'tmp', '.cache',
]);
const PROJECT_MARKERS = ['README.md', 'CLAUDE.md', 'STATUS.md', 'PLAN.md'];
const DOC_RANK = ['STATUS.md', 'HANDOFF.md', 'PLAN.md', 'PROGRESS.md', 'README.md'];
const MAX_DOCS = 5;

// ── manifest parser ──────────────────────────────────────────────
// Tolerant, supports exactly the fields we render:
//   scalar: status, summary, next, type
//   block list: objectives:\n  - item
//   subprojects:\n  - { name: x, path: y }   |   - bareName
function parseManifest(text) {
  const empty = { status: null, summary: null, objectives: [], subprojects: [], documents: [], next: null };
  if (!text) return empty;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return empty;
  const lines = m[1].split(/\r?\n/);
  const out = { ...empty, objectives: [], subprojects: [], documents: [] };
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
  let mode = null; // 'objectives' | 'subprojects' | 'documents'
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && mode) {
      const val = listItem[1].trim();
      if (mode === 'objectives') {
        out.objectives.push(unquote(val));
      } else if (mode === 'documents') {
        out.documents.push(unquote(val));
      } else if (mode === 'subprojects') {
        const flow = val.match(/^\{\s*(.*?)\s*\}$/);
        if (flow) {
          const obj = {};
          for (const pair of flow[1].split(',')) {
            const kv = pair.split(':');
            if (kv.length >= 2) obj[kv[0].trim()] = unquote(kv.slice(1).join(':'));
          }
          const name = obj.name || obj.path;
          if (name) out.subprojects.push({ name, path: obj.path || name });
        } else {
          const name = unquote(val);
          if (name) out.subprojects.push({ name, path: name });
        }
      }
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (key === 'objectives') { mode = 'objectives'; continue; }
    if (key === 'documents') { mode = 'documents'; continue; }
    if (key === 'subprojects') { mode = 'subprojects'; continue; }
    mode = null;
    if (key === 'status') out.status = value ? unquote(value) : null;
    else if (key === 'summary') out.summary = value ? unquote(value) : null;
    else if (key === 'next') out.next = value ? unquote(value) : null;
  }
  return out;
}

function isProjectLike(absChild) {
  if (exists(path.join(absChild, '.git'))) return true;
  return PROJECT_MARKERS.some((mk) => exists(path.join(absChild, mk)));
}

// Returns { isCollection, subprojects[], docs[] }.
// Collection = >=2 project-like child dirs (noise excluded). Otherwise single-project:
// surface up to MAX_DOCS top-level .md files, ranked by DOC_RANK then recency.
function detectChildren(absDir, relDir) {
  const childDirs = [];
  for (const name of listDir(absDir)) {
    if (NOISE_DIRS.has(name) || name.startsWith('.')) continue;
    const st = safeStat(path.join(absDir, name));
    if (st && st.isDirectory()) childDirs.push(name);
  }
  const projectLike = childDirs.filter((n) => isProjectLike(path.join(absDir, n)));

  if (projectLike.length >= 2) {
    const subprojects = projectLike.sort().map((n) => ({
      name: n,
      path: `${relDir}/${n}`,
      status: null,
      summary: firstBodyLine(path.join(absDir, n, 'README.md'))
        || firstBodyLine(path.join(absDir, n, 'STATUS.md')) || null,
    }));
    return { isCollection: true, subprojects, docs: [] };
  }

  const mdFiles = listDir(absDir).filter((n) => {
    const st = safeStat(path.join(absDir, n));
    return st && st.isFile() && n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'workspace.md';
  });
  mdFiles.sort((a, b) => {
    const ra = DOC_RANK.indexOf(a); const rb = DOC_RANK.indexOf(b);
    const wa = ra === -1 ? 99 : ra; const wb = rb === -1 ? 99 : rb;
    if (wa !== wb) return wa - wb;
    const ma = safeStat(path.join(absDir, a))?.mtimeMs || 0;
    const mb = safeStat(path.join(absDir, b))?.mtimeMs || 0;
    return mb - ma;
  });
  const docs = mdFiles.slice(0, MAX_DOCS).map((n) => ({ name: n, path: `${relDir}/${n}` }));
  return { isCollection: false, subprojects: [], docs };
}

// Bullets under the first "## Objectives" / "## Goals" heading (until next heading).
function extractObjectives(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (inSection) break;
      if (/^(objectives|goals|scope|project\s+scope)\b/i.test(heading[1])) inSection = true;
      continue;
    }
    if (inSection) {
      const b = line.match(/^[-*+]\s+(.*)$/);
      if (b) out.push(b[1].trim());
    }
  }
  return out;
}

// First bullet under the first "## Next" / "## What's Next" / "## TODO" heading.
function extractNext(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (inSection) break;
      if (/^(next|what['’]?s\s+next|to\s?do|todo)\b/i.test(heading[1])) inSection = true;
      continue;
    }
    if (inSection) {
      const b = line.match(/^[-*+]\s+(.*)$/);
      if (b) return b[1].trim();
    }
  }
  return null;
}

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

// Default status when none is declared in a manifest or STATUS file.
function defaultStatusFromAge(ageDays) {
  if (ageDays == null) return 'planned';
  if (ageDays <= 14) return 'active';
  if (ageDays <= 60) return 'idle';
  return 'planned';
}

function computeInputHash(input) {
  const stable = {
    status: input.status || null,
    summary: input.summary || null,
    objectives: (input.objectives || []).map((o) => (typeof o === 'string' ? o : o.text)),
    subprojects: (input.subprojects || []).map((s) => `${s.name}:${s.status || ''}`),
    next: input.next ? input.next.text || input.next : null,
    ageBucket: input.lastEvent && input.lastEvent.ageDays != null
      ? Math.min(input.lastEvent.ageDays, 30) : null,
  };
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

// Read the first existing file from a ranked list; return its text or null.
function firstReadable(absDir, names) {
  for (const n of names) {
    const t = readText(path.join(absDir, n), 256 * 1024);
    if (t) return { name: n, text: t };
  }
  return null;
}

function scanOneWorkspace(absDir, relDir, name) {
  const manifestText = readText(path.join(absDir, 'workspace.md'), 256 * 1024);
  const manifest = parseManifest(manifestText);

  // last event (git)
  const lc = lastCommit(absDir, relDir);
  const stat = safeStat(absDir);
  const lastEvent = lc
    ? { iso: lc.iso, ageDays: daysSince(new Date(lc.iso).getTime()), subject: lc.subject }
    : { iso: stat ? new Date(stat.mtimeMs).toISOString() : null,
        ageDays: stat ? daysSince(stat.mtimeMs) : null, subject: null };

  // status
  let status = manifest.status ? normalizeStatus(manifest.status) : null;
  let statusSource = manifest.status ? 'manifest' : 'derived';
  if (!status) {
    const sf = firstReadable(absDir, ['STATUS.md', 'HANDOFF.md']);
    if (sf) { status = normalizeStatus(sf.text.match(/status[:\s]+([a-z _-]+)/i)?.[1]) || null; }
  }
  if (!status) { status = defaultStatusFromAge(lastEvent.ageDays); }

  // summary
  let summary = manifest.summary || null;
  let summarySource = manifest.summary ? 'manifest' : 'derived';
  if (!summary) {
    summary = firstBodyLine(path.join(absDir, 'STATUS.md'))
      || firstBodyLine(path.join(absDir, 'README.md'))
      || firstBodyLine(path.join(absDir, 'HANDOFF.md'))
      || firstBodyLine(path.join(absDir, 'CLAUDE.md')) || null;
  }

  // objectives
  let objectives = [];
  if (manifest.objectives.length) {
    objectives = manifest.objectives.map((t) => ({ text: t, source: 'manifest' }));
  } else {
    for (const f of ['PLAN.md', 'MASTER-PLAN.md', 'PROGRESS.md', 'README.md', 'STATUS.md', 'CLAUDE.md']) {
      const ex = extractObjectives(readText(path.join(absDir, f), 256 * 1024));
      if (ex.length) { objectives = ex.map((t) => ({ text: t, source: 'derived' })); break; }
    }
  }

  // children
  let isCollection, subprojects, docs;
  if (manifest.subprojects.length) {
    isCollection = false; docs = [];
    subprojects = manifest.subprojects.map((s) => ({
      name: s.name, path: `${relDir}/${s.path}`, status: null,
      summary: firstBodyLine(path.join(absDir, s.path, 'README.md')) || null,
    }));
  } else {
    ({ isCollection, subprojects, docs } = detectChildren(absDir, relDir));
  }
  // A manifest `documents:` list curates KEY DOCUMENTS explicitly (files or dirs),
  // overriding auto-derivation. Each entry's display name is its trailing path segment.
  if (manifest.documents.length) {
    isCollection = false; subprojects = [];
    docs = manifest.documents.map((d) => {
      const rel = d.replace(/\/+$/, '');
      const name = rel.split('/').pop() + (d.endsWith('/') ? '/' : '');
      return { name, path: `${relDir}/${rel}` };
    });
  }

  // next
  let next;
  if (manifest.next) {
    next = { text: manifest.next, source: 'manifest' };
  } else {
    let nextText = null;
    for (const f of ['STATUS.md', 'PLAN.md', 'README.md', 'CLAUDE.md']) {
      nextText = extractNext(readText(path.join(absDir, f), 256 * 1024));
      if (nextText) break;
    }
    if (!nextText && lc && lc.subject) nextText = lc.subject;
    next = { text: nextText, source: 'derived' };
  }

  const entry = {
    name, path: relDir, status, statusSource, summary, summarySource,
    objectives, isCollection, subprojects, docs, next, lastEvent,
    insight: { text: null, status: 'unavailable' },
  };
  entry.inputHash = computeInputHash(entry);
  // Absolute filesystem path of the workspace, recorded at scan time so the
  // plugin's file tree can read files via Node fs directly — robust even when
  // Obsidian opens a symlink-curated vault whose root differs from where the
  // collector ran. Set AFTER the hash so it never affects insight caching.
  entry.absPath = absDir;
  return entry;
}

// Sync discovery. `prevWorkspaces` (from the previous snapshot) lets us carry
// forward cached insights; insight *generation* happens later (async, in main()).
function collectWorkspaces(opts = {}) {
  const vault = opts.vault || VAULT;
  const dirName = opts.workspacesDirName || 'workspaces';
  const wsRoot = path.join(vault, dirName);
  const prev = new Map((opts.prevWorkspaces || []).map((w) => [w.name, w]));
  const out = [];
  for (const name of listDir(wsRoot)) {
    if (name.startsWith('.')) continue;
    const absDir = path.join(wsRoot, name);
    const st = safeStat(absDir);
    if (!st || !st.isDirectory()) continue;
    const relDir = `${dirName}/${name}`;
    const entry = scanOneWorkspace(absDir, relDir, name);
    const old = prev.get(name);
    if (old && old.insight && old.insight.inputHash === entry.inputHash && old.insight.text) {
      entry.insight = old.insight; // unchanged inputs → reuse cached insight
    }
    out.push(entry);
  }
  out.sort((a, b) => {
    const rank = (s) => (s === 'active' ? 0 : s === 'blocked' ? 1 : s === 'idle' ? 2 : s === 'planned' ? 3 : 4);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return (a.lastEvent.ageDays ?? 999) - (b.lastEvent.ageDays ?? 999);
  });
  return out;
}

module.exports = { parseManifest, detectChildren, extractObjectives, extractNext, defaultStatusFromAge, computeInputHash, collectWorkspaces };
