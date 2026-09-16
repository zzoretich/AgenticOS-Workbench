const path = require('path');
const { VAULT, safeStat, listDir, readText, iso } = require('./util');

const ACTIVE_MAX_DAYS = 7;
const STALE_MAX_DAYS = 30;

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

function parsePlan(fullPath) {
  const text = readText(fullPath);
  const stat = safeStat(fullPath);
  const ageDays = stat ? daysSince(stat.mtimeMs) : null;
  const out = {
    name: path.basename(fullPath),
    path: path.relative(VAULT, fullPath).replace(/\\/g, '/'),
    size: stat?.size ?? null,
    mtime: stat ? iso(stat.mtimeMs) : null,
    ageDays,
    title: null,
    explicitStatus: null,
    checkboxes: { total: 0, done: 0, pct: null },
    sections: [],
    lifecycleStatus: null,
  };
  if (!text) return out;

  // Title — first `# ` heading
  const titleMatch = text.match(/^#\s+(.+)$/m);
  if (titleMatch) out.title = titleMatch[1].trim();

  // Sections — all `## ` headings
  out.sections = (text.match(/^##\s+(.+)$/gm) || []).map(s => s.replace(/^##\s+/, ''));

  // Checkboxes
  const total = (text.match(/^\s*[-*]\s*\[[ xX]\]/gm) || []).length;
  const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  out.checkboxes = { total, done, pct: total ? Math.round((done / total) * 100) : null };

  // Explicit status — match `## Status`, `## Status: X`, or `## Status  ` only (not `## Status Semantics`)
  const statusHeadingOnly = text.match(/^##\s+Status\s*$\n+([^\n#].*?)(?=\n\s*\n|\n##|$)/ms);
  const statusInline = text.match(/^##\s+Status\s*:\s*(.+?)\s*$/m);
  if (statusInline) {
    out.explicitStatus = statusInline[1].trim().slice(0, 120);
  } else if (statusHeadingOnly) {
    out.explicitStatus = statusHeadingOnly[1].trim().replace(/^[-*]\s*/, '').slice(0, 120);
  } else {
    // Also look for `status:` in frontmatter
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const st = fm[1].match(/^status:\s*(.+)$/im);
      if (st) out.explicitStatus = st[1].trim();
    }
  }

  // Lifecycle — age-based classification
  if (ageDays == null) out.lifecycleStatus = null;
  else if (ageDays <= ACTIVE_MAX_DAYS) out.lifecycleStatus = 'active';
  else if (ageDays <= STALE_MAX_DAYS) out.lifecycleStatus = 'stale';
  else out.lifecycleStatus = 'dormant';

  // If all checkboxes done or explicit status says complete → mark complete
  if (total > 0 && done === total) out.lifecycleStatus = 'complete';
  if (out.explicitStatus && /complete|done|shipped|archived/i.test(out.explicitStatus)) {
    out.lifecycleStatus = 'complete';
  }

  return out;
}

function collectPlans() {
  const plansDir = path.join(VAULT, 'plans');
  const files = listDir(plansDir).filter(n => n.endsWith('.md'));
  const plans = files.map(n => parsePlan(path.join(plansDir, n)));
  plans.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

  const summary = {
    total: plans.length,
    active: plans.filter(p => p.lifecycleStatus === 'active').length,
    stale: plans.filter(p => p.lifecycleStatus === 'stale').length,
    dormant: plans.filter(p => p.lifecycleStatus === 'dormant').length,
    complete: plans.filter(p => p.lifecycleStatus === 'complete').length,
    totalCheckboxes: plans.reduce((a, p) => a + p.checkboxes.total, 0),
    totalCheckboxesDone: plans.reduce((a, p) => a + p.checkboxes.done, 0),
  };

  return { plans, summary };
}

module.exports = { collectPlans };
