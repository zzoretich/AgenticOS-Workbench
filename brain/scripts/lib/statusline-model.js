'use strict';
/**
 * statusline-model.js — what the AgenticOS status line shows (spec 2026-09-28-statusline-design): the gates, alerts
 * and flags that need the user, live team runs, the spend family nearest its cap, and health. Built from a vault and
 * written to <vault>/brain/_index/statusline.json (schema 1); the Claude Code status line, the Codex session-start line
 * and the Obsidian status bar only read that file (D3).
 *
 * Strictly read-only over the vault (D4): no team sweep, no process signal beyond kill(pid, 0), no write but the model
 * file itself. Every source is read on its own, so one unreadable file drops one field, never the model.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./teams.js');
const N = require('./notifications.js');
const S = require('./settings-schema.js');
const fsx = require('./fsx.js');

const SCHEMA = 1;
const STALE_MS = 15e3;
const SPEND_SHOW_RATIO = 0.5;       // D6: a family appears once it has spent half its daily cap
const MAX_UNREAD_READS = 200;       // the Workbench badge's bound on unread files read for their level
const LEDGER_TAIL_BYTES = 512 * 1024;
const FAMILY_OF = [                // cli/aos.js's feature families; every other row is a background hook call
  [/^duty:/, 'duties'], [/^reason:/, 'reasoner'], [/^routine:/, 'routines'], [/^graph:/, 'graph'],
  [/^cross-review:/, 'crossReview'], [/^team:/, 'teams'],
];

const modelPath = (vault) => path.join(vault, 'brain', '_index', 'statusline.json');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round2 = (n) => Math.round(n * 100) / 100;

/** True when a pid answers signal 0 (EPERM still means alive). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readTeams(vault) {
  const root = T.teamsRoot(vault);
  const out = [];
  for (const id of T.listTeams(root)) { try { out.push(T.readTeam(root, id)); } catch { /* a TEAM.md mid-edit */ } }
  return out;
}

/** Pending gates across every team, longest waiting first. */
function gatesOf(teams) {
  const out = [];
  for (const t of teams) {
    let items = [];
    try { items = T.pendingGates(t); } catch { continue; }
    for (const it of items) out.push({ team: t.id, item: it.id, stage: it.stage || (it.gate && it.gate.name) || null, title: it.title || null, since: it.ts || null });
  }
  return out.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
}

/** Runs dispatched from this host whose dispatcher is still alive (D4: others are hidden, never reaped). */
function runsOf(teams, { host = os.hostname(), alive = pidAlive } = {}) {
  const out = [];
  for (const t of teams) {
    for (const m of T.liveMarkers(t)) {
      if (!m || (m.host && m.host !== host) || !alive(m.pid)) continue;
      out.push({ team: m.team || t.id, member: m.member || null, stage: m.stage || null, item: m.item || null, provider: m.provider || null, since: m.startedAt || null });
    }
  }
  return out.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
}

/** Unread breaking and alert notifications (the Workbench badge's reading: state.json, then unread files' levels). */
function alertsOf(vault) {
  const state = N.readState(vault).items;
  const unread = N.itemFiles(vault).filter((f) => { const s = state[f.id]; return !(s && (s.read || s.archived)); });
  let alerts = 0;
  let breaking = 0;
  for (const f of unread.slice(0, MAX_UNREAD_READS)) {
    const it = N.parse(readText(f.file));
    const level = it && it.meta.level;
    if (level === 'breaking') breaking++;
    else if (level === 'alert') alerts++;
  }
  return { alerts, breaking };
}

/** Open flags in persona/STATE.md: `- [ ]` and bare `- ` bullets under `## Flags`, never `- [x]` or "none" (D5). */
function countFlags(text) {
  if (!text) return 0;
  let inFlags = false;
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inFlags = /^##\s+Flags\b/.test(line); continue; }
    if (!inFlags || !/^[-*]\s+\S/.test(line)) continue;
    if (/^[-*]\s+\[[xX]\]/.test(line) || /^[-*]\s+\(?none\)?\.?\s*$/i.test(line)) continue;
    n++;
  }
  return n;
}

function familyOf(feature) {
  for (const [re, fam] of FAMILY_OF) if (re.test(feature)) return fam;
  return 'hooks';
}

/** Today's USD per family from the ledger's tail (local calendar day, rows with a numeric usd). */
function spendToday(text, now) {
  const day = localDay(now);
  const out = {};
  for (const line of String(text || '').split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.usd !== 'number' || !Number.isFinite(r.usd)) continue;
    const ts = new Date(r.ts);
    if (Number.isNaN(ts.getTime()) || localDay(ts) !== day) continue;
    const fam = familyOf(String(r.feature || ''));
    out[fam] = (out[fam] || 0) + r.usd;
  }
  return out;
}

/** The daily cap of each family from the settings schema; the hook cap follows the resolved provider (cli status). */
function capsOf(cfg, providerName) {
  const caps = {};
  for (const e of S.SETTINGS) {
    if (!e.spend) continue;
    if (e.spend === 'hooks' && e.host && e.host !== (providerName === 'codex' ? 'codex' : 'claude')) continue;
    caps[e.spend] = S.dayCap(S.getPath(cfg || {}, e.key), S.defaultOf(e));
  }
  return caps;
}

/** The family with the highest spent/cap ratio once it reaches SPEND_SHOW_RATIO, or null (D6). */
function spendOf(totals, caps) {
  let best = null;
  for (const fam of S.SPEND_FAMILIES) {
    const cap = caps[fam];
    if (!(cap > 0)) continue;
    const usd = totals[fam] || 0;
    const ratio = usd / cap;
    if (ratio >= SPEND_SHOW_RATIO && (!best || ratio > best.ratio)) best = { family: fam, usd: round2(usd), cap, ratio: Math.round(ratio * 100) / 100 };
  }
  return best;
}

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

function healthOf(vault, providerState) {
  const idx = path.join(vault, 'brain', '_index');
  const line = readText(path.join(idx, 'update-line.txt')) || '';
  const m = /AgenticOS\s+(\d+\.\d+\.\d+\S*)/.exec(line);
  const session = readText(path.join(idx, 'SESSION.md')) || '';
  let drafts = 0;
  try { drafts = fs.readdirSync(path.join(vault, 'brain', 'memory', 'feedback', '_drafts')).filter((n) => n.endsWith('.md')).length; } catch { /* none */ }
  return {
    update: m ? m[1] : null,
    provider: providerState && providerState.name === 'none' ? String(providerState.reason || 'none') : null,
    unwrapped: /^##\s+Wrap Status\b[\s\S]*?not wrapped/m.test(session),
    drafts,
  };
}

/** The whole model. Pure over (vault, cfg, now, host, alive); each source fails on its own. */
function build(vault, { cfg = {}, now = new Date(), host = os.hostname(), alive = pidAlive } = {}) {
  const idx = path.join(vault, 'brain', '_index');
  const providerState = readJson(path.join(idx, 'provider-state.json'));
  const part = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  const teams = part(() => readTeams(vault), []);
  const alerts = part(() => alertsOf(vault), { alerts: 0, breaking: 0 });
  return {
    schema: SCHEMA,
    at: now.toISOString(),
    vault: path.basename(path.resolve(vault)),
    needs: {
      gates: part(() => gatesOf(teams), []),
      alerts: alerts.alerts,
      breaking: alerts.breaking,
      flags: part(() => countFlags(readText(path.join(vault, 'persona', 'STATE.md'))), 0),
    },
    runs: part(() => runsOf(teams, { host, alive }), []),
    spend: part(() => spendOf(spendToday(readTail(path.join(idx, 'provider-spend.jsonl'), LEDGER_TAIL_BYTES), now), capsOf(cfg, providerState && providerState.name)), null),
    health: part(() => healthOf(vault, providerState), { update: null, provider: null, unwrapped: false, drafts: 0 }),
  };
}

/** The stored model, or null when missing, unparseable or another schema. */
function read(vault) {
  const m = readJson(modelPath(vault));
  return m && m.schema === SCHEMA && typeof m.at === 'string' ? m : null;
}

function write(vault, model) { fsx.writeAtomic(modelPath(vault), `${JSON.stringify(model, null, 2)}\n`); }

/** Older than staleMs, from the future (clock skew), or absent. */
function isStale(model, now = new Date(), staleMs = STALE_MS) {
  const t = model ? Date.parse(model.at) : NaN;
  return !Number.isFinite(t) || now.getTime() - t > staleMs || t - now.getTime() > 60e3;
}

/** Build and write under the model file's lock; null when another refresh holds it (no dogpile). */
function refresh(vault, opts = {}) {
  try {
    return fsx.withLockSync(modelPath(vault), () => { const m = build(vault, opts); write(vault, m); return m; }, { timeoutMs: 0 });
  } catch (e) {
    if (e instanceof fsx.LockBusy) return null;
    throw e;
  }
}

module.exports = {
  SCHEMA, STALE_MS, SPEND_SHOW_RATIO, modelPath, pidAlive, countFlags, familyOf, spendToday, capsOf, spendOf,
  gatesOf, runsOf, alertsOf, healthOf, build, read, write, isStale, refresh,
};
