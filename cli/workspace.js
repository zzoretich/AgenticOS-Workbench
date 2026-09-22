'use strict';
/**
 * workspace.js — `aos workspace <verb>` over <vault>/workspaces/ (workspace hub spec D3).
 *   list [--json]                  every workspace with status and per-host session counts, then the
 *                                  working directories sessions ran in outside workspaces/
 *   new <name>                     create workspaces/<slug>/ with README.md, CLAUDE.md and AGENTS.md stubs
 *   adopt <path> [--name <slug>]   move an existing project directory into workspaces/ and add the missing stubs
 * Slugs are lowercase kebab-case. CLAUDE.md and AGENTS.md carry the same text: Claude Code reads the first,
 * Codex reads the second, and neither can include the other. Runs from the checkout and from the vendored copy.
 * Zero dependencies; every external effect is injectable (opts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERBS = ['list', 'new', 'adopt'];
const RESERVED = new Set(['_archive', 'research']);
const REPO = path.join(__dirname, '..');

class UsageError extends Error {}

function resolveModule(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(REPO, 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${rel} not found beside cli/workspace.js — run \`aos upgrade\``);
}

function claudeConfigDir() { return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function exists(p) { return fs.existsSync(p); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function resolveCtx(opts = {}) {
  const configDir = opts.configDir || claudeConfigDir();
  const cfg = readJson(process.env.AOS_CONFIG || path.join(configDir, 'agenticos.json')) || {};
  const vault = path.resolve(opts.vault || process.env.AOS_VAULT || cfg.vault || '');
  if (!vault || vault === path.resolve('')) throw new Error('no vault configured (run `aos init` first)');
  const codexHome = path.resolve((cfg.hosts && cfg.hosts.codex && cfg.hosts.codex.home) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return { configDir, cfg, vault, workspacesDir: path.join(vault, 'workspaces'), codexHome, home: opts.home || os.homedir() };
}

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
/** `_archive` and `research` are the vault's own folders under workspaces/, whatever the user typed. */
function isReserved(name, slug) {
  return RESERVED.has(slug) || RESERVED.has(String(name || '').trim().toLowerCase()) || RESERVED.has('_' + slug);
}
function titleOf(slug) { return slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }

/** The three stubs. CLAUDE.md and AGENTS.md are identical on purpose. */
function stubs(slug) {
  const title = titleOf(slug);
  const instructions = [
    `# ${title} — project instructions`,
    '',
    `This is the \`workspaces/${slug}/\` workspace of an AgenticOS vault. Project notes, plans and status live here;`,
    'durable knowledge goes to the vault\'s memory through `/remember` and `/wrap` (Claude Code) or `$remember` and `$wrap` (Codex).',
    '',
    '<!-- CLAUDE.md and AGENTS.md carry the same text: Claude Code reads the first, Codex the second. Edit both. -->',
    '',
  ].join('\n');
  return {
    'README.md': `# ${title}\n\nOne line about what this project is.\n\n## Objectives\n\n- \n\n## Next step\n\n- \n`,
    'CLAUDE.md': instructions,
    'AGENTS.md': instructions,
  };
}

/** Write the stubs that are missing. When exactly one instruction file exists, mirror it into the other. */
function completeStubs(dir, slug) {
  const written = [];
  const s = stubs(slug);
  const hasClaude = exists(path.join(dir, 'CLAUDE.md'));
  const hasAgents = exists(path.join(dir, 'AGENTS.md'));
  if (hasClaude !== hasAgents) {
    const [from, to] = hasClaude ? ['CLAUDE.md', 'AGENTS.md'] : ['AGENTS.md', 'CLAUDE.md'];
    fs.copyFileSync(path.join(dir, from), path.join(dir, to));
    written.push(`${to} (mirrored from ${from})`);
  }
  for (const name of Object.keys(s)) {
    if (exists(path.join(dir, name))) continue;
    fs.writeFileSync(path.join(dir, name), s[name]);
    written.push(name);
  }
  return written;
}

function newWorkspace(ctx, name, { io = console } = {}) {
  const slug = slugify(name);
  if (!slug) throw new UsageError('aos workspace new <name>: the name must contain a letter or digit');
  if (isReserved(name, slug)) throw new UsageError(`aos workspace new: "${slug}" is reserved (${[...RESERVED].join(', ')})`);
  const target = path.join(ctx.workspacesDir, slug);
  if (exists(target)) throw new Error(`${target} already exists`);
  fs.mkdirSync(target, { recursive: true });
  const written = completeStubs(target, slug);
  io.log(`created ${target}`);
  for (const w of written) io.log(`  ${w}`);
  io.log('open a terminal there and start `claude` or `codex`; both read their instruction file from the workspace root');
  return 0;
}

function insideDir(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Move `source` into workspaces/<slug>/. Refuses anything that is not a plain project directory. */
function adoptWorkspace(ctx, source, { name, io = console, rename = fs.renameSync, copy = fs.cpSync, remove = fs.rmSync } = {}) {
  if (!source) throw new UsageError('aos workspace adopt <path> [--name <slug>]');
  const src = path.resolve(source);
  if (!isDir(src)) throw new Error(`${src} is not a directory`);
  const root = path.parse(src).root;
  if (src === root) throw new Error('refusing a filesystem root');
  if (src === path.resolve(ctx.home)) throw new Error('refusing the home directory');
  for (const [label, dir] of [['the Claude config dir', ctx.configDir], ['the Codex home', ctx.codexHome]]) {
    if (insideDir(src, dir) || insideDir(dir, src)) throw new Error(`refusing ${src}: it is inside or contains ${label} ${dir}`);
  }
  if (insideDir(src, ctx.workspacesDir)) throw new Error(`${src} is already under ${ctx.workspacesDir}`);
  if (insideDir(src, ctx.vault)) throw new Error(`refusing ${src}: it is inside the vault; move it by hand if it belongs in workspaces/`);
  if (insideDir(ctx.vault, src)) throw new Error(`refusing ${src}: it contains the vault`);
  const slug = slugify(name || path.basename(src));
  if (!slug) throw new UsageError('aos workspace adopt: pass --name <slug>; the folder name has no letters or digits');
  if (isReserved(name || path.basename(src), slug)) throw new UsageError(`aos workspace adopt: "${slug}" is reserved (${[...RESERVED].join(', ')})`);
  const target = path.join(ctx.workspacesDir, slug);
  if (exists(target)) throw new Error(`${target} already exists; pass --name <other-slug>`);
  fs.mkdirSync(ctx.workspacesDir, { recursive: true });
  try {
    rename(src, target);
  } catch (e) {
    if (e && e.code !== 'EXDEV') throw e;
    copy(src, target, { recursive: true, preserveTimestamps: true });
    remove(src, { recursive: true, force: true });
  }
  const written = completeStubs(target, slug);
  io.log(`adopted ${src}`);
  io.log(`  → ${target}`);
  for (const w of written) io.log(`  + ${w}`);
  if (exists(path.join(target, '.git'))) io.log('  (a git repository of its own; the vault\'s git ignores nested repos)');
  io.log('note: Codex asks once to trust the new path; the old path\'s trust entry in its config.toml is harmless');
  return 0;
}

/** Workspaces with sessions: from the last snapshot when it has hostSessions, else a fresh scan. */
function workspaceRows(ctx) {
  const snap = readJson(path.join(ctx.vault, 'brain', '_index', 'snapshot.json'));
  if (snap && Array.isArray(snap.workspaces) && snap.hostSessions) {
    return { workspaces: snap.workspaces, outside: snap.hostSessions.outsideWorkspaces || [], source: 'snapshot', scannedAt: snap.scannedAt };
  }
  process.env.AOS_VAULT = ctx.vault;
  const { collectWorkspaces } = resolveModule('collectors/workspaces.js');
  const { collectHostSessions, attachSessions } = resolveModule('collectors/hostSessions.js');
  const workspaces = collectWorkspaces({ vault: ctx.vault });
  const outside = attachSessions(workspaces, collectHostSessions().byCwd, { vault: ctx.vault });
  return { workspaces, outside, source: 'scan', scannedAt: new Date().toISOString() };
}

function ago(isoStr, now = Date.now()) {
  if (!isoStr) return 'never';
  const d = Math.floor((now - Date.parse(isoStr)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
}
function shorten(p, home) { return home && p.startsWith(home) ? '~' + p.slice(home.length) : p; }

function listWorkspaces(ctx, { io = console, json = false, now = Date.now() } = {}) {
  const { workspaces, outside, source, scannedAt } = workspaceRows(ctx);
  if (json) {
    io.log(JSON.stringify({
      source, scannedAt,
      workspaces: workspaces.map((w) => ({ name: w.name, status: w.status, sessions: w.sessions || { claude: 0, codex: 0, total: 0, lastAt: null } })),
      outsideWorkspaces: outside,
    }, null, 2));
    return 0;
  }
  if (!workspaces.length) io.log(`no workspaces under ${ctx.workspacesDir} (aos workspace new <name>)`);
  for (const w of workspaces) {
    const s = w.sessions || { claude: 0, codex: 0, lastAt: null };
    io.log(`${w.name.padEnd(28)} ${String(w.status || '-').padEnd(8)} claude ${String(s.claude).padStart(3)}  codex ${String(s.codex).padStart(3)}  ${ago(s.lastAt, now)}`);
  }
  if (outside.length) {
    io.log('');
    io.log(`outside workspaces/ (${outside.length}):`);
    for (const o of outside) io.log(`  ${shorten(o.cwd, ctx.home).padEnd(48)} claude ${String(o.claude).padStart(3)}  codex ${String(o.codex).padStart(3)}  ${ago(o.lastAt, now)}   aos workspace adopt ${shorten(o.cwd, ctx.home)}`);
  }
  io.log(`(${source === 'snapshot' ? `from the snapshot of ${scannedAt}` : 'fresh scan'})`);
  return 0;
}

async function main(argv, opts = {}) {
  const io = opts.io || console;
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--name') flags.name = argv[++i];
    else if (a.startsWith('--name=')) flags.name = a.slice(7);
    else if (a.startsWith('--')) throw new UsageError(`aos workspace: unknown flag ${a}`);
    else words.push(a);
  }
  const verb = words[0] || 'list';
  if (!VERBS.includes(verb)) throw new UsageError(`aos workspace: unknown verb "${verb}" (${VERBS.join(' | ')})`);
  const ctx = resolveCtx(opts);
  switch (verb) {
    case 'list': return listWorkspaces(ctx, { io, json: !!flags.json, now: opts.now });
    case 'new': return newWorkspace(ctx, words.slice(1).join(' '), { io });
    case 'adopt': return adoptWorkspace(ctx, words[1], { name: flags.name, io, rename: opts.rename, copy: opts.copy, remove: opts.remove });
    default: return 2;
  }
}

module.exports = { VERBS, RESERVED, UsageError, main, resolveCtx, slugify, stubs, completeStubs, newWorkspace, adoptWorkspace, listWorkspaces, ago };
