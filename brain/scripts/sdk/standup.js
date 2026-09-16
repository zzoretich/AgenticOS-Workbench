#!/usr/bin/env node
/**
 * standup.js — generate a Did/Doing/Blockers standup from recent daily notes + git + telemetry.
 * Prints to stdout AND appends a timestamped block to today's daily note.
 *
 * Usage: node brain/scripts/sdk/standup.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const brain = require('./lib/brain.js');
const { dailyNotePath } = require('../lib/paths.js');
const { summarize } = require('./lib/qwen.js');
const telemetry = require('./lib/telemetry.js');

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
  const prefix = fs.existsSync(notePath) && fs.readFileSync(notePath, 'utf8').trim() ? '\n\n' : '';
  fs.appendFileSync(notePath, prefix + block + '\n');
  return notePath;
}

async function main() {
  const sessions = brain.listSessions(5).slice(0, 2); // today + most recent prior
  const notes = sessions.map((s) => `### ${s.date}\n${brain.readIfExists(s.absPath) || ''}`).join('\n\n');
  const context = [
    '## Recent daily notes', notes || '(none)',
    '', '## Git (last 24h)', gitLog(1) || '(no commits)',
    '', '## Agent activity', recentTelemetry(20) || '(none)',
  ].join('\n');

  let run = null;
  try {
    run = telemetry.startRun({ script: 'standup', prompt: `context_len=${context.length}` });
  } catch (err) {
    process.stderr.write(`[telemetry] run_id=${crypto.randomUUID()}\n`);
  }

  let body;
  try {
    body = await summarize(context, {
      style: 'bullets',
      maxWords: 180,
      focus: 'a standup with exactly three sections — **Did** (recent/yesterday), **Doing** (today/next), **Blockers**. Terse bullets under each. If a section is empty, write "(nothing)".',
    });
  } catch (err) {
    try { await telemetry.endRun(run, { status: 'error', error: err }); } catch { /* fail-soft */ }
    process.stderr.write(`[standup] ${err.message}\n`);
    process.exit(1);
  }
  try { await telemetry.endRun(run, { status: 'ok', reply: `len=${body ? body.length : 0}` }); } catch { /* fail-soft */ }

  const hhmm = new Date().toTimeString().slice(0, 5);
  const block = `## Standup — ${hhmm}\n\n${body}`;
  process.stdout.write(block + '\n');
  try {
    const p = appendToDailyNote(block);
    process.stderr.write(`[standup] appended to ${path.relative(brain.PATHS.VAULT, p)}\n`);
  } catch (err) {
    process.stderr.write(`[standup] note append failed: ${err.message}\n`);
  }
}

main().catch((err) => { process.stderr.write(`[standup] fatal: ${(err && err.stack) || err}\n`); process.exit(1); });
