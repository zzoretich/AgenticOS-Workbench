'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
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
