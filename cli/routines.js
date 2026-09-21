'use strict';
/**
 * routines.js — `aos routines <verb>` over <vault>/brain/routines/*.md (spec D11).
 *   list [--json]        every routine: kind, cadence, enabled, next fire, last run, health
 *   sync                 render + (re)load one OS schedule per enabled routine (cli/schedule.js)
 *   run <slug> [--dry-run]   run one routine now through run-routine.js (trigger "manual")
 *   enable|disable <slug>    flip `enabled:` in the file, then sync
 *   next [<slug>]        the next three fire times
 * Runs from the checkout (node cli/aos.js) and from the vendored <vault>/brain/scripts/cli/ (the aos launcher):
 * the store, cron and interview modules are looked up next to this file first, then in the checkout.
 * Zero dependencies; every external effect is injectable (opts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const schedule = require('./schedule.js');

const VERBS = ['list', 'sync', 'run', 'enable', 'disable', 'next'];
const REPO = path.join(__dirname, '..');

function resolveModule(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${rel} not found beside cli/routines.js — run \`aos upgrade\``);
}
const store = () => resolveModule('lib/routines-store.js');
const cron = () => resolveModule('lib/cron.js');

function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readAgenticos(configDir) { return readJson(process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json')); }

function resolveCtx(opts = {}) {
  const configDir = opts.configDir || claudeConfigDir();
  const cfg = readAgenticos(configDir) || {};
  const vault = opts.vault || process.env.AOS_VAULT || cfg.vault;
  if (!vault) throw new Error('no vault configured (run `aos init` first)');
  return { configDir, vault, cfg, node: opts.node || cfg.node || 'node', platform: opts.platform || process.platform };
}

/** The template variables every schedule carries: persona answers (model, effort, name) when the interview ran. */
function scheduleVarsFor({ vault, configDir, node, cfg }) {
  const answers = readJson(path.join(vault, 'persona', 'answers.json')) || {};
  return schedule.scheduleVars({
    vault, configDir, node,
    model: answers.dutyModel || (cfg && cfg.claude && cfg.claude.model) || 'haiku',
    effort: answers.dutyEffort, agentName: answers.name,
  });
}

function routinesDir(vault) { return path.join(vault, 'brain', 'routines'); }
function stateFile(vault) { return path.join(vault, 'brain', '_index', 'routines.json'); }

/** Reader-side rows (lib/routines-store.js overview): routine + state + computed next/health. */
function rows({ vault, now = new Date() }) {
  return store().overview({ dir: routinesDir(vault), file: stateFile(vault), now });
}

function pad(n) { return String(n).padStart(2, '0'); }
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${DAY[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(iso, now = new Date()) {
  if (!iso) return 'never';
  const ms = now - new Date(iso);
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
function table(headers, lines) {
  const widths = headers.map((h, i) => Math.max(h.length, ...lines.map(l => String(l[i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), ...lines.map(fmt)].join('\n');
}

function list(ctx, { json = false, io, now = new Date() }) {
  const all = rows({ vault: ctx.vault, now });
  if (json) { io.log(JSON.stringify({ schema: 1, routines: all }, null, 2)); return 0; }
  if (!all.length) { io.log(`no routines under ${routinesDir(ctx.vault)} — create <slug>.md there or use the HUD Routines tab`); return 0; }
  const lines = all.map(r => [r.slug, r.kind, r.enabled ? 'on' : 'off', r.cadence, r.next[0] ? fmtLocal(r.next[0]) : '—',
    r.last ? `${ago(r.last.at, now)} (exit ${r.last.exit}${r.last.usd != null ? `, $${Number(r.last.usd).toFixed(2)}` : ''})` : 'never', r.health]);
  io.log(table(['slug', 'kind', 'on', 'cadence', 'next', 'last', 'health'], lines));
  const bad = all.filter(r => r.errors.length);
  for (const r of bad) io.error(`${r.slug}: ${r.errors.join('; ')}`);
  return 0;
}

function sync(ctx, { io, installSchedules = schedule.installSchedules }) {
  const vars = scheduleVarsFor(ctx);
  const r = installSchedules({ vars, platform: ctx.platform, warn: (m) => io.error(`warning: ${m}`) });
  if (r.unsupported) { io.log(`routines: scheduling is not supported on ${r.platform}; run them by hand: aos routines run <slug>`); return 0; }
  io.log(`routines: scheduled ${r.labels.length ? r.labels.join(', ') : 'nothing (no enabled routine)'}${r.removed.length ? `; removed ${r.removed.map(x => path.basename(x)).join(', ')}` : ''}`);
  return r.warnings.length ? 1 : 0;
}

function runnerPath(vault) {
  const vendored = path.join(vault, 'brain', 'scripts', 'routines', 'run-routine.js');
  return fs.existsSync(vendored) ? vendored : path.join(REPO, 'brain', 'scripts', 'routines', 'run-routine.js');
}
function run(ctx, slug, { io, dryRun = false, spawn = spawnSync }) {
  if (!slug) throw new UsageError('usage: aos routines run <slug> [--dry-run]');
  const S = store();
  if (!S.read(slug, { dir: routinesDir(ctx.vault) })) { io.error(`no routine "${slug}" under ${routinesDir(ctx.vault)}`); return 2; }
  const args = [runnerPath(ctx.vault), slug, '--manual', ...(dryRun ? ['--dry-run'] : [])];
  const env = { ...process.env, AOS_VAULT: ctx.vault, AOS_CONFIG: process.env.AOS_CONFIG || path.join(ctx.configDir, 'agenticos.json') };
  const r = spawn(ctx.node === 'node' ? process.execPath : ctx.node, args, { stdio: 'inherit', env, cwd: ctx.vault });
  return typeof r.status === 'number' ? r.status : 1;
}

function setEnabled(ctx, slug, enabled, opts) {
  if (!slug) throw new UsageError(`usage: aos routines ${enabled ? 'enable' : 'disable'} <slug>`);
  const S = store();
  const r = S.read(slug, { dir: routinesDir(ctx.vault) });
  if (!r) { opts.io.error(`no routine "${slug}" under ${routinesDir(ctx.vault)}`); return 2; }
  if (r.errors.length) { opts.io.error(`${slug} is invalid: ${r.errors.join('; ')}`); return 2; }
  S.write({ ...r, enabled }, { dir: routinesDir(ctx.vault) });
  opts.io.log(`${slug}: ${enabled ? 'enabled' : 'disabled'}`);
  return sync(ctx, opts);
}

function next(ctx, slug, { io, now = new Date() }) {
  const all = rows({ vault: ctx.vault, now }).filter(r => !slug || r.slug === slug);
  if (slug && !all.length) { io.error(`no routine "${slug}" under ${routinesDir(ctx.vault)}`); return 2; }
  for (const r of all) {
    if (!r.enabled) { io.log(`${r.slug}: disabled`); continue; }
    if (r.errors.length) { io.log(`${r.slug}: invalid (${r.errors[0]})`); continue; }
    io.log(`${r.slug}: ${r.cadence}\n${r.next.map(t => `  ${fmtLocal(t)}`).join('\n') || '  (no fire time in the next year)'}`);
  }
  return 0;
}

class UsageError extends Error {}

/** `argv` = words after `aos routines`. Returns the exit code. */
async function main(argv, opts = {}) {
  const io = opts.io || console;
  const words = argv.filter(a => !a.startsWith('--'));
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos routines: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  const ctx = resolveCtx(opts);
  const o = { io, installSchedules: opts.installSchedules, spawn: opts.spawn, now: opts.now };
  switch (verb) {
    case 'list': return list(ctx, { ...o, json: flags.has('--json') });
    case 'sync': return sync(ctx, o);
    case 'run': return run(ctx, words[1], { ...o, dryRun: flags.has('--dry-run') });
    case 'enable': return setEnabled(ctx, words[1], true, o);
    case 'disable': return setEnabled(ctx, words[1], false, o);
    case 'next': return next(ctx, words[1], o);
    default: return 2;
  }
}

module.exports = { VERBS, UsageError, main, rows, scheduleVarsFor, resolveCtx, table, fmtLocal, ago };
