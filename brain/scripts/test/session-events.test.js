'use strict';
// session-events.js: each host's stream becomes the same events (spec 2026-10-07-unidex-sessions S7, §4.2). The
// fixtures follow the shapes claude -p --output-format stream-json --verbose and codex exec --json print.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/session-events.js');

const NOW = () => new Date('2026-10-07T15:00:00.000Z');
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
/** Feeds the stream in uneven chunks, so a line split across two of them must wait for its end. */
function run(host, text, opts = {}) {
  const p = E.createParser(host, { now: NOW, ...opts });
  const out = [];
  for (let i = 0; i < text.length; i += 37) out.push(...p.push(text.slice(i, i + 37)));
  out.push(...p.end());
  return { events: out, state: p.state };
}
const kinds = (events) => events.map((e) => e.kind);

const CLAUDE = jsonl([
  { type: 'system', subtype: 'init', session_id: 'a1b2', model: 'claude-sonnet-5', tools: ['Read', 'Edit'] },
  { type: 'assistant', session_id: 'a1b2', message: { content: [
    { type: 'text', text: 'Reading the parser first.' },
    { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/tide.js' } },
  ] } },
  { type: 'user', session_id: 'a1b2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'export function parse() {}' }] }] } },
  { type: 'assistant', session_id: 'a1b2', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'src/tide.js', old_string: 'a', new_string: 'b' } }] } },
  { type: 'user', session_id: 'a1b2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'denied', is_error: true }] } },
  { type: 'assistant', session_id: 'a1b2', message: { content: [{ type: 'text', text: 'Done: the parser handles negative tides.' }] } },
  { type: 'result', subtype: 'success', is_error: false, session_id: 'a1b2', total_cost_usd: 0.0421, num_turns: 3,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 } },
]);

test('claude: session id, text, tool rows with their kind and file, results, then usage and done with its own cost', () => {
  const { events, state } = run('claude', CLAUDE);
  assert.deepEqual(kinds(events), ['session', 'text', 'tool', 'tool_result', 'tool', 'tool_result', 'text', 'usage', 'done']);
  assert.deepEqual(events[0], { t: '2026-10-07T15:00:00.000Z', kind: 'session', id: 'a1b2' });
  assert.deepEqual(events[2], { t: '2026-10-07T15:00:00.000Z', kind: 'tool', id: 'tu1', name: 'Read', toolKind: 'read', summary: '{"file_path":"src/tide.js"}', filePath: 'src/tide.js' });
  assert.deepEqual([events[3].ok, events[3].summary], [true, 'export function parse() {}']);
  assert.equal(events[4].toolKind, 'edit');
  assert.deepEqual([events[5].ok, events[5].summary], [false, 'denied'], 'a refused tool is a failed result');
  assert.deepEqual(events[7], { t: '2026-10-07T15:00:00.000Z', kind: 'usage', in: 1200, out: 340, cached: 800, usd: 0.0421, estimated: false });
  assert.deepEqual(events[8], { t: '2026-10-07T15:00:00.000Z', kind: 'done', ok: true, usd: 0.0421, estimated: false });
  assert.deepEqual(state, { hostSessionId: 'a1b2', usd: 0.0421, estimated: false, done: true });
});

test('claude: a failed result is an error, then done not ok; a budget stop says why', () => {
  const { events } = run('claude', jsonl([
    { type: 'system', subtype: 'init', session_id: 'c3' },
    { type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 'c3', total_cost_usd: 1.0, usage: {} },
  ]));
  assert.deepEqual(kinds(events), ['session', 'usage', 'error', 'done']);
  assert.equal(events[2].message, 'error_max_budget_usd');
  assert.equal(events[3].ok, false);
});

const CODEX = jsonl([
  { type: 'thread.started', thread_id: '0199-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'r0', type: 'reasoning', text: 'thinking' } },
  { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '1 failing', exit_code: 1, status: 'failed' } },
  { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/tide.js', kind: 'update' }, { path: 'test/tide.test.js', kind: 'add' }], status: 'completed' } },
  { type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'agenticos', tool: 'recall', arguments: { q: 'tides' }, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'agenticos', tool: 'recall', status: 'completed', result: { content: [] } } },
  { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Fixed the parser and added a test.' } },
  { type: 'turn.completed', usage: { input_tokens: 20000, cached_input_tokens: 10000, output_tokens: 1000 } },
]);

test('codex: thread id, command and MCP rows, the files a patch changed, text, then an estimated usage and done', () => {
  const { events, state } = run('codex', CODEX, { model: 'gpt-5-mini' });
  assert.deepEqual(kinds(events), ['session', 'tool', 'tool_result', 'patch', 'tool', 'tool_result', 'text', 'usage', 'done']);
  assert.equal(events[0].id, '0199-thread');
  assert.deepEqual(events[1], { t: '2026-10-07T15:00:00.000Z', kind: 'tool', id: 'c1', name: 'shell', toolKind: 'bash', summary: 'npm test', filePath: null });
  assert.deepEqual([events[2].ok, events[2].summary], [false, '1 failing'], 'a non-zero exit is a failed result');
  assert.deepEqual(events[3].files, [{ path: 'src/tide.js', change: 'update' }, { path: 'test/tide.test.js', change: 'add' }]);
  assert.deepEqual([events[4].name, events[4].toolKind, events[5].ok], ['mcp__agenticos__recall', 'mcp', true]);
  // gpt-5-mini: 10k uncached input at $0.25/M, 10k cached at a tenth of it, 1k output at $2/M.
  assert.deepEqual(events[7], { t: '2026-10-07T15:00:00.000Z', kind: 'usage', in: 20000, out: 1000, cached: 10000, usd: 0.00475, estimated: true });
  assert.deepEqual(events[8], { t: '2026-10-07T15:00:00.000Z', kind: 'done', ok: true, usd: 0.00475, estimated: true });
  assert.equal(state.hostSessionId, '0199-thread');
});

test('codex: a failed turn is an error then done not ok; a bare error event alone does not end the turn', () => {
  const { events } = run('codex', jsonl([
    { type: 'thread.started', thread_id: 't9' },
    { type: 'error', message: 'stream disconnected, retrying' },
    { type: 'turn.failed', error: { message: 'model overloaded' } },
  ]));
  assert.deepEqual(kinds(events), ['session', 'error', 'error', 'done']);
  assert.deepEqual([events[2].message, events[3].ok], ['model overloaded', false]);
});

test('a stream that stops before the host finished the turn (killed, crashed) closes it as failed; noise lines are skipped', () => {
  const { events, state } = run('claude', 'not json\n' + jsonl([{ type: 'system', subtype: 'init', session_id: 'k1' }]).trimEnd());
  assert.deepEqual(kinds(events), ['session', 'error', 'done']);
  assert.equal(events[2].ok, false);
  assert.equal(state.hostSessionId, 'k1', 'the last line, without its newline, still counts at end()');
  assert.throws(() => E.createParser('nohost'), /no such host/);
});

test('summary: one line, clipped, from strings, content blocks or objects', () => {
  assert.equal(E.summary('a\n  b'), 'a b');
  assert.equal(E.summary([{ type: 'text', text: 'x' }, 'y']), 'x y');
  assert.equal(E.summary({ q: 1 }), '{"q":1}');
  assert.equal(E.summary('z'.repeat(1000)).length, E.SUMMARY_MAX);
  assert.equal(E.summary(undefined), '');
});

test('plans: claude TodoWrite and codex todo_list become one plan event each time the list changes (U10)', () => {
  const claude = run('claude', jsonl([
    { type: 'system', subtype: 'init', session_id: 'p1' },
    { type: 'assistant', session_id: 'p1', message: { content: [{ type: 'tool_use', id: 'td1', name: 'TodoWrite', input: { todos: [
      { content: 'Read the parser', status: 'completed', activeForm: 'Reading the parser' },
      { content: 'Fix negative tides', status: 'in_progress' },
      { content: '', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ] } }] } },
    { type: 'user', session_id: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'td1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'p1', total_cost_usd: 0.01, usage: {} },
  ]));
  assert.deepEqual(kinds(claude.events), ['session', 'plan', 'tool_result', 'usage', 'done'], 'the list is a plan, not a tool row');
  assert.deepEqual(claude.events[1].items, [
    { text: 'Read the parser', status: 'done' }, { text: 'Fix negative tides', status: 'active' }, { text: 'Run the tests', status: 'pending' },
  ]);
  const codex = run('codex', jsonl([
    { type: 'thread.started', thread_id: 't9' },
    { type: 'item.started', item: { id: 'l1', type: 'todo_list', items: [{ text: 'Reproduce', completed: false }, { text: 'Fix', completed: false }] } },
    { type: 'item.updated', item: { id: 'l1', type: 'todo_list', items: [{ text: 'Reproduce', completed: true }, { text: 'Fix', completed: false }] } },
    { type: 'item.completed', item: { id: 'l1', type: 'todo_list', items: [] } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ]), { model: 'gpt-5-mini' });
  assert.deepEqual(kinds(codex.events), ['session', 'plan', 'plan', 'usage', 'done'], 'an empty list adds nothing');
  assert.deepEqual(codex.events[2].items, [{ text: 'Reproduce', status: 'done' }, { text: 'Fix', status: 'pending' }]);
});
