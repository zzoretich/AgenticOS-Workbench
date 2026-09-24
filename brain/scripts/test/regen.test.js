'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { regenInto } = require('../regen-workspace-insight');

test('regenInto replaces one workspace insight in a snapshot object', async () => {
  const snap = { workspaces: [
    { name: 'A', inputHash: 'h1', next: { text: null, source: 'derived' }, insight: { text: null, status: 'unavailable' }, objectives: [], subprojects: [], lastEvent: { ageDays: 1 } },
    { name: 'B', inputHash: 'h2', next: { text: null, source: 'derived' }, insight: { text: 'keep', status: 'ok' }, objectives: [], subprojects: [], lastEvent: { ageDays: 1 } },
  ]};
  const updated = await regenInto(snap, 'A', { chatFn: async () => 'INSIGHT: Fresh take.\nNEXT: Do thing.' });
  assert.equal(updated.workspaces[0].insight.text, 'Fresh take.');
  assert.equal(updated.workspaces[0].insight.status, 'ok');
  assert.equal(updated.workspaces[0].next.text, 'Do thing.');
  assert.equal(updated.workspaces[1].insight.text, 'keep'); // untouched
});

test('regenInto throws when workspace name not found', async () => {
  await assert.rejects(() => regenInto({ workspaces: [] }, 'missing', { chatFn: async () => 'x' }));
});
