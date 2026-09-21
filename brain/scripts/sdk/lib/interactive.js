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

/**
 * The provider for --local; a `none` provider is an error the CLI reports on stderr.
 * With `{ role: 'reasoner' }` the reasoner's provider (headless Claude) is returned; when that is
 * unavailable and the global provider is Ollama, the Ollama provider comes back instead with
 * `degraded` set to the reason, and reason() then sends it the workhorse request.
 */
async function localProvider(feature, { role } = {}) {
  const prov = require('./provider.js');
  const p = role ? await prov.getProviderForRole(role, feature) : await prov.getProvider(feature);
  if (p.name !== 'none') return p;
  if (role && require('./models.js').providerFor(role) === 'claude') {
    const g = await prov.getProvider(feature);
    if (g.name === 'ollama') return { ...g, degraded: p.reason };
    const e = new Error(`no model provider for the ${role} (${p.reason}) and none for the workhorse fallback (${g.reason}); run without --local for the in-session path`);
    e.code = 'PROVIDER_NONE';
    throw e;
  }
  const e = new Error(`no model provider (${p.reason}); run without --local for the in-session path`);
  e.code = 'PROVIDER_NONE';
  throw e;
}

module.exports = { parseMode, renderContextBlock, printContext, readWriteFile, localProvider };
