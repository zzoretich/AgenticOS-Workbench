'use strict';
/**
 * host-routines.js — the recurring actions each session host owns, read-only (spec host-routines D2–D4).
 *
 *   codex   The Codex app's Automations: <codex home>/sqlite/codex-dev.db, tables `automations` and
 *           `automation_runs`, read live through the `sqlite3` CLI (`-readonly -json`). No Node binding
 *           (node:sqlite needs Node ≥ 22.5 and is absent in Electron), no dependency.
 *   claude  Claude Code cloud routines (claude.ai/code/routines). The runtime has no client for them —
 *           the OAuth token lives inside the Claude Code process — so a session imports the payload of
 *           the in-process `RemoteTrigger list` tool with `aos routines import-cloud <file>`.
 *
 * Cache: <vault>/brain/_index/routines-hosts.json =
 *   { schema: 1, hosts: { codex: { fetchedAt, ok, warning, routines }, claude: { fetchedAt, routines } } }
 * Row: { id, name, cadence, schedule, enabled, next, last: { at, status } | null, model, target, link, summary }
 * Every reader (aos routines, the MCP tool, the HUD) shows the section's age; nothing here ever throws.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cron = require('./cron.js');

const CACHE_SCHEMA = 1;
const HOSTS = ['codex', 'claude'];
const DAY_NAMES = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
const FULL_NAMES = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];
const ALL_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const pad = (n) => String(n).padStart(2, '0');
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtLocal(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return `${DAY[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function firstLine(text, max = 120) {
  const line = String(text || '').split(/\r?\n/).find(l => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
/** Epoch seconds or milliseconds (Codex stores ms) → ISO; null for anything that is not a finite number. */
function toIso(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return new Date(v < 1e11 ? v * 1000 : v).toISOString();
}

// ---------- RRULE (RFC 5545 subset the Codex app writes) ----------

function parseRrule(rrule) {
  const out = {};
  for (const part of String(rrule || '').replace(/^RRULE:/i, '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim().toUpperCase();
  }
  return out;
}

/** "Every day at 09:00", "Weekdays at 07:45", "Mon, Wed at 18:30", "Every 24 h at :00" — else the raw string. */
function describeRrule(rrule) {
  const raw = String(rrule || '').trim();
  const r = parseRrule(raw);
  if (!r.FREQ) return raw;
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const hour = r.BYHOUR !== undefined ? parseInt(r.BYHOUR.split(',')[0], 10) : null;
  const minute = r.BYMINUTE !== undefined ? parseInt(r.BYMINUTE.split(',')[0], 10) : 0;
  const at = hour !== null && Number.isFinite(hour) ? ` at ${pad(hour)}:${pad(minute)}` : '';
  const days = r.BYDAY ? r.BYDAY.split(',').map(d => d.replace(/^[-+]?\d+/, '')).filter(d => DAY_NAMES[d]) : [];
  const dayWord = () => {
    if (days.length === 7) return 'Every day';
    if (days.length === 5 && WEEKDAYS.every(d => days.includes(d))) return 'Weekdays';
    if (days.length === 1) return `${FULL_NAMES[days[0]]}s`;
    return ALL_DAYS.filter(d => days.includes(d)).map(d => DAY_NAMES[d]).join(', ');
  };
  switch (r.FREQ) {
    case 'MINUTELY': return interval === 1 ? 'Every minute' : `Every ${interval} min`;
    case 'HOURLY':
      if (interval === 1) return `Every hour${r.BYMINUTE !== undefined ? ` at :${pad(minute)}` : ''}`;
      return `Every ${interval} h${r.BYMINUTE !== undefined ? ` at :${pad(minute)}` : ''}`;
    case 'DAILY':
      return `${interval === 1 ? 'Every day' : `Every ${interval} days`}${at}`;
    case 'WEEKLY':
      if (!days.length) return `${interval === 1 ? 'Every week' : `Every ${interval} weeks`}${at}`;
      return `${interval === 1 ? dayWord() : `Every ${interval} weeks on ${dayWord()}`}${at}`;
    case 'MONTHLY': {
      const dom = r.BYMONTHDAY ? r.BYMONTHDAY.split(',')[0] : null;
      return `${interval === 1 ? 'Monthly' : `Every ${interval} months`}${dom ? ` on day ${dom}` : ''}${at}`;
    }
    default: return raw;
  }
}

// ---------- codex ----------

function codexDbPath(home) { return path.join(home, 'sqlite', 'codex-dev.db'); }

const CODEX_SQL = [
  'SELECT a.id, a.name, a.status, a.kind, a.rrule, a.next_run_at, a.last_run_at, a.model, a.cwds, a.target_type, a.prompt,',
  '       r.status AS run_status, r.created_at AS run_at',
  'FROM automations a',
  'LEFT JOIN automation_runs r ON r.thread_id = (',
  '  SELECT thread_id FROM automation_runs WHERE automation_id = a.id ORDER BY created_at DESC LIMIT 1)',
  'ORDER BY a.name COLLATE NOCASE, a.id;',
].join('\n');

function codexRow(row) {
  let cwds = [];
  try { const v = JSON.parse(row.cwds || '[]'); if (Array.isArray(v)) cwds = v.filter(s => typeof s === 'string'); } catch { /* not an array */ }
  const status = String(row.status || '').toUpperCase();
  const enabled = status === 'ACTIVE';
  const last = row.run_at ? { at: toIso(row.run_at), status: String(row.run_status || 'ran').toLowerCase() }
    : row.last_run_at ? { at: toIso(row.last_run_at), status: 'ran' } : null;
  return {
    id: String(row.id), name: String(row.name || row.id),
    cadence: describeRrule(row.rrule), schedule: String(row.rrule || ''),
    enabled, status: status.toLowerCase() || null,
    next: enabled ? toIso(row.next_run_at) : null,
    last: last && last.at ? last : null,
    model: row.model || null, target: cwds[0] || null, link: null,
    summary: firstLine(row.prompt),
  };
}

/** The Codex automations section. `ok: false` with a `warning` when the database, the binary or the query is missing. */
function readCodex({ home, sqlite3 = 'sqlite3', exec = execFileSync, now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const db = codexDbPath(home);
  if (!fs.existsSync(db)) return { fetchedAt, ok: false, warning: `no Codex automations database (${db})`, routines: [] };
  let out;
  try {
    out = exec(sqlite3, ['-readonly', '-json', db, CODEX_SQL], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const why = e && e.code === 'ENOENT' ? `${sqlite3} is not on PATH` : String((e && e.stderr) || (e && e.message) || e).trim().split('\n').pop();
    return { fetchedAt, ok: false, warning: `could not read Codex automations: ${why}`, routines: [] };
  }
  let rows = [];
  try { rows = String(out || '').trim() ? JSON.parse(String(out)) : []; } catch { return { fetchedAt, ok: false, warning: 'could not read Codex automations: unexpected sqlite3 output', routines: [] }; }
  return { fetchedAt, ok: true, warning: null, routines: (Array.isArray(rows) ? rows : []).map(codexRow) };
}

// ---------- claude (imported snapshot) ----------

function cloudRow(t) {
  const id = String(t.id || '');
  const ctx = (((t.job_config || {}).ccr || {}).session_context) || {};
  const sources = Array.isArray(ctx.sources) ? ctx.sources : [];
  const repo = sources.map(s => s && s.git_repository && s.git_repository.url).find(Boolean) || null;
  const derived = t.derived_state || {};
  let cadence, schedule;
  if (t.cron_expression) {
    schedule = String(t.cron_expression);
    let words; try { words = cron.describe(schedule); } catch { words = schedule; }
    cadence = `${words} (UTC)`;
  } else if (t.run_once_at) {
    schedule = String(t.run_once_at);
    cadence = `once at ${fmtLocal(schedule)}`;
  } else { schedule = ''; cadence = 'no schedule'; }
  const enabled = t.enabled === true;
  const ranOnce = t.ended_reason === 'run_once_fired';
  return {
    id, name: String(t.name || id), cadence, schedule, enabled,
    status: ranOnce ? 'ran once' : enabled ? 'active' : 'paused',
    next: enabled && t.next_run_at ? String(t.next_run_at) : null,
    last: t.last_fired_at ? { at: String(t.last_fired_at), status: ranOnce ? 'ran once' : 'fired' } : null,
    model: derived.model || ctx.model || null, target: repo,
    link: id ? `https://claude.ai/code/routines/${encodeURIComponent(id)}` : null,
    summary: firstLine(derived.prompt),
  };
}

/** The `RemoteTrigger list` payload → the claude section. Throws TypeError when the payload is not that shape. */
function normalizeCloud(payload, now = new Date()) {
  const data = payload && typeof payload === 'object' ? payload.data : undefined;
  if (!Array.isArray(data)) throw new TypeError('expected the RemoteTrigger list payload: an object with a data[] array');
  const routines = data.filter(t => t && typeof t === 'object' && t.id).map(cloudRow);
  routines.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { fetchedAt: now.toISOString(), routines };
}

// ---------- cache ----------

function cacheFile(vault) { return path.join(vault, 'brain', '_index', 'routines-hosts.json'); }
function emptyCache() { return { schema: CACHE_SCHEMA, hosts: {} }; }

function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') {
      const hosts = {};
      for (const h of HOSTS) if (parsed.hosts[h] && Array.isArray(parsed.hosts[h].routines)) hosts[h] = parsed.hosts[h];
      return { schema: CACHE_SCHEMA, hosts };
    }
  } catch { /* missing or corrupt */ }
  return emptyCache();
}

/** Merge per host: `patch.codex = null` drops that section, an object replaces it, an absent key keeps it. */
function writeCache(file, patch) {
  const cur = readCache(file);
  for (const h of HOSTS) {
    if (!(h in patch)) continue;
    if (patch[h]) cur.hosts[h] = patch[h]; else delete cur.hosts[h];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Per-process temp name: the HUD, the CLI and an upgrade can refresh at the same moment, and two writers sharing
  // one `<file>.tmp` lose the race at rename (ENOENT). The last rename wins; both wrote a complete file.
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n'); fs.renameSync(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ } throw e; }
  return cur;
}

/** D6: Codex rows follow hosts.codex.enabled (absent = on); hosts.codex.home locates the database. */
function codexEnabled(cfg) { return !(cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.enabled === false); }
function codexHomeOf(cfg, env = process.env) {
  const fromCfg = cfg && cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.home;
  return path.resolve(fromCfg || env.CODEX_HOME || path.join(require('os').homedir(), '.codex'));
}

/** Re-read the live host (Codex) and rewrite the cache; the Claude section is only touched by importCloud. */
function refresh({ vault, cfg = {}, env = process.env, sqlite3, exec, now = new Date() }) {
  const file = cacheFile(vault);
  const codex = codexEnabled(cfg) ? readCodex({ home: codexHomeOf(cfg, env), sqlite3, exec, now }) : null;
  return writeCache(file, { codex });
}

function importCloud({ vault, payload, now = new Date() }) {
  return writeCache(cacheFile(vault), { claude: normalizeCloud(payload, now) });
}

/** Flat rows for tables: one per routine with its host and the section's fetchedAt. */
function flatten(cache) {
  const out = [];
  for (const h of HOSTS) {
    const section = cache && cache.hosts && cache.hosts[h];
    if (!section) continue;
    for (const r of section.routines) out.push({ host: h, fetchedAt: section.fetchedAt, ...r });
  }
  return out;
}

module.exports = {
  CACHE_SCHEMA, HOSTS, CODEX_SQL,
  describeRrule, parseRrule, codexDbPath, readCodex, normalizeCloud,
  cacheFile, readCache, writeCache, refresh, importCloud, flatten, codexEnabled, codexHomeOf, fmtLocal, toIso,
};
