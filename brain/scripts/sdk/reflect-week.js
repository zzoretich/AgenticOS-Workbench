#!/usr/bin/env node
/**
 * reflect-week.js — weekly reflection from the last 7 daily notes + git history.
 * Local qwen (no SDK). Writes brain/reflections/<YYYY-WW>.md.
 *
 * Usage:
 *   node brain/scripts/sdk/reflect-week.js [--weeks=N] [--print]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const brain = require('./lib/brain.js');
const { reason } = require('./lib/qwen.js');

const rawArgs = process.argv.slice(2);
const args = new Map(rawArgs.map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const WEEKS = parseInt(args.get('weeks') || '1', 10);
const PRINT = !!args.get('print');
const log = (...a) => console.error(...a);

function gitLog(days) {
  try {
    return execSync(`git log --since="${days} days ago" --pretty=format:"%h %ad %s" --date=short`, {
      cwd: brain.PATHS.VAULT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

function truncate(text, max = 2000) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

async function main() {
  const days = WEEKS * 7;
  const sessions = brain.listSessions(days + 5);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const inWindow = sessions.filter(s => new Date(s.date) >= cutoff);

  if (!inWindow.length) {
    log('[reflect] no daily notes in window; nothing to reflect on.');
    process.exit(0);
  }

  const sessionBlob = inWindow.map(s => `### ${s.date}\n${truncate(brain.readIfExists(s.absPath) || '')}`).join('\n\n');
  const gitBlob = gitLog(days);
  const snap = brain.loadSnapshot();
  const week = brain.isoWeek(new Date());
  const now = new Date().toISOString();

  const system = [
    "You are the user's reflective journal. Surface patterns, wins, losses, and open questions across a week of work — do not just restate what happened.",
    'Output a single markdown document in this exact shape:',
    '',
    '---', 'type: reflection', `week: ${week}`, 'tags: [reflection, weekly]', `generated: ${now}`, '---', '',
    `# Reflection — ${week}`, '',
    '## Highlights (what actually moved)', '- Concrete wins with date anchors in backticks, 3-6 bullets max.', '',
    '## Patterns noticed', '- Recurring behaviors, decision tendencies, friction points. 2-5 bullets.', '',
    '## Open threads', '- Things still in flight, carrying over. Action-oriented.', '',
    '## Lessons', '- 1-3 distilled learnings. Terse. As rules if applicable.', '',
    '## Candidate memory updates', '- Propose new feedback/pattern memories. Format: `- [type] <filename>.md — <summary>`. Proposals only.', '',
    'Rules: no preamble, no hedging, no meta-commentary, no emoji. Terse. Empty section -> "(nothing of note)".',
  ].join('\n');

  const prompt = [
    `Reflect on the last ${days} days (${inWindow[inWindow.length - 1].date} → ${inWindow[0].date}). Write the reflection for week ${week}.`,
    '', '## Daily notes', sessionBlob,
    '', '## Git history', gitBlob || '(no commits in window)',
    '', '## Current vault state',
    snap ? `memories=${snap.brain?.counts?.memoryTotal || 0}, patterns=${snap.brain?.counts?.patterns || 0}, plans=${snap.plans?.summary?.total || 0}` : 'snapshot unavailable',
  ].join('\n');

  log(`[reflect] week=${week} notes=${inWindow.length} days=${days} — calling qwen…`);
  let text;
  try { text = await reason(prompt, { system, effort: 'medium', numPredict: 3072 }); }
  catch (e) { log('[reflect] qwen error:', e.message); process.exit(1); }
  if (!text) { log('[reflect] empty response; aborting.'); process.exit(1); }

  const output = text.includes('type: reflection')
    ? text
    : `---\ntype: reflection\nweek: ${week}\ntags: [reflection, weekly]\ngenerated: ${now}\n---\n\n${text}`;
  const outPath = path.join(brain.PATHS.REFLECTIONS_DIR, `${week}.md`);
  fs.mkdirSync(brain.PATHS.REFLECTIONS_DIR, { recursive: true });
  fs.writeFileSync(outPath, output);
  log(`[reflect] wrote ${path.relative(brain.PATHS.VAULT, outPath)}`);
  if (PRINT) process.stdout.write(output + '\n');
}

main().catch(err => { console.error('[reflect] fatal:', err?.stack || err); process.exit(1); });
