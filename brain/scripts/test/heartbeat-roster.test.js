'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildRoster, orchestratorFor } = require('../heartbeat-writer.js');

test('an empty orchestrator map yields no roster and never attributes a run', () => {
  const roster = buildRoster({});
  assert.deepEqual(roster, []);
  assert.equal(orchestratorFor(roster, { prompt: '/plan build it', script: 'session' }), null);
});

test('config entries supply nickname, trigger and match regex with sensible defaults', () => {
  const roster = buildRoster({
    Planner: { nickname: 'PLAN', trigger: '/plan', match: '/plan\\b|planner' },
    Builder: {},
  });
  assert.equal(roster.length, 2);
  const planner = orchestratorFor(roster, { prompt: 'run /plan now', script: 'session' });
  assert.equal(planner.name, 'Planner');
  assert.equal(planner.nickname, 'PLAN');
  assert.equal(planner.trigger, '/plan');
  const builder = orchestratorFor(roster, { prompt: '', script: 'Builder' });
  assert.equal(builder.name, 'Builder');
  assert.equal(builder.nickname, 'Builder');
  assert.equal(builder.trigger, '/builder');
});

test('heartbeat-writer.js loads when brain/config.json sets "roster": null', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-roster-null-'));
  fs.mkdirSync(path.join(v, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(v, 'brain', 'config.json'), JSON.stringify({ provider: 'none', roster: null }));
  const script = `require(${JSON.stringify(path.resolve(__dirname, '..', 'heartbeat-writer.js'))}); process.stdout.write('LOADED_OK');`;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, AOS_VAULT: v, AOS_CONFIG: path.join(os.tmpdir(), 'no-such-agenticos.json') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'LOADED_OK');
});
