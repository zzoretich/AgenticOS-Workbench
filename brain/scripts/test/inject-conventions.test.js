'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'inject-conventions.js');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-conv-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  return v;
}

function run(v, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(v, 'none.json'), AOS_HOST: 'codex', ...extraEnv },
  });
}

test('prints AGENTICOS.md wrapped in a conventions tag on every SessionStart', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), '# AgenticOS\n\nUse /wrap at the end.\n');
  const r = run(v);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^<agenticos-conventions>\n# AgenticOS/);
  assert.match(r.stdout, /Use \/wrap at the end\.\n<\/agenticos-conventions>\n$/);
  // no marker, no idempotency: a second call (resume/compact) injects again
  assert.equal(run(v).stdout, r.stdout);
});

test('no file, or an empty file, prints nothing and still exits 0', () => {
  const v = vault();
  let r = run(v);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), '\n\n');
  r = run(v);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a huge file is truncated under the context budget', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), 'x'.repeat(20000));
  const { conventionsBlock, MAX_CHARS } = require('../inject-conventions.js');
  const out = conventionsBlock(v);
  assert.ok(out.length < MAX_CHARS + 200);
  assert.match(out, /truncated/);
});

test('AOS_HEADLESS=1 exits 0 silently (a headless worker never re-enters the hooks)', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'AGENTICOS.md'), '# x\n');
  // test/setup.js (preloaded through NODE_OPTIONS) deletes AOS_HEADLESS in every child, so drop the preload here.
  const r = run(v, { AOS_HEADLESS: '1', NODE_OPTIONS: '' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
