const fs = require('fs');
const path = require('path');
const { VAULT, safeStat, listDir, readJson } = require('./util');

const HISTORY_DIR = path.join(VAULT, 'brain/_index/snapshots');
const RETAIN_DAYS = 90;
const DAILY_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function makeCompactRecord(s) {
  return {
    date: s.scannedAt.slice(0, 10),
    scannedAt: s.scannedAt,
    totalBytes: s.folderAtlas.reduce((a, f) => a + (f.bytes || 0), 0),
    folderBytes: Object.fromEntries(s.folderAtlas.map(f => [f.name, f.bytes || 0])),
    counts: {
      agents: s.capabilities.agents.count,
      commands: s.capabilities.commands.count,
      skills: s.capabilities.skills.count,
      hooks: s.capabilities.hooks.count,
      hooksWired: s.capabilities.hooks.wired,
      brainScripts: s.capabilities.brainScripts.count,
      memories: s.brain.counts.memoryTotal,
      patterns: s.brain.counts.patterns,
      reflections: s.brain.counts.reflections,
      sessions: s.brain.counts.sessions,
    },
    health: { ...s.health.counts },
    plans: {
      total: s.plans.summary.total,
      totalCheckboxes: s.plans.summary.totalCheckboxes,
      done: s.plans.summary.totalCheckboxesDone,
      complete: s.plans.summary.complete,
    },
    projects: {
      projects: s.projects.summary.totalProjects,
      sessions: s.projects.summary.totalSessions,
      records: s.projects.summary.totalRecords,
      jsonlBytes: s.projects.summary.totalJsonlBytes,
      active: s.projects.activeSessionCount,
      stale: s.projects.staleSessionCount,
    },
  };
}

function readHistory() {
  const records = [];
  if (!safeStat(HISTORY_DIR)) return records;
  for (const name of listDir(HISTORY_DIR)) {
    if (!DAILY_RE.test(name)) continue;
    const r = readJson(path.join(HISTORY_DIR, name));
    if (r && r.date) records.push(r);
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

function findClosestBefore(records, targetDate) {
  const targetMs = new Date(targetDate + 'T23:59:59Z').getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const r of records) {
    const rMs = new Date(r.date + 'T12:00:00Z').getTime();
    if (rMs > targetMs) continue;
    const diff = Math.abs(rMs - targetMs);
    if (diff < bestDiff) { best = r; bestDiff = diff; }
  }
  return best;
}

function daysAgoDate(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function collectHistory(currentSnapshot) {
  const today = currentSnapshot.scannedAt.slice(0, 10);
  const all = readHistory();
  const priorOnly = all.filter(r => r.date !== today);
  const current = makeCompactRecord(currentSnapshot);

  const previous = priorOnly[priorOnly.length - 1] || null;
  const sevenDayAgo = findClosestBefore(priorOnly, daysAgoDate(7));
  const thirtyDayAgo = findClosestBefore(priorOnly, daysAgoDate(30));

  return {
    records: all.length,
    earliestDate: all[0]?.date || null,
    latestPriorDate: previous?.date || null,
    current,
    previous,
    sevenDayAgo: sevenDayAgo && sevenDayAgo.date !== previous?.date ? sevenDayAgo : null,
    thirtyDayAgo: thirtyDayAgo && thirtyDayAgo.date !== previous?.date && thirtyDayAgo.date !== sevenDayAgo?.date ? thirtyDayAgo : null,
  };
}

function writeDailyRecord(currentSnapshot) {
  if (!safeStat(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
  const rec = makeCompactRecord(currentSnapshot);
  const file = path.join(HISTORY_DIR, `${rec.date}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return file;
}

function prune() {
  if (!safeStat(HISTORY_DIR)) return 0;
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of listDir(HISTORY_DIR)) {
    const m = name.match(DAILY_RE);
    if (!m) continue;
    const rMs = new Date(m[1] + 'T00:00:00Z').getTime();
    if (rMs < cutoff) {
      try { fs.unlinkSync(path.join(HISTORY_DIR, name)); removed++; } catch {}
    }
  }
  return removed;
}

module.exports = { collectHistory, writeDailyRecord, prune, makeCompactRecord };
