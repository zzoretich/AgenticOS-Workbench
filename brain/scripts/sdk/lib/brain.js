/**
 * brain.js — shared helpers for reading the vault.
 *
 * All paths resolve relative to the vault root, which comes from lib/paths.js
 * (the single vault resolver).
 * Pure Node, zero external deps.
 */

const fs = require('fs');
const path = require('path');
const { PATHS: ROOT, dailyNotePath, listDailyNotes } = require('../../lib/paths.js');

const VAULT = ROOT.VAULT;

const PATHS = {
  VAULT,
  CLAUDE_CONFIG_DIR: ROOT.CLAUDE_CONFIG_DIR,
  PROJECTS: ROOT.PROJECTS,
  BRAIN: path.join(VAULT, 'brain/_index/BRAIN.md'),
  SESSION: path.join(VAULT, 'brain/_index/SESSION.md'),
  MEMORY_INDEX: path.join(VAULT, 'MEMORY.md'),
  SNAPSHOT_JSON: path.join(VAULT, 'brain/_index/snapshot.json'),
  SNAPSHOT_MD: path.join(VAULT, 'brain/_index/snapshot.md'),
  HEALTH: path.join(VAULT, 'brain/_index/health.md'),
  MEMORY_DIR: path.join(VAULT, 'brain/memory'),
  PATTERNS_DIR: path.join(VAULT, 'brain/patterns'),
  REFLECTIONS_DIR: path.join(VAULT, 'brain/reflections'),
  HISTORY_DIR: path.join(VAULT, 'brain/_index/snapshots'),
};

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJsonIfExists(p) {
  const raw = readIfExists(p);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return { frontmatter: {}, body: content || '' };
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: content };
  const block = content.slice(4, end).trim();
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    fm[m[1]] = val;
  }
  return { frontmatter: fm, body: content.slice(end + 4).replace(/^\r?\n/, '') };
}

function walkMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && p.endsWith('.md')) out.push(p);
    }
  }
  return out;
}

function listMemories() {
  const files = walkMarkdown(PATHS.MEMORY_DIR);
  return files.map(f => {
    const rel = path.relative(PATHS.VAULT, f).replace(/\\/g, '/');
    const type = rel.split('/')[2] || 'unknown';
    const content = readIfExists(f) || '';
    const { frontmatter } = parseFrontmatter(content);
    return { path: rel, absPath: f, type, name: path.basename(f, '.md'), frontmatter };
  });
}

function readMemory(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(PATHS.VAULT, relPath);
  const safe = path.resolve(abs);
  if (!safe.startsWith(path.resolve(PATHS.VAULT))) return null;
  return readIfExists(safe);
}

function listPatterns() {
  return walkMarkdown(PATHS.PATTERNS_DIR).map(f => {
    const rel = path.relative(PATHS.VAULT, f).replace(/\\/g, '/');
    const content = readIfExists(f) || '';
    const { frontmatter } = parseFrontmatter(content);
    return { path: rel, absPath: f, name: path.basename(f, '.md'), frontmatter };
  });
}

// Daily notes: every note under the configured dailyNote.layout (lib/paths.js listDailyNotes), newest first.
function listSessions(limit = 20) {
  return listDailyNotes({ vault: VAULT }).reverse().slice(0, limit);
}

function readSession(date) {
  const clean = String(date).replace(/[^0-9-]/g, '');
  const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return readIfExists(dailyNotePath(d));
}

function listFeedback() {
  return listMemories().filter(m => m.type === 'feedback');
}

function loadSnapshot() {
  return readJsonIfExists(PATHS.SNAPSHOT_JSON);
}

function readBrief() {
  const candidates = [path.join(VAULT, 'brain/_index/brief.md')];
  if (process.env.AOS_BRIEF_PATH) candidates.push(process.env.AOS_BRIEF_PATH);
  for (const p of candidates) {
    const content = readIfExists(p);
    if (content != null) {
      let ageHours = null;
      try { ageHours = Math.round((Date.now() - fs.statSync(p).mtimeMs) / 3600000); } catch { /* stat only */ }
      return { path: path.relative(VAULT, p).replace(/\\/g, '/'), ageHours, content };
    }
  }
  return null;
}

function grepMemories(needle) {
  const q = String(needle || '').toLowerCase().trim();
  if (!q) return [];
  const hits = [];
  for (const m of listMemories()) {
    const content = readIfExists(m.absPath) || '';
    if (content.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) {
      const snippet = extractSnippet(content, q);
      hits.push({ path: m.path, name: m.name, type: m.type, snippet });
    }
  }
  for (const p of listPatterns()) {
    const content = readIfExists(p.absPath) || '';
    if (content.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
      hits.push({ path: p.path, name: p.name, type: 'pattern', snippet: extractSnippet(content, q) });
    }
  }
  return hits;
}

function extractSnippet(content, needle) {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return content.slice(0, 160);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + 160);
  return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\s+/g, ' ').trim() + (end < content.length ? '…' : '');
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

module.exports = {
  PATHS,
  readIfExists,
  readJsonIfExists,
  parseFrontmatter,
  walkMarkdown,
  listMemories,
  readMemory,
  listPatterns,
  listSessions,
  readSession,
  listFeedback,
  loadSnapshot,
  readBrief,
  grepMemories,
  todayDate,
  isoWeek,
};
