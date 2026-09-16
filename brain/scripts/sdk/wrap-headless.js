#!/usr/bin/env node
/**
 * wrap-headless.js — autonomous session-end wrap. Local qwen (no SDK).
 *
 *   1. Run brain/scripts/wrap-session.js (mechanical: promote #promote, reset SESSION.md)
 *   2. qwen writes a narrative summary; we append it to today's daily note and
 *      refresh BRAIN.md "Last Session" programmatically (qwen has no tool-edit).
 *   3. Optional scoped commit of brain files only (default OFF — pass --commit).
 *
 * Usage:
 *   node brain/scripts/sdk/wrap-headless.js            # wrap, no commit
 *   node brain/scripts/sdk/wrap-headless.js --commit   # also commit brain files
 *   node brain/scripts/sdk/wrap-headless.js --print
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const brain = require('./lib/brain.js');
const { dailyNotePath } = require('../lib/paths.js');
const { chat } = require('./lib/ollama.js');

const flags = new Set(process.argv.slice(2));
const COMMIT = flags.has('--commit'); // default OFF — safe for a busy repo
const PRINT = flags.has('--print');
const VAULT = brain.PATHS.VAULT;
const log = (...a) => console.error(...a);

function git(argv) {
  const r = spawnSync('git', argv, { cwd: VAULT, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

// Replaces the "## Last Session" section in BRAIN.md. A separate, previously
// untested twin of update-session.js's renderLastSession — same bug class
// (a non-greedy up-to-next-heading-or-EOF match never consumes pre-existing
// trailing blank lines, so they pile up run over run) gets the same fix:
// greedy from the first run of newlines before the heading through to EOF,
// so old trailing whitespace is consumed and replaced, not left in place.
function renderLastSession(brainContent, newSection) {
  return brainContent.replace(/\n+## Last [Ss]ession[\s\S]*$/, '\n\n' + newSection);
}

async function main() {
  log('[wrap] 1/3 mechanical wrap…');
  const mech = spawnSync(process.execPath, [path.join(VAULT, 'brain/scripts/wrap-session.js')], { cwd: VAULT, encoding: 'utf8' });
  log('[wrap]', (mech.stdout || '').trim());

  log('[wrap] 2/3 qwen narrative…');
  const today = brain.todayDate();
  const notePath = dailyNotePath(new Date());
  const noteBefore = brain.readIfExists(notePath) || '';
  const status = git(['status', '--porcelain']);
  const diff = git(['diff', '--stat', 'HEAD']);

  const system = [
    "You are the user's session-end scribe. Produce a terse markdown summary of today's work. No preamble, no hedging, no emoji.",
    'Output exactly:',
    '## Summary', '<1-2 sentences>', '',
    '## What Happened', '- 3-6 bullets: what was built/changed, key decisions, open threads.',
  ].join('\n');
  const prompt = [
    `Today: ${today}`, '', '## Daily note so far', noteBefore.slice(0, 6000),
    '', '## git status --porcelain', status || '(clean)',
    '', '## git diff --stat HEAD', diff || '(no diff)',
  ].join('\n');

  let text = '';
  try { text = await chat({ system, prompt, numPredict: 1024 }); }
  catch (e) { log('[wrap] qwen error:', e.message); }

  if (text) {
    const now = new Date().toLocaleString('en-US', { hour12: false });
    try {
      fs.appendFileSync(notePath, `\n\n## Wrap Summary @ ${now}\n${text}\n`);
    } catch (e) { log('[wrap] note append failed:', e.message); }
    // Refresh BRAIN.md "Last Session"
    try {
      const BRAIN = path.join(VAULT, 'brain/_index/BRAIN.md');
      const b = fs.readFileSync(BRAIN, 'utf8');
      const firstLine = text.split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#')) || text.slice(0, 120);
      const newSection = `## Last Session\n- **Date**: ${today}\n- **Auto-summary**: ${firstLine}\n`;
      fs.writeFileSync(BRAIN, renderLastSession(b, newSection));
    } catch (e) { log('[wrap] BRAIN.md update failed:', e.message); }
  }

  if (COMMIT) {
    log('[wrap] 3/3 commit (brain files only)…');
    const rel = path.relative(VAULT, notePath);
    git(['add', rel, 'brain/_index/BRAIN.md', 'brain/_index/SESSION.md', 'MEMORY.md', 'brain/memory']);
    const r = spawnSync('git', ['commit', '-m', `vault: session wrap ${today}`], { cwd: VAULT, encoding: 'utf8' });
    log('[wrap]', (r.stdout || r.stderr || '').trim().split('\n')[0]);
  } else {
    log('[wrap] 3/3 commit skipped (pass --commit to enable).');
  }

  if (PRINT) process.stdout.write((text || '(no summary)') + '\n');
  log('[wrap] complete.');
}

if (require.main === module) {
  main().catch(err => { console.error('[wrap] fatal:', err?.stack || err); process.exit(1); });
}

module.exports = { renderLastSession };
