'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thook-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
const CONFIG = path.join(TMP, 'brain', 'config.json');
const SCRIPT = path.join(__dirname, '..', 'telemetry-hook.js');
const LIVE = (sid) => path.join(TMP, 'brain', '_index', 'agent-runs', 'live', `sess-${sid}.ndjson`);

function fire(sid, extraEnv = {}) {
  const payload = { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_input: { file_path: '/home/alice/secret.md' }, tool_response: { ok: true } };
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') };
  delete env.BRAIN_AGENT_REDACT; // strip the developer's shell override first, then apply the test's own
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  if (!fs.existsSync(LIVE(sid))) return null;
  return fs.readFileSync(LIVE(sid), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('redaction is on by default: tool name kept, input and output summaries null', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const events = fire('r1');
  const use = events.find((e) => e.type === 'tool_use_batch');
  const res = events.find((e) => e.type === 'tool_result_batch');
  assert.equal(use.tools[0].name, 'Read');
  assert.equal(use.tools[0].input_summary, null);
  assert.equal(res.results[0].output_summary, null);
  assert.ok(!fs.readFileSync(LIVE('r1'), 'utf8').includes('secret.md'));
});

test('telemetry.redact=false keeps the summaries; BRAIN_AGENT_REDACT=1 still wins', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', telemetry: { redact: false } }));
  const events = fire('r2');
  assert.match(events.find((e) => e.type === 'tool_use_batch').tools[0].input_summary, /secret\.md/);
  const forced = fire('r3', { BRAIN_AGENT_REDACT: '1' });
  assert.equal(forced.find((e) => e.type === 'tool_use_batch').tools[0].input_summary, null);
});

test('telemetry.enabled=false writes nothing', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', telemetry: { enabled: false } }));
  assert.equal(fire('r4'), null);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});

test('a Codex payload (tool_input / tool_response as JSON strings, apply_patch) is recorded like a Claude one', () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none', telemetry: { redact: false } }));
  const payload = {
    hook_event_name: 'PostToolUse', session_id: 'cx1', tool_name: 'apply_patch',
    tool_input: JSON.stringify({ command: '*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch' }),
    tool_response: 'Exit code: 0\nSuccess. Updated the following files:\nA note.txt\n',
    tool_use_id: 'exec-1', model: 'gpt-x', permission_mode: 'bypassPermissions',
  };
  const env = { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: 'codex' };
  delete env.BRAIN_AGENT_REDACT;
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'PostToolUse prints nothing on either host');
  const events = fs.readFileSync(LIVE('cx1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const use = events.find((e) => e.type === 'tool_use_batch');
  assert.equal(use.tools[0].name, 'apply_patch');
  assert.match(use.tools[0].input_summary, /Add File: note\.txt/);
  assert.equal(use.tools[0].input_length, JSON.stringify(JSON.parse(payload.tool_input)).length);
  const res = events.find((e) => e.type === 'tool_result_batch');
  assert.equal(res.results[0].is_error, false);
  assert.match(res.results[0].output_summary, /Updated the following files/);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
});
