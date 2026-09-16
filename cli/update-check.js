'use strict';
/**
 * update-check.js — `aos update-check` / `aos update-status` / `aos update-notice`.
 *
 * One producer owns the network and the clock (`update-check`, run detached); every other surface is a
 * pure read of two files in <vault>/brain/_index/:
 *   update-check.json   state (schema 1)
 *   update-line.txt     pre-rendered status line fragment: zero bytes, or one line plus "\n"
 *
 * Design: docs/superpowers/specs/2026-09-15-update-notification-design.md
 * Contract: every path exits 0 with empty stdout — a hook must never fail a Claude Code session.
 * Zero dependencies; the HTTP getter and the clock are injectable (the `getFn` seam mirrors
 * cli/aos.js download()).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const REPO_SLUG = 'zzoretich/AgenticOS-Workbench';
const LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const STORE_REL = path.join('brain', '_index', 'update-check.json');
const LINE_REL = path.join('brain', '_index', 'update-line.txt');
const SCHEMA = 1;
const DEFAULT_INTERVAL_HOURS = 24;
const MAX_BACKOFF_DOUBLINGS = 4;
const MAX_BODY_BYTES = 1e6;

// A release tag this CLI is willing to order. Anything else is ignored rather than announced.
const TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The normalised version inside a tag ("v0.2.0" -> "0.2.0"), or null when it is not orderable semver. */
function parseTag(tag) {
  const m = TAG_RE.exec(String(tag == null ? '' : tag).trim());
  return m ? m[1] : null;
}

function parseSemver(v) {
  const core = parseTag(v);
  if (!core) return null;
  // indexOf, not split('-'): a prerelease may itself contain hyphens ("1.0.0-alpha-1").
  const i = core.indexOf('-');
  return {
    nums: (i === -1 ? core : core.slice(0, i)).split('.').map(Number),
    pre: i === -1 ? '' : core.slice(i + 1),
  };
}

/**
 * Semver §11 prerelease precedence, over the dot-separated identifiers: numeric identifiers
 * compare numerically, a numeric identifier ranks below an alphanumeric one, and a shorter set of
 * identifiers ranks below a longer one when every shared identifier is equal. An absent prerelease
 * (a real release) outranks any prerelease.
 * A plain `a < b` string compare is wrong here: it puts "rc.9" above "rc.10".
 */
function cmpPre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const ai = a.split('.');
  const bi = b.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === undefined) return -1;
    if (bi[i] === undefined) return 1;
    if (ai[i] === bi[i]) continue;
    const an = /^\d+$/.test(ai[i]);
    const bn = /^\d+$/.test(bi[i]);
    if (an && bn) return Number(ai[i]) < Number(bi[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ai[i] < bi[i] ? -1 : 1;
  }
  return 0;
}

/** -1 | 0 | 1, or null when either side is not orderable. A prerelease precedes its release. */
function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  return cmpPre(pa.pre, pb.pre);
}

/** The skew rule (design §8): a user is only as upgraded as their least-upgraded part. */
function lowerVersion(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const c = cmpSemver(a, b);
  if (c === null) return a;
  return c <= 0 ? a : b;
}

function storePath(vault) { return path.join(vault, STORE_REL); }
function linePath(vault) { return path.join(vault, LINE_REL); }

/** tmp + rename: a reader always sees the whole old file or the whole new one, never a partial write. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Missing, unparseable, or a foreign schema all mean "no state" — never an error, never a migration. */
function readState(vault) {
  try {
    const s = JSON.parse(fs.readFileSync(storePath(vault), 'utf8'));
    return s && s.schema === SCHEMA ? s : null;
  } catch { return null; }
}

function writeState(vault, state) { writeAtomic(storePath(vault), `${JSON.stringify(state, null, 2)}\n`); }

function isBehind(state) {
  return !!(state && state.latest && state.installed && cmpSemver(state.installed, state.latest) === -1);
}

/** A snooze covers one specific version, so a newer release breaks it. */
function isSnoozed(state, now = new Date()) {
  const s = state && state.snooze;
  if (!s || !s.version || !s.until) return false;
  if (s.version !== state.latest) return false;
  const until = new Date(s.until).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

function isStale(state, { intervalHours = DEFAULT_INTERVAL_HOURS, now = new Date() } = {}) {
  if (!state || !state.checkedAt) return true;
  const t = new Date(state.checkedAt).getTime();
  if (!Number.isFinite(t)) return true;
  if (t > now.getTime()) return true; // clock skew: re-check rather than wait it out
  // Math.max clamps negative failure counts to 0 so exponential backoff never shrinks the interval.
  const doublings = Math.min(Math.max(state.consecutiveFailures || 0, 0), MAX_BACKOFF_DOUBLINGS);
  return now.getTime() - t >= intervalHours * 3600e3 * Math.pow(2, doublings);
}

function renderStatusline(state, now = new Date()) {
  if (!isBehind(state) || isSnoozed(state, now)) return '';
  return `⬆ AgenticOS ${state.latest}`;
}

function renderNotice(state, now = new Date()) {
  if (!isBehind(state) || isSnoozed(state, now)) return '';
  const { latest, pluginVersion, vaultVersion, installed } = state;
  const skew = pluginVersion && vaultVersion && cmpSemver(pluginVersion, vaultVersion) !== 0;
  const have = skew ? `plugin ${pluginVersion}, vault ${vaultVersion}` : `you have ${installed}`;
  return `AgenticOS Workbench ${latest} available (${have}) — run \`aos upgrade\``;
}

/** Re-rendered by the producer on every check AND by update-notice at every session start, so
 *  snooze expiry is never more than one session stale. */
function writeFragment(vault, state, now = new Date()) {
  const line = renderStatusline(state, now);
  writeAtomic(linePath(vault), line ? `${line}\n` : '');
  return line;
}

function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function agenticosPath(configDir) { return process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json'); }
function readJsonOrNull(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** brain/config.json then agenticos.json, the latter winning key by key (the established precedence). */
function updatesConfig({ configDir = claudeConfigDir(), vault } = {}) {
  const out = { check: true, intervalHours: DEFAULT_INTERVAL_HOURS };
  const apply = (u) => {
    if (!u || typeof u !== 'object') return;
    if (typeof u.check === 'boolean') out.check = u.check;
    if (Number.isFinite(u.intervalHours) && u.intervalHours > 0) out.intervalHours = u.intervalHours;
  };
  if (vault) apply((readJsonOrNull(path.join(vault, 'brain', 'config.json')) || {}).updates);
  apply((readJsonOrNull(agenticosPath(configDir)) || {}).updates);
  return out;
}

/** GET + JSON parse. Rejects with an Error carrying .statusCode on a non-200 so callers can single out 404. */
function httpGetJson(url, { getFn = (u, o, cb) => https.get(u, o, cb), timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const req = getFn(url, {
      headers: { 'user-agent': 'agenticos-update-check', accept: 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error(`HTTP ${res.statusCode} for ${url}`);
        e.statusCode = res.statusCode;
        return fail(e);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY_BYTES) { req.destroy(); fail(new Error('response too large')); }
      });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        try { settled = true; resolve(JSON.parse(body)); } catch (e) { settled = true; reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
  });
}

/**
 * The producer. Writes both files atomically and resolves to the new state, or null when disabled.
 * Never throws: a transport failure preserves the previous known-good `latest`; a 404 is the
 * successful answer "there is no release", which is how this ships dark before the first tag.
 */
async function runCheck({
  vault, vaultVersion = null, pluginVersion = null, configDir = claudeConfigDir(),
  get, now = () => new Date(),
} = {}) {
  if (!vault) return null;
  const cfg = updatesConfig({ configDir, vault });
  if (!cfg.check) return null;

  const prev = readState(vault) || {};
  const at = now();
  const base = {
    schema: SCHEMA,
    checkedAt: at.toISOString(),
    vaultVersion: vaultVersion || prev.vaultVersion || null,
    // Only update-notice runs with CLAUDE_PLUGIN_ROOT set, so the producer must carry this forward
    // rather than clear it — otherwise every daily check would erase the skew signal (design §6.1).
    pluginVersion: pluginVersion || prev.pluginVersion || null,
    snooze: prev.snooze || null,
    lastError: null,
    consecutiveFailures: 0,
  };
  base.installed = lowerVersion(base.pluginVersion, base.vaultVersion);

  let next;
  try {
    const rel = await httpGetJson(LATEST_URL, { getFn: get });
    const v = parseTag(rel && rel.tag_name);
    // Only the parsed version and a URL we construct ourselves. The release body is never stored.
    next = { ...base, latest: v, url: v ? `https://github.com/${REPO_SLUG}/releases/tag/v${v}` : null };
  } catch (e) {
    if (e.statusCode === 404) {
      next = { ...base, latest: null, url: null };
    } else {
      next = {
        ...base,
        latest: prev.latest || null,
        url: prev.url || null,
        lastError: e.message,
        consecutiveFailures: (prev.consecutiveFailures || 0) + 1,
      };
    }
  }
  next.behind = isBehind(next);
  writeState(vault, next);
  writeFragment(vault, next, at);
  return next;
}

module.exports = {
  REPO_SLUG, LATEST_URL, STORE_REL, LINE_REL, SCHEMA,
  DEFAULT_INTERVAL_HOURS, MAX_BACKOFF_DOUBLINGS, MAX_BODY_BYTES, TAG_RE,
  parseTag, cmpSemver, lowerVersion,
  storePath, linePath, writeAtomic, readState, writeState,
  isBehind, isSnoozed, isStale, renderStatusline, renderNotice, writeFragment,
  claudeConfigDir, agenticosPath, updatesConfig, httpGetJson, runCheck,
};
