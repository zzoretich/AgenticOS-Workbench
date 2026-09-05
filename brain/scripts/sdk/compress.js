#!/usr/bin/env node
/**
 * compress.js — compress a large input (file arg or stdin) into a distillate.
 *   --context (default)  print the summarize system prompt + the input for Claude-in-session
 *   --write <file>       print the distillate file to stdout
 *   --local              summarize through the provider; telemetry run-id on stderr
 *
 * Usage:
 *   node brain/scripts/sdk/compress.js path/to/file.txt --local --style=bullets --max-words=200
 *   cat big.log | node brain/scripts/sdk/compress.js --focus="errors"
 */
const fs = require('fs');
const crypto = require('crypto');
const { summarize, summarizeSystem } = require('./lib/qwen.js');
const { parseMode, printContext, readWriteFile, localProvider } = require('./lib/interactive.js');
const telemetry = require('./lib/telemetry.js');

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function readInput(positional) {
  if (positional.length) {
    if (!fs.existsSync(positional[0])) return Promise.reject(new Error(`file not found: ${positional[0]}`));
    return Promise.resolve(fs.readFileSync(positional[0], 'utf8'));
  }
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    if (process.stdin.isTTY) resolve('');
  });
}

function buildCompressSpec(text, flags) {
  const style = flags.style || 'bullets';
  const maxWords = parseInt(flags['max-words'] || '200', 10);
  const focus = flags.focus || null;
  return {
    system: summarizeSystem({ style, maxWords, focus }),
    context: text,
    format: `${style === 'prose' ? 'A prose paragraph' : style === 'outline' ? 'A nested outline' : 'Terse markdown bullets'} under ${maxWords} words. No preamble.`,
  };
}

async function main() {
  const { mode, writeFile, rest } = parseMode(process.argv.slice(2));
  if (mode === 'write') { process.stdout.write(readWriteFile(writeFile)); return; }
  const { flags, positional } = parseArgs(rest);
  const text = await readInput(positional);
  if (!text || !text.trim()) {
    process.stderr.write('Usage: compress.js <file> [--context|--local|--write <file>] [--style=bullets|prose|outline] [--max-words=N] [--focus="topic"]\n');
    process.exit(2);
  }
  const spec = buildCompressSpec(text, flags);
  if (mode === 'context') { printContext({ feature: 'compress', ...spec }); return; }

  const p = await localProvider('compress');
  let run = null;
  try {
    run = telemetry.startRun({ script: 'compress', prompt: `len=${text.length} style=${flags.style || 'bullets'}` });
  } catch (err) {
    process.stderr.write(`[telemetry] run_id=${crypto.randomUUID()}\n`);
  }
  try {
    const out = await summarize(text, {
      style: flags.style || 'bullets',
      maxWords: parseInt(flags['max-words'] || '200', 10),
      focus: flags.focus || null,
      chatFn: (o) => p.chat({ ...o, feature: 'compress' }),
    });
    try { await telemetry.endRun(run, { status: 'ok', reply: `len=${out ? out.length : 0}` }); } catch { /* fail-soft */ }
    process.stdout.write((out || '(empty)') + '\n');
  } catch (err) {
    try { await telemetry.endRun(run, { status: 'error', error: err }); } catch { /* fail-soft */ }
    process.stderr.write(`[compress] ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[compress] ${err.code === 'PROVIDER_NONE' ? err.message : 'fatal: ' + ((err && err.stack) || err)}\n`);
    process.exit(1);
  });
}

module.exports = { buildCompressSpec, parseArgs };
