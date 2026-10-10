#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { VAULT, workspaceName } = require('./collectors/util');
const { generateInsight } = require('./collectors/workspaceInsights');
const { withLock } = require('./lib/snapshotLock');

const SNAPSHOT = path.join(VAULT, 'brain/_index/snapshot.json');
const LOCK = path.join(VAULT, 'brain/_index/.snapshot.lock');
const USAGE = 'usage: regen-workspace-insight.js "<workspace name>"';

// Pure: regenerate one named workspace's insight inside a snapshot object. Only the insight changes: the model's
// suggested next step stays on the insight and never becomes the workspace's own next (spaces-redesign D23).
async function regenInto(snapshot, name, opts = {}) {
  const list = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
  const ws = list.find((w) => w.name === name);
  if (!ws) throw new Error(`workspace not found: ${name}`);
  const { insight } = await generateInsight(ws, opts);
  ws.insight = insight;
  return snapshot;
}

/**
 * argv → the workspace name, or { error }: one argument, an existing folder (or a link to one) under workspaces/
 * (spaces-redesign §6). The name only picks a snapshot entry and no file is read, so a linked code folder is fine.
 */
function checkArgs(args, vault = VAULT) {
  if (args.length !== 1) return { error: USAGE };
  const name = args[0];
  if (!workspaceName(name, vault)) return { error: `not a workspace: ${JSON.stringify(name)} (an existing folder under workspaces/, not ., .., _x or a path)` };
  return { name };
}

async function main() {
  const checked = checkArgs(process.argv.slice(2));
  if (checked.error) { console.error(checked.error); process.exit(2); }
  const { name } = checked;
  await withLock(LOCK, async () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    await regenInto(snapshot, name);
    require('./lib/fsx.js').writeAtomic(SNAPSHOT, JSON.stringify(snapshot, null, 2));
  });
  console.log(`regenerated insight for: ${name}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { regenInto, checkArgs };
