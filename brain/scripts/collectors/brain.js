const path = require('path');
const { VAULT, safeStat, listDir, exists, readText, iso } = require('./util');
const { listDailyNotes } = require('../lib/paths.js');

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

// Daily-note dates ('YYYY-MM-DD', ascending) under the configured dailyNote.layout (lib/paths.js listDailyNotes).
function collectDailyNoteDates(vault) {
  return listDailyNotes({ vault }).map((n) => n.date);
}

function collectBrain() {
  const brainDir = path.join(VAULT, 'brain');
  const memoryDir = path.join(brainDir, 'memory');
  const patternsDir = path.join(brainDir, 'patterns');
  const reflectionsDir = path.join(brainDir, 'reflections');
  const indexDir = path.join(brainDir, '_index');
  const templatesDir = path.join(VAULT, 'templates');

  const memoryTypes = ['user', 'feedback', 'projects', 'reference'];
  const memoryByType = {};
  const memoryFiles = [];
  for (const t of memoryTypes) {
    const typeDir = path.join(memoryDir, t);
    const files = listDir(typeDir).filter(n => n.endsWith('.md'));
    memoryByType[t] = files.length;
    for (const f of files) memoryFiles.push(path.join(typeDir, f));
  }

  // MEMORY.md pointer parsing — lines like `- [Title](brain/memory/...)`
  const memoryMdPath = path.join(VAULT, 'MEMORY.md');
  const memoryMdText = readText(memoryMdPath) || '';
  const pointerRegex = /^- \[([^\]]+)\]\(([^)]+)\)/gm;
  const pointers = [];
  let m;
  while ((m = pointerRegex.exec(memoryMdText)) !== null) {
    pointers.push({ title: m[1].trim(), target: m[2].trim() });
  }
  const brokenPointers = pointers
    .filter(p => !exists(path.join(VAULT, p.target)))
    .map(p => ({ title: p.title, target: p.target }));

  // Reverse orphan check: memory files in brain/memory/ not referenced by MEMORY.md
  const pointedTargets = new Set(
    pointers
      .map(p => path.normalize(path.join(VAULT, p.target)).replace(/\\/g, '/').toLowerCase())
  );
  const orphanMemories = [];
  for (const f of memoryFiles) {
    const norm = path.normalize(f).replace(/\\/g, '/').toLowerCase();
    if (!pointedTargets.has(norm)) {
      const rel = path.relative(VAULT, f).replace(/\\/g, '/');
      orphanMemories.push(rel);
    }
  }

  // Patterns MEMORY.md also lists — same check, separate reporting
  const patternFiles = listDir(patternsDir).filter(n => n.endsWith('.md'));
  const orphanPatterns = [];
  for (const pf of patternFiles) {
    const full = path.join(patternsDir, pf);
    const norm = path.normalize(full).replace(/\\/g, '/').toLowerCase();
    if (!pointedTargets.has(norm)) {
      orphanPatterns.push(path.relative(VAULT, full).replace(/\\/g, '/'));
    }
  }

  // "Sessions" are daily notes (dates under the configured layout; the legacy brain/sessions/ is gone).
  const dailyDates = collectDailyNoteDates(VAULT);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayPresent = dailyDates.includes(today);
  let streak = 0;
  if (dailyDates.length > 0) {
    const dates = new Set(dailyDates);
    const probe = new Date();
    if (!todayPresent) probe.setDate(probe.getDate() - 1); // start from yesterday if today is missing
    while (true) {
      const key = `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, '0')}-${String(probe.getDate()).padStart(2, '0')}`;
      if (dates.has(key)) { streak++; probe.setDate(probe.getDate() - 1); }
      else break;
    }
  }

  // Oldest memories — surface the 3 that haven't been touched in a while
  const withAge = [...memoryFiles, ...patternFiles.map(n => path.join(patternsDir, n))]
    .map(p => {
      const s = safeStat(p);
      return s ? { path: path.relative(VAULT, p).replace(/\\/g, '/'), ageDays: daysSince(s.mtimeMs), mtime: iso(s.mtimeMs) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ageDays - a.ageDays);
  const oldestMemories = withAge.slice(0, 3);

  // Index files (BRAIN/SESSION/DASHBOARD) + .base files
  const idxFile = (name) => {
    const p = path.join(indexDir, name);
    const s = safeStat(p);
    return s ? { present: true, size: s.size, mtime: iso(s.mtimeMs), ageDays: daysSince(s.mtimeMs) } : { present: false };
  };
  const indexFiles = {
    brainMd: idxFile('BRAIN.md'),
    sessionMd: idxFile('SESSION.md'),
    dashboardMd: idxFile('DASHBOARD.md'),
    bases: listDir(indexDir).filter(n => n.endsWith('.base')),
  };

  // Templates
  const templates = listDir(templatesDir).filter(n => n.endsWith('.md'));

  const reflections = listDir(reflectionsDir).filter(n => n.endsWith('.md'));

  return {
    counts: {
      memoryByType,
      memoryTotal: memoryFiles.length,
      patterns: patternFiles.length,
      reflections: reflections.length,
      sessions: dailyDates.length,
      templates: templates.length,
    },
    sessions: {
      today: `${today}.md`,
      todayPresent,
      streak,
      latestDate: dailyDates.length ? dailyDates[dailyDates.length - 1] : null,
      oldestDate: dailyDates.length ? dailyDates[0] : null,
    },
    indexFiles,
    templates,
    reflectionsLatest: reflections.length ? reflections[reflections.length - 1].replace('.md', '') : null,
    memoryIndex: {
      pointerCount: pointers.length,
      brokenPointers,
      orphanMemories,
      orphanPatterns,
    },
    oldestMemories,
  };
}

module.exports = { collectBrain };
