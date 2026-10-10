'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectFormat, parseJsonl, readTurns, readTranscriptFile, flattenTurns, parseEntries, isRealPrompt } = require('../lib/transcript.js');

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

test('sessionModel: Claude assistant message.model, Codex turn_context / session_meta model, null otherwise (codex-parity D6)', () => {
  const { sessionModel, sessionModelFile } = require('../lib/transcript.js');
  const claude = [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-x-1', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-x-2', content: 'later' } },
  ];
  assert.equal(sessionModel(claude), 'claude-x-1');
  assert.equal(sessionModel([{ type: 'user', message: { content: 'hi' } }]), null);
  const codex = [
    { type: 'session_meta', payload: { id: 's1', cwd: '/w' } },
    { type: 'turn_context', payload: { cwd: '/w', model: 'gpt-5-codex' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ];
  assert.equal(sessionModel(codex), 'gpt-5-codex');
  assert.equal(sessionModel([{ type: 'session_meta', payload: { id: 's1', model: 'gpt-meta' } }]), 'gpt-meta');
  assert.equal(sessionModel([{ type: 'session_meta', payload: { id: 's1' } }]), null);
  assert.equal(sessionModel(null), null);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-model-')), 'x.jsonl');
  fs.writeFileSync(f, claude.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(sessionModelFile(f), 'claude-x-1');
  assert.equal(sessionModelFile(path.join(path.dirname(f), 'missing.jsonl')), null);
  assert.equal(sessionModelFile(''), null);
});

test('prompts counts only what the user typed, on both hosts (summary-throttle D1)', () => {
  const claude = readTurns(CLAUDE);
  assert.equal(claude.prompts, 1, 'the isMeta command envelope and the tool result are not prompts');
  assert.equal(claude.userTurns, 3, 'userTurns keeps its meaning');
  assert.equal(readTranscriptFile(CODEX_FIXTURE).prompts, 2);
  assert.equal(parseEntries([]).prompts, 0);
});

test('isRealPrompt skips envelopes, tool results and non-user turns', () => {
  assert.equal(isRealPrompt({ role: 'user', text: 'Fix the parser', meta: false }), true);
  assert.equal(isRealPrompt({ role: 'user', text: '<command-name>/clear</command-name>', meta: false }), false);
  assert.equal(isRealPrompt({ role: 'user', text: '<local-command-stdout>done</local-command-stdout>', meta: false }), false);
  assert.equal(isRealPrompt({ role: 'user', text: '   ', meta: false }), false, 'a tool_result-only entry flattens to blank');
  assert.equal(isRealPrompt({ role: 'user', text: 'hi', meta: true }), false);
  assert.equal(isRealPrompt({ role: 'assistant', text: 'On it.', meta: false }), false);
  assert.equal(isRealPrompt(null), false);
});

// ── The session-index seams (spaces-redesign D20, D25) ──────────────────────────────────────────────────────────

const { sessionHead, sessionTail, fileTouches, readSessionIndex } = require('../lib/transcript.js');

const CLAUDE_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const CODEX_ID = '01a0d2c4-1191-77f3-b185-31f412027aaa';
const PARENT_ID = '01a0d2c4-1191-77f3-b185-31f412027bbb';

function seamDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-seams-')); }
function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const pad = (n) => 'x'.repeat(n);
const ts = (s) => `2026-10-0${s}T10:00:00.000Z`;

let entrySeq = 0;
function claudeEntry(type, extra = {}) {
  return { parentUuid: null, isSidechain: false, type, uuid: `u-${++entrySeq}`, timestamp: ts(2), entrypoint: 'cli', cwd: '/w/vault/workspaces/demo', sessionId: CLAUDE_ID, version: '2.0.0', ...extra };
}

test('sessionHead (claude): an agent-setting first line, the cwd found past 64 KB within 256 KB, kind from the entrypoint', () => {
  const dir = seamDir();
  const file = writeJsonl(path.join(dir, `${CLAUDE_ID}.jsonl`), [
    { type: 'agent-setting', agentSetting: 'default', sessionId: CLAUDE_ID },
    { type: 'ai-title', aiTitle: 'Generated title', sessionId: CLAUDE_ID },
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(1), sessionId: CLAUDE_ID, content: pad(100 * 1024) },
    claudeEntry('user', { isMeta: true, message: { role: 'user', content: '<command-name>/wrap</command-name>' } }),
    claudeEntry('user', { message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    claudeEntry('user', { message: { role: 'user', content: [{ type: 'text', text: `  Fix the   parser ${pad(200)}` }] } }),
  ]);
  const head = sessionHead(file);
  assert.equal(head.format, 'claude');
  assert.equal(head.id, CLAUDE_ID);
  assert.equal(head.startCwd, '/w/vault/workspaces/demo', 'the first line carries no cwd: the head keeps reading');
  assert.equal(head.startedAt, ts(1), 'the first timestamp, even on a line with no cwd');
  assert.equal(head.kind, 'interactive');
  assert.equal(head.parentId, null);
  assert.equal(head.title, 'Generated title');
  assert.equal(head.titleSource, 'ai');
  assert.equal(head.firstPrompt, `Fix the parser ${pad(65)}`, 'envelopes and isMeta skipped, whitespace collapsed, cut to 80 characters');
  assert.equal(head.firstPrompt.length, 80);
  const short = sessionHead(file, 64 * 1024);
  assert.equal(short.startCwd, null, 'a 64 KB head stops inside the long queue line');
  assert.equal(short.id, CLAUDE_ID);
});

test('sessionHead (claude): an sdk-* entrypoint is headless; a custom title beats an ai one', () => {
  const dir = seamDir();
  const file = writeJsonl(path.join(dir, `${CLAUDE_ID}.jsonl`), [
    { type: 'custom-title', customTitle: 'My rename', sessionId: CLAUDE_ID },
    { type: 'ai-title', aiTitle: 'Generated', sessionId: CLAUDE_ID },
    claudeEntry('user', { entrypoint: 'sdk-cli', message: { role: 'user', content: 'Summarize the run' } }),
  ]);
  const head = sessionHead(file);
  assert.equal(head.kind, 'headless');
  assert.equal(head.title, 'My rename');
  assert.equal(head.titleSource, 'custom');
  assert.equal(head.firstPrompt, 'Summarize the run');
});

test('sessionTail (claude): a title more than 64 KB from the end is found by growing to 256 KB; lastAt is the newest timestamp', () => {
  const dir = seamDir();
  const filler = [];
  for (let i = 0; i < 10; i++) filler.push(claudeEntry('assistant', { timestamp: `2026-10-03T10:00:0${i}.000Z`, message: { role: 'assistant', content: pad(10 * 1024) } }));
  const file = writeJsonl(path.join(dir, `${CLAUDE_ID}.jsonl`), [
    { type: 'custom-title', customTitle: 'Old name', sessionId: CLAUDE_ID },
    claudeEntry('user', { message: { role: 'user', content: pad(300 * 1024) } }),
    { type: 'ai-title', aiTitle: 'Generated later', sessionId: CLAUDE_ID },
    { type: 'custom-title', customTitle: 'Renamed', sessionId: CLAUDE_ID },
    ...filler,
  ]);
  const tail = sessionTail(file);
  assert.equal(tail.title, 'Renamed', 'the last custom title, about 100 KB from the end');
  assert.equal(tail.titleSource, 'custom');
  assert.equal(tail.lastAt, '2026-10-03T10:00:09.000Z');

  const aiOnly = writeJsonl(path.join(dir, 'ai.jsonl'), [
    { type: 'ai-title', aiTitle: 'First guess', sessionId: CLAUDE_ID },
    { type: 'ai-title', aiTitle: 'Second guess', sessionId: CLAUDE_ID },
    claudeEntry('user', { message: { role: 'user', content: 'hi' } }),
  ]);
  assert.deepEqual(sessionTail(aiOnly), { title: 'Second guess', titleSource: 'ai', lastAt: ts(2) });

  const far = writeJsonl(path.join(dir, 'far.jsonl'), [
    { type: 'custom-title', customTitle: 'Too far back', sessionId: CLAUDE_ID },
    claudeEntry('user', { message: { role: 'user', content: pad(300 * 1024) } }),
  ]);
  const t = sessionTail(far);
  assert.equal(t.title, null, 'past 256 KB the tail gives up: the head title is the fallback');
  assert.equal(t.titleSource, null);
  assert.equal(sessionHead(far).title, 'Too far back');
});

test('sessionTail: a file with no timestamps falls back to its mtime; a missing file is null', () => {
  const dir = seamDir();
  const file = writeJsonl(path.join(dir, 'x.jsonl'), [{ type: 'agent-setting', agentSetting: 'default', sessionId: CLAUDE_ID }]);
  const when = new Date('2026-10-04T08:00:00.000Z');
  fs.utimesSync(file, when, when);
  assert.deepEqual(sessionTail(file), { title: null, titleSource: null, lastAt: when.toISOString() });
  assert.equal(sessionTail(path.join(dir, 'missing.jsonl')), null);
  assert.equal(sessionHead(path.join(dir, 'missing.jsonl')), null);
  assert.equal(fileTouches(path.join(dir, 'missing.jsonl')), null);
});

function codexMeta(source, extra = {}) {
  return { timestamp: '2026-10-05T09:00:01.000Z', type: 'session_meta', payload: { id: CODEX_ID, timestamp: '2026-10-05T09:00:00.000Z', cwd: '/w/vault/workspaces/demo', originator: 'codex-tui', cli_version: '0.158.0', source, ...extra } };
}
const codexUser = (text, at = '2026-10-05T09:00:02.000Z') => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const codexFile = (dir, entries, id = CODEX_ID) => writeJsonl(path.join(dir, 'sessions', '2026', '10', '05', `rollout-2026-10-05T09-00-00-${id}.jsonl`), entries);

test('sessionHead (codex): a session_meta line over 64 KB, the first real prompt after the injected context', () => {
  const dir = seamDir();
  const file = codexFile(dir, [
    codexMeta('cli', { base_instructions: { text: pad(100 * 1024) } }),
    { timestamp: '2026-10-05T09:00:01.500Z', type: 'turn_context', payload: { turn_id: 't1', cwd: '/w/vault/workspaces/demo' } },
    codexUser('<environment_context>\n  <cwd>/w</cwd>\n</environment_context>'),
    codexUser('<recommended_plugins>\nnone\n</recommended_plugins>'),
    codexUser('# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>be brief</INSTRUCTIONS>'),
    codexUser('Wire the   seams'),
  ]);
  assert.ok(fs.readFileSync(file, 'utf8').indexOf('\n') > 64 * 1024, 'the first line is longer than the old 64 KB cap');
  const head = sessionHead(file);
  assert.deepEqual(head, {
    format: 'codex', id: CODEX_ID, startCwd: '/w/vault/workspaces/demo', startedAt: '2026-10-05T09:00:00.000Z',
    kind: 'interactive', parentId: null, subagent: null, title: null, titleSource: null, firstPrompt: 'Wire the seams',
  });
  assert.equal(sessionHead(file, 64 * 1024).id, null, 'a 64 KB head cannot parse it');
});

test('sessionHead (codex): exec is headless, vscode interactive, a thread_spawn subagent names its parent, a guardian has none', () => {
  const dir = seamDir();
  assert.equal(sessionHead(codexFile(dir, [codexMeta('exec')])).kind, 'headless');
  assert.equal(sessionHead(codexFile(dir, [codexMeta('vscode')])).kind, 'interactive');
  const spawn = sessionHead(codexFile(dir, [codexMeta({ subagent: { thread_spawn: { parent_thread_id: PARENT_ID, depth: 1, agent_path: '/root/audit', agent_nickname: 'Scout', agent_role: null } } }, { parent_thread_id: PARENT_ID, forked_from_id: PARENT_ID })]));
  assert.equal(spawn.kind, 'subagent');
  assert.equal(spawn.subagent, 'thread_spawn');
  assert.equal(spawn.parentId, PARENT_ID, 'folded into its parent');
  const guardian = sessionHead(codexFile(dir, [codexMeta({ subagent: { other: 'guardian' } }, { parent_thread_id: PARENT_ID })]));
  assert.equal(guardian.kind, 'subagent');
  assert.equal(guardian.subagent, 'guardian');
  assert.equal(guardian.parentId, null, 'not a thread of its own: dropped by the collector');
  assert.equal(sessionHead(codexFile(dir, [codexMeta({ subagent: 'review' })])).subagent, 'review');
});

test('sessionHead (codex): only the first session_meta counts in a forked rollout; the turn cwd stands in for a missing meta cwd', () => {
  const dir = seamDir();
  const forked = codexFile(dir, [
    codexMeta('vscode', { forked_from_id: PARENT_ID }),
    { timestamp: '2026-10-05T09:00:01.000Z', type: 'session_meta', payload: { id: PARENT_ID, cwd: '/elsewhere', source: 'exec' } },
  ]);
  const head = sessionHead(forked);
  assert.equal(head.id, CODEX_ID);
  assert.equal(head.startCwd, '/w/vault/workspaces/demo');
  assert.equal(head.kind, 'interactive');
  const noCwd = codexFile(dir, [
    { timestamp: '2026-10-05T09:00:01.000Z', type: 'session_meta', payload: { id: CODEX_ID, source: 'cli' } },
    { timestamp: '2026-10-05T09:00:02.000Z', type: 'turn_context', payload: { cwd: '/w/turn' } },
  ]);
  assert.equal(sessionHead(noCwd).startCwd, '/w/turn');
  assert.equal(sessionHead(noCwd).startedAt, '2026-10-05T09:00:01.000Z');
  // the fixture (an exec run) through the same reader
  const fx = sessionHead(CODEX_FIXTURE);
  assert.equal(fx.kind, 'headless');
  assert.equal(fx.firstPrompt, 'Run echo spike, then create note.txt containing hello, then call memory_list.');
});

test('sessionTail (codex): no title in a rollout, lastAt from the newest record', () => {
  assert.deepEqual(sessionTail(CODEX_FIXTURE), { title: null, titleSource: null, lastAt: '2026-09-21T20:50:56.500Z' });
});

test('fileTouches (claude): FILE_TOOLS paths and each entry cwd; Bash carries none; offsets read only what was appended', () => {
  const dir = seamDir();
  const ws = '/w/vault/workspaces/demo';
  const file = writeJsonl(path.join(dir, `${CLAUDE_ID}.jsonl`), [
    { type: 'agent-setting', agentSetting: 'default', sessionId: CLAUDE_ID },
    claudeEntry('user', { cwd: '/w/vault', message: { role: 'user', content: 'edit the demo notes' } }),
    claudeEntry('assistant', { cwd: '/w/vault', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: `${ws}/notes.md` } },
      { type: 'tool_use', name: 'Edit', input: { file_path: `${ws}/notes.md` } },
      { type: 'tool_use', name: 'Write', input: { file_path: `${ws}/plan.md` } },
      { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: `${ws}/a.ipynb` } },
      { type: 'tool_use', name: 'Bash', input: { command: `cat ${ws}/secret.md` } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'x', path: ws } },
    ] } }),
  ]);
  const first = fileTouches(file);
  assert.deepEqual(first.touches, { '/w/vault': 2, [`${ws}/notes.md`]: 2, [`${ws}/plan.md`]: 1, [`${ws}/a.ipynb`]: 1 });
  assert.equal(first.offset, fs.statSync(file).size);
  assert.equal(first.cwd, '/w/vault');
  assert.equal(first.reset, false);

  // a line still being written is left for the next read
  const more = JSON.stringify(claudeEntry('assistant', { cwd: ws, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'MultiEdit', input: { file_path: 'plan.md' } }] } }));
  fs.appendFileSync(file, more.slice(0, 40));
  const partial = fileTouches(file, first.offset, { cwd: first.cwd });
  assert.deepEqual(partial.touches, {});
  assert.equal(partial.offset, first.offset);
  fs.appendFileSync(file, more.slice(40) + '\n');
  const next = fileTouches(file, partial.offset, { cwd: partial.cwd });
  assert.deepEqual(next.touches, { [ws]: 1, [`${ws}/plan.md`]: 1 }, 'a relative path resolves against the entry cwd');
  assert.equal(next.offset, fs.statSync(file).size);

  const again = fileTouches(file, fs.statSync(file).size + 10);
  assert.equal(again.reset, true, 'an offset past the end means the file was rewritten: read it all again');
  assert.equal(again.touches[`${ws}/notes.md`], 2);
});

test('fileTouches (codex): turn_context cwd, patch_apply_end and FileChange changes, relative keys, one count per call', () => {
  const fx = fileTouches(CODEX_FIXTURE);
  assert.deepEqual(fx.touches, { '/home/demo/proj': 1, '/home/demo/proj/note.txt': 1, '/home/demo/proj/README.md': 1 }, 'exec_command_end carries no path');
  const dir = seamDir();
  const ws = '/w/vault/workspaces/demo';
  const file = codexFile(dir, [
    codexMeta('cli', { cwd: '/w/vault' }),
    { timestamp: 't', type: 'turn_context', payload: { turn_id: 't1', cwd: '/w/vault' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c1', success: true, changes: { [`${ws}/a.md`]: { type: 'update' }, 'workspaces/demo/b.md': { type: 'add' } } } },
    { timestamp: 't', type: 'turn_context', payload: { turn_id: 't2', cwd: ws } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', thread_id: CODEX_ID, turn_id: 't2', item: { type: 'FileChange', id: 'c2', changes: { [`${ws}/a.md`]: { type: 'update' }, 'c.md': { type: 'add' } }, status: 'completed' } } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c2', changes: { [`${ws}/a.md`]: { type: 'update' } } } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'c3', command: 'cat x', cwd: '/w/other' } } },
  ]);
  const r = fileTouches(file);
  assert.deepEqual(r.touches, {
    '/w/vault': 1,
    [`${ws}/a.md`]: 2,
    [`${ws}/b.md`]: 1,
    [ws]: 1,
    [`${ws}/c.md`]: 1,
  }, 'the same call reported twice counts once; a shell command is not a touch');
  assert.equal(r.cwd, ws);
  assert.equal(r.offset, fs.statSync(file).size);
});

test('readSessionIndex: the newest thread_name per id; garbage and a missing file are tolerated', () => {
  const dir = seamDir();
  const file = path.join(dir, 'session_index.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ id: CODEX_ID, thread_name: 'First name', updated_at: '2026-10-05T09:00:00.000000Z' }),
    'not json',
    JSON.stringify({ id: PARENT_ID, thread_name: '  Parent  ', updated_at: '2026-10-05T08:00:00Z' }),
    JSON.stringify({ id: CODEX_ID, thread_name: 'Renamed', updated_at: '2026-10-05T10:00:00.000000Z' }),
    JSON.stringify({ id: CODEX_ID, thread_name: 'Stale row', updated_at: '2026-10-05T07:00:00Z' }),
    JSON.stringify({ id: '', thread_name: 'no id' }),
    JSON.stringify({ id: 'x', thread_name: '' }),
  ].join('\n') + '\n');
  assert.deepEqual({ ...readSessionIndex(file) }, {
    [CODEX_ID]: { title: 'Renamed', updatedAt: '2026-10-05T10:00:00.000Z' },
    [PARENT_ID]: { title: 'Parent', updatedAt: '2026-10-05T08:00:00.000Z' },
  });
  assert.deepEqual({ ...readSessionIndex(path.join(dir, 'missing.jsonl')) }, {});
});
