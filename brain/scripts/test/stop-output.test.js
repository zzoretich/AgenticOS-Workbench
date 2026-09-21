'use strict';
// Stop-hook output contract per host: Codex requires JSON on stdout, Claude Code accepts silence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-stop-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), '# SESSION\n');
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'BRAIN.md'), '# BRAIN\n');

function run(script, env) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', script)], {
    input: JSON.stringify({ session_id: 'st1', hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: TMP, AOS_CONFIG: path.join(TMP, 'none.json'), ...env },
  });
}

for (const script of ['update-session.js', 'heartbeat-writer.js']) {
  test(`${script}: under Codex the Stop hook answers {} and nothing else`, () => {
    const r = run(script, { AOS_HOST: 'codex' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{}');
  });
  test(`${script}: under Claude Code the Stop hook stays silent`, () => {
    const r = run(script, { CLAUDE_PROJECT_DIR: TMP });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  });
}

test('finishStop is a no-op outside Codex', () => {
  const { finishStop } = require('../lib/hook-entry.js');
  delete process.env.AOS_HOST;
  let written = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { written += s; return true; };
  try { finishStop(); } finally { process.stdout.write = orig; }
  assert.equal(written, '');
});
