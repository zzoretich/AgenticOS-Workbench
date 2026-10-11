'use strict';
/**
 * workspace-manifest.js — a workspace's workspace.md frontmatter, read by the scan and written by `aos workspace`
 * (spaces-redesign D18, D28). One parser for both sides, so what a verb writes is what the next scan reads.
 *
 *   parseManifest(text)                    the tolerant parser collectors/workspaces.js reads with (unchanged)
 *   repoPath(value, vault, home)           a `repo:` value as an absolute folder outside the vault, else null
 *   workspacesRoot(vault, {archived, make}) workspaces/ (or workspaces/_archive/) as a plain folder of the vault
 *   workspaceDir(vault, name, {archived})  a name → the real path of a direct child of workspaces/ (or _archive/)
 *   listField(text, key)                   a frontmatter block list the parser does not read (Archive's record)
 *   readManifest(dir)                      { file, exists, refused, text, hash, manifest }; never through a link
 *   manifestHash(text | Buffer | null)     the --expect hash: sha256 hex of the bytes, 'none' when there is no file
 *   setFields(text, fields)                frontmatter keys replaced in place, every other line kept byte for byte
 *   validateSetFields(input, ctx)          `aos workspace set --set <json>`: the allowed keys, types and limits
 *   setManifest(dir, fields, {expect, dryRun})  read → compare --expect → setFields → atomic write
 *   writeManifest(dir, text)               fsx.writeAtomic: a symlinked workspace.md is replaced, never followed
 *
 * setFields renders strings as YAML scalars the parser reads back exactly: plain when that is safe, else quoted.
 * Arrays become block lists indented two spaces; booleans true/false; null, '' and [] remove the key; undefined leaves
 * it alone. A key that appears twice keeps its first place and loses the rest, so the result reads as exactly the value
 * that was set. Unknown keys, comments, blank lines, line endings and the body are kept as they were.
 *
 * Zero dependencies beyond lib/fsx.js and lib/host.js (lazily, for the host config folders); requires no vault at
 * load time, so the CLI and the collector can both load it.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFEST = 'workspace.md';
const MAX_READ = 256 * 1024;
const ARCHIVE_DIR = '_archive';

// `aos workspace set` (spaces-redesign §6, Mechanics › PR 3 › Security): the keys the page and sessions may set.
const SET_KEYS = Object.freeze(['status', 'pinned', 'objectives', 'summary', 'next', 'repo']);
const STATUS_WORDS = Object.freeze(['active', 'paused', 'done']);
const LIMITS = Object.freeze({ objectives: 20, objective: 200, summary: 500, next: 500 });
// C0 controls, DEL and the two Unicode line separators: none may reach a frontmatter line.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
// An existing workspace's name (surfaces.ts `WS`): not `.`, `..`, `_x`, nor containing a separator.
const WS_RE = /^[^\s._/\\-][^/\\\0\n\r]{0,127}$/;
const KEY_RE = /^[A-Za-z0-9_-]+$/;

class ManifestError extends Error {
  /** @param {'INVALID'|'UNSAFE'|'CHANGED'|'NOT_FOUND'} code */
  constructor(message, code = 'INVALID') {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

// ── parser (moved from collectors/workspaces.js, behaviour unchanged) ──
// Tolerant, supports exactly the fields we render:
//   scalar: status, summary, next, type, repo (a linked code folder outside the vault: spec 2026-10-08-term-agent-deck T8),
//           pinned (true/false), archived (a date, set by Archive) — spaces-redesign D18, D22
//   block list: objectives:\n  - item   (a list item may also sit unindented under its key, as YAML allows)
//   aliases: block list or [a, b]: former folders, `workspaces/<old>` or `~/…` (spaces-redesign D16, D17)
//   subprojects:\n  - { name: x, path: y }   |   - bareName
function parseManifest(text) {
  const empty = () => ({ status: null, summary: null, objectives: [], subprojects: [], documents: [], next: null, repo: null, pinned: false, archived: null, aliases: [] });
  if (!text) return empty();
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return empty();
  const lines = m[1].split(/\r?\n/);
  const out = empty();
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
  let mode = null; // 'objectives' | 'subprojects' | 'documents' | 'aliases'
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const listItem = raw.match(/^\s*-(?:\s+(.*))?$/);
    if (listItem && mode) {
      const val = (listItem[1] || '').trim();
      if (!val) continue; // an empty `- ` placeholder
      if (mode === 'objectives') {
        out.objectives.push(unquote(val));
      } else if (mode === 'documents') {
        out.documents.push(unquote(val));
      } else if (mode === 'aliases') {
        const a = unquote(val);
        if (a) out.aliases.push(a);
      } else if (mode === 'subprojects') {
        const flow = val.match(/^\{\s*(.*?)\s*\}$/);
        if (flow) {
          const obj = {};
          for (const pair of flow[1].split(',')) {
            const kv = pair.split(':');
            if (kv.length >= 2) obj[kv[0].trim()] = unquote(kv.slice(1).join(':'));
          }
          const name = obj.name || obj.path;
          if (name) out.subprojects.push({ name, path: obj.path || name });
        } else {
          const name = unquote(val);
          if (name) out.subprojects.push({ name, path: name });
        }
      }
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (key === 'objectives') { mode = 'objectives'; continue; }
    if (key === 'documents') { mode = 'documents'; continue; }
    if (key === 'subprojects') { mode = 'subprojects'; continue; }
    if (key === 'aliases') {
      mode = 'aliases';
      const flow = value.match(/^\[(.*)\]$/);
      const inline = flow ? flow[1].split(',') : value ? [value] : [];
      for (const a of inline.map(unquote)) if (a) out.aliases.push(a);
      continue;
    }
    mode = null;
    if (key === 'status') out.status = value ? unquote(value) : null;
    else if (key === 'summary') out.summary = value ? unquote(value) : null;
    else if (key === 'next') out.next = value ? unquote(value) : null;
    else if (key === 'repo') out.repo = value ? unquote(value) : null;
    else if (key === 'pinned') out.pinned = /^(true|yes|on|1)$/i.test(unquote(value));
    else if (key === 'archived') { const v = unquote(value); out.archived = v && !/^(false|no|off|0|null|~)$/i.test(v) ? v : null; }
  }
  return out;
}

/**
 * A frontmatter list the parser above does not read, by key (`[a, b]`, a block list, or one value): Archive's record of
 * the project notes it flipped (`archivedNotes:`) and the name it archived from (`archivedFrom:`, one value), which
 * Restore reads back (spaces-redesign D17). [] when the key is missing.
 */
function listField(text, key) {
  const m = typeof text === 'string' ? text.match(/^---\r?\n([\s\S]*?)\r?\n---/) : null;
  if (!m) return [];
  const out = [];
  const unquote = (v) => v.trim().replace(/^["']|["']$/g, '');
  let on = false;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const item = raw.match(/^\s*-(?:\s+(.*))?$/);
    if (item && on) { const v = unquote(item[1] || ''); if (v) out.push(v); continue; }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    on = kv[1] === key;
    if (!on) continue;
    const value = kv[2].trim();
    const flow = value.match(/^\[(.*)\]$/);
    for (const v of (flow ? flow[1].split(',') : value ? [value] : []).map(unquote)) if (v) out.push(v);
  }
  return out;
}

/**
 * A manifest's `repo:` as an absolute folder: `~/…` or absolute, and outside the vault (a workspace's own folder is
 * already its place). Anything else is null, so a typo never points a workspace somewhere unexpected.
 */
function repoPath(value, vaultRoot, home = os.homedir()) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();
  const p = v === '~' ? home : v.startsWith('~/') ? path.join(home, v.slice(2)) : v;
  if (!path.isAbsolute(p)) return null;
  const abs = path.resolve(p);
  const rel = path.relative(path.resolve(vaultRoot), abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return null;
  return abs;
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Every spelling of a path: as given (resolved) and its realpath when it exists. The native realpath, which on a
 * case-insensitive file system (macOS) answers the case stored on disk, so `~/.CLAUDE` compares as `~/.claude`
 * (spaces-redesign §6).
 */
function spellings(p) {
  const out = new Set([path.resolve(p)]);
  try { out.add(fs.realpathSync.native(p)); } catch { /* not there */ }
  return [...out];
}

// ── locating and reading ──

/**
 * workspaces/ (or workspaces/_archive/ with `archived`) as a plain folder of the vault (spaces-redesign §6): each part
 * below the vault is a directory, never a link or a file, and its real path is the vault's own, as team-run.js requires
 * of workspaces/ (AT-REV-05). So a `workspaces -> ..` or `_archive -> ~` link never sends a verb out of the vault.
 * `make` creates a missing part with a plain mkdir (each parent was just checked). → the real path; throws a
 * ManifestError (NOT_FOUND when a part is missing, UNSAFE otherwise).
 */
function workspacesRoot(vault, { archived = false, make = false } = {}) {
  const segs = archived ? ['workspaces', ARCHIVE_DIR] : ['workspaces'];
  let realVault;
  try { realVault = fs.realpathSync(vault); } catch { throw new ManifestError(`the vault ${vault} does not exist`, 'NOT_FOUND'); }
  let cur = vault;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const shown = segs.slice(0, i + 1).join('/');
    let st = null;
    try { st = fs.lstatSync(cur); } catch { /* missing */ }
    if (!st && make) {
      try { fs.mkdirSync(cur); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
      st = fs.lstatSync(cur);
    }
    if (!st) throw new ManifestError(`there is no ${shown}/ folder`, 'NOT_FOUND');
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ManifestError(`${shown} is not a plain folder (a link or a file): refusing to work through it`, 'UNSAFE');
  }
  const real = fs.realpathSync(cur);
  if (real !== path.join(realVault, ...segs)) throw new ManifestError(`${segs.join('/')} resolves outside the vault`, 'UNSAFE');
  return real;
}

/**
 * A workspace name → the real path of its folder (spaces-redesign §6): the name passes `WS`, workspaces/ (and _archive/
 * with `archived`) is a plain folder of the vault (workspacesRoot), the folder is a directory (not a link) whose name is
 * an entry of that folder byte for byte, and its realpath is a direct child of it. The exact entry matters on a
 * case-insensitive or Unicode-folding file system (macOS), where `FOO` or `reſearch` would otherwise find `foo` or
 * `research` and get past the reserved-name check. Throws a ManifestError otherwise.
 */
function workspaceDir(vault, name, { archived = false } = {}) {
  if (typeof name !== 'string' || !WS_RE.test(name)) throw new ManifestError(`not a workspace name: ${JSON.stringify(String(name)).slice(0, 80)}`);
  let root;
  try { root = workspacesRoot(vault, { archived }); } catch (e) {
    if (e instanceof ManifestError && e.code === 'NOT_FOUND') throw new ManifestError(`no such workspace: ${name}`, 'NOT_FOUND');
    throw e;
  }
  const dir = path.join(root, name);
  let st;
  try { st = fs.lstatSync(dir); } catch { throw new ManifestError(`no such workspace: ${name}`, 'NOT_FOUND'); }
  const shown = `workspaces/${archived ? `${ARCHIVE_DIR}/` : ''}${name}`;
  if (st.isSymbolicLink()) throw new ManifestError(`${shown} is a symlink, not a workspace folder`, 'UNSAFE');
  if (!st.isDirectory()) throw new ManifestError(`${shown} is not a folder`, 'UNSAFE');
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { /* unreadable: no entry matches */ }
  if (!entries.includes(name)) throw new ManifestError(`no such workspace: ${name} (names are matched exactly, as the folder is spelled)`, 'NOT_FOUND');
  let real;
  try { real = fs.realpathSync(dir); } catch { throw new ManifestError(`no such workspace: ${name}`, 'NOT_FOUND'); }
  if (path.dirname(real) !== root) throw new ManifestError(`workspaces/${name} resolves outside workspaces/`, 'UNSAFE');
  return real;
}

/** A folder a verb is about to read or write in, as lstat sees it now: a link swapped in since it was checked refuses. */
function plainDir(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { throw new ManifestError(`no such workspace folder: ${path.basename(String(dir))}`, 'NOT_FOUND'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ManifestError(`${path.basename(String(dir))} is no longer a plain folder: refusing to work through it`, 'UNSAFE');
  return path.resolve(dir);
}

/** sha256 hex of the file's bytes; 'none' for a missing file (the `--expect none` of a first write). */
function manifestHash(content) {
  if (content == null) return 'none';
  return crypto.createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')).digest('hex');
}

/**
 * workspace.md in `dir` (a workspace's real folder). Never follows a link: a symlinked workspace.md (dangling or not),
 * a folder, a file larger than 256 KB or one whose realpath is outside the folder comes back `refused` with the reason,
 * and no text. A missing file is `exists: false` with hash 'none'.
 */
function readManifest(dir) {
  // The folder as it is now (spaces-redesign §6): never re-resolved through a link that replaced it after workspaceDir.
  const base = plainDir(dir);
  let real;
  try { real = fs.realpathSync(base); } catch { throw new ManifestError(`no such workspace folder: ${path.basename(String(dir))}`, 'NOT_FOUND'); }
  const file = path.join(base, MANIFEST);
  const out = { file, exists: false, refused: null, text: null, hash: 'none', manifest: parseManifest(null) };
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    return { ...out, exists: true, refused: `${MANIFEST} cannot be read (${e && e.code})`, hash: null };
  }
  const refuse = (why) => ({ ...out, exists: true, refused: why, hash: null });
  if (st.isSymbolicLink()) return refuse(`${MANIFEST} is a symlink: refusing to read through it`);
  if (!st.isFile()) return refuse(`${MANIFEST} is not a regular file`);
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return refuse(`${MANIFEST} is not a regular file`);
    if (fst.size > MAX_READ) return refuse(`${MANIFEST} is larger than ${MAX_READ / 1024} KB`);
    if (!within(fs.realpathSync(file), real)) return refuse(`${MANIFEST} resolves outside the workspace`);
    const buf = fs.readFileSync(fd);
    const text = buf.toString('utf8');
    return { ...out, exists: true, text, hash: manifestHash(buf), manifest: parseManifest(text) };
  } catch (e) {
    if (e && e.code === 'ELOOP') return refuse(`${MANIFEST} is a symlink: refusing to read through it`);
    return refuse(`${MANIFEST} cannot be read (${(e && e.code) || 'error'})`);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

// ── writing ──

const PLAIN_UNSAFE_START = /^[-?:,[\]{}#&*!|>'"%@`\s]/;
// Words and numbers YAML would read as something other than this string.
const NON_STRING = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.(?:inf|nan))$/i;

/**
 * A string as a YAML scalar that parseManifest reads back exactly: plain when YAML reads it as the same string, else
 * double quotes when it has no `"` or `\`, else single quotes when it has no `'`. A string with both kinds of quote is
 * double-quoted as is: the parser (and the HUD's reader) strips the outer quotes without unescaping, so it still reads
 * back exactly, though a strict YAML reader would not take it.
 */
function scalar(s) {
  const v = String(s);
  if (v === '') return '""';
  const plain = !PLAIN_UNSAFE_START.test(v) && !/\s$/.test(v) && !/["']$/.test(v) && !/:(\s|$)|\s#/.test(v) && !NON_STRING.test(v);
  if (plain) return v;
  if (!/["\\]/.test(v)) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v}"`;
}

/** One value → its frontmatter lines (without line endings), or null to remove the key. */
function renderKey(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const items = value.filter((x) => x !== null && x !== undefined && String(x) !== '');
    if (!items.length) return null;
    return [`${key}:`, ...items.map((x) => `  - ${scalar(x)}`)];
  }
  if (typeof value === 'boolean') return [`${key}: ${value ? 'true' : 'false'}`];
  if (typeof value === 'number' && Number.isFinite(value)) return [`${key}: ${String(value)}`];
  if (typeof value === 'string') return [`${key}: ${scalar(value)}`];
  throw new ManifestError(`${key}: unsupported value type`);
}

/** `s` → [{ text, eol }] with each line's own ending kept; the last line's eol is ''. */
function splitLines(s) {
  const out = [];
  const re = /\r?\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) { out.push({ text: s.slice(last, m.index), eol: m[0] }); last = re.lastIndex; }
  out.push({ text: s.slice(last), eol: '' });
  return out;
}

// A top-level key line exactly as parseManifest matches one (`status:active` included).
const KEY_LINE = /^([A-Za-z0-9_-]+):/;
const LIST_LINE = /^\s*-(?:\s|$)/;
const INDENTED = /^\s+\S/;
const SKIPPABLE = (t) => !t.trim() || /^\s*#/.test(t);

/**
 * The frontmatter as the parser sees it (the same regex), else an empty `---\n---` block: { open, lines, after, eol }.
 * Every line carries its own ending (the last one the separator before the closing `---`), and `after` is everything
 * from the closing `---` on. null when there is none.
 */
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (m) {
    const open = text.startsWith('---\r\n') ? '---\r\n' : '---\n';
    const closeAt = m[0].length - 3;
    const lines = splitLines(text.slice(open.length, closeAt));
    lines.pop(); // the empty remainder after the last separator
    return { open, lines, after: text.slice(closeAt), eol: open.slice(3) };
  }
  const e = /^---(\r?\n)---/.exec(text);
  if (e) return { open: `---${e[1]}`, lines: [], after: text.slice(e[0].length - 3), eol: e[1] };
  return null;
}

// A key line that opens a block (no value, or a `|`/`>` block scalar): its indented lines, comments included, are its own.
const OPENS_BLOCK = /^[A-Za-z0-9_-]+:[ \t]*(?:[|>][-+0-9]*[ \t]*)?(?:#.*)?$/;

/** The index range [start, end) of each top-level occurrence of `key`: its line plus the list items, indented lines,
 *  blanks and comments that follow it, up to the next key or other line, without trailing blanks and comments. Under a
 *  key with a value on its line, an indented comment is a comment, not part of the value, and is kept. */
function spansOf(lines, key) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const k = KEY_LINE.exec(lines[i].text);
    if (!k || k[1] !== key) continue;
    const block = OPENS_BLOCK.test(lines[i].text);
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].text;
      if (KEY_LINE.test(t)) break;
      if (!block && /^\s+#/.test(t)) continue;
      if (LIST_LINE.test(t) || INDENTED.test(t)) { end = j + 1; continue; }
      if (SKIPPABLE(t)) continue;
      break;
    }
    spans.push([i, end]);
    i = end - 1;
  }
  return spans;
}

/**
 * workspace.md's text with `fields` set (spaces-redesign D13, D18): each key's lines replaced where the key first
 * appears, else appended after the frontmatter's last non-blank line; null, '' and [] remove it. Every other line
 * (unknown keys, comments, blank lines, each line's ending) and the body are kept byte for byte. A file with no
 * frontmatter gets one above its body; a frontmatter left empty is dropped. Throws a ManifestError for a bad key or a
 * control character.
 */
function setFields(text, fields) {
  const src = text == null ? '' : String(text);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new ManifestError('fields must be an object');
  for (const [key, value] of Object.entries(fields)) {
    if (!KEY_RE.test(key)) throw new ManifestError(`not a frontmatter key: ${JSON.stringify(key).slice(0, 40)}`);
    for (const s of Array.isArray(value) ? value : [value]) {
      if (typeof s === 'string' && CONTROL.test(s)) throw new ManifestError(`${key}: control characters are not allowed`);
    }
  }
  const fm = splitFrontmatter(src);
  const eol = fm ? fm.eol : (/\r\n/.test(src) ? '\r\n' : '\n');
  const lines = fm ? fm.lines.slice() : [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue; // not named: left as it is
    const rendered = renderKey(key, value);
    const fresh = rendered ? rendered.map((t) => ({ text: t, eol })) : [];
    const spans = spansOf(lines, key);
    if (!spans.length) {
      let at = lines.length;
      while (at > 0 && !lines[at - 1].text.trim()) at--;
      lines.splice(at, 0, ...fresh);
      continue;
    }
    for (let s = spans.length - 1; s >= 1; s--) lines.splice(spans[s][0], spans[s][1] - spans[s][0]);
    lines.splice(spans[0][0], spans[0][1] - spans[0][0], ...fresh);
  }
  const inner = lines.map((l) => l.text + l.eol).join('');
  if (!fm) return lines.length ? `---${eol}${inner}---${eol}${src}` : src;
  if (!lines.length && fm.lines.length) return fm.after.slice(3).replace(/^\r?\n/, '');
  return `${fm.open}${inner}${fm.after}`;
}

/** Write workspace.md atomically: a temp file opened exclusively, then rename, so a symlinked workspace.md is replaced
 *  by the file and its target never written (spaces-redesign §6). */
function writeManifest(dir, text) {
  // lstat right before the write, never realpath again: a folder swapped for a link meanwhile is refused (§6).
  const base = plainDir(dir);
  require('./fsx.js').writeAtomic(path.join(base, MANIFEST), String(text));
  return path.join(base, MANIFEST);
}

/**
 * `aos workspace set`: read (refusing a link or an unreadable file), compare `expect` with the file's hash ("workspace.md
 * changed: draft again"), merge `fields`, and write unless `dryRun` or nothing changed. Returns
 * { file, before, hash, changed, written, text, beforeText }: `text` is the exact file after the change and `beforeText`
 * the file as it was (null when there was none), so the Draft's preview can mark the lines that are new (D13).
 */
function setManifest(dir, fields, { expect = null, dryRun = false } = {}) {
  const cur = readManifest(dir);
  if (cur.refused) throw new ManifestError(cur.refused, 'UNSAFE');
  if (expect !== null && expect !== undefined && expect !== cur.hash) throw new ManifestError('workspace.md changed: draft again', 'CHANGED');
  const before = cur.text == null ? '' : cur.text;
  const text = setFields(cur.text, fields);
  const changed = text !== before;
  let written = false;
  if (changed && !dryRun) { writeManifest(dir, text); written = true; }
  return { file: cur.file, before: cur.hash, hash: changed ? manifestHash(text) : cur.hash, changed, written, text, beforeText: cur.exists ? before : null };
}

// ── `set` validation (spaces-redesign §6; Mechanics › PR 3 › Security) ──

const chars = (s) => Array.from(s).length;

/** The host config folders a `repo:` may neither sit in nor contain: Claude Code's and Codex's, through lib/host.js. */
function hostConfigDirs(userConfig) {
  const { hostDirs } = require('./host.js');
  const opts = userConfig === undefined ? {} : { userConfig };
  return [hostDirs('claude', opts).configDir, hostDirs('codex', opts).configDir];
}

/**
 * `--set <json>` → the fields setFields takes, or a ManifestError naming the first problem. Keys: status (active,
 * paused, done, or '' to clear it), pinned (a JSON boolean), objectives (≤ 20 strings of ≤ 200 characters; blank items
 * dropped), summary and next (≤ 500 characters; '' clears), repo (checked like repoPath: `~/…` or absolute, outside the
 * vault, an existing folder, not / or home, neither inside nor containing a host config folder; '' unlinks; written as
 * `~/…` under home). No value may hold a control character. ctx: { vault, home, configDirs, userConfig }.
 */
function validateSetFields(input, ctx = {}) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { throw new ManifestError('--set takes a JSON object'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ManifestError('--set takes a JSON object');
  const keys = Object.keys(obj);
  if (!keys.length) throw new ManifestError('--set names no key');
  const out = {};
  const str = (k, v, max) => {
    if (typeof v !== 'string') throw new ManifestError(`${k} must be a string`);
    if (CONTROL.test(v)) throw new ManifestError(`${k}: control characters are not allowed`);
    const t = v.trim();
    if (chars(t) > max) throw new ManifestError(`${k} is longer than ${max} characters`);
    return t;
  };
  for (const k of keys) {
    const v = obj[k];
    if (!SET_KEYS.includes(k)) throw new ManifestError(`unknown key "${String(k).slice(0, 40)}": set takes ${SET_KEYS.join(', ')}`);
    if (k === 'status') {
      if (typeof v !== 'string' || CONTROL.test(v) || (v !== '' && !STATUS_WORDS.includes(v))) {
        throw new ManifestError(`status must be one of ${STATUS_WORDS.join(', ')}, or "" to clear it`);
      }
      out.status = v || null;
    } else if (k === 'pinned') {
      if (typeof v !== 'boolean') throw new ManifestError('pinned must be true or false');
      out.pinned = v;
    } else if (k === 'objectives') {
      if (!Array.isArray(v)) throw new ManifestError('objectives must be a list of strings');
      if (v.length > LIMITS.objectives) throw new ManifestError(`objectives holds more than ${LIMITS.objectives} items`);
      out.objectives = v.map((x) => str('objectives', x, LIMITS.objective)).filter(Boolean);
    } else if (k === 'summary' || k === 'next') {
      out[k] = str(k, v, LIMITS[k]) || null;
    } else if (k === 'repo') {
      out.repo = checkRepo(str('repo', v, 4096), ctx);
    }
  }
  return out;
}

/** A `repo:` value → the form written (`~/…` under home, else absolute), null to unlink, or a ManifestError. */
function checkRepo(value, ctx) {
  if (!value) return null;
  const home = path.resolve(ctx.home || os.homedir());
  if (!ctx.vault) throw new ManifestError('repo: no vault to check against');
  const abs = repoPath(value, ctx.vault, home);
  if (!abs) throw new ManifestError('repo must be a folder outside the vault, as ~/… or a full path');
  if (abs === path.parse(abs).root) throw new ManifestError('repo cannot be the filesystem root');
  let st = null;
  try { st = fs.statSync(abs); } catch { /* missing */ }
  if (!st || !st.isDirectory()) throw new ManifestError('repo must be an existing folder');
  const own = spellings(abs);
  if (own.some((p) => spellings(home).includes(p))) throw new ManifestError('repo cannot be the home folder');
  if (own.some((p) => spellings(ctx.vault).some((v) => within(p, v) || within(v, p)))) {
    throw new ManifestError('repo must be a folder outside the vault, as ~/… or a full path');
  }
  const dirs = ctx.configDirs || hostConfigDirs(ctx.userConfig);
  for (const d of dirs.filter(Boolean)) {
    for (const c of spellings(d)) {
      if (own.some((p) => within(p, c) || within(c, p))) throw new ManifestError('repo cannot be inside or contain a host config folder');
    }
  }
  const rel = path.relative(home, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : abs;
}

module.exports = {
  MANIFEST, MAX_READ, SET_KEYS, STATUS_WORDS, LIMITS, CONTROL, WS_RE,
  ManifestError, parseManifest, listField, repoPath, workspacesRoot, workspaceDir, readManifest, manifestHash, setFields, scalar,
  validateSetFields, setManifest, writeManifest, hostConfigDirs,
};
