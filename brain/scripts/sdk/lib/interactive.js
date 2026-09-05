'use strict';
/**
 * interactive.js — the three-mode contract for the interactive scripts
 * (ask, standup, reflect-week, consolidate-memory, compress):
 *   --context (default)  print the assembled prompt for Claude-in-session; write nothing
 *   --write <file>       persist Claude's answer where the script would have written model output
 *   --local              run through the provider exactly as the old Ollama path did
 */
const fs = require('fs');

function parseMode(argv) {
  const rest = [];
  let mode = 'context';
  let writeFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') mode = 'local';
    else if (a === '--context') mode = 'context';
    else if (a === '--write') { mode = 'write'; writeFile = argv[++i] ?? null; }
    else if (a.startsWith('--write=')) { mode = 'write'; writeFile = a.slice('--write='.length); }
    else rest.push(a);
  }
  return { mode, writeFile, rest };
}

function renderContextBlock({ feature, system, context, format }) {
  return [
    `<<<AOS_CONTEXT feature=${feature}>>>`,
    '## System', String(system ?? ''), '',
    '## Context', String(context ?? ''), '',
    '## Output format', String(format ?? ''),
    '<<<END>>>',
  ].join('\n') + '\n';
}

function printContext(spec) { process.stdout.write(renderContextBlock(spec)); }

function readWriteFile(file) {
  if (!file) throw new Error('--write needs a file path (or - for stdin)');
  return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
}

/** The provider for --local; a `none` provider is an error the CLI reports on stderr. */
async function localProvider(feature) {
  const p = await require('./provider.js').getProvider(feature);
  if (p.name === 'none') {
    const e = new Error(`no model provider (${p.reason}); run without --local for the in-session path`);
    e.code = 'PROVIDER_NONE';
    throw e;
  }
  return p;
}

module.exports = { parseMode, renderContextBlock, printContext, readWriteFile, localProvider };
