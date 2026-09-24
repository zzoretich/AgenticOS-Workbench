'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/skill-translate.js');

const ctx = (over = {}) => ({ name: 'deploy', dir: '/mirror/deploy', source: '/src/deploy', names: new Map(), ...over });

test('parse: name and description, block scalars, quotes, continuation lines; no frontmatter', () => {
  const p = T.parse('---\nname: a\ndescription: >\n  first line\n  second line\nallowed-tools: Bash\n---\n# Body\n');
  assert.equal(p.has, true);
  assert.deepEqual(p.fm, { name: 'a', description: 'first line second line' });
  assert.equal(p.body, '# Body\n');
  assert.equal(T.parse('---\nname: "q: x"\ndescription: \'it\'\'s\'\n---\n').fm.name, 'q: x');
  assert.equal(T.parse('---\nname: "q: x"\ndescription: \'it\'\'s\'\n---\n').fm.description, "it's");
  assert.equal(T.parse('---\ndescription: one\n  two\n---\n').fm.description, 'one two');
  const none = T.parse('# Just a body\n');
  assert.equal(none.has, false);
  assert.equal(none.body, '# Just a body\n');
});

test('codexName: lowercase letters, digits, hyphens, at most 64', () => {
  assert.equal(T.codexName('AgenticOS-New-Feature'), 'agenticos-new-feature');
  assert.equal(T.codexName('my_skill.v2'), 'my-skill-v2');
  assert.equal(T.codexName('--x--'), 'x');
  assert.equal(T.codexName('___'), '');
  assert.equal(T.codexName('a'.repeat(80)).length, 64);
});

test('yamlScalar: plain when safe, JSON-quoted otherwise', () => {
  assert.equal(T.yamlScalar('Deploy the app'), 'Deploy the app');
  assert.equal(T.yamlScalar('Use when: deploying'), '"Use when: deploying"');
  assert.equal(T.yamlScalar('"quoted"'), '"\\"quoted\\""');
  assert.equal(T.yamlScalar('- dash first'), '"- dash first"');
});

test('toCodex: frontmatter reduced to name + description, every Claude idiom translated', () => {
  const src = [
    '---', 'name: Deploy', 'description: Ship it. Use /review first.', 'allowed-tools: Bash, Read', 'argument-hint: <env>', '---',
    '# Deploy', '',
    'Target: $ARGUMENTS. First word: $ARGUMENTS[0].',
    'Run `${CLAUDE_SKILL_DIR}/scripts/go.sh`.',
    'Read the plan with the Read tool.',
    'Ask with an AskUserQuestion call.',
    'Stay in this Claude Code session. An interactive Claude Code session is different.',
    'Then run /review, not /unknown.', '',
  ].join('\n');
  const r = T.toCodex(src, ctx({ names: new Map([['review', 'review']]) }));
  assert.equal(r.ok, true);
  assert.equal(r.name, 'deploy');
  const [, head, body] = r.content.split('---\n');
  assert.equal(head, 'name: deploy\ndescription: Ship it. Use $review first.\n');
  assert.match(body, /^\n> Host: Codex CLI\. Written for Claude Code; AgenticOS mirrors it from `\/src\/deploy`/);
  assert.match(body, /Invoke as `\$deploy`\. A question to the user is one message/);
  assert.match(body, /Target: the text the user wrote after `\$deploy`\. First word: word 1 of the text the user wrote after `\$deploy`\./);
  assert.match(body, /Run `\/mirror\/deploy\/scripts\/go\.sh`\./);
  assert.match(body, /Read the plan\./);
  assert.match(body, /Ask with a question\./);
  assert.match(body, /Stay in this Codex session\. An interactive Claude Code session is different\./);
  assert.match(body, /Then run \$review, not \/unknown\./);
  assert.doesNotMatch(r.content, /allowed-tools|argument-hint/);
  assert.ok(r.content.endsWith('\n'));
});

test('toCodex: description falls back to the first prose line and is clipped; refusals', () => {
  const r = T.toCodex('---\nname: x\n---\n\n# Heading as description\n\nbody', ctx({ name: 'x' }));
  assert.equal(r.ok, true);
  assert.match(r.content, /^---\nname: x\ndescription: Heading as description\n---/);
  const long = T.toCodex(`---\nname: x\ndescription: ${'a'.repeat(2000)}\n---\nbody`, ctx({ name: 'x' }));
  assert.equal(long.content.split('\n')[2].length, 'description: '.length + T.DESC_MAX);
  assert.deepEqual(T.toCodex('/some/path/only', ctx()), { ok: false, reason: 'no YAML frontmatter (Codex needs a name and a description)' });
  assert.equal(T.toCodex('---\nname: x\n---\n', ctx({ name: 'x' })).reason, 'no description');
  assert.equal(T.toCodex('---\nname: ___\ndescription: d\n---\n', ctx({ name: '___' })).ok, false);
});

test('toClaude: frontmatter kept, $<skill> and "this Codex session" translated', () => {
  const src = '---\nname: triage\ndescription: Triage, then hand to $fix.\nmetadata:\n  short-description: t\n---\n\nIn this Codex session, call $fix and $agenticos:wrap; leave $HOME alone.\n';
  const names = new Map([['fix', 'fix'], ['agenticos:wrap', 'agenticos:wrap']]);
  const r = T.toClaude(src, { name: 'triage', dir: '/c/triage', source: '/x/triage', names });
  assert.equal(r.ok, true);
  assert.match(r.content, /^---\nname: triage\ndescription: Triage, then hand to \/fix\.\nmetadata:\n  short-description: t\n---\n\n> Host: Claude Code\. Written for Codex; AgenticOS mirrors it from `\/x\/triage`/);
  assert.match(r.content, /In this Claude Code session, call \/fix and \/agenticos:wrap; leave \$HOME alone\./);
  assert.equal(T.toClaude(src, { name: '../evil', names }).ok, false);
});

test('crossRefs: longest name first, and a name ends where it cannot continue', () => {
  const names = new Map([['gsd', 'gsd'], ['gsd-plan', 'gsd-plan']]);
  assert.equal(T.crossRefs('run /gsd-plan and /gsd then /gsdx or a/gsd path', '/', '$', names), 'run $gsd-plan and $gsd then /gsdx or a/gsd path');
  assert.equal(T.crossRefs('(`/gsd`)', '/', '$', names), '(`$gsd`)');
  assert.equal(T.crossRefs('x', '/', '$', new Map()), 'x');
});
