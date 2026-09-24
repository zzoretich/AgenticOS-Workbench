'use strict';
/**
 * notifications.js — the store behind `aos notify` and the Workbench Notifications tab (spec
 * 2026-09-24-notifications-design). Pure over an injected vault path and clock; notify.js is the CLI.
 *
 *   <vault>/brain/notifications/<year>/<id>.md   one immutable item; id = filename stem (D1, D3)
 *   <vault>/brain/notifications/state.json       { schema: 1, items: { <id>: { read?, archived? } } }
 *   <vault>/brain/notifications/reactions.jsonl  { schema: 1, at, id, ref, value } — appended by the tab
 *
 * Frontmatter values are written as single-line JSON (valid YAML), so the tab parses them with JSON.parse and no
 * YAML library (D7). Actions are allow-listed (D4): `ask` names a skill and one argument, `react` a +1/-1; any
 * other kind or key is refused, so an item can never carry a command.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const LEVELS = ['breaking', 'alert', 'edition', 'info'];
const ALERT_LEVELS = new Set(['breaking', 'alert']);
const SENDER_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9:_-]{0,60}$/;
const ANCHOR_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{4}-[a-z0-9-]+$/;
const ACTION_KEYS = { ask: ['kind', 'label', 'skill', 'arg', 'anchor'], react: ['kind', 'label', 'value', 'ref', 'anchor'] };
const MAX_TITLE = 160;
const MAX_ACTIONS = 40;
const DEFAULTS = { osAlert: true, retentionDays: 30, maxPerSenderPerHour: 6 };
const HOUR_MS = 3600e3;
const DAY_MS = 86400e3;

const dirOf = (vault) => path.join(vault, 'brain', 'notifications');
const statePath = (vault) => path.join(dirOf(vault), 'state.json');
const pad = (n) => String(n).padStart(2, '0');

/** The config block with defaults filled in; bad values fall back to the default. */
function settings(cfg) {
  const n = (cfg && cfg.notifications) || {};
  return {
    osAlert: typeof n.osAlert === 'boolean' ? n.osAlert : DEFAULTS.osAlert,
    retentionDays: Number.isFinite(n.retentionDays) && n.retentionDays > 0 ? n.retentionDays : DEFAULTS.retentionDays,
    maxPerSenderPerHour: Number.isInteger(n.maxPerSenderPerHour) && n.maxPerSenderPerHour >= 0 ? n.maxPerSenderPerHour : DEFAULTS.maxPerSenderPerHour,
  };
}

/** Local ISO 8601 with the UTC offset: 2026-09-24T07:00:12-04:00. */
function localIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function slugify(s, max = 40) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'item';
}

/** The id stem for a post: local minute, sender, title slug. */
function idFor(now, from, title) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}-${from}-${slugify(title)}`;
}

function validateAction(a, i) {
  const where = `action ${i + 1}`;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return [`${where} must be an object`];
  const keys = ACTION_KEYS[a.kind];
  if (!keys) return [`${where}: kind must be ask or react`];
  const errors = [];
  for (const k of Object.keys(a)) if (!keys.includes(k)) errors.push(`${where}: unknown key "${k}"`);
  if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 40) errors.push(`${where}: label must be 1–40 characters`);
  if (a.anchor !== undefined && !ANCHOR_RE.test(String(a.anchor))) errors.push(`${where}: anchor must be a heading slug`);
  if (a.kind === 'ask') {
    if (!SKILL_RE.test(String(a.skill || ''))) errors.push(`${where}: skill must match ${SKILL_RE}`);
    if (a.arg !== undefined && (typeof a.arg !== 'string' || a.arg.length > 200 || /[\r\n]/.test(a.arg))) errors.push(`${where}: arg must be one line of at most 200 characters`);
  } else {
    if (a.value !== 1 && a.value !== -1) errors.push(`${where}: value must be 1 or -1`);
    if (typeof a.ref !== 'string' || !a.ref.trim() || a.ref.length > 120) errors.push(`${where}: ref must be 1–120 characters`);
  }
  return errors;
}

/** Every problem with a post, or [] when it is valid. */
function validate(p) {
  const errors = [];
  if (!SENDER_RE.test(String(p.from || ''))) errors.push('from must be a kebab-case sender slug (1–41 chars)');
  if (!LEVELS.includes(p.level)) errors.push(`level must be one of ${LEVELS.join(', ')}`);
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > MAX_TITLE || /[\r\n]/.test(p.title)) errors.push(`title must be one line of 1–${MAX_TITLE} characters`);
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some((t) => !/^[a-z0-9][a-z0-9/_-]{0,40}$/i.test(String(t))))) errors.push('tags must be simple words');
  if (p.body !== undefined && typeof p.body !== 'string') errors.push('body must be text');
  if (p.actions !== undefined) {
    if (!Array.isArray(p.actions)) errors.push('actions must be a JSON array');
    else if (p.actions.length > MAX_ACTIONS) errors.push(`at most ${MAX_ACTIONS} actions`);
    else p.actions.forEach((a, i) => errors.push(...validateAction(a, i)));
  }
  return errors;
}

/** The file text for an item: JSON-valued frontmatter, then the body. */
function format(meta, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---', '');
  const text = String(body || '').replace(/\s+$/, '');
  return `${lines.join('\n')}\n${text ? `${text}\n` : ''}`;
}

/** { meta, body } from an item's text, or null when it has no frontmatter. A non-JSON value is kept as a string. */
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ''));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    try { meta[kv[1]] = JSON.parse(kv[2]); } catch { meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  }
  return { meta, body: text.slice(m[0].length).replace(/^\r?\n/, '') };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Every item file as { id, file }, newest id first. Year folders only; state and reactions are skipped. */
function itemFiles(vault) {
  const root = dirOf(vault);
  let years = [];
  try { years = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name)).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const y of years) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, y)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const id = n.slice(0, -3);
      if (ID_RE.test(id)) out.push({ id, file: path.join(root, y, n) });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function readState(vault) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(vault), 'utf8'));
    if (s && typeof s === 'object' && s.items && typeof s.items === 'object' && !Array.isArray(s.items)) return { schema: SCHEMA, items: s.items };
  } catch { /* missing or corrupt: nothing read yet */ }
  return { schema: SCHEMA, items: {} };
}

function writeState(vault, state) { writeAtomic(statePath(vault), `${JSON.stringify({ schema: SCHEMA, items: state.items }, null, 2)}\n`); }

/** Items sent by `from` whose created time is within the last hour. Reads only files whose id minute is that recent. */
function recentFrom(vault, from, now) {
  const since = now.getTime() - HOUR_MS;
  const floor = idFor(new Date(since - 60e3), 'a', 'a').slice(0, 15);   // yyyy-mm-ddThhmm a minute early
  let n = 0;
  for (const { id, file } of itemFiles(vault)) {
    if (id.slice(0, 15) < floor) break;
    let it;
    try { it = parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const t = it && Date.parse(it.meta.created);
    if (it && it.meta.from === from && Number.isFinite(t) && t >= since) n++;
  }
  return n;
}

/**
 * Validates and writes one item. Returns { id, file, level, downgraded, alerted }. Throws with `.errors` on invalid
 * input. Over maxPerSenderPerHour the item is written as info and raises no alert (D5). `notify(title, message)` is
 * the OS notifier, injected so tests never raise a banner.
 */
function post(p, { vault, now = new Date(), cfg = {}, notify = null, dryRun = false } = {}) {
  const errors = validate(p);
  if (errors.length) { const e = new Error(`invalid notification: ${errors.join('; ')}`); e.errors = errors; throw e; }
  const s = settings(cfg);
  let level = p.level;
  const downgraded = level !== 'info' && recentFrom(vault, p.from, now) >= s.maxPerSenderPerHour;
  if (downgraded) level = 'info';
  const base = idFor(now, p.from, p.title);
  const yearDir = path.join(dirOf(vault), String(now.getFullYear()));
  let id = base;
  for (let i = 2; fs.existsSync(path.join(yearDir, `${id}.md`)); i++) id = `${base}-${i}`;
  const file = path.join(yearDir, `${id}.md`);
  const meta = { schema: SCHEMA, id, from: p.from, level, title: p.title.trim(), created: localIso(now) };
  if (downgraded) meta.requestedLevel = p.level;
  if (p.tags && p.tags.length) meta.tags = p.tags;
  if (p.actions && p.actions.length) meta.actions = p.actions;
  const text = format(meta, p.body);
  let alerted = false;
  if (!dryRun) {
    writeAtomic(file, text);
    if (ALERT_LEVELS.has(level) && s.osAlert && typeof notify === 'function') {
      const first = String(p.body || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
      alerted = notify(`${level === 'breaking' ? 'BREAKING · ' : ''}${meta.title}`, first || p.from) !== false;
    }
  }
  return { id, file, level, downgraded, alerted, text: dryRun ? text : undefined };
}

/** Newest first by created time; the id breaks ties and orders items whose time does not parse. */
function newestFirst(a, b) {
  const ta = Date.parse(a.created);
  const tb = Date.parse(b.created);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Items with their state, newest first. Filters: unread, archived ('only' | true to include | false), from, level. */
function list(vault, { unread = false, archived = false, from = null, level = null } = {}) {
  const st = readState(vault).items;
  const out = [];
  let unreadable = 0;
  for (const { id, file } of itemFiles(vault)) {
    let it;
    try { it = parse(fs.readFileSync(file, 'utf8')); } catch { unreadable++; continue; }
    if (!it || !LEVELS.includes(it.meta.level) || typeof it.meta.title !== 'string') { unreadable++; continue; }
    const s = st[id] || {};
    const row = {
      id, from: String(it.meta.from || ''), level: it.meta.level, title: it.meta.title, created: String(it.meta.created || ''),
      tags: Array.isArray(it.meta.tags) ? it.meta.tags : [], read: !!s.read, archived: !!s.archived,
      path: path.relative(vault, file).split(path.sep).join('/'),
    };
    if (archived === 'only' ? !row.archived : (archived !== true && row.archived)) continue;
    if (unread && row.read) continue;
    if (from && row.from !== from) continue;
    if (level && row.level !== level) continue;
    out.push(row);
  }
  out.sort(newestFirst);
  return { items: out, unreadable };
}

/** Sets `key` (read | archived) on ids (or on every item with all:true). Returns the number changed. */
function mark(vault, { ids = [], all = false, key = 'read', value = true } = {}) {
  const state = readState(vault);
  const known = new Set(itemFiles(vault).map((f) => f.id));
  const targets = all ? list(vault, { archived: true }).items.map((i) => i.id) : ids;   // all: readable items only
  const missing = targets.filter((id) => !known.has(id));
  if (missing.length) { const e = new Error(`no such notification: ${missing.join(', ')}`); e.errors = [e.message]; throw e; }
  let n = 0;
  for (const id of targets) {
    const cur = state.items[id] || {};
    if (!!cur[key] === value) continue;
    const next = { ...cur };
    if (value) next[key] = true; else delete next[key];
    if (Object.keys(next).length) state.items[id] = next; else delete state.items[id];
    n++;
  }
  if (n) writeState(vault, state);
  return n;
}

/** Archives (never deletes) items older than `days`, and drops state for items that no longer exist. */
function prune(vault, { days, now = new Date() } = {}) {
  const state = readState(vault);
  const files = itemFiles(vault);
  const known = new Set(files.map((f) => f.id));
  const cutoff = now.getTime() - days * DAY_MS;
  let archived = 0;
  let dropped = 0;
  for (const { id, file } of files) {
    if (state.items[id] && state.items[id].archived) continue;
    let it;
    try { it = parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const t = it && Date.parse(it.meta.created);
    if (Number.isFinite(t) && t < cutoff) { state.items[id] = { ...(state.items[id] || {}), archived: true }; archived++; }
  }
  for (const id of Object.keys(state.items)) if (!known.has(id)) { delete state.items[id]; dropped++; }
  if (archived || dropped) writeState(vault, state);
  return { archived, dropped };
}

module.exports = {
  SCHEMA, LEVELS, ALERT_LEVELS, DEFAULTS, SENDER_RE, SKILL_RE, ID_RE,
  dirOf, statePath, settings, localIso, slugify, idFor, validate, validateAction, format, parse,
  itemFiles, readState, post, list, mark, prune, newestFirst,
};
