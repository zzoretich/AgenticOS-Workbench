#!/usr/bin/env node
/**
 * Playbook bootstrap — generates the initial PLAYBOOK.md from the
 * arsenal scan. One-time use (or --force): after bootstrap the playbook is
 * the persona's to curate; regenerating would destroy annotations.
 */
const fs = require('fs');
const path = require('path');
const { scanArsenal } = require('./scan-arsenal.js');

const DEFAULT_ROOT = process.env.CLAUDE_CONFIG_DIR || require('path').join(require('os').homedir(), '.claude');

const HEADER = `---
type: persona-playbook
updated: ${new Date().toISOString().slice(0, 10)}
---

# {{AGENT_NAME}} PLAYBOOK — the front door

> Route by intent, not by name. After using a route, annotate it: append
> \`✓ <date> note\` or \`✗ <date> note\` to its Notes cell. Curate ruthlessly —
> a stale playbook is worse than none. Core Routes are hand-curated; the
> generated sections below them are the raw inventory.

## Core Routes

| Intent | Route | Notes |
|---|---|---|
| _curated in bootstrap step_ | | |
`;

function table(entries) {
  const rows = entries.map(e => `| ${e.name} | ${e.description.replace(/\|/g, '\\|')} | |`);
  return ['| Name | Description | Notes |', '|---|---|---|', ...rows].join('\n');
}

function buildPlaybook(root = DEFAULT_ROOT, force = false) {
  const target = path.join(root, 'persona/PLAYBOOK.md');
  if (fs.existsSync(target) && !force) {
    throw new Error(`${target} exists — pass --force to overwrite (destroys annotations)`);
  }
  const all = scanArsenal(root);
  const section = t => all.filter(e => e.type === t);
  const md = [
    HEADER,
    '\n## Skills (generated)\n', table(section('skill')),
    '\n\n## Agents (generated)\n', table(section('agent')),
    '\n\n## Commands (generated)\n', table(section('command')),
    '',
  ].join('');
  fs.writeFileSync(target, md);
  return md;
}

if (require.main === module) {
  const rootIdx = process.argv.indexOf('--root');
  const root = rootIdx !== -1 ? process.argv[rootIdx + 1] : DEFAULT_ROOT;
  buildPlaybook(root, process.argv.includes('--force'));
  console.log(`wrote ${path.join(root, 'persona/PLAYBOOK.md')}`);
}

module.exports = { buildPlaybook };
