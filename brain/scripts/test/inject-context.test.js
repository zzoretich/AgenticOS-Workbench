'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'), '# BRAIN\nhello brain\n');
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), '# SESSION\n');
process.env.AOS_VAULT = TMP;
const { markerPath } = require('../lib/markers.js');
const SCRIPT = path.join(__dirname, '..', 'inject-context.js');
const SID = `t-${process.pid}`;

function run() {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ session_id: SID }), encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json') },
  });
}

test('first turn injects brain context and writes its marker to tmpdir, not brain/_index', () => {
  try { fs.unlinkSync(markerPath(`.injected-${SID}`)); } catch {}
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /<brain-context>/);
  assert.match(r.stdout, /hello brain/);
  assert.ok(fs.existsSync(markerPath(`.injected-${SID}`)));
  assert.ok(!fs.readdirSync(path.join(TMP, 'brain', '_index')).some((n) => n.startsWith('.injected-')));
});

test('second turn of the same session injects nothing', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a Codex rollout with a user turn already in it counts as a started session: nothing injected', () => {
  const sid = `cx-${process.pid}`;
  try { fs.unlinkSync(markerPath(`.injected-${sid}`)); } catch {}
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ session_id: sid, transcript_path: path.join(__dirname, 'fixtures', 'codex-rollout.jsonl'), hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: 'codex' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(fs.existsSync(markerPath(`.injected-${sid}`)));
});

test('an empty Codex rollout path injects on the first prompt like Claude does', () => {
  const sid = `cx0-${process.pid}`;
  try { fs.unlinkSync(markerPath(`.injected-${sid}`)); } catch {}
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ session_id: sid, transcript_path: path.join(TMP, 'no-such-rollout.jsonl') }),
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), AOS_HOST: 'codex' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<brain-context>/);
});
