'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/agent-translate.js');

const ctx = (over = {}) => ({ source: '/src/agents/reviewer.md', sourceHash: 'h1', id: 'reviewer', ...over });
const claudeMd = (fm, body = '<role>\nReview the diff.\n</role>\n') => `---\n${fm}\n---\n\n${body}`;

test('parseToml: every string form, escapes, arrays, inline tables, scalars; tables and dotted keys noted', () => {
  const t = A.parseToml([
    '# a comment',
    'name = "pr_explorer"  # trailing comment',
    "lit = 'C:\\path\\no escapes'",
    'esc = "tab\\tquote\\" nl\\n uni\\u00e9 big\\U0001F600"',
    'ml = """',
    'first line',
    'has ""quotes"" and \\\\ backslash \\',
    '    continued"""',
    "mll = '''",
    "raw \\n kept'''",
    'arr = [ "a", \'b\',',
    '  "c", # inside',
    ']',
    'inline = { x = 1, "y z" = "w" }',
    'yes = true',
    'n = 1_000',
    'when = 2026-09-23',
    'skills.config = []',
    '[mcp_servers.docs]',
    'command = "docs"',
    '[[agents.list]]',
    'name = "under a table"',
    '',
  ].join('\n'));
  assert.equal(t.top.name, 'pr_explorer');
  assert.equal(t.top.lit, 'C:\\path\\no escapes');
  assert.equal(t.top.esc, 'tab\tquote" nl\n uni\u00e9 big\u{1F600}');
  assert.equal(t.top.ml, 'first line\nhas ""quotes"" and \\ backslash continued');
  assert.equal(t.top.mll, 'raw \\n kept');
  assert.deepEqual(t.top.arr, ['a', 'b', 'c']);
  assert.deepEqual(t.top.inline, { x: 1, 'y z': 'w' });
  assert.equal(t.top.yes, true);
  assert.equal(t.top.n, 1000);
  assert.equal(t.top.when, '2026-09-23');
  assert.deepEqual(t.dotted, ['skills.config']);
  assert.deepEqual(t.tables, ['mcp_servers.docs', 'agents.list']);
  assert.equal(Object.keys(t.top).includes('command'), false);
});

test('parseToml: a closing run of four or five quotes keeps the extra ones', () => {
  assert.equal(A.parseToml('a = """x""""\n').top.a, 'x"');
  assert.equal(A.parseToml("b = '''y'''''\n").top.b, "y''");
});

test('parseToml: malformed input throws with a line number', () => {
  assert.throws(() => A.parseToml('name = "open\n'), /line 1: unterminated string/);
  assert.throws(() => A.parseToml('a = 1\na = 2\n'), /line 2: duplicate key a/);
  assert.throws(() => A.parseToml('a = """never closed\n'), /unterminated multi-line/);
  assert.throws(() => A.parseToml('just words\n'), /expected =/);
  assert.throws(() => A.parseToml('a = "x" b\n'), /end of the line/);
  assert.throws(() => A.parseToml('a = "\\q"\n'), /bad escape/);
});

test('tomlString: round-trips quotes, backslashes, triple quotes and control characters', () => {
  const nasty = 'He said """hi""" \\ C:\\tmp\n\ttab\u0001bell\u007f end "';
  for (const multiline of [false, true]) {
    const out = A.tomlString(nasty, { multiline });
    assert.equal(A.parseToml(`v = ${out}\n`).top.v, nasty, `multiline=${multiline}`);
  }
  assert.equal(A.tomlString('one line', { multiline: true }), '"one line"');
  assert.equal(A.tomlString('a\r\nb'), '"a\\nb"');
});

test('readClaude: name, description, tools inline or as a list, model, keys; no frontmatter is refused', () => {
  const a = A.readClaude(claudeMd('name: reviewer\ndescription: Reviews diffs\ntools: Read, Grep, "Glob"\nmodel: sonnet\ncolor: cyan\n# hooks:\n#   x: y'));
  assert.equal(a.ok, true);
  assert.deepEqual([a.name, a.description, a.model], ['reviewer', 'Reviews diffs', 'sonnet']);
  assert.deepEqual(a.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(a.keys, ['name', 'description', 'tools', 'model', 'color']);
  assert.deepEqual(A.readClaude(claudeMd('name: x\ndescription: y\ntools:\n  - Read\n  - Bash(git:*)')).tools, ['Read', 'Bash(git:*)']);
  assert.deepEqual(A.readClaude(claudeMd('name: x\ndescription: y\ntools: [Read, Glob]')).tools, ['Read', 'Glob']);
  assert.equal(A.readClaude('# no frontmatter\n').ok, false);
});

test('isReadOnlyTools: read-only only when a list exists and nothing in it can write', () => {
  assert.equal(A.isReadOnlyTools(['Read', 'Grep', 'Glob', 'WebFetch', 'mcp__docs__*']), true);
  assert.equal(A.isReadOnlyTools(['Read', 'Bash(git:*)']), false);
  assert.equal(A.isReadOnlyTools(['Read', 'Edit']), false);
  assert.equal(A.isReadOnlyTools([]), false);
  assert.equal(A.isReadOnlyTools(null), false);
});

test('toCodex: name, description, read-only sandbox, host note, wording; model and colour left out and named', () => {
  const src = claudeMd('name: Reviewer\ndescription: Reviews diffs in this Claude Code session\ntools: Read, Grep\nmodel: opus\ncolor: red',
    'Read the diff with the Read tool.\nAsk with an AskUserQuestion call.\nStay in this Claude Code session.\n');
  const r = A.toCodex(A.readClaude(src), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.name, 'reviewer');
  assert.equal(r.readOnly, true);
  const t = A.readCodex(r.content);
  assert.equal(t.ok, true);
  assert.equal(t.name, 'reviewer');
  assert.equal(t.description, 'Reviews diffs in this Codex session');
  assert.equal(t.sandbox, 'read-only');
  assert.equal(t.model, '');
  assert.match(t.instructions, /^> Host: Codex\. This agent was written for Claude Code/);
  assert.match(t.instructions, /Read the diff\.\nAsk with a question\.\nStay in this Codex session\.\n$/);
  assert.match(r.content, /^# Mirrored by AgenticOS from \/src\/agents\/reviewer\.md\./);
  assert.match(r.content, /# Left out \(Claude Code only\): tools, model, color\. Codex runs it on your default model; its tool list cannot write, so it runs read-only\./);
});

test('toCodex: a writing tool list or none leaves the sandbox alone; refusals say why', () => {
  const rw = A.toCodex(A.readClaude(claudeMd('name: fixer\ndescription: Fixes\ntools: Read, Edit')), ctx());
  assert.equal(rw.readOnly, false);
  assert.doesNotMatch(rw.content, /sandbox_mode/);
  assert.doesNotMatch(A.toCodex(A.readClaude(claudeMd('name: plain\ndescription: Plain')), ctx()).content, /Left out/);
  assert.match(A.toCodex(A.readClaude(claudeMd('name: explorer\ndescription: x')), ctx()).reason, /replace Codex's built-in explorer/);
  assert.match(A.toCodex(A.readClaude(claudeMd('description: x')), ctx()).reason, /no name/);
  assert.match(A.toCodex(A.readClaude(claudeMd('name: x')), ctx()).reason, /no description/);
  assert.match(A.toCodex(A.readClaude(claudeMd('name: x\ndescription: y', '\n\n')), ctx()).reason, /body under the frontmatter is empty/);
  assert.match(A.toCodex(A.readClaude('no frontmatter'), ctx()).reason, /no YAML frontmatter/);
});

test('toClaude: underscores become hyphens, read-only becomes a read-only tool list, config keys left out and named', () => {
  const src = [
    'name = "pr_explorer"',
    'description = "Maps code paths: read-only"',
    'model = "gpt-5.5"',
    'model_reasoning_effort = "high"',
    'sandbox_mode = "read-only"',
    'nickname_candidates = ["Atlas"]',
    'developer_instructions = """',
    'Stay in this Codex session and use $review first.',
    '"""',
    '[mcp_servers.docs]',
    'url = "https://example.com/mcp"',
    '',
  ].join('\n');
  const r = A.toClaude(A.readCodex(src), ctx({ source: '/codex/agents/pr_explorer.toml' }));
  assert.equal(r.ok, true);
  assert.equal(r.name, 'pr-explorer');
  const a = A.readClaude(r.content);
  assert.equal(a.name, 'pr-explorer');
  assert.equal(a.description, 'Maps code paths: read-only');
  assert.deepEqual(a.tools, A.READ_ONLY_TOOLS.split(', '));
  assert.equal(a.model, null);
  assert.match(a.body, /^\n> Host: Claude Code\. This agent was written for Codex/);
  assert.match(a.body, /Stay in this Claude Code session and use \$review first\.\n$/);
  assert.match(r.content, /# Left out \(Codex only\): model, model_reasoning_effort, nickname_candidates, mcp_servers\./);
});

test('toClaude: refusals — reserved names, missing fields, broken TOML', () => {
  const t = (s) => A.toClaude(A.readCodex(s), ctx()).reason;
  assert.match(t('name = "general-purpose"\ndescription = "x"\ndeveloper_instructions = "y"\n'), /shadow Claude Code's built-in general-purpose/);
  assert.match(t('name = "Plan"\ndescription = "x"\ndeveloper_instructions = "y"\n'), /built-in plan/);
  assert.match(t('description = "x"\ndeveloper_instructions = "y"\n'), /no `name`/);
  assert.match(t('name = "a"\ndeveloper_instructions = "y"\n'), /no `description`/);
  assert.match(t('name = "a"\ndescription = "x"\n'), /no `developer_instructions`/);
  assert.match(t('name = "a\n'), /not valid TOML \(line 1/);
});

test('marker: found only where we put it, hash excludes the marker line, any edit breaks it', () => {
  const toml = A.toCodex(A.readClaude(claudeMd('name: a\ndescription: b')), ctx()).content;
  const md = A.toClaude(A.readCodex('name = "c"\ndescription = "d"\ndeveloper_instructions = "e"\n'), ctx()).content;
  for (const [text, kind] of [[toml, 'toml'], [md, 'md']]) {
    const m = A.readMarker(text, kind);
    assert.equal(m.meta.schema, 1);
    assert.equal(m.meta.sourceHash, 'h1');
    assert.equal(A.sha(m.unmarked), m.meta.writtenHash);
    assert.equal(A.isPristine(text, kind), true);
    assert.equal(A.isPristine(`${text}\nedited\n`, kind), false);
  }
  assert.equal(A.readMarker(toml, 'toml').meta.from, 'claude');
  assert.equal(A.readMarker(md, 'md').meta.from, 'codex');
  // A marker-looking line in an agent's body, or after the first TOML key, is not ours.
  assert.equal(A.readMarker(claudeMd('name: a\ndescription: b', '# aos-mirror: {"id":"x"}\n'), 'md'), null);
  assert.equal(A.readMarker('name = "a"\n# aos-mirror: {"id":"x"}\n', 'toml'), null);
  assert.equal(A.readMarker('# aos-mirror: not json\nname = "a"\n', 'toml'), null);
});

test('sameInstructions: the same prompt by hand on both hosts, host wording aside', () => {
  const c = A.readClaude(claudeMd('name: a\ndescription: b', 'Do it in this Claude Code session.\n'));
  const x = A.readCodex('name = "a"\ndescription = "b"\ndeveloper_instructions = """\nDo it in this Codex session.\n"""\n');
  assert.equal(A.sameInstructions(c, x), true);
  assert.equal(A.sameInstructions(c, A.readCodex('name = "a"\ndescription = "b"\ndeveloper_instructions = "Other"\n')), false);
});
