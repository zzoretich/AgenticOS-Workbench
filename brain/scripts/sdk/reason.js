#!/usr/bin/env node
/**
 * reason.js — direct deep Q&A with the local reasoner (no vault retrieval;
 * use ask.js for retrieval-augmented questions). Prints the answer to stdout
 * and a telemetry run-id to stderr (same contract as ask.js).
 *
 * Usage:
 *   node brain/scripts/sdk/reason.js [--effort=low|medium|high] "question"
 *   echo "question" | node brain/scripts/sdk/reason.js
 */
const crypto = require('crypto');
const { reason } = require('./lib/qwen.js');
const telemetry = require('./lib/telemetry.js');

function readQuestion(flagless) {
  if (flagless.length) return Promise.resolve(flagless.join(' ').trim());
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.trim()));
    if (process.stdin.isTTY) resolve('');
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const effortArg = argv.find((a) => a.startsWith('--effort='));
  const effort = effortArg ? effortArg.split('=')[1] : 'medium';
  const question = await readQuestion(argv.filter((a) => !a.startsWith('--')));
  if (!question) {
    process.stderr.write('Usage: node reason.js [--effort=low|medium|high] "question"\n');
    process.exit(2);
  }
  let run = null;
  try {
    run = telemetry.startRun({ script: 'reason', prompt: `effort=${effort} len=${question.length}` });
  } catch (err) {
    // startRun's own internals fail-soft (still print + return); this only
    // catches ensureDirs() throwing before that — fall back to the old contract.
    process.stderr.write(`[telemetry] run_id=${crypto.randomUUID()}\n`);
  }

  const system = 'You are a careful reasoning assistant running locally. Work the problem through, then answer directly and concisely. No preamble.';
  let answer;
  try {
    answer = await reason(question, { system, effort });
  } catch (err) {
    try { await telemetry.endRun(run, { status: 'error', error: err }); } catch { /* fail-soft */ }
    throw err;
  }
  try { await telemetry.endRun(run, { status: 'ok', reply: `len=${answer ? answer.length : 0}` }); } catch { /* fail-soft */ }
  process.stdout.write((answer || '(no answer)') + '\n');
}

main().catch((err) => { process.stderr.write(`[reason] fatal: ${err.message}\n`); process.exit(1); });
