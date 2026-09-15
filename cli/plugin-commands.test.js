'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', 'plugin', 'commands');
const EXPECTED = ['remember', 'feedback', 'pattern', 'project', 'wrap', 'brain', 'scan', 'ask-brain', 'reflect-week',
  'consolidate-memory', 'compress', 'standup', 'cost', 'aos'];

test('exactly the 14 contract commands exist', () => {
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(), [...EXPECTED].sort());
});

test('every command has frontmatter with description and allowed-tools, and no absolute or owner paths', () => {
  for (const name of EXPECTED) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], /^description: .{10,}$/m, `${name}: description`);
    assert.match(fm[1], /^allowed-tools: /m, `${name}: allowed-tools`);
    assert.ok(!/\/home\/|~\/\.claude\/brain|\/usr\/local\/bin/.test(text), `${name}: hardcoded path`);
    assert.ok(!/qwen|ollama run|token-goblin/i.test(text), `${name}: model or owner tooling name`);
  }
});

test('script-driven commands name the launcher and its fallback', () => {
  for (const name of ['wrap', 'scan', 'ask-brain', 'reflect-week', 'consolidate-memory', 'compress', 'standup', 'cost', 'aos', 'project']) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    assert.match(text, /`aos [a-z-]+/, `${name}: aos call`);
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/aos/, `${name}: fallback`);
  }
  // The context-assembly commands pass $ARGUMENTS unquoted: Plan 2's parseMode matches `--local` only as a
  // whole argv token, so a quoted "$ARGUMENTS" would bury it inside the question.
  for (const name of ['ask-brain', 'reflect-week', 'consolidate-memory', 'compress', 'standup']) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    assert.ok(!/"\$ARGUMENTS"/.test(text), `${name}: $ARGUMENTS must not be quoted`);
  }
});

test('MCP tools use the plugin-prefixed names Claude Code exposes for a plugin-declared server', () => {
  // mcp__plugin_<plugin>_<server>__<tool> (contract §0); the bare mcp__agenticos__ form never matches allowed-tools.
  for (const name of ['wrap', 'ask-brain']) {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.match(fm[1], /^allowed-tools: .*mcp__plugin_agenticos_agenticos__/m, `${name}: prefixed MCP tool in allowed-tools`);
  }
  for (const name of EXPECTED) {
    assert.ok(!/mcp__agenticos__/.test(fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8')), `${name}: unprefixed MCP name`);
  }
});

test('the six plugin skills exist with frontmatter and are free of owner paths', () => {   // execution amendment 2026-09-15 (A32)
  const SK = path.resolve(__dirname, '..', 'plugin', 'skills');
  // final review Minor 18 (tests-12): iterating six names never catches a SEVENTH skill directory shipping
  // by accident — pin the directory listing itself.
  assert.deepEqual(
    fs.readdirSync(SK, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    ['cost', 'feedback-review', 'persona-flag-closer', 'persona-sitrep', 'recall', 'wrap'],
    'exactly six plugin skills ship');
  for (const name of ['recall', 'wrap', 'feedback-review', 'cost', 'persona-flag-closer', 'persona-sitrep']) {
    const text = fs.readFileSync(path.join(SK, name, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(fm[1], /^description: .{40,}/m);
    assert.ok(!/\/opt\/|\/home\/|\/usr\/local\/bin|~\/\.claude\/brain/.test(text), `${name}: hardcoded path`);
    assert.ok(!/qwen|token-goblin/i.test(text), `${name}: model or owner tooling name`);
  }
  assert.match(fs.readFileSync(path.join(SK, 'wrap', 'SKILL.md'), 'utf8'), /wrap_session/);
  assert.match(fs.readFileSync(path.join(SK, 'feedback-review', 'SKILL.md'), 'utf8'), /feedback_rules/);
  assert.match(fs.readFileSync(path.join(SK, 'cost', 'SKILL.md'), 'utf8'), /cost\.enabled/);
  // MCP tools are named as Claude Code exposes them for a plugin-declared server (contract §0).
  for (const name of ['recall', 'wrap', 'feedback-review']) {
    const text = fs.readFileSync(path.join(SK, name, 'SKILL.md'), 'utf8');
    assert.match(text, /mcp__plugin_agenticos_agenticos__/, `${name}: prefixed MCP tool name`);
    assert.ok(!/mcp__agenticos__/.test(text), `${name}: unprefixed MCP name`);
  }
});
