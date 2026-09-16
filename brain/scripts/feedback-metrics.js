#!/usr/bin/env node
'use strict';
/**
 * feedback-metrics.js — the honest "is this thing learning?" line for the
 * weekly reflect duty: corrections captured vs corrections that RECURRED
 * despite an existing rule. Reads brain/_index/feedback-metrics.jsonl
 * (written by lib/feedback-drafts.js + lib/correction-detector.js).
 *   node feedback-metrics.js [--days N]   # default 7
 */
const { readEvents } = require('./lib/feedback-drafts.js');

function summarize(rows) {
  const count = (ev) => rows.filter((r) => r.event === ev).length;
  const recurredRules = [...new Set(
    rows.filter((r) => r.event === 'recurred').map((r) => r.matched).filter(Boolean)
  )];
  return {
    captured: count('captured'), applied: count('applied'),
    rejected: count('rejected'), recurred: count('recurred'), recurredRules,
  };
}

function formatLine(s, days) {
  const tail = s.recurredRules.length ? ` (recurred rules: ${s.recurredRules.join('; ')})` : '';
  return `feedback-autoloop last ${days}d: captured ${s.captured}, applied ${s.applied}, rejected ${s.rejected}, recurred ${s.recurred}${tail}`;
}

if (require.main === module) {
  const i = process.argv.indexOf('--days');
  const days = i > -1 ? (Number(process.argv[i + 1]) || 7) : 7;
  console.log(formatLine(summarize(readEvents({ sinceDays: days })), days));
}

module.exports = { summarize, formatLine };
