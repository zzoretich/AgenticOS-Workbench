'use strict';
/**
 * map-workspace.js — unbounded file-map run for one workspace (or all).
 * Fix Queue target: "N unmapped → map now". Usage:
 *   node brain/scripts/map-workspace.js "Example Workspace"          # map one workspace, no budget cap
 *   node brain/scripts/map-workspace.js "Example Workspace" --file src/x.js   # re-describe one file
 *   node brain/scripts/map-workspace.js                            # all workspaces, no cap
 * The page's WS and REL rules are checked again here (spaces-redesign §6): the name is an existing folder under
 * workspaces/ and the file a regular file inside it that the map itself would list (no dot path but .github, no
 * node_modules or other skipped folder, no binary or lock file, at most 1 MB), so ↻ never sends a .env or .git/config
 * to a model. Re-describing one file is a `file-map` model call (D33).
 */
const { VAULT, workspaceDir, workspaceFile } = require('./collectors/util.js');

const USAGE = 'usage: map-workspace.js ["<workspace name>" [--file <relative path>]]';

/** argv → { name, relFile } or { error }. One name at most, `--file <path>` at most once, no other option. */
function parseArgs(args) {
  let name = null;
  let relFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file') {
      if (relFile !== null) return { error: '--file given twice' };
      if (i + 1 >= args.length) return { error: '--file requires a relative path argument' };
      relFile = args[++i];
    } else if (a.startsWith('-')) {
      return { error: `unknown option ${a}` };
    } else if (name !== null) {
      return { error: 'one workspace name at most' };
    } else {
      name = a;
    }
  }
  if (relFile !== null && name === null) return { error: '--file requires a workspace name' };
  return { name, relFile };
}

/** { name, relFile } once checked against the vault, or { error }. */
function checkTarget({ name, relFile }, vault = VAULT) {
  if (name === null) return { name: null, relFile: null };
  const dir = workspaceDir(name, vault);
  if (!dir) return { error: `not a workspace: ${JSON.stringify(name)} (an existing folder under workspaces/, not ., .., _x or a path)` };
  if (relFile === null) return { name, relFile };
  const file = workspaceFile(dir, relFile);
  const { mappableFile } = require('./collectors/fileMap.js');
  if (!file || !mappableFile(file, relFile)) return { error: `not a file the map lists inside ${name}: ${JSON.stringify(relFile)}` };
  return { name, relFile };
}

/** deps (tests): vault, getProvider, stdout. A refused argument throws with `usage` set, before anything is written. */
async function run(args, deps = {}) {
  const parsed = parseArgs(args);
  const target = parsed.error ? parsed : checkTarget(parsed, deps.vault || VAULT);
  if (target.error) throw Object.assign(new Error(target.error), { usage: true });
  const { name, relFile } = target;
  const { withReport } = require('./lib/pipeline-report.js');
  const { collectFileMaps, describeOneFile, listWorkspaces } = require('./collectors/fileMap.js');
  const out = deps.stdout || process.stdout;
  return withReport('file-map', async (report) => {
    if (relFile) {
      // The ↻ on one file: one call through the provider, tagged `file-map` (D33), never `unknown`.
      const p = await (deps.getProvider || require('./sdk/lib/provider.js').getProvider)('file-map');
      report.provider = p.name;
      if (p.name === 'none') throw new Error(`no model provider to describe ${relFile} (${p.reason || 'none'})`);
      const line = await describeOneFile(name, relFile, { chatFn: (o) => p.chat({ ...o, feature: 'file-map' }) });
      report.counts.described = line ? 1 : 0;
      report.wrote.push(`brain/_index/workspace-maps/${name}.json`);
      if (!line) throw new Error(`could not describe ${relFile} (missing file or model failure)`);
      out.write(`${relFile}: ${line}\n`);
      return;
    }
    const targets = name ? [name] : listWorkspaces();
    const res = await collectFileMaps({ budget: Infinity, workspaces: targets, report });
    out.write(`described ${res.described}, pending ${res.pending}\n`);
  });
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((e) => {
    console.error('[map-workspace]', e.message);
    if (e.usage) console.error(USAGE);
    process.exit(e.usage ? 2 : 1);
  });
}

module.exports = { parseArgs, checkTarget, run };
