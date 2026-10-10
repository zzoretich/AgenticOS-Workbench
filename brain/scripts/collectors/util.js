const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { VAULT, PATHS } = require('../lib/paths.js');

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function exists(p) {
  return safeStat(p) !== null;
}

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

function countLines(p) {
  try {
    const s = safeStat(p);
    if (!s || s.size > 50 * 1024 * 1024) return null;
    const buf = fs.readFileSync(p);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
  } catch { return null; }
}

function readText(p, maxBytes = 2 * 1024 * 1024) {
  try {
    const s = safeStat(p);
    if (!s || s.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

function readJson(p) {
  const t = readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function walkSize(dir, opts = {}) {
  const { maxDepth = 10, skipNames = new Set() } = opts;
  let bytes = 0;
  let files = 0;
  let newestMtime = 0;
  function walk(p, depth) {
    if (depth > maxDepth) return;
    const s = safeStat(p);
    if (!s) return;
    if (s.isFile()) {
      bytes += s.size;
      files++;
      if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs;
      return;
    }
    if (!s.isDirectory()) return;
    for (const name of listDir(p)) {
      if (skipNames.has(name)) continue;
      walk(path.join(p, name), depth + 1);
    }
  }
  walk(dir, 0);
  return { bytes, files, newestMtime: newestMtime ? new Date(newestMtime).toISOString() : null };
}

function humanSize(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

function iso(ms) {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

// Parse a leading `---`…`---` YAML frontmatter block into a flat {key: value} map.
// Strings only; tolerant of missing/malformed files. Returns {} when absent.
function readFrontmatter(absPath) {
  const t = readText(absPath, 256 * 1024);
  if (!t) return {};
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, '');
    out[kv[1]] = v;
  }
  return out;
}

// ── git (spaces-redesign D24, spec §6) ──────────────────────────────────────
// These calls only read, and none may run a program a repository's own config names (a folder whose .git came from
// elsewhere is not trusted). What is guarded, and how:
//   core.fsmonitor (a hook on status), log.showSignature (gpg.program on a signed commit): off through GIT_GUARD's -c,
//     which beats the repo's config and reaches the git processes git starts itself;
//   filter.<driver>.clean/smudge/process (status re-hashes a changed file through them): every driver defined below
//     global and system scope is turned off for status (filterGuard), so the user's own (git-lfs) still work;
//   a lazy fetch in a partial clone (core.sshCommand, remote helpers): GIT_NO_LAZY_FETCH, and GIT_ALLOW_PROTOCOL empty,
//     which allows no transport whatever the repo's protocol.*.allow says;
//   diff.external and textconv: no call here prints a patch, and the log that pairs renames passes --no-ext-diff
//     --no-textconv.
// --no-optional-locks (with no untracked cache) keeps status from writing the index. Every call is bounded (2 s unless
// told otherwise), never prompts, and reads git's output in the C locale. The app's git.ts mirrors these rules.
const GIT_GUARD = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.untrackedCache=false', '--no-optional-locks']);
const GIT_TIMEOUT_MS = 2000;
const GIT_LOG_TIMEOUT_MS = 10000; // the vault's one --name-status log per scan
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// filterGuard's --config-env values: an empty command and required=false turn a driver off without failing status.
const GIT_EMPTY_ENV = 'AOS_GIT_EMPTY';
const GIT_FALSE_ENV = 'AOS_GIT_FALSE';

function gitEnv() {
  // Literal pathspecs: a folder named with *, ? or [ ] is that folder, never a pattern.
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', [GIT_EMPTY_ENV]: '', [GIT_FALSE_ENV]: 'false',
  };
  // -C <dir> picks the repository, never a GIT_DIR or work tree inherited from a parent git process (a hook).
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
}

/** `git <guard> -C <dir> <args…>` → { code (git's exit status; -1 when it did not exit: missing, killed), out }. */
function gitCall(dir, args, opts = {}) {
  try {
    const out = execFileSync('git', [...GIT_GUARD, '-C', dir, ...args], {
      timeout: opts.timeout || GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e && Number.isInteger(e.status) ? e.status : -1, out: null };
  }
}

/** `git <guard> -C <dir> <args…>` → stdout, or null when git is missing, fails or runs past the timeout. */
function runGit(dir, args, opts = {}) {
  const r = gitCall(dir, args, opts);
  return r.code === 0 ? r.out : null;
}

/**
 * `config -z --show-scope --name-only --get-regexp ^filter\.` → the global options that turn off, for one command,
 * every filter driver defined below global and system scope (a repo's .git/config, its worktree config, a file either
 * includes). `--config-env` splits at the last `=`, so a driver named with `=` is turned off too. Pure.
 */
function filterOverrides(out) {
  const t = String(out || '').split('\0');
  const names = new Set();
  for (let i = 0; i + 1 < t.length; i += 2) {
    const scope = t[i];
    const key = t[i + 1];
    if (scope === 'global' || scope === 'system' || !key.startsWith('filter.')) continue;
    const dot = key.lastIndexOf('.');
    if (dot >= 'filter.'.length) names.add(key.slice('filter.'.length, dot));
  }
  const args = [];
  for (const n of names) {
    for (const k of ['clean', 'smudge', 'process']) args.push(`--config-env=filter.${n}.${k}=${GIT_EMPTY_ENV}`);
    args.push(`--config-env=filter.${n}.required=${GIT_FALSE_ENV}`);
  }
  return args;
}

/** filterOverrides for `dir`'s repository (reading config runs nothing), or null when git cannot say, so no status runs. */
function filterGuard(dir) {
  const r = gitCall(dir, ['config', '-z', '--show-scope', '--name-only', '--get-regexp', '^filter\\.']);
  if (r.code === 1) return []; // no filter defined anywhere
  return r.code === 0 ? filterOverrides(r.out) : null;
}

/** Whether `dir` is the top of its own repository (a `.git` folder, or a linked worktree's `.git` file, in it). */
function ownRepo(dir) {
  return !!dir && exists(path.join(dir, '.git'));
}

// Most recent commit touching a path. Uses the dir's own repo if it has one,
// else the vault repo scoped to relPath. Returns { iso, subject, hash } or null.
function lastCommit(absDir, relPath) {
  const fmt = '%cI%x00%s%x00%h';
  const out = ownRepo(absDir)
    ? runGit(absDir, ['log', '-1', '--no-color', `--format=${fmt}`])
    : runGit(VAULT, ['log', '-1', '--no-color', `--format=${fmt}`, '--', relPath]);
  if (!out || !out.trim()) return null;
  const [ci, subject, hash] = out.trim().split('\x00');
  if (!ci) return null;
  return { iso: ci, subject: subject || null, hash: hash || null };
}

/** `status --porcelain=v2 --branch` → { branch, detached, head, upstream, ahead, behind, dirty }. Pure. */
function parsePorcelainV2(out) {
  const st = { branch: null, detached: false, head: null, upstream: null, ahead: null, behind: null, dirty: 0 };
  for (const line of String(out || '').split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      st.head = /^[0-9a-f]{7,}$/.test(oid) ? oid.slice(0, 7) : null; // "(initial)": no commit yet
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      st.detached = head === '(detached)';
      st.branch = st.detached ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      st.upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
      if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]); }
    } else if (/^[12u?] /.test(line)) {
      st.dirty++;
    }
  }
  return st;
}

/**
 * The state of `dir`'s own repository (spaces-redesign D24): a workspace's own folder or its `repo:` folder, never an
 * enclosing repository (a folder the vault's git tracks has none of its own: see vaultPathCommits).
 * → { kind: 'repo', branch, detached, head, upstream, ahead, behind, dirty, remotes }, or null (no repository of its
 * own, git missing, a timeout). `head` is the short hash (null before the first commit); `dirty` counts changed,
 * conflicted and untracked entries, submodules ignored; `remotes` holds names only, since a remote URL can carry a
 * credential.
 */
function gitState(dir) {
  if (!ownRepo(dir)) return null;
  const filters = filterGuard(dir);
  if (!filters) return null;
  const out = runGit(dir, [...filters, 'status', '--porcelain=v2', '--branch', '--ignore-submodules=all']);
  if (out == null) return null;
  const remotes = (runGit(dir, ['remote']) || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { kind: 'repo', ...parsePorcelainV2(out), remotes };
}

/** Each pattern of `workspaces.ignoreCommitSubjects` as a RegExp; one that does not compile is skipped. */
function subjectMatchers(patterns) {
  const out = [];
  for (const p of Array.isArray(patterns) ? patterns : []) {
    if (typeof p !== 'string' || !p) continue;
    try { out.push(new RegExp(p)); } catch { /* a bad pattern ignores nothing */ }
  }
  return out;
}

/**
 * `log -z --name-status --format=%x01%h%x00%cI%x00%s` → [{ hash, iso, subject, changes: [{ status, score, from, path }] }].
 * Read token by token, so a subject or a path holding any byte but NUL parses. Pure.
 */
function parseNameStatusLog(out) {
  const commits = [];
  const t = String(out || '').split('\0');
  let cur = null;
  let i = 0;
  while (i < t.length) {
    const tok = t[i].replace(/^\n+/, '');
    if (tok.startsWith('\x01')) {
      cur = { hash: tok.slice(1), iso: t[i + 1] || null, subject: t[i + 2] || '', changes: [] };
      commits.push(cur);
      i += 3;
      continue;
    }
    const m = cur && tok.match(/^([ACDMRTUXB])(\d*)$/);
    if (m && (m[1] === 'R' || m[1] === 'C')) {
      cur.changes.push({ status: m[1], score: m[2] ? Number(m[2]) : null, from: t[i + 1], path: t[i + 2] });
      i += 3;
    } else if (m) {
      cur.changes.push({ status: m[1], score: null, from: null, path: t[i + 1] });
      i += 2;
    } else {
      i++;
    }
  }
  return commits;
}

/** The files the `aos workspace` verbs write in a workspace folder: workspace.md and the stubs. */
const VERB_FILES = Object.freeze(['workspace.md', 'README.md', 'CLAUDE.md', 'AGENTS.md']);

// One read of the vault's log per folder scope and HEAD, shared by every workspace a scan asks about.
const vaultLogMemo = new Map();
function vaultLog(vault, scope, limit) {
  const head = (runGit(vault, ['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim();
  if (!head) return null;
  const key = `${path.resolve(vault)}\0${scope}\0${limit}\0${head}`;
  if (vaultLogMemo.has(key)) return vaultLogMemo.get(key);
  // -M across the whole scope (spaces-redesign D11/A2): a log of one folder alone sees every file moved into it as
  // added. Exact renames are paired whatever diff.renameLimit says, so the moves Rename and Restore make read as such.
  // A long workspaces/ history gets its own timeout, and a failed read is not remembered, so the next ask tries again.
  const out = runGit(vault, ['log', '-M', '-z', '--name-status', '--relative', '--no-color', '--no-ext-diff', '--no-textconv',
    `--max-count=${limit}`, '--format=%x01%h%x00%cI%x00%s', '--', scope], { timeout: GIT_LOG_TIMEOUT_MS });
  if (out == null) return null;
  const log = parseNameStatusLog(out);
  if (vaultLogMemo.size >= 16) vaultLogMemo.clear();
  vaultLogMemo.set(key, log);
  return log;
}

/**
 * A folder the vault's own git tracks (spaces-redesign D11/A2, D24): one `git log -M --name-status -- <top folder>/`
 * (memoized per HEAD), filtered to `relPath`, a vault-relative folder such as `workspaces/x`.
 *   tracked   the vault's HEAD holds the folder (then the caller marks its git `{ kind: 'vault' }`); null with opts.log
 *   commits   the newest `opts.n` (10) commits that touched the folder, minus those whose subject matches one of
 *             `opts.ignoreCommitSubjects` (regular expressions)
 *   activity  the newest commit that counts as work there: one whose subject matches none of them, or one that does but
 *             adds or modifies a file there other than `opts.verbFiles` (workspace.md and the stubs). A move (an exact
 *             rename, as Rename and Restore make) and a deletion never count. It carries `ignored` (its subject matched).
 * Rows are { hash, iso, subject }. `opts.log` (parseNameStatusLog's output) makes it pure.
 */
function vaultPathCommits(vault, relPath, opts = {}) {
  const n = Number.isInteger(opts.n) && opts.n >= 0 ? opts.n : 10;
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const none = { tracked: false, commits: [], activity: null };
  if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return none;
  const log = opts.log || vaultLog(vault, `${rel.split('/')[0]}/`, opts.scanLimit || 2000);
  if (!log) return none;
  const tracked = opts.log ? null : !!(runGit(vault, ['ls-tree', 'HEAD', '--', rel]) || '').trim();
  const ignore = subjectMatchers(opts.ignoreCommitSubjects);
  const verbFiles = new Set(opts.verbFiles || VERB_FILES);
  const prefix = `${rel}/`;
  const inside = (p) => typeof p === 'string' && p.startsWith(prefix);
  const changesWork = (ch) => inside(ch.path) && !verbFiles.has(ch.path.slice(prefix.length))
    && (ch.status === 'A' || ch.status === 'M' || ch.status === 'T' || ch.status === 'C' || (ch.status === 'R' && ch.score !== 100));
  const commits = [];
  let activity = null;
  for (const c of log) {
    const here = c.changes.filter((ch) => inside(ch.path) || inside(ch.from));
    if (!here.length) continue;
    const ignored = ignore.some((re) => re.test(c.subject));
    const row = { hash: c.hash, iso: c.iso, subject: c.subject };
    if (!ignored && commits.length < n) commits.push(row);
    if (!activity && (!ignored || here.some(changesWork))) activity = { ...row, ignored };
    if (activity && commits.length >= n) break;
  }
  return { tracked, commits, activity };
}

/**
 * Recent commits, newest first, as [{ hash, iso, subject }] ([] when there are none or git fails).
 *   recentCommits(dir, n)                                   dir's own repository (a workspace's folder or `repo:` folder)
 *   recentCommits(vault, n, { path, ignoreCommitSubjects }) the vault-tracked folder `path`, as vaultPathCommits
 */
function recentCommits(dir, n, opts = {}) {
  const count = Number.isInteger(n) && n >= 0 ? n : 10;
  if (count === 0) return [];
  if (opts.path) return vaultPathCommits(dir, opts.path, { ...opts, n: count }).commits;
  if (!ownRepo(dir)) return [];
  const out = runGit(dir, ['log', `--max-count=${count}`, '--no-color', '--format=%h%x00%cI%x00%s']);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, ci, subject] = line.split('\x00');
    return { hash: hash || null, iso: ci || null, subject: subject || '' };
  }).filter((c) => c.hash && c.iso);
}

// ── workspace names and files (spaces-redesign §6, D33) ─────────────────────
// The page's WS argument kind (app/src/shared/surfaces.ts), checked again here: not `.`, `..`, `.x`, `_x` (hidden and
// archived folders) or `-x`, no path separator, no NUL or line break (U+2028 and U+2029 included), at most 128 characters.
const WS_NAME = /^[^\s\0._/\\-][^/\\\0\n\r\u2028\u2029]{0,127}$/;

/** The real folder of the existing workspace `name`, a direct child of <vault>/workspaces/, or null. */
function workspaceDir(name, vault = VAULT) {
  if (typeof name !== 'string' || !WS_NAME.test(name)) return null;
  try {
    const root = fs.realpathSync(path.join(vault, 'workspaces'));
    const real = fs.realpathSync(path.join(root, name));
    if (path.dirname(real) !== root || !fs.statSync(real).isDirectory()) return null;
    return real;
  } catch { return null; }
}

/**
 * Whether `name` names an existing workspace, read by name alone: WS_NAME, and a direct child of <vault>/workspaces/ that
 * is a folder or a link to one (a code folder linked in). For a caller that only picks the snapshot entry of that name
 * (regen-workspace-insight.js); anything that reads files under the name takes workspaceDir.
 */
function workspaceName(name, vault = VAULT) {
  if (typeof name !== 'string' || !WS_NAME.test(name)) return false;
  const p = path.join(vault, 'workspaces', name);
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() || (st.isSymbolicLink() && fs.statSync(p).isDirectory());
  } catch { return false; }
}

/**
 * A file the caller names inside a workspace folder (`wsDir`, a real path from workspaceDir): relative, with no `.` or
 * `..` segment and no leading `-`; a regular file by lstat (a link is never followed); its real path inside the folder,
 * so a linked folder on the way cannot lead out. → its absolute path, or null.
 */
function workspaceFile(wsDir, rel) {
  if (typeof wsDir !== 'string' || typeof rel !== 'string' || !rel || rel.length > 4096) return null;
  if (/[\0\n\r]/.test(rel) || rel.startsWith('-') || path.isAbsolute(rel)) return null;
  if (rel.split(/[\\/]/).some((s) => s === '.' || s === '..')) return null;
  const abs = path.join(wsDir, rel);
  try {
    if (!fs.lstatSync(abs).isFile()) return null;
    const r = path.relative(wsDir, fs.realpathSync(abs));
    if (!r || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return null;
    return abs;
  } catch { return null; }
}

module.exports = {
  VAULT, PATHS,
  safeStat, exists, listDir,
  countLines, readText, readJson,
  walkSize, humanSize, iso, nowIso,
  readFrontmatter, lastCommit,
  GIT_GUARD, runGit, gitState, recentCommits, vaultPathCommits, parsePorcelainV2, parseNameStatusLog, filterOverrides, VERB_FILES,
  WS_NAME, workspaceDir, workspaceName, workspaceFile,
};
