'use strict';
/**
 * skills.js — `aos skills <verb>` (spec 2026-09-23-universal-skills).
 *   list [--all] [--json]      your skills on both hosts from brain/_index/skills.json (--all adds plugin skills and
 *                              built-ins); before the first sync, a dry-run plan
 *   sync [--dry-run] [--json]  mirror each host's user skills into the other host's user folder and rewrite the cache
 *   exclude <name>             stop sharing a skill (skills.exclude in <vault>/brain/config.json), then sync
 *   include <name>             share it again, then sync
 *   reset <name>               delete an edited mirror (the edit is lost) so the sync writes it fresh
 * Runs from the checkout (node cli/aos.js) and from the vendored <vault>/brain/scripts/cli/ (the aos launcher):
 * lib/skills.js is looked up next to this file first, then in the checkout. Every external effect is injectable (opts).
 */
const fs = require('fs');
const path = require('path');

const VERBS = ['list', 'sync', 'exclude', 'include', 'reset'];
const REPO = path.join(__dirname, '..');

function resolveModule(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${rel} not found beside cli/skills.js — run \`aos upgrade\``);
}
const lib = () => resolveModule('lib/skills.js');
const translate = () => resolveModule('lib/skill-translate.js');

class UsageError extends Error {}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function resolveCtx(opts = {}) {
  const configDir = opts.configDir || resolveModule('lib/host.js').claudeConfigDir();
  const userCfg = readJson(process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json')) || {};
  const vault = opts.vault || process.env.AOS_VAULT || userCfg.vault;
  if (!vault) throw new Error('no vault configured (run `aos init` first)');
  return { configDir, vault, userCfg, roots: opts.roots, now: opts.now || new Date() };
}

function ago(iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  if (ms < 90_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function table(headers, lines) {
  const widths = headers.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), ...lines.map(fmt)].join('\n');
}

const USER_SCOPES = new Set(['user', 'synced', 'mirror']);
function isYours(row) { return USER_SCOPES.has(row.origin && row.origin.scope); }

function source(row) {
  const o = row.origin || {};
  if (o.scope === 'synced') return 'claude.ai';
  if (o.scope === 'plugin') return `plugin ${o.plugin}`;
  if (o.scope === 'builtin') return `${o.host} built-in`;
  if (o.scope === 'mirror') return `${o.host} (orphan)`;
  return `${o.host}`;
}

/** "94 yours (80 universal, 3 differs) · 150 from plugins and built-ins · sharing on, synced 2m ago". */
function summary(cache, now) {
  const yours = cache.skills.filter(isYours);
  const counts = {};
  for (const r of yours) counts[r.status] = (counts[r.status] || 0) + 1;
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
  const listed = cache.skills.length - yours.length;
  const sharing = !cache.sync.on ? cache.sync.reason : cache.sync.at ? `sharing on, synced ${ago(cache.sync.at, now)}` : 'sharing on, not synced yet';
  return `${yours.length} yours${parts.length ? ` (${parts.join(', ')})` : ''} · ${listed} from plugins and built-ins · ${sharing}`;
}

function print(cache, { io, all, now }) {
  const rows = cache.skills.filter((r) => all || isYours(r));
  io.log(summary(cache, now));
  if (!rows.length) { io.log('no skills yet — a skill is a folder with a SKILL.md in either host\'s skills folder'); return; }
  io.log('');
  io.log(table(['NAME', 'CLAUDE CODE', 'CODEX', 'SOURCE', 'STATUS'], rows.map((r) => [
    r.name, r.on.claude ? r.on.claude.invoke : '—', r.on.codex ? r.on.codex.invoke : '—', source(r), r.status,
  ])));
  const notes = rows.filter((r) => ['differs', 'edited', 'invalid', 'error'].includes(r.status) && r.note);
  if (notes.length) { io.log(''); for (const r of notes) io.log(`${r.name}: ${r.note}`); }
}

function list(ctx, { io, json, all }) {
  const S = lib();
  let cache = S.readCache(S.cacheFile(ctx.vault));
  const fresh = !cache;
  if (fresh) cache = S.sync({ vault: ctx.vault, userCfg: ctx.userCfg, roots: ctx.roots, now: ctx.now, dryRun: true }).cache;
  if (json) { io.log(JSON.stringify(cache, null, 2)); return 0; }
  print(cache, { io, all, now: ctx.now });
  if (fresh) io.log('\nnot synced yet — `aos skills sync` shares them');
  return 0;
}

function sync(ctx, { io, json, dryRun }) {
  const { cache, actions, result } = lib().sync({ vault: ctx.vault, userCfg: ctx.userCfg, roots: ctx.roots, now: ctx.now, dryRun });
  if (json) { io.log(JSON.stringify(dryRun ? { actions: actions.map(({ content, ...a }) => a), skills: cache.skills } : cache, null, 2)); return result.errors.length ? 1 : 0; }
  if (dryRun) {
    if (!actions.length) io.log('nothing to do');
    for (const a of actions) io.log(a.type === 'mirror' ? `mirror ${a.id} (${a.from} → ${a.from === 'claude' ? 'codex' : 'claude'}) at ${a.dir}` : `remove ${a.dir}`);
    return 0;
  }
  io.log(`synced: ${result.written.length} written, ${result.removed.length} removed${result.errors.length ? `, ${result.errors.length} failed` : ''}`);
  for (const e of result.errors) io.error(`${e.id}: ${e.message}`);
  print(cache, { io, all: false, now: ctx.now });
  return result.errors.length ? 1 : 0;
}

/** skills.exclude in <vault>/brain/config.json; refuses a config it cannot parse rather than replace it. */
function setExcluded(ctx, name, excluded, o) {
  if (!name) throw new UsageError(`aos skills ${excluded ? 'exclude' : 'include'} <name>`);
  const id = translate().codexName(name);
  if (!id) throw new UsageError(`"${name}" is not a skill name`);
  const file = path.join(ctx.vault, 'brain', 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix it first`); }
  }
  const skills = cfg.skills && typeof cfg.skills === 'object' ? cfg.skills : {};
  const set = new Set((Array.isArray(skills.exclude) ? skills.exclude : []).map((n) => String(n).toLowerCase()));
  const had = set.has(id);
  if (excluded) set.add(id); else set.delete(id);
  cfg.skills = { ...skills, exclude: [...set].sort() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, file);
  o.io.log(excluded ? (had ? `${id} was already excluded` : `${id} is no longer shared`) : (had ? `${id} is shared again` : `${id} was not excluded`));
  return sync(ctx, { io: o.io });
}

function reset(ctx, name, o) {
  if (!name) throw new UsageError('aos skills reset <name>');
  const id = translate().codexName(name);
  const removed = lib().reset({ userCfg: ctx.userCfg, roots: ctx.roots, id });
  if (!removed.length) { o.io.log(`no mirror named ${id}`); return 1; }
  for (const d of removed) o.io.log(`removed ${d}`);
  return sync(ctx, { io: o.io });
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const words = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos skills: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  if (flags.has('--dry-run') && verb !== 'sync') throw new UsageError('--dry-run is only supported by `aos skills sync`');
  const ctx = resolveCtx(opts);
  const o = { io, json: flags.has('--json'), all: flags.has('--all'), dryRun: flags.has('--dry-run') };
  switch (verb) {
    case 'list': return list(ctx, o);
    case 'sync': return sync(ctx, o);
    case 'exclude': return setExcluded(ctx, words[1], true, o);
    case 'include': return setExcluded(ctx, words[1], false, o);
    case 'reset': return reset(ctx, words[1], o);
    default: return 2;
  }
}

/** `aos doctor`'s row: a warn only for what needs the user (an edited mirror, a failed write); the rest is the summary. */
function doctorRow({ vault, now = new Date() }) {
  const S = lib();
  const cache = S.readCache(S.cacheFile(vault));
  if (!cache) return { name: 'skills', ok: true, detail: 'not synced yet — it runs at session end, or `aos skills sync`', level: 'info' };
  const need = cache.skills.filter((r) => r.status === 'edited' || r.status === 'error');
  const detail = `${summary(cache, now)}${need.length ? ` — ${need.map((r) => `${r.name} ${r.status}`).join(', ')}: aos skills list` : ''}`;
  return { name: 'skills', ok: need.length === 0, detail, level: 'warn' };
}

module.exports = { VERBS, UsageError, main, summary, source, doctorRow, resolveModule, resolveCtx, ago, table };
