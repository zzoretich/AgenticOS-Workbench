'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { workingMemoryFromTranscript, describeFileHeuristic, insightHeuristic } = require('../lib/heuristics.js');

const user = (text, extra = {}) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] }, ...extra });
const toolUse = (name, file_path) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { file_path } }] } });
const assistant = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('workingMemoryFromTranscript: last N prompts, files touched, slash commands', () => {
  const lines = [];
  for (let i = 1; i <= 8; i++) lines.push(user(`prompt number ${i} ` + 'x'.repeat(200)));
  lines.push(user('<command-name>/wrap</command-name>\n<command-message>wrap</command-message>'));
  lines.push(user('meta line', { isMeta: true }));
  lines.push(toolUse('Edit', '/home/alice/proj/a.js'));
  lines.push(toolUse('Write', '/home/alice/proj/b.md'));
  lines.push(toolUse('Edit', '/home/alice/proj/a.js'));
  lines.push(toolUse('Bash', undefined));
  lines.push(assistant('done'));
  lines.push('not json at all');
  const { keyContext } = workingMemoryFromTranscript(lines.join('\n'));
  const asked = keyContext.filter((l) => l.startsWith('Asked: '));
  assert.equal(asked.length, 6);
  assert.match(asked[0], /prompt number 3/);
  assert.match(asked[5], /prompt number 8/);
  assert.ok(asked.every((l) => l.length <= 'Asked: '.length + 120), 'prompts trimmed to 120 chars');
  assert.ok(keyContext.includes('Files touched: a.js, b.md'));
  assert.ok(keyContext.includes('Commands: /wrap'));
  assert.ok(!keyContext.some((l) => /meta line/.test(l)));
});

test('workingMemoryFromTranscript: empty or dialogue-free input yields no bullets', () => {
  assert.deepEqual(workingMemoryFromTranscript(''), { keyContext: [] });
  assert.deepEqual(workingMemoryFromTranscript(assistant('hi')), { keyContext: [] });
});

test('describeFileHeuristic: H1 for markdown, doc comment or line comment for code, package description, extension label', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'heur-'));
  const w = (name, body) => { fs.writeFileSync(path.join(d, name), body); return path.join(d, name); };
  assert.equal(describeFileHeuristic(w('README.md', '# Alpha readme\n\nmore'), 'README.md'), 'Alpha readme');
  assert.equal(describeFileHeuristic(w('main.js', "'use strict';\n/**\n * main.js — starts the thing\n * more\n */\n"), 'src/main.js'), 'main.js — starts the thing');
  assert.equal(describeFileHeuristic(w('one.ts', '/** One-liner doc */\nexport const a = 1;\n'), 'one.ts'), 'One-liner doc');
  assert.equal(describeFileHeuristic(w('util.js', '// utility helpers for dates\nmodule.exports = {};\n'), 'util.js'), 'utility helpers for dates');
  assert.equal(describeFileHeuristic(w('run.sh', '#!/bin/sh\n# run the build\necho hi\n'), 'run.sh'), 'run the build');
  assert.equal(describeFileHeuristic(w('package.json', '{"name":"x","description":"A package"}'), 'package.json'), 'A package');
  assert.equal(describeFileHeuristic(w('plain.js', 'console.log(1)\n'), 'plain.js'), 'JavaScript file');
  assert.equal(describeFileHeuristic(w('data.csv', 'a,b\n1,2\n'), 'data.csv'), 'csv file');
  assert.equal(describeFileHeuristic(path.join(d, 'missing.py'), 'missing.py'), 'Python file');
});

test('insightHeuristic renders age, objectives, subprojects and next step', () => {
  assert.equal(insightHeuristic({ lastEvent: { ageDays: 12 }, objectives: [1, 2, 3], subprojects: [], next: { text: null } }),
    'Stalled 12d · 3 objectives open · next step unset');
  assert.equal(insightHeuristic({ lastEvent: { ageDays: 0 }, objectives: [], subprojects: [{}, {}], next: { text: 'Ship it' } }),
    'Active today · 0 objectives listed · 2 subprojects · next: Ship it');
  assert.equal(insightHeuristic({ lastEvent: { ageDays: 5 }, objectives: [1] }), 'Quiet 5d · 1 objective open · next step unset');
  assert.equal(insightHeuristic({}), 'No activity recorded · 0 objectives listed · next step unset');
});
