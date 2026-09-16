'use strict';
/**
 * map-workspace.js — unbounded file-map run for one workspace (or all).
 * Fix Queue target: "N unmapped → map now". Usage:
 *   node brain/scripts/map-workspace.js "Example Workspace"          # map one workspace, no budget cap
 *   node brain/scripts/map-workspace.js "Example Workspace" --file src/x.js   # re-describe one file
 *   node brain/scripts/map-workspace.js                            # all workspaces, no cap
 */
const { withReport } = require('./lib/pipeline-report.js');
const { collectFileMaps, describeOneFile, listWorkspaces } = require('./collectors/fileMap.js');

const args = process.argv.slice(2);
const fileIx = args.indexOf('--file');
const relFile = fileIx >= 0 ? args[fileIx + 1] : null;
const name = args.find((a, i) => !a.startsWith('--') && (fileIx < 0 || (i !== fileIx && i !== fileIx + 1))) || null;

withReport('file-map', async (report) => {
  if (fileIx >= 0 && !relFile) throw new Error('--file requires a relative path argument');
  if (relFile) {
    if (!name) throw new Error('--file requires a workspace name');
    const line = await describeOneFile(name, relFile);
    report.counts.described = line ? 1 : 0;
    report.wrote.push(`brain/_index/workspace-maps/${name}.json`);
    if (!line) throw new Error(`could not describe ${relFile} (missing file or qwen failure)`);
    process.stdout.write(`${relFile}: ${line}\n`);
    return;
  }
  const targets = name ? [name] : listWorkspaces();
  const out = await collectFileMaps({ budget: Infinity, workspaces: targets, report });
  process.stdout.write(`described ${out.described}, pending ${out.pending}\n`);
}).catch((e) => { console.error('[map-workspace]', e.message); process.exit(1); });
