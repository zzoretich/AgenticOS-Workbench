#!/usr/bin/env node
/**
 * local-code.js — offline coding help via the local reasoner. Off-quota
 * drafts, debugging, and script work; NOT a substitute for Claude on
 * production changes.
 *
 * Usage:
 *   node extras/ollama/local-code.js [--file=/path/to/source] "task or question"
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const SCRIPTS = path.join(__dirname, '..', '..', 'brain', 'scripts');
const { reason } = require(path.join(SCRIPTS, 'sdk', 'lib', 'qwen.js'));
const ollama = require(path.join(SCRIPTS, 'sdk', 'lib', 'ollama.js'));
const telemetry = require(path.join(SCRIPTS, 'sdk', 'lib', 'telemetry.js'));

const MAX_SOURCE_CHARS = 36000; // ~12K tokens — leaves the 16K reasoner window room for the 3072-token answer

async function main() {
  const argv = process.argv.slice(2);
  const fileArg = argv.find((a) => a.startsWith('--file='));
  const task = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!task) {
    process.stderr.write('Usage: node local-code.js [--file=path] "task"\n');
    process.exit(2);
  }
  let source = '';
  if (fileArg) {
    const p = fileArg.split('=').slice(1).join('=');
    try { source = fs.readFileSync(p, 'utf8').slice(0, MAX_SOURCE_CHARS); }
    catch (e) { process.stderr.write(`[local-code] cannot read ${p}: ${e.message}\n`); process.exit(2); }
  }
  let run = null;
  try {
    run = telemetry.startRun({ script: 'local-code', prompt: `task_len=${task.length} source_len=${source.length}` });
  } catch (err) {
    process.stderr.write(`[telemetry] run_id=${crypto.randomUUID()}\n`);
  }

  const system = 'You are an expert software engineer running locally. Give working code with terse explanations. Match the style of any provided source. Put code in fenced blocks.';
  const prompt = source ? `${task}\n\n---SOURCE---\n${source}\n---END SOURCE---` : task;
  let answer;
  try {
    answer = await reason(prompt, { system, effort: 'high', numPredict: 3072, chatFn: (o) => ollama.chat(o) });
  } catch (err) {
    try { await telemetry.endRun(run, { status: 'error', error: err }); } catch { /* fail-soft */ }
    throw err;
  }
  try { await telemetry.endRun(run, { status: 'ok', reply: `len=${answer ? answer.length : 0}` }); } catch { /* fail-soft */ }
  process.stdout.write((answer || '(no answer)') + '\n');
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`[local-code] fatal: ${err.message}\n`); process.exit(1); });
}
