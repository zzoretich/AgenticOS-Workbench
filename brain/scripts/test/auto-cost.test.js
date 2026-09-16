'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findTranscript, costTranscript } = require('../auto-cost.js');

test('findTranscript locates a transcript in any projects/<slug>/ dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cost-'));
  try {
    fs.mkdirSync(path.join(root, '-home-alice--claude'), { recursive: true });
    fs.mkdirSync(path.join(root, '-'), { recursive: true });
    fs.writeFileSync(path.join(root, '-', 'aaaa-1111.jsonl'), '{}\n');
    fs.writeFileSync(path.join(root, '-home-alice--claude', 'bbbb-2222.jsonl'), '{}\n');
    assert.equal(findTranscript('aaaa-1111', root), path.join(root, '-', 'aaaa-1111.jsonl'));
    assert.equal(findTranscript('bbbb-2222', root),
      path.join(root, '-home-alice--claude', 'bbbb-2222.jsonl'));
    assert.equal(findTranscript('cccc-3333', root), null);
    assert.equal(findTranscript('', root), null);
    assert.equal(findTranscript('aaaa-1111', path.join(root, 'no-such-dir')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Regression: these three outcomes used to collapse into a bare `false`, so
// costOne() threw "costTranscript failed" for a session that simply had no
// transcript to cost — a permanent, unactionable Fix Queue entry.
test('costTranscript reports no-transcript rather than a generic failure', () => {
  assert.equal(costTranscript(null, 'sess-1').status, 'no-transcript');
  assert.equal(costTranscript('', 'sess-1').status, 'no-transcript');
  assert.equal(
    costTranscript(path.join(os.tmpdir(), 'auto-cost-definitely-absent.jsonl'), 'sess-1').status,
    'no-transcript');
});

test('costTranscript surfaces a real analyzer failure with its stderr', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cost-fail-'));
  try {
    // A transcript that exists but is not valid JSONL: the analyzer runs and
    // fails, which must be distinguishable from "no transcript".
    const t = path.join(root, 'dddd-4444.jsonl');
    fs.writeFileSync(t, 'not json at all\n');
    const r = costTranscript(t, 'dddd-4444');
    assert.ok(['ok', 'analyzer-failed', 'no-analyzer'].includes(r.status),
      `unexpected status ${r.status}`);
    if (r.status === 'analyzer-failed') assert.ok(r.detail, 'a failure must carry detail');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
