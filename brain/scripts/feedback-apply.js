#!/usr/bin/env node
'use strict';
/**
 * feedback-apply.js — approve/reject feedback drafts by slug. The thin CLI the
 * feedback-autoloop skill drives after its AskUserQuestion batch review.
 *   node feedback-apply.js --list
 *   node feedback-apply.js --approve <slug>   # promotes via memory-writer.js
 *   node feedback-apply.js --reject <slug>    # deletes + remembers the rejection
 */
const { applyDraft, rejectDraft, listDrafts } = require('./lib/feedback-drafts.js');

const [, , flag, slug] = process.argv;
try {
  if (flag === '--list') {
    const drafts = listDrafts();
    if (!drafts.length) console.log('no drafts pending');
    for (const d of drafts) console.log(`${d.slug} | ${d.title} | ${d.description}`);
  } else if (flag === '--approve' && slug) {
    console.log(`applied: ${applyDraft(slug).memoryPath}`);
  } else if (flag === '--reject' && slug) {
    console.log(`rejected: ${rejectDraft(slug).slug}`);
  } else {
    console.error('usage: feedback-apply.js --list | --approve <slug> | --reject <slug>');
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
