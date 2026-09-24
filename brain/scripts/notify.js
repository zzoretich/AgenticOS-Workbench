#!/usr/bin/env node
'use strict';
/**
 * notify.js — `aos notify`: post to and manage the vault's notifications (spec 2026-09-24-notifications-design).
 * Any agent, routine or duty on either host posts here; the Workbench Notifications tab reads the same files.
 *
 *   aos notify post --from <slug> --level breaking|alert|edition|info --title <text> [--tag t]...
 *                   [--body-file <path>|-] [--actions-json <path>|-] [--dry-run] [--json]
 *   aos notify list [--unread] [--archived] [--from <slug>] [--level <level>] [--json]
 *   aos notify read <id>... | --all        aos notify unread <id>...
 *   aos notify archive <id>...             aos notify unarchive <id>...
 *   aos notify prune [--days N]            archive (never delete) items older than N days (notifications.retentionDays)
 *   Every verb takes --root <vault> (default: the resolved vault); under AOS_HEADLESS=1 it must name the vault.
 *
 * Exit 0 on success, 2 on a usage or validation error. `post` prints the new id (or JSON with --json).
 */
const fs = require('fs');
const N = require('./lib/notifications.js');
const { assertPinned } = require('./lib/pin-root.js');

const USAGE = `usage: aos notify post --from <slug> --level ${N.LEVELS.join('|')} --title <text> [--tag t]... [--body-file <path>|-] [--actions-json <path>|-] [--dry-run] [--json]
       aos notify list [--unread] [--archived] [--from <slug>] [--level <level>] [--json]
       aos notify read <id>...|--all · unread <id>... · archive <id>... · unarchive <id>... · prune [--days N]
`;
const BOOL = new Set(['json', 'unread', 'archived', 'all', 'dry-run']);

function parseArgs(argv) {
  const flags = { tag: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '-') { positional.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { flags[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    i++;
    if (k === 'tag') flags.tag.push(v); else flags[k] = v;
  }
  return { flags, positional };
}

/** A file's text, or stdin for '-'. */
function readInput(spec, readStdin) { return spec === '-' ? readStdin() : fs.readFileSync(spec, 'utf8'); }

function fmtRow(r) {
  return `${r.read ? ' ' : '●'} ${r.level.padEnd(8)} ${r.created.slice(0, 16).replace('T', ' ')}  ${r.from.padEnd(16)} ${r.title}${r.archived ? '  (archived)' : ''}\n     ${r.id}`;
}

function main(argv, {
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  now = new Date(),
  vault = null,
  cfg = null,
  notify = null,
  readStdin = () => fs.readFileSync(0, 'utf8'),
} = {}) {
  let flags;
  let positional;
  try { ({ flags, positional } = parseArgs(argv)); } catch (e) { stderr(`notify: ${e.message}\n${USAGE}`); return 2; }
  const [verb, ...rest] = positional;
  let root;
  try {
    assertPinned({ root: flags.root });
    root = flags.root || vault || require('./lib/paths.js').VAULT;
  } catch (e) { stderr(`notify: ${e.message}\n`); return 2; }
  const config = cfg || require('./lib/config.js').loadConfig();

  if (verb === 'post') {
    let body = '';
    let actions;
    try {
      if (flags['body-file']) body = readInput(flags['body-file'], readStdin);
      if (flags['actions-json']) actions = JSON.parse(readInput(flags['actions-json'], readStdin));
    } catch (e) { stderr(`notify: ${e.message}\n`); return 2; }
    const notifier = notify || ((t, m) => require('./persona/watchdog.js').osNotify(t, m));
    try {
      const r = N.post({ from: flags.from, level: flags.level, title: flags.title, tags: flags.tag.length ? flags.tag : undefined, body, actions },
        { vault: root, now, cfg: config, notify: notifier, dryRun: !!flags['dry-run'] });
      if (flags.json) stdout(`${JSON.stringify({ id: r.id, level: r.level, downgraded: r.downgraded, alerted: r.alerted, dryRun: !!flags['dry-run'] })}\n`);
      else if (flags['dry-run']) stdout(r.text);
      else stdout(`${r.id}${r.downgraded ? ` (over ${N.settings(config).maxPerSenderPerHour}/hour for ${flags.from}: posted as info)` : ''}\n`);
      return 0;
    } catch (e) { stderr(`notify: ${e.message}\n`); return 2; }
  }

  if (verb === 'list') {
    if (flags.level && !N.LEVELS.includes(flags.level)) { stderr(`notify: level must be one of ${N.LEVELS.join(', ')}\n`); return 2; }
    const { items, unreadable } = N.list(root, { unread: !!flags.unread, archived: flags.archived ? 'only' : false, from: flags.from || null, level: flags.level || null });
    if (flags.json) { stdout(`${JSON.stringify({ schema: N.SCHEMA, items, unreadable }, null, 2)}\n`); return 0; }
    if (!items.length) stdout(flags.unread ? 'No unread notifications.\n' : 'No notifications.\n');
    else stdout(`${items.map(fmtRow).join('\n')}\n`);
    if (unreadable) stdout(`(${unreadable} unreadable item(s) skipped)\n`);
    return 0;
  }

  const MARKS = { read: ['read', true], unread: ['read', false], archive: ['archived', true], unarchive: ['archived', false] };
  if (MARKS[verb]) {
    const [key, value] = MARKS[verb];
    const all = verb === 'read' && !!flags.all;
    if (!all && !rest.length) { stderr(`notify: ${verb} needs at least one id${verb === 'read' ? ' or --all' : ''}\n`); return 2; }
    try {
      const n = N.mark(root, { ids: rest, all, key, value });
      stdout(`${n} notification(s) ${value ? '' : 'un'}${key === 'read' ? 'marked read' : 'archived'}\n`.replace('unmarked read', 'marked unread'));
      return 0;
    } catch (e) { stderr(`notify: ${e.message}\n`); return 2; }
  }

  if (verb === 'prune') {
    const days = flags.days !== undefined ? Number(flags.days) : N.settings(config).retentionDays;
    if (!Number.isFinite(days) || days <= 0) { stderr('notify: --days must be a positive number\n'); return 2; }
    const r = N.prune(root, { days, now });
    stdout(`${r.archived} archived (older than ${days} days) · ${r.dropped} stale state entr${r.dropped === 1 ? 'y' : 'ies'} dropped\n`);
    return 0;
  }

  stderr(USAGE);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, parseArgs, USAGE };
