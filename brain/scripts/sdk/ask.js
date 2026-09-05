#!/usr/bin/env node
/**
 * ask.js — answer a single question using the vault as context.
 *
 * Retrieval-augmented: recall (BM25 + vector when available) picks the files and their
 * content is inlined into the system prompt. Three modes (sdk/lib/interactive.js):
 *   --context (default)  print the assembled prompt; Claude answers in-session
 *   --write <file>       print the answer file (ask has no persistent target)
 *   --local              answer through the provider; telemetry run-id on stderr
 *
 * Usage:
 *   node brain/scripts/sdk/ask.js "what did I decide about model routing?"
 *   node brain/scripts/sdk/ask.js --local "what did I decide about model routing?"
 */

const crypto = require('crypto');
const brain = require('./lib/brain.js');
const { reason } = require('./lib/qwen.js');
const recall = require('./lib/recall.js');
const telemetry = require('./lib/telemetry.js');
const fsx = require('fs');
const pathx = require('path');
const { VAULT } = require('../lib/paths.js');
const { parseMode, printContext, readWriteFile, localProvider } = require('./lib/interactive.js');

function readQuestion() {
  const argv = process.argv.slice(2);
  const flagless = argv.filter((a) => !a.startsWith('--'));
  if (flagless.length) return Promise.resolve(flagless.join(' ').trim());
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.trim()));
    if (process.stdin.isTTY) resolve('');
  });
}

function buildContextLegacy(question, charBudget = 14000) {
  const words = String(question).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const items = [...brain.listMemories(), ...brain.listPatterns()];
  const scored = items.map((m) => {
    const content = brain.readIfExists(m.absPath) || '';
    const lc = content.toLowerCase();
    let score = 0;
    for (const w of words) if (lc.includes(w)) score++;
    if (words.some((w) => m.name.toLowerCase().includes(w))) score += 2;
    return { path: m.path, content, score };
  });
  scored.sort((a, b) => b.score - a.score);

  let budget = charBudget;
  const parts = [];
  for (const s of scored) {
    const block = `### ${s.path}\n${s.content}\n`;
    if (budget - block.length < 0) break;
    budget -= block.length;
    parts.push(block);
  }
  return parts.join('\n');
}

// Hybrid retrieval: recall (BM25 + vector RRF when the embed index exists)
// picks the files; we inline their content under the same char budget.
// Falls back to the legacy keyword scorer when recall has nothing.
async function buildContext(question, charBudget = 14000) {
  let hits = [];
  try {
    let index = recall.loadIndex();
    if (!index) { index = recall.buildRecallIndex(); recall.saveIndex(index); }
    hits = (await recall.queryRecallHybrid(index, question, { limit: 8 })).hits;
  } catch { /* recall unavailable — legacy path below */ }
  if (!hits.length) return buildContextLegacy(question, charBudget);
  let budget = charBudget;
  const parts = [];
  for (const h of hits) {
    let content = '';
    try { content = fsx.readFileSync(pathx.join(VAULT, h.path), 'utf8'); } catch { continue; }
    const block = `### ${h.path}\n${content}\n`;
    if (budget - block.length < 0) break;
    budget -= block.length;
    parts.push(block);
  }
  return parts.length ? parts.join('\n') : buildContextLegacy(question, charBudget);
}

async function buildAskPrompt(question) {
  const context = await buildContext(question);
  const system = [
    "You are the user's second-brain assistant. Answer using ONLY the vault context provided below.",
    'Rules:',
    '- Lead with the answer. No preamble.',
    '- Cite the source file(s) in backticks, e.g. `brain/memory/feedback/lead-with-recommendation.md`.',
    '- If the vault context has no information on the topic, say so plainly — do NOT invent.',
    '- Keep answers under ~200 words unless the question requires more.',
    '',
    '=== VAULT CONTEXT ===',
    context || '(no matching memories found)',
    '=== END VAULT CONTEXT ===',
  ].join('\n');
  return { system, context };
}

const ASK_FORMAT = 'A markdown answer under ~200 words: lead with the answer, cite vault files in backticks.';

async function main() {
  const { mode, writeFile, rest } = parseMode(process.argv.slice(2));
  if (mode === 'write') { process.stdout.write(readWriteFile(writeFile)); return; }

  const question = rest.length ? rest.join(' ').trim() : await readQuestion();
  if (!question) {
    process.stderr.write('Usage: node ask.js [--context|--local|--write <file>] "your question"\n');
    process.exit(2);
  }
  const { system } = await buildAskPrompt(question);
  if (mode === 'context') { printContext({ feature: 'ask', system, context: question, format: ASK_FORMAT }); return; }

  const p = await localProvider('ask');
  let run = null;
  try {
    run = telemetry.startRun({ script: 'ask', prompt: `len=${question.length}` });
  } catch (err) {
    process.stderr.write(`[telemetry] run_id=${crypto.randomUUID()}\n`);
  }
  try {
    const answer = await reason(question, {
      system, effort: 'medium', numPredict: 1024,
      chatFn: (o) => p.chat({ ...o, feature: 'ask' }), noFallback: p.name !== 'ollama',
    });
    try { await telemetry.endRun(run, { status: 'ok', reply: `len=${answer ? answer.length : 0}` }); } catch { /* fail-soft */ }
    process.stdout.write((answer || '(no answer)') + '\n');
  } catch (err) {
    try { await telemetry.endRun(run, { status: 'error', error: err }); } catch { /* fail-soft */ }
    process.stderr.write(`[ask] ${p.name} error: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[ask] ${err.code === 'PROVIDER_NONE' ? err.message : 'fatal: ' + ((err && err.stack) || err)}\n`);
    process.exit(1);
  });
}

module.exports = { buildAskPrompt, buildContext, ASK_FORMAT };
