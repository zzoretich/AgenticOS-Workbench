'use strict';
/**
 * skill-translate.js — one user skill's SKILL.md, rewritten for the other session host (spec 2026-09-23-universal-skills
 * D4). Pure: text in, text out, no file access; lib/skills.js decides what to mirror and where.
 *
 *   toCodex(text, ctx)   a Claude Code skill → Codex. Codex requires `name` + `description`, so the frontmatter is
 *                        reduced to those two (a source without frontmatter is refused); `$ARGUMENTS`,
 *                        `${CLAUDE_SKILL_DIR}`, AskUserQuestion, "with the Read tool", "this Claude Code session" and
 *                        `/<skill>` for a skill Codex also has become their Codex wording.
 *   toClaude(text, ctx)  a Codex skill → Claude Code. The frontmatter is kept (Claude Code ignores keys it does not
 *                        know); `$<skill>` for a skill Claude Code also has → `/<skill>`; "this Codex session" → "this
 *                        Claude Code session".
 * ctx: { name, dir, source, names } — the mirror's skill name and folder, the source folder, and a Map from a
 * cross-reference as the source host writes it (no sigil) to the target host's form (no sigil).
 * Both add a one-line host note naming the source, so the model knows where the skill came from.
 */

const DESC_MAX = 1024;
const NAME_MAX = 64;
const ASK_NOTE = ' A question to the user is one message with its options numbered (where it says multiSelect, the user may pick several); wait for the reply before acting on it.';

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function unquote(s) {
  const t = (s || '').trim();
  if (/^"(.*)"$/s.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  if (/^'(.*)'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/**
 * { has, raw, body, fm: { name, description } }. `raw` is the text between the fences. Only `name` and `description`
 * are read: a block scalar (`>`/`|`) or an indented continuation joins its lines with spaces.
 */
function parse(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { has: false, raw: '', body: src, fm: {} };
  const raw = m[1];
  const fm = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):[ \t]*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    const block = /^[>|][-+]?$/.test(val);
    const buf = block ? [] : [val];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && !/^[ \t]/.test(lines[j])) break;
      buf.push(lines[j].trim());
    }
    val = buf.filter(Boolean).join(' ');
    fm[kv[1]] = block ? val : unquote(val);
  }
  return { has: true, raw, body: src.slice(m[0].length), fm };
}

/** The first line of prose in a body: a heading's text, else the first non-empty line that is not a comment. */
function firstProse(body) {
  for (const line of String(body || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('<!--') || t === '---') continue;
    return t.replace(/^#+\s*/, '').replace(/^>\s*/, '').trim();
  }
  return '';
}

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A name Codex accepts: lowercase letters, digits and hyphens, at most 64. '' when nothing usable is left. */
function codexName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX).replace(/-+$/, '');
}

/** A YAML scalar: plain when it cannot be misread, else double-quoted (JSON string escapes are valid YAML). */
function yamlScalar(s) {
  const t = String(s);
  if (/^[A-Za-z0-9(][^\n]*$/.test(t) && !/:\s|\s#|:$|["'`{}[\]|>&*!%@\\]/.test(t)) return t;
  return JSON.stringify(t);
}

/** `<sigil><ref>` for every known ref → `<to><target>`. A ref ends where a name cannot continue. */
function crossRefs(s, from, to, names) {
  if (!names || !names.size) return s;
  const keys = [...names.keys()].sort((a, b) => b.length - a.length).map(esc);
  const re = new RegExp(`(^|[\\s(\`"'])${esc(from)}(${keys.join('|')})(?![\\w/:-])`, 'gm');
  return s.replace(re, (m, pre, ref) => `${pre}${to}${names.get(ref)}`);
}

function claudeWording(s, ctx) {
  let out = s.replace(/\b(a|the|this|your|each|every) Claude Code session/gi, (m, det) => `${det} Codex session`);
  return crossRefs(out, '/', '$', ctx.names);
}

function codexWording(s, ctx) {
  const out = s.replace(/\b(a|the|this|your|each|every) Codex session/gi, (m, det) => `${det} Claude Code session`);
  return crossRefs(out, '$', '/', ctx.names);
}

/** The Claude Code idioms a skill body uses → their Codex wording. */
function claudeBodyToCodex(body, ctx) {
  const inv = `\`$${ctx.name}\``;
  let s = body;
  s = s.replace(/\$ARGUMENTS\[(\d+)\]/g, (m, i) => `word ${Number(i) + 1} of the text the user wrote after ${inv}`);
  s = s.replace(/\$ARGUMENTS\b/g, () => `the text the user wrote after ${inv}`);
  s = s.replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => ctx.dir);
  s = s.replace(/ with the (?:Read|Edit|Write|Glob|Grep) tool\b/g, '');
  s = s.replace(/\ban AskUserQuestion(?: tool)?(?: call)?\b/g, 'a question');
  s = s.replace(/\bAskUserQuestion(?: tool)?(?: call)?\b/g, 'question');
  return claudeWording(s, ctx);
}

/** { ok: true, name, content } or { ok: false, reason }. */
function toCodex(text, ctx) {
  const { has, body, fm } = parse(text);
  if (!has) return { ok: false, reason: 'no YAML frontmatter (Codex needs a name and a description)' };
  const name = codexName(ctx.name);
  if (!name) return { ok: false, reason: 'no name Codex accepts (lowercase letters, digits, hyphens)' };
  const description = clip(claudeWording(fm.description || firstProse(body), ctx), DESC_MAX);
  if (!description) return { ok: false, reason: 'no description' };
  const asks = /\bAskUserQuestion\b/.test(body);
  const note = `> Host: Codex CLI. Written for Claude Code; AgenticOS mirrors it from \`${ctx.source}\`, so edit that copy, not this one. Invoke as \`$${name}\`.${asks ? ASK_NOTE : ''}`;
  const out = claudeBodyToCodex(body, { ...ctx, name }).replace(/^\n+/, '');
  return { ok: true, name, content: `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${note}\n\n${out.endsWith('\n') ? out : `${out}\n`}` };
}

/** { ok: true, name, content } or { ok: false, reason }. */
function toClaude(text, ctx) {
  const { has, raw, body, fm } = parse(text);
  const name = String(ctx.name || '');
  if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(name)) return { ok: false, reason: 'no folder name Claude Code accepts' };
  const description = fm.description || firstProse(body);
  if (!description) return { ok: false, reason: 'no description' };
  const head = has ? codexWording(raw, ctx) : `name: ${name}\ndescription: ${yamlScalar(clip(description, DESC_MAX))}`;
  const note = `> Host: Claude Code. Written for Codex; AgenticOS mirrors it from \`${ctx.source}\`, so edit that copy, not this one. Invoke as \`/${name}\`.`;
  const out = codexWording(body, ctx).replace(/^\n+/, '');
  return { ok: true, name, content: `---\n${head}\n---\n\n${note}\n\n${out.endsWith('\n') ? out : `${out}\n`}` };
}

module.exports = { parse, firstProse, clip, codexName, yamlScalar, crossRefs, toCodex, toClaude, DESC_MAX, NAME_MAX };
