#!/usr/bin/env node
'use strict';
/**
 * duty-guard.js — what a duty may write, and a check that it wrote nothing else it could reach
 * (docs/superpowers/specs/2026-09-23-duty-write-scope-design.md). run-duty.sh calls it around every duty, on both hosts.
 *
 *   node duty-guard.js scope --host claude [--tools <list>] [--writes <list>]
 *        two lines: the --allowedTools value (D1: bare Write/Edit and every Edit(…)/Write(…) rule dropped, one absolute
 *        Edit(//…) rule per write-scope entry added; D2: git log/diff/show and unrestricted Bash dropped) and the
 *        --disallowedTools value (the guarded and executable areas, git's --output). Relative Edit rules are not used:
 *        they did not match through a symlinked vault path in a live probe, so each rule names both the vault path as
 *        configured and its realpath.
 *   node duty-guard.js scope --host codex [--writes <list>] [--dry-run]
 *        one directory per line for `codex exec --add-dir` (D4): every write-scope directory outside persona/ (the run's
 *        -C root), created when missing (not on --dry-run). A file entry grants its folder: Codex roots are directories.
 *   node duty-guard.js snapshot <slug>
 *        copies the guarded persona files (D6) to <config home>/agenticos-duty-guard/<slug>/ (D7: outside every duty's
 *        reach — Codex's sandbox can write $TMPDIR, neither host's duty can write the config home). Exit 0, or 1.
 *   node duty-guard.js check <slug> [--keep <dir>]
 *        after the duty: every added, changed or removed guarded file is restored and the duty's version kept under
 *        <dir>/guard-<slug>-<stamp>/ (default <vault>/persona/journal/logs); ledger.jsonl keeps the lines it had plus
 *        appended `filed` events only. A restore adds a flag under `## Flags` in STATE.md and one OS notification.
 *        Prints one JSON line; exit 0 clean, 4 restored, 5 no snapshot.
 *
 * The write scope (D5) is DEFAULT_WRITES plus a routine's `writes:` entries (PERSONA_WRITES). An entry that is the vault,
 * holds or sits in a guarded or executable area, or has a dot-segment is refused on stderr and left out.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const EXIT_RESTORED = 4;
const EXIT_NO_SNAPSHOT = 5;
/** Vault-relative; a trailing / marks a folder. The built-in duties' writes, so an un-reseeded vault keeps working. */
const DEFAULT_WRITES = ['persona/journal/', 'persona/STATE.md', 'persona/proposals/', 'persona/PLAYBOOK.md', 'brain/reflections/', 'brain/_index/sitrep.md'];
/** D6: what decides what runs and what is trusted. The ledger is guarded separately (append-only, `filed` only). */
const GUARDED = ['persona/IDENTITY.md', 'persona/duties/', 'persona/routines/', 'persona/autoapply.json', 'persona/flag-closer/', 'persona/repos.json'];
const LEDGER = 'persona/ledger.jsonl';
/** Never writable by a duty, on top of GUARDED: code, schedules, other projects, tool and host config. */
const EXECUTABLE = ['brain/scripts/', 'brain/routines/', 'workspaces/'];
/** The vault's own dot-folders (git, Obsidian, each host's project settings) — never the user's config dir. */
const DENY_DOT_DIRS = ['.git/', '.obsidian/', '.claude/', '.codex/', '.agents/'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const GIT_WRITE_OUT = 'Bash(git *--output*)';
const DROP_BASH = /^Bash\((git (log|diff|show)\b.*|\*|:\*)\)$/;

// ── scope ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Splits an allowedTools list on commas outside parentheses; a rule keeps its inner spaces (Bash(node <path>:*)). */
function splitTools(list) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(list || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function toolName(rule) { const i = rule.indexOf('('); return i === -1 ? rule : rule.slice(0, i); }

function norm(entry) {
  const dir = entry.endsWith('/');
  const rel = path.posix.normalize(entry.replace(/\\/g, '/').replace(/\/+$/, ''));
  return { rel, dir };
}

/** Why a write-scope entry is refused, or null. `rel` is posix, normalized, without a trailing slash. */
function refusal(rel) {
  if (!rel || rel === '.' || rel === '/') return 'the vault itself';
  if (path.posix.isAbsolute(rel)) return 'an absolute path';
  const segs = rel.split('/');
  if (segs.includes('..')) return 'a path leaving the vault';
  if (segs.some((s) => s.startsWith('.'))) return 'a dot-folder or dot-file';
  for (const g of [...GUARDED, LEDGER, ...EXECUTABLE]) {
    const gr = g.replace(/\/$/, '');
    if (rel === gr || rel.startsWith(`${gr}/`)) return `guarded (${g})`;
    if (gr.startsWith(`${rel}/`)) return `it holds a guarded path (${g})`;
  }
  return null;
}

/** The daily-note folder for `now`, vault-relative, or null when the layout puts notes at the vault root. */
function dailyNoteDir(vault, now = new Date()) {
  const { dailyNoteLayoutFor, formatLayout } = require('../lib/paths.js');
  const rel = path.posix.dirname(formatLayout(dailyNoteLayoutFor(vault), now).replace(/\\/g, '/'));
  return rel === '.' ? null : `${rel}/`;
}

/** D5: DEFAULT_WRITES + today's daily-note folder + `writes`, each checked; returns { entries: [{rel, dir}], refused }. */
function writeScope({ vault, writes = '', now = new Date() } = {}) {
  const raw = [...DEFAULT_WRITES];
  const daily = dailyNoteDir(vault, now);
  if (daily) raw.push(daily);
  for (const w of String(writes || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const isDir = w.endsWith('/') || (() => { try { return fs.statSync(path.join(vault, w)).isDirectory(); } catch { return false; } })();
    raw.push(isDir && !w.endsWith('/') ? `${w}/` : w);
  }
  const entries = [], refused = [], seen = new Set();
  for (const r of raw) {
    const e = norm(r);
    const why = refusal(e.rel);
    if (why) { refused.push({ entry: r, why }); continue; }
    const key = `${e.rel}${e.dir ? '/' : ''}`;
    if (!seen.has(key)) { seen.add(key); entries.push(e); }
  }
  return { entries, refused };
}

/** The vault as configured and its realpath (deduplicated): Claude matches a rule against the path the model wrote. */
function vaultForms(vault) {
  const abs = path.resolve(vault);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* not there: the configured form is all there is */ }
  return real === abs ? [abs] : [abs, real];
}

function editRule(abs, rel, dir) { return `Edit(/${abs}/${rel}${dir ? '/**' : ''})`; }

/** D1 + D2: { allowed, denied } for a Claude duty. */
function claudeTools({ vault, tools = '', writes = '', now = new Date() } = {}) {
  const { entries, refused } = writeScope({ vault, writes, now });
  const kept = splitTools(tools).filter((r) => !WRITE_TOOLS.has(toolName(r)) && r !== 'Bash' && !DROP_BASH.test(r));
  const forms = vaultForms(vault);
  const allowed = [...kept];
  for (const abs of forms) for (const e of entries) allowed.push(editRule(abs, e.rel, e.dir));
  const denied = [GIT_WRITE_OUT];
  for (const abs of forms) {
    for (const g of [...GUARDED, LEDGER, ...EXECUTABLE, ...DENY_DOT_DIRS]) {
      const e = norm(g);
      denied.push(editRule(abs, e.rel, e.dir));
    }
  }
  return { allowed: allowed.join(','), denied: denied.join(','), refused };
}

/** D4: absolute folders for `codex exec --add-dir`, outside persona/ (the -C root); created when missing. */
function codexDirs({ vault, writes = '', now = new Date(), mkdir = true } = {}) {
  const { entries, refused } = writeScope({ vault, writes, now });
  const dirs = [];
  for (const e of entries) {
    const rel = e.dir ? e.rel : path.posix.dirname(e.rel);
    if (rel === 'persona' || rel.startsWith('persona/')) continue;
    const why = refusal(rel);
    if (why) { refused.push({ entry: `${rel}/ (folder of ${e.rel})`, why }); continue; }
    const abs = path.join(path.resolve(vault), ...rel.split('/'));
    if (dirs.includes(abs)) continue;
    if (mkdir) fs.mkdirSync(abs, { recursive: true });
    dirs.push(abs);
  }
  return { dirs, refused };
}

// ── snapshot / check ────────────────────────────────────────────────────────────────────────────────────────────────

/** The folder holding agenticos.json (AOS_CONFIG, else the config dir lib/host.js names) — the same on both hosts. */
function configHome(env = process.env) {
  const cfg = env.AOS_CONFIG || path.join(require('../lib/host.js').claudeConfigDir(env), 'agenticos.json');
  return path.dirname(path.resolve(cfg));
}
function guardDir(slug, home = configHome()) { return path.join(home, 'agenticos-duty-guard', slug); }

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Every guarded file under `vault` → { rel: 'sha256:<hex>' | 'link:<target>' }. lstat: a symlink is recorded, not followed. */
function listGuarded(vault) {
  const out = {};
  const visit = (rel) => {
    const abs = path.join(vault, ...rel.split('/'));
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
    else if (st.isDirectory()) for (const n of fs.readdirSync(abs).sort()) visit(`${rel}/${n}`);
    else if (st.isFile()) out[rel] = `sha256:${sha(fs.readFileSync(abs))}`;
  };
  for (const g of GUARDED) visit(g.replace(/\/$/, ''));
  return out;
}

function copyEntry(fromRoot, toRoot, rel) {
  const src = path.join(fromRoot, ...rel.split('/'));
  const dst = path.join(toRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
  else fs.copyFileSync(src, dst);
}

function snapshot({ vault, slug, dir = guardDir(slug), now = new Date() } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const files = listGuarded(vault);
  for (const rel of Object.keys(files)) copyEntry(vault, path.join(dir, 'files'), rel);
  const ledgerAbs = path.join(vault, ...LEDGER.split('/'));
  const ledger = fs.existsSync(ledgerAbs);
  if (ledger) fs.copyFileSync(ledgerAbs, path.join(dir, 'ledger.jsonl'));
  const manifest = { schema: SCHEMA, slug, at: now.toISOString(), vault: path.resolve(vault), files, ledger };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { schema: SCHEMA, slug, files: Object.keys(files).length, ledger };
}

function moveAside(vault, keepDir, rel) {
  const src = path.join(vault, ...rel.split('/'));
  const dst = path.join(keepDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); } catch { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
}

/** The ledger rule: the old bytes stay a prefix and only valid `filed` lines were appended; anything else is undone. */
function reconcileLedger(vault, snapDir, keepDir) {
  const abs = path.join(vault, ...LEDGER.split('/'));
  const orig = fs.existsSync(path.join(snapDir, 'ledger.jsonl')) ? fs.readFileSync(path.join(snapDir, 'ledger.jsonl')) : Buffer.alloc(0);
  let cur;
  try { cur = fs.readFileSync(abs); } catch { cur = null; }
  if (cur === null) {
    if (!orig.length) return null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, orig);
    return 'removed';
  }
  if (cur.length >= orig.length && cur.subarray(0, orig.length).equals(orig)) {
    const tail = cur.subarray(orig.length).toString('utf8');
    const lines = tail.split('\n').filter((l) => l.trim());
    const kept = lines.filter((l) => { try { const r = JSON.parse(l); return r && r.event === 'filed'; } catch { return false; } });
    if (kept.length === lines.length) return null;
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'ledger.appended.jsonl'), tail);
    fs.writeFileSync(abs, Buffer.concat([orig, Buffer.from(kept.map((l) => `${l}\n`).join(''))]));
    return 'appended';
  }
  fs.mkdirSync(keepDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, 'ledger.jsonl'), cur);
  fs.writeFileSync(abs, orig);
  return 'rewritten';
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function stamp(d) { return `${localDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

/** Inserts `line` right under `## Flags` (run-duty.sh's FAILED slot); no heading → unchanged. */
function flagState(stateFile, line) {
  let text;
  try { text = fs.readFileSync(stateFile, 'utf8'); } catch { return false; }
  const lines = text.split('\n');
  const h = lines.findIndex((l) => /^## Flags\s*$/.test(l));
  if (h === -1) return false;
  lines.splice(h + 1, 0, line);
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, stateFile);
  return true;
}

function check({ vault, slug, dir = guardDir(slug), keepRoot = path.join(vault, 'persona', 'journal', 'logs'), now = new Date(), notify } = {}) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return { schema: SCHEMA, slug, error: 'no snapshot' }; }
  const before = manifest.files || {};
  const after = listGuarded(vault);
  const keepDir = path.join(keepRoot, `guard-${slug}-${stamp(now)}`);
  const restored = [];
  // Added or changed: the duty's version moves aside (a file standing where a folder was is caught here too).
  for (const rel of Object.keys(after).sort()) {
    if (before[rel] === after[rel]) continue;
    moveAside(vault, keepDir, rel);
    restored.push({ path: rel, change: rel in before ? 'changed' : 'added' });
  }
  // Changed or removed: the snapshot's version comes back.
  for (const rel of Object.keys(before).sort()) {
    if (after[rel] === before[rel]) continue;
    const dst = path.join(vault, ...rel.split('/'));
    // A parent that became a file (or a symlink) blocks the restore: move it aside first.
    let p = path.dirname(rel);
    while (p && p !== '.') {
      const abs = path.join(vault, ...p.split('/'));
      try { const st = fs.lstatSync(abs); if (!st.isDirectory()) { moveAside(vault, keepDir, p); break; } } catch { /* missing: mkdir below */ }
      p = path.posix.dirname(p);
    }
    fs.rmSync(dst, { recursive: true, force: true });
    copyEntry(path.join(dir, 'files'), vault, rel);
    if (!(rel in after)) restored.push({ path: rel, change: 'removed' });
  }
  const ledger = reconcileLedger(vault, dir, keepDir);
  if (ledger) restored.push({ path: LEDGER, change: ledger });
  fs.rmSync(dir, { recursive: true, force: true });
  if (!restored.length) return { schema: SCHEMA, slug, restored: [] };
  const names = restored.map((r) => r.path).join(', ');
  flagState(path.join(vault, 'persona', 'STATE.md'), `- [ ] ${localDay(now)} duty '${slug}' wrote guarded file(s) ${names} — restored, its version kept in ${path.relative(vault, keepDir)} (guard)`);
  (notify || ((t, m) => require('./watchdog.js').osNotify(t, m)))('AgenticOS', `duty '${slug}' wrote guarded file(s) — restored`);
  return { schema: SCHEMA, slug, restored, kept: keepDir };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BOOL_FLAGS = new Set(['dry-run']);
function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && BOOL_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] === undefined ? '' : argv[i + 1]; i++; }
    else positional.push(a);
  }
  return { flags, positional };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const USAGE = 'usage: duty-guard.js scope --host claude|codex [--tools <list>] [--writes <list>] [--dry-run] | snapshot <slug> | check <slug> [--keep <dir>]\n';

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), env = process.env, now = new Date() } = {}) {
  const { flags, positional } = parseArgs(argv);
  const [verb, slug] = positional;
  let vault;
  try { vault = flags.vault || env.AOS_VAULT || require('../lib/paths.js').VAULT; } catch (e) { stderr(`duty-guard: ${e.message}\n`); return 1; }
  try {
    if (verb === 'scope') {
      if (flags.host === 'claude') {
        const r = claudeTools({ vault, tools: flags.tools, writes: flags.writes, now });
        for (const x of r.refused) stderr(`duty-guard: writes entry '${x.entry}' refused: ${x.why}\n`);
        stdout(`${r.allowed}\n${r.denied}\n`);
        return 0;
      }
      if (flags.host === 'codex') {
        const r = codexDirs({ vault, writes: flags.writes, now, mkdir: !flags['dry-run'] });
        for (const x of r.refused) stderr(`duty-guard: writes entry '${x.entry}' refused: ${x.why}\n`);
        stdout(r.dirs.map((d) => `${d}\n`).join(''));
        return 0;
      }
      stderr(USAGE); return 2;
    }
    if ((verb === 'snapshot' || verb === 'check') && !SLUG_RE.test(String(slug || ''))) { stderr(USAGE); return 2; }
    const dir = guardDir(slug, configHome(env));
    if (verb === 'snapshot') { stdout(JSON.stringify(snapshot({ vault, slug, dir, now })) + '\n'); return 0; }
    if (verb === 'check') {
      const r = check({ vault, slug, dir, keepRoot: flags.keep || undefined, now });
      stdout(JSON.stringify(r) + '\n');
      if (r.error) return EXIT_NO_SNAPSHOT;
      return r.restored.length ? EXIT_RESTORED : 0;
    }
  } catch (e) { stderr(`duty-guard ${verb}: ${e.message}\n`); return 1; }
  stderr(USAGE);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
  SCHEMA, EXIT_RESTORED, EXIT_NO_SNAPSHOT, DEFAULT_WRITES, GUARDED, LEDGER, EXECUTABLE, GIT_WRITE_OUT,
  splitTools, refusal, dailyNoteDir, writeScope, vaultForms, claudeTools, codexDirs, configHome, guardDir, listGuarded, snapshot, check, flagState, main,
};
