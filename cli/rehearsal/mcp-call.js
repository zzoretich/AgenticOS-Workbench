#!/usr/bin/env node
'use strict';
/**
 * mcp-call.js — one tools/call against the vault's agenticos MCP server over stdio.
 *   node cli/rehearsal/mcp-call.js <tool> [<json-arguments>]
 * Prints the text content of the result. Used by the first-run rehearsal and handy for debugging.
 */
const fs = require('fs');
const { mcpProbe, configPath } = require('../aos.js');

const [tool, json] = process.argv.slice(2);
if (!tool) { process.stderr.write('usage: mcp-call.js <tool> [<json-arguments>]\n'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
mcpProbe({ vault: cfg.vault, tool, args: json ? JSON.parse(json) : {} }).then((r) => {
  const text = ((r.result && r.result.content) || []).map((c) => c.text || '').join('\n');
  process.stdout.write(text + '\n');
  process.exit(r.result && r.result.isError ? 1 : 0);
}, (e) => { process.stderr.write(`mcp-call: ${e.message}\n`); process.exit(1); });
