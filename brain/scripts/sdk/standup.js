#!/usr/bin/env node
/**
 * standup.js — Did/Doing/Blockers standup from recent daily notes + git + telemetry.
 *   --context (default)  print the assembled context for Claude-in-session
 *   --write <file>       append the file's contents as today's standup block (and print it)
 *   --local              summarize through the provider, then append + print
 *
 * Usage: node brain/scripts/sdk/standup.js [--context|--local|--write <file>]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const brain = require('./lib/brain.js');
const { dailyNotePath } = require('../lib/paths.js');
const { summarize } = require('./lib/qwen.js');
const telemetry = require('./lib/telemetry.js');
const { summarizeSystem } = require('./lib/qwen.js');
const { parseMode, printContext, readWriteFile, localProvider } = require('./lib/interactive.js');

function gitLog(days = 1) {
  try {
    return execSync(`git log --since="${days} day ago" --pretty=format:"%h %ad %s" --date=short`, {
      cwd: brain.PATHS.VAULT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

function recentTelemetry(n = 20) {
  const p = path.join(brain.PATHS.VAULT, 'brain/_index/agent-runs/runs.jsonl');
  const raw = brain.readIfExists(p);
  if (!raw) return '';
  return raw.trim().split('\n').slice(-n).map((l) => {
    try { const o = JSON.parse(l); return `- ${o.script || o.subagent_type || 'run'}: ${o.status || ''}`.trim(); }
    catch { return ''; }
  }).filter(Boolean).join('\n');
}

function appendToDailyNote(block) {
  const notePath = dailyNotePath(new Date());
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  // Under the daily note's lock, like every other writer of the note (spec 2026-09-24-locked-writers D3).
  require('../lib/fsx.js').updateSync(notePath, (t) => {
    const cur = t == null ? '' : t;
    return cur + (cur.trim() ? '\n\n' : '') + block + '\n';
  }, { timeoutMs: 5000 });
  return notePath;
}

const STANDUP_FOCUS = 'a standup with exactly three sections — **Did** (recent/yesterday), **Doing** (today/next), **Blockers**. Terse bullets under each. If a section is empty, write "(nothing)".';

function buildStandupContext() {
  const sessions = brain.listSessions(5).slice(0, 2); // today + most recent prior
  const notes = sessions.map((s) => `### ${s.date}\n${brain.readIfExists(s.absPath) || ''}`).join('\n\n');
  return [
    '## Recent daily notes', notes || '(none)',
    '', '## Git (last 24h)', gitLog(1) || '(no commits)',
    '', '## Agent activity', recentTelemetry(20) || '(none)',
  ].join('\n');
}

function renderStandupBlock(body, hhmm = new Date().toTimeString().slice(0, 5)) {
  return `## Standup — ${hhmm}\n\n${String(body).trim()}`;
}

function emit(block) {
  process.stdout.write(block + '\n');
  try {
    const p = appendToDailyNote(block);
    process.stderr.write(`[standup] appended to ${path.relative(brain.PATHS.VAULT, p)}\n`);
  } catch (err) {
    process.stderr.write(`[standup] note append failed: ${err.message}\n`);
  }
}

async function main() {
  const { mode, writeFile } = parseMode(process.argv.slice(2));
  if (mode === 'write') { emit(renderStandupBlock(readWriteFile(writeFile))); return; }
  const context = buildStandupContext();
  if (mode === 'context') {
    printContext({ feature: 'standup', system: summarizeSystem({ style: 'bullets', maxWords: 180, focus: STANDUP_FOCUS }), context, format: STANDUP_FOCUS });
    return;
  }

  const p = await localProvider('standup');
  let run = null;
  try {
    run = telemetry.startRun({ script: 'standup', prompt: `context_len=${context.length}` });
  } catch (err) {
    process.stderr.write(`[telemetry] run_id=${crypto.randomUUID()}\n`);
  }
  let body;
  try {
    body = await summarize(context, { style: 'bullets', maxWords: 180, focus: STANDUP_FOCUS, chatFn: (o) => p.chat({ ...o, feature: 'standup' }) });
  } catch (err) {
    try { await telemetry.endRun(run, { status: 'error', error: err }); } catch { /* fail-soft */ }
    process.stderr.write(`[standup] ${err.message}\n`);
    process.exit(1);
  }
  try { await telemetry.endRun(run, { status: 'ok', reply: `len=${body ? body.length : 0}` }); } catch { /* fail-soft */ }
  emit(renderStandupBlock(body));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[standup] ${err.code === 'PROVIDER_NONE' ? err.message : 'fatal: ' + ((err && err.stack) || err)}\n`);
    process.exit(1);
  });
}

module.exports = { buildStandupContext, renderStandupBlock, appendToDailyNote, STANDUP_FOCUS };
