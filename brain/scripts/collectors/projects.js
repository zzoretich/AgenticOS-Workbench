const path = require('path');
const { VAULT, PATHS, safeStat, listDir, exists, countLines, walkSize, iso, readJson, readText, readFrontmatter, lastCommit } = require('./util');

// Canonical workspace status vocabulary + alias normalization.
function normalizeStatus(s) {
  if (!s) return null;
  const v = String(s).toLowerCase().trim();
  if (/(in[_\s-]?progress|active|wip|ongoing)/.test(v)) return 'active';
  if (/(done|complete|shipped|roadmap[_\s-]?complete|finished)/.test(v)) return 'shipped';
  if (/(planned|backlog|todo|idea|scoping)/.test(v)) return 'planned';
  if (/(blocked|stuck|waiting|on[_\s-]?hold)/.test(v)) return 'blocked';
  if (/(paused|idle|parked)/.test(v)) return 'idle';
  if (/(dormant|archived|stale)/.test(v)) return 'dormant';
  return 'active';
}

// Strip common inline markdown so summaries render cleanly as plain text.
function stripMd(s) {
  return s
    .replace(/`([^`]+)`/g, '$1')                 // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // **bold**
    .replace(/__([^_]+)__/g, '$1')               // __bold__
    .replace(/\*([^*]+)\*/g, '$1')               // *italic*
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // [text](url) -> text
    .replace(/^[-*+]\s+/, '')                     // leading list bullet
    .replace(/^\d+\.\s+/, '')                     // leading ordered marker
    .trim();
}

// First meaningful body line (skips frontmatter, headings, hr), markdown-stripped + truncated.
function firstBodyLine(absPath) {
  const t = readText(absPath, 256 * 1024);
  if (!t) return null;
  const body = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  for (const raw of body.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    if (/^([-*_=])\1{2,}$/.test(line)) continue;            // skip --- *** === hr lines
    line = stripMd(line);
    if (!line) continue;
    return line.length > 160 ? line.slice(0, 157) + '…' : line;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIN_CWD_RE = /^[A-Z]--/;                                  // C--Users-alice--claude
const NIX_CWD_RE = /^-(Users|home|var|tmp|opt|etc|root|mnt)-/;  // -home-alice--claude, -home-user
const RUNTIME_CWD_RE = new RegExp(`${WIN_CWD_RE.source}|${NIX_CWD_RE.source}`);
const STALE_DAYS = 30;

const scannerCfg = readJson(path.join(VAULT, 'brain/_index/scanner-config.json')) || {};
const ORPHAN_MIN_AGE_MS = (scannerCfg.orphanUuidMinAgeMinutes ?? 60) * 60 * 1000;

function decodeRuntimeCwd(name) {
  // Windows: C--Users-alice--claude → C:\Users\alice\.claude
  // Unix:    -home-alice--claude    → /home/alice/.claude
  // Rule: `--` → dot-prefixed segment separator, single `-` → segment separator.
  if (WIN_CWD_RE.test(name)) {
    const drive = name[0];
    let rest = name.slice(3); // skip "C--"
    rest = rest.replace(/--/g, '\x00').replace(/-/g, '\\').replace(/\x00/g, '\\.');
    return `${drive}:\\${rest}`;
  }
  if (NIX_CWD_RE.test(name)) {
    let rest = name.slice(1); // skip leading "-"
    rest = rest.replace(/--/g, '\x00').replace(/-/g, '/').replace(/\x00/g, '/.');
    return '/' + rest;
  }
  return null;
}

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

function collectProjects() {
  const projectsDir = PATHS.PROJECTS;
  // Additional project roots (e.g. vault-root "workspaces/") from scanner-config.json.
  // Relocating projects out of projects/ keeps them indexed by listing the root here.
  const extraProjectRoots = (Array.isArray(scannerCfg.extraProjectRoots) ? scannerCfg.extraProjectRoots : [])
    .map(r => path.join(VAULT, r));
  const projectRoots = [projectsDir, ...extraProjectRoots];
  const tasksDir = path.join(PATHS.CLAUDE_CONFIG_DIR, 'tasks');
  const sessionEnvDir = path.join(PATHS.CLAUDE_CONFIG_DIR, 'session-env');
  const fileHistoryDir = path.join(PATHS.CLAUDE_CONFIG_DIR, 'file-history');

  // Build UUID side-folder indexes
  const taskUuids = new Map(); // uuid → { hasLock, ageDays, mtime }
  for (const name of listDir(tasksDir)) {
    if (!UUID_RE.test(name)) continue;
    const dir = path.join(tasksDir, name);
    const st = safeStat(dir);
    if (!st) continue;
    const hasLock = exists(path.join(dir, '.lock'));
    taskUuids.set(name.toLowerCase(), {
      hasLock,
      mtime: iso(st.mtimeMs),
      ageDays: daysSince(st.mtimeMs),
    });
  }
  const envUuids = new Map();
  for (const name of listDir(sessionEnvDir)) {
    if (!UUID_RE.test(name)) continue;
    const dir = path.join(sessionEnvDir, name);
    const st = safeStat(dir);
    if (!st) continue;
    const sz = walkSize(dir, { maxDepth: 4 });
    envUuids.set(name.toLowerCase(), { bytes: sz.bytes, files: sz.files, mtime: iso(st.mtimeMs), ageDays: daysSince(st.mtimeMs) });
  }
  const fhUuids = new Map();
  for (const name of listDir(fileHistoryDir)) {
    if (!UUID_RE.test(name)) continue;
    const dir = path.join(fileHistoryDir, name);
    const st = safeStat(dir);
    if (!st) continue;
    const sz = walkSize(dir, { maxDepth: 4 });
    fhUuids.set(name.toLowerCase(), { bytes: sz.bytes, files: sz.files, mtime: iso(st.mtimeMs), ageDays: daysSince(st.mtimeMs) });
  }

  // Walk projects/: classify each subdir; collect per-UUID JSONL info
  const projects = [];
  const sessions = [];   // UUIDs that have a JSONL somewhere
  const uuidToJsonl = new Map();

  for (const root of projectRoots) {
  for (const name of listDir(root)) {
    const full = path.join(root, name);
    const st = safeStat(full);
    if (!st || !st.isDirectory()) continue;

    if (RUNTIME_CWD_RE.test(name)) {
      // Runtime-cwd project: collect JSONL files
      const jsonls = listDir(full).filter(n => n.endsWith('.jsonl'));
      let totalBytes = 0;
      let latestMtime = 0;
      for (const jn of jsonls) {
        const jpath = path.join(full, jn);
        const jst = safeStat(jpath);
        if (!jst) continue;
        totalBytes += jst.size;
        if (jst.mtimeMs > latestMtime) latestMtime = jst.mtimeMs;
        const uuid = jn.replace(/\.jsonl$/, '').toLowerCase();
        const lines = countLines(jpath);
        uuidToJsonl.set(uuid, {
          jsonlPath: path.relative(VAULT, jpath).replace(/\\/g, '/'),
          jsonlBytes: jst.size,
          jsonlMtime: iso(jst.mtimeMs),
          jsonlAgeDays: daysSince(jst.mtimeMs),
          records: lines,
          projectName: name,
        });
      }
      projects.push({
        name,
        kind: 'runtime-cwd',
        decodedCwd: decodeRuntimeCwd(name),
        path: path.relative(VAULT, full).replace(/\\/g, '/'),
        jsonlCount: jsonls.length,
        totalBytes,
        latestMtime: latestMtime ? iso(latestMtime) : null,
        latestAgeDays: latestMtime ? daysSince(latestMtime) : null,
      });
    } else {
      // User-named project
      const files = listDir(full);
      const sz = walkSize(full, { maxDepth: 4 });

      // Find matching brain memory across all types (user may classify as reference, etc.)
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const memTypes = ['projects', 'reference', 'feedback', 'user'];
      let linkedMemory = null;
      for (const t of memTypes) {
        const dir = path.join(VAULT, 'brain/memory', t);
        for (const mf of listDir(dir).filter(n => n.endsWith('.md'))) {
          const mfSlug = mf.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (mfSlug === slug) { linkedMemory = `brain/memory/${t}/${mf}`; break; }
          // Also match substring for multi-word project names (e.g. "1 - Ruflo" → "ruflo")
          const coreSlug = slug.replace(/^\d+-/, '').replace(/^-+|-+$/g, '');
          if (coreSlug && (mfSlug === coreSlug || mfSlug.endsWith('-' + coreSlug) || mfSlug.startsWith(coreSlug + '-'))) {
            linkedMemory = `brain/memory/${t}/${mf}`;
            break;
          }
        }
        if (linkedMemory) break;
      }

      // Last event = most recent git commit touching the folder; fallback to mtime.
      const rel = path.relative(VAULT, full).replace(/\\/g, '/');
      const ev = lastCommit(full, rel);
      const lastEvent = ev
        ? { iso: ev.iso, ageDays: daysSince(new Date(ev.iso).getTime()), subject: ev.subject }
        : { iso: iso(st.mtimeMs), ageDays: daysSince(st.mtimeMs), subject: null };

      // Status + summary (hybrid): authored STATUS.md/HANDOFF.md wins, else derive.
      let status, statusSource, nextStep = null, summary = null;
      const statusMd = path.join(full, 'STATUS.md');
      const handoffMd = path.join(full, 'HANDOFF.md');
      if (exists(statusMd)) {
        const fm = readFrontmatter(statusMd);
        status = normalizeStatus(fm.status) || 'active';
        nextStep = fm.next_step || fm.nextStep || null;
        summary = fm.summary || firstBodyLine(statusMd);
        statusSource = 'status.md';
      } else if (exists(handoffMd)) {
        const fm = readFrontmatter(handoffMd);
        status = normalizeStatus(fm.status) || 'active';
        nextStep = fm.next_step || fm.nextStep || null;
        summary = fm.summary || firstBodyLine(handoffMd);
        statusSource = 'handoff.md';
      } else {
        const age = lastEvent.ageDays;
        status = age == null ? 'dormant' : age <= 7 ? 'active' : age <= 30 ? 'idle' : 'dormant';
        summary = linkedMemory ? firstBodyLine(path.join(VAULT, linkedMemory)) : null;
        statusSource = 'derived';
      }

      projects.push({
        name,
        kind: 'user-named',
        path: rel,
        fileCount: files.length,
        totalBytes: sz.bytes,
        mtime: iso(st.mtimeMs),
        ageDays: daysSince(st.mtimeMs),
        hasClaudeMd: exists(path.join(full, 'CLAUDE.md')),
        hasAgentsMd: exists(path.join(full, 'AGENTS.md')),
        hasReadme: exists(path.join(full, 'README.md')),
        linkedMemory,
        status,
        statusSource,
        nextStep,
        summary,
        lastEvent,
      });
    }
  }
  }

  // Assemble per-UUID session rows (union of all UUID sources)
  const allUuids = new Set([
    ...uuidToJsonl.keys(),
    ...taskUuids.keys(),
    ...envUuids.keys(),
    ...fhUuids.keys(),
  ]);

  for (const uuid of allUuids) {
    const j = uuidToJsonl.get(uuid);
    const t = taskUuids.get(uuid);
    const e = envUuids.get(uuid);
    const f = fhUuids.get(uuid);
    const hasLock = !!(t && t.hasLock);

    // Last activity = max mtime across all sources we know about
    const candidates = [
      j?.jsonlMtime, t?.mtime, e?.mtime, f?.mtime,
    ].filter(Boolean).map(s => new Date(s).getTime());
    const lastActivityMs = candidates.length ? Math.max(...candidates) : null;
    const ageDays = lastActivityMs ? daysSince(lastActivityMs) : null;

    sessions.push({
      uuid,
      hasJsonl: !!j,
      projectName: j?.projectName || null,
      jsonlPath: j?.jsonlPath || null,
      jsonlBytes: j?.jsonlBytes ?? null,
      records: j?.records ?? null,
      hasTasks: !!t,
      hasLock,
      taskAgeDays: t?.ageDays ?? null,
      hasEnv: !!e,
      envBytes: e?.bytes ?? null,
      hasFileHistory: !!f,
      fileHistoryBytes: f?.bytes ?? null,
      lastActivity: lastActivityMs ? iso(lastActivityMs) : null,
      ageDays,
      stale: ageDays != null && ageDays >= STALE_DAYS && !hasLock,
    });
  }

  sessions.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));

  // Orphans per side-folder: UUID has side-folder but no JSONL anywhere.
  // Split by age — fresh ones may still get populated (transient), old ones are real residue.
  const isOldEnough = (entry) => {
    if (!entry?.mtime) return true; // unknown age — flag conservatively
    return (Date.now() - new Date(entry.mtime).getTime()) >= ORPHAN_MIN_AGE_MS;
  };
  const pickOrphans = (map) => [...map.keys()].filter(u => !uuidToJsonl.has(u) && isOldEnough(map.get(u))).sort();
  const pickTransients = (map) => [...map.keys()].filter(u => !uuidToJsonl.has(u) && !isOldEnough(map.get(u))).sort();
  const orphanUuids = {
    sessionEnv:  pickOrphans(envUuids),
    tasks:       pickOrphans(taskUuids),
    fileHistory: pickOrphans(fhUuids),
  };
  const transientUuids = {
    sessionEnv:  pickTransients(envUuids),
    tasks:       pickTransients(taskUuids),
    fileHistory: pickTransients(fhUuids),
    minAgeMinutes: ORPHAN_MIN_AGE_MS / 60000,
  };

  return {
    projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
    sessions,
    orphanUuids,
    transientUuids,
    staleSessionCount: sessions.filter(s => s.stale).length,
    activeSessionCount: sessions.filter(s => s.hasLock).length,
    summary: {
      totalProjects: projects.length,
      runtimeCwdProjects: projects.filter(p => p.kind === 'runtime-cwd').length,
      userNamedProjects: projects.filter(p => p.kind === 'user-named').length,
      userNamedWithoutMemory: projects.filter(p => p.kind === 'user-named' && !p.linkedMemory).length,
      totalSessions: sessions.length,
      totalJsonlBytes: [...uuidToJsonl.values()].reduce((a, x) => a + x.jsonlBytes, 0),
      totalRecords: [...uuidToJsonl.values()].reduce((a, x) => a + (x.records || 0), 0),
    },
  };
}

module.exports = { collectProjects, decodeRuntimeCwd, normalizeStatus, stripMd, firstBodyLine };
