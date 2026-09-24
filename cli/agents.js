'use strict';
/**
 * agents.js — `aos agents <verb>` (spec 2026-09-23-universal-agents).
 *   list [--all] [--json]      your agents on both hosts from brain/_index/agents.json (--all adds plugin agents and the
 *                              roles Codex's config.toml declares); before the first sync, a dry-run plan
 *   sync [--dry-run] [--json]  mirror each host's user agents into the other host's agents folder and rewrite the cache
 *   exclude <name>             stop sharing an agent (agents.exclude in <vault>/brain/config.json), then sync
 *   include <name>             share it again, then sync
 *   reset <name>               delete an edited mirror (the edit is lost) so the sync writes it fresh
 * Runs from the checkout and from the vendored <vault>/brain/scripts/cli/, like cli/skills.js, whose helpers it shares.
 */
const fs = require('fs');
const path = require('path');
const K = require('./skills.js');

const VERBS = ['list', 'sync', 'exclude', 'include', 'reset'];
const { UsageError, resolveModule, resolveCtx, ago, table } = K;
const lib = () => resolveModule('lib/agents.js');
const translate = () => resolveModule('lib/skill-translate.js');

const USER_SCOPES = new Set(['user', 'mirror']);
function isYours(row) { return USER_SCOPES.has(row.origin && row.origin.scope); }

function source(row) {
  const o = row.origin || {};
  if (o.scope === 'plugin') return `plugin ${o.plugin}`;
  if (o.scope === 'config') return 'codex config.toml';
  if (o.scope === 'mirror') return `${o.host} (orphan)`;
  return `${o.host}`;
}

/** "33 yours (33 universal) · 1 from plugins and config.toml · sharing on, synced 2m ago". */
function summary(cache, now) {
  const yours = cache.agents.filter(isYours);
  const counts = {};
  for (const r of yours) counts[r.status] = (counts[r.status] || 0) + 1;
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
  const listed = cache.agents.length - yours.length;
  const sharing = !cache.sync.on ? cache.sync.reason : cache.sync.at ? `sharing on, synced ${ago(cache.sync.at, now)}` : 'sharing on, not synced yet';
  const off = cache.codexAgents && cache.codexAgents.on === false ? ` · ${cache.codexAgents.reason}` : '';
  return `${yours.length} yours${parts.length ? ` (${parts.join(', ')})` : ''} · ${listed} from plugins and config.toml · ${sharing}${off}`;
}

function print(cache, { io, all, now }) {
  const rows = cache.agents.filter((r) => all || isYours(r));
  io.log(summary(cache, now));
  if (!rows.length) { io.log('no agents yet — an agent is a .md file in Claude Code\'s agents folder or a .toml file in Codex\'s'); return; }
  io.log('');
  io.log(table(['NAME', 'CLAUDE CODE', 'CODEX', 'SOURCE', 'STATUS'], rows.map((r) => [
    `${r.name}${r.readOnly ? ' (read-only)' : ''}`, r.on.claude ? r.on.claude.invoke : '—', r.on.codex ? r.on.codex.invoke : '—', source(r), r.status,
  ])));
  const notes = rows.filter((r) => ['differs', 'edited', 'invalid', 'error'].includes(r.status) && r.note);
  if (notes.length) { io.log(''); for (const r of notes) io.log(`${r.name}: ${r.note}`); }
  io.log('');
  io.log('Claude Code: ask for an agent by name, mention @agent-<name>, or start a session as one with `claude --agent <name>`. Codex: ask for it by name and Codex spawns it.');
}

function list(ctx, { io, json, all }) {
  const S = lib();
  let cache = S.readCache(S.cacheFile(ctx.vault));
  const fresh = !cache;
  if (fresh) cache = S.sync({ vault: ctx.vault, userCfg: ctx.userCfg, roots: ctx.roots, now: ctx.now, dryRun: true }).cache;
  if (json) { io.log(JSON.stringify(cache, null, 2)); return 0; }
  print(cache, { io, all, now: ctx.now });
  if (fresh) io.log('\nnot synced yet — `aos agents sync` shares them');
  return 0;
}

function sync(ctx, { io, json, dryRun }) {
  const { cache, actions, result } = lib().sync({ vault: ctx.vault, userCfg: ctx.userCfg, roots: ctx.roots, now: ctx.now, dryRun });
  if (json) { io.log(JSON.stringify(dryRun ? { actions: actions.map(({ content, ...a }) => a), agents: cache.agents } : cache, null, 2)); return result.errors.length ? 1 : 0; }
  if (dryRun) {
    if (!actions.length) io.log('nothing to do');
    for (const a of actions) io.log(a.type === 'mirror' ? `mirror ${a.id} (${a.from} → ${a.from === 'claude' ? 'codex' : 'claude'}) at ${a.file}` : `remove ${a.file}`);
    return 0;
  }
  io.log(`synced: ${result.written.length} written, ${result.removed.length} removed${result.errors.length ? `, ${result.errors.length} failed` : ''}`);
  for (const e of result.errors) io.error(`${e.id}: ${e.message}`);
  print(cache, { io, all: false, now: ctx.now });
  return result.errors.length ? 1 : 0;
}

/** agents.exclude in <vault>/brain/config.json; refuses a config it cannot parse rather than replace it. */
function setExcluded(ctx, name, excluded, o) {
  if (!name) throw new UsageError(`aos agents ${excluded ? 'exclude' : 'include'} <name>`);
  const id = translate().codexName(name);
  if (!id) throw new UsageError(`"${name}" is not an agent name`);
  const file = path.join(ctx.vault, 'brain', 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix it first`); }
  }
  const agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
  const set = new Set((Array.isArray(agents.exclude) ? agents.exclude : []).map((n) => String(n).toLowerCase()));
  const had = set.has(id);
  if (excluded) set.add(id); else set.delete(id);
  cfg.agents = { ...agents, exclude: [...set].sort() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, file);
  o.io.log(excluded ? (had ? `${id} was already excluded` : `${id} is no longer shared`) : (had ? `${id} is shared again` : `${id} was not excluded`));
  return sync(ctx, { io: o.io });
}

function reset(ctx, name, o) {
  if (!name) throw new UsageError('aos agents reset <name>');
  const id = translate().codexName(name);
  const removed = lib().reset({ userCfg: ctx.userCfg, roots: ctx.roots, id });
  if (!removed.length) { o.io.log(`no mirror named ${id}`); return 1; }
  for (const f of removed) o.io.log(`removed ${f}`);
  return sync(ctx, { io: o.io });
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const words = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos agents: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  if (flags.has('--dry-run') && verb !== 'sync') throw new UsageError('--dry-run is only supported by `aos agents sync`');
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
  if (!cache) return { name: 'agents', ok: true, detail: 'not synced yet — it runs at session end, or `aos agents sync`', level: 'info' };
  const need = cache.agents.filter((r) => r.status === 'edited' || r.status === 'error');
  const detail = `${summary(cache, now)}${need.length ? ` — ${need.map((r) => `${r.name} ${r.status}`).join(', ')}: aos agents list` : ''}`;
  return { name: 'agents', ok: need.length === 0, detail, level: 'warn' };
}

module.exports = { VERBS, UsageError, main, summary, source, doctorRow };
