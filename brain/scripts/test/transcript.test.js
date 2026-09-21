'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { detectFormat, parseJsonl, readTurns, readTranscriptFile, flattenTurns, parseEntries } = require('../lib/transcript.js');

const CODEX_FIXTURE = path.join(__dirname, 'fixtures', 'codex-rollout.jsonl');

const CLAUDE = [
  { type: 'user', message: { content: 'Fix the parser' } },
  { type: 'user', isMeta: true, message: { content: '<command-name>/wrap</command-name>' } },
  { type: 'assistant', message: { content: [
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/home/demo/proj/a.js' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/home/demo/proj/a.js' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
].map((e) => JSON.stringify(e)).join('\n');

test('detectFormat tells the two envelopes apart and defaults to claude', () => {
  assert.equal(detectFormat(parseJsonl(CLAUDE)), 'claude');
  assert.equal(detectFormat(parseJsonl(fs.readFileSync(CODEX_FIXTURE, 'utf8'))), 'codex');
  assert.equal(detectFormat([]), 'claude');
  assert.equal(detectFormat([{ type: 'event_msg', payload: { type: 'token_count' } }]), 'codex');
});

test('claude: every user entry counts as a turn, tool uses carry a kind and a file path', () => {
  const p = readTurns(CLAUDE);
  assert.equal(p.format, 'claude');
  assert.equal(p.userTurns, 3);
  assert.deepEqual(p.turns.map((t) => t.role), ['user', 'user', 'assistant', 'user']);
  assert.equal(p.turns[1].meta, true);
  assert.deepEqual(p.toolUses, [
    { name: 'Read', kind: 'read', filePath: '/home/demo/proj/a.js' },
    { name: 'Edit', kind: 'edit', filePath: '/home/demo/proj/a.js' },
    { name: 'Bash', kind: 'bash', filePath: null },
  ]);
  assert.equal(p.usage, null);
});

test('codex: developer and environment messages are skipped, tool activity comes from event_msg records', () => {
  const p = readTranscriptFile(CODEX_FIXTURE);
  assert.equal(p.format, 'codex');
  assert.equal(p.userTurns, 2);
  assert.deepEqual(p.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(p.turns[0].text, /^Run echo spike/);
  assert.ok(!p.turns.some((t) => /SPIKE-CONTEXT|environment_context|permissions/.test(t.text)));
  assert.deepEqual(p.toolUses, [
    { name: 'Bash', kind: 'bash', filePath: null },
    { name: 'apply_patch', kind: 'edit', filePath: '/home/demo/proj/note.txt' },
    { name: 'apply_patch', kind: 'edit', filePath: '/home/demo/proj/README.md' },
    { name: 'mcp__agenticos__memory_list', kind: 'mcp', filePath: null },
  ]);
  // the last token_count wins: it is the running total for the session
  assert.deepEqual(p.usage, { inputTokens: 56562, cachedInputTokens: 48384, outputTokens: 420, reasoningOutputTokens: 185, totalTokens: 56982 });
  assert.equal(p.meta.id, '01a0c5bc-1191-77f3-b185-31f412027020');
  assert.equal(p.meta.cliVersion, '0.144.5');
});

test('flattenTurns yields role: text lines without meta or empty turns', () => {
  const lines = flattenTurns(readTurns(CLAUDE)).split('\n');
  assert.deepEqual(lines, ['user: Fix the parser', 'assistant: On it.']);
  const codex = flattenTurns(readTranscriptFile(CODEX_FIXTURE), { maxChars: 20 }).split('\n');
  assert.equal(codex.length, 4);
  assert.equal(codex[0], 'user: Run echo spike, then');
});

test('parseEntries tolerates garbage and a missing file', () => {
  assert.equal(parseEntries(null).userTurns, 0);
  assert.equal(parseEntries([null, 1, 'x', {}]).turns.length, 0);
  assert.equal(readTranscriptFile('/nonexistent/path.jsonl').format, 'claude');
  assert.equal(readTurns('not json\n{"type":"user","message":{"content":"hi"}}\n').userTurns, 1);
});
