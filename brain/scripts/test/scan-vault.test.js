'use strict';
// scan-vault.js: a hidden entry (an `_` folder, an archived one: spaces-redesign D22) gets no insight, so no model call
// is spent on it; a visible one whose insight is stale gets one, and a fresh one keeps its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enrichWorkspaceInsights } = require('../scan-vault');

const entry = (name, extra = {}) => ({
  name, inputHash: `h-${name}`, insight: null, next: { text: null, source: 'derived' }, objectives: [], subprojects: [],
  lastEvent: { ageDays: 1 }, ...extra,
});

test('enrichWorkspaceInsights asks the model for visible entries only, and only when the insight is stale', async () => {
  let calls = 0;
  const provider = { name: 'ollama', chat: async () => { calls++; return 'INSIGHT: Moving along.\nNEXT: Ship it.'; } };
  const fresh = { text: 'Still right.', status: 'ok', inputHash: 'h-fresh', next: null };
  const snap = { workspaces: [
    entry('_spikes', { hidden: true, hiddenReason: 'underscore' }),
    entry('_archive/pier', { hidden: true, hiddenReason: 'archived', insight: { text: 'old', status: 'ok', inputHash: 'other' } }),
    entry('harbor'),
    entry('fresh', { insight: fresh }),
  ] };
  await enrichWorkspaceInsights(snap, provider);
  assert.equal(calls, 1);
  assert.equal(snap.workspaces[0].insight, null, 'a hidden entry is left as it was');
  assert.deepEqual(snap.workspaces[1].insight, { text: 'old', status: 'ok', inputHash: 'other' });
  assert.equal(snap.workspaces[2].insight.text, 'Moving along.');
  assert.equal(snap.workspaces[2].insight.next, 'Ship it.', 'the model\'s next stays on the insight (D23)');
  assert.equal(snap.workspaces[3].insight, fresh);
});
