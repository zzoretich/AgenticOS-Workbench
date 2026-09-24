#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { VAULT } = require('./collectors/util');
const { generateInsight } = require('./collectors/workspaceInsights');
const { withLock } = require('./lib/snapshotLock');

const SNAPSHOT = path.join(VAULT, 'brain/_index/snapshot.json');
const LOCK = path.join(VAULT, 'brain/_index/.snapshot.lock');

// Pure: regenerate one named workspace's insight inside a snapshot object.
async function regenInto(snapshot, name, opts = {}) {
  const list = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
  const ws = list.find((w) => w.name === name);
  if (!ws) throw new Error(`workspace not found: ${name}`);
  const { insight, next } = await generateInsight(ws, opts);
  ws.insight = insight;
  ws.next = next;
  return snapshot;
}

async function main() {
  const name = process.argv[2];
  if (!name) { console.error('usage: regen-workspace-insight.js "<workspace name>"'); process.exit(2); }
  await withLock(LOCK, async () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    await regenInto(snapshot, name);
    require('./lib/fsx.js').writeAtomic(SNAPSHOT, JSON.stringify(snapshot, null, 2));
  });
  console.log(`regenerated insight for: ${name}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { regenInto };
