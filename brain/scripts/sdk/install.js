#!/usr/bin/env node
/**
 * install.js — register the brain MCP server with Claude Code (user scope).
 *
 * Idempotent: safe to run multiple times. If `brain` is already registered,
 * it's removed and re-added with the current path.
 *
 * Usage:
 *   node brain/scripts/sdk/install.js            # register at user scope
 *   node brain/scripts/sdk/install.js --project  # register at project scope (this directory)
 *   node brain/scripts/sdk/install.js --uninstall
 */

const path = require('path');
const { spawnSync } = require('child_process');

const args = new Set(process.argv.slice(2));
const PROJECT = args.has('--project');
const UNINSTALL = args.has('--uninstall');
const SCOPE = PROJECT ? 'project' : 'user';

const mcpServerPath = path.resolve(__dirname, 'mcp-server.js');

function run(cmd, argv, { allowFail = false } = {}) {
  const res = spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0 && !allowFail) {
    process.stderr.write(`[install] ${cmd} ${argv.join(' ')} exited ${res.status}\n`);
    process.exit(res.status || 1);
  }
  return res.status;
}

function main() {
  console.log(`[install] scope=${SCOPE} mcp-server=${mcpServerPath}`);

  // Always remove first so re-install picks up path changes.
  console.log('[install] removing any prior `brain` registration…');
  run('claude', ['mcp', 'remove', 'brain', '--scope', SCOPE], { allowFail: true });

  if (UNINSTALL) {
    console.log('[install] uninstall complete.');
    return;
  }

  console.log('[install] registering `brain` MCP server…');
  run('claude', [
    'mcp', 'add', 'brain',
    '--scope', SCOPE,
    '--', 'node', mcpServerPath,
  ]);

  console.log('');
  console.log('[install] done. Verify:');
  console.log('  claude mcp list');
  console.log('');
  console.log('[install] tools available once you start a new session:');
  console.log('  mcp__brain__memory_search');
  console.log('  mcp__brain__memory_read');
  console.log('  mcp__brain__memory_list');
  console.log('  mcp__brain__pattern_list');
  console.log('  mcp__brain__session_list');
  console.log('  mcp__brain__session_recall');
  console.log('  mcp__brain__feedback_rules');
  console.log('  mcp__brain__snapshot_read');
}

main();
