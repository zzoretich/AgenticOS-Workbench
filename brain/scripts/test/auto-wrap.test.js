'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awrap-'));
for (const d of ['brain/_index', 'brain/memory/feedback', 'brain/memory/projects']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
fs.writeFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'),
  '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n- (template)\n\n## Things to Remember\n');
process.env.BRAIN_VAULT = TMP;
const { runAutoWrap } = require('../auto-wrap.js');

const GOOD_EXTRACTION = {
  facts: ['Shipped the pipelines ledger', 'All suites green'],
  decisions: ['History ring rescues only killed runs'],
  feedback: [], threads: ['P2 file map next'],
  candidates: [{ type: 'feedback', title: 'Commit immediately after green tests',
    description: 'auto-backup races sweep finished files otherwise',
    body: 'Commit as soon as a gate passes.\n**Why:** vault auto-backup races.\n**How to apply:** stage + commit per task.' }],
};
const goodChat = () => JSON.stringify(GOOD_EXTRACTION);
const junkChat = () => JSON.stringify({ facts: [], decisions: [], feedback: [], threads: [], candidates: [] });

beforeEach(() => {
  try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')); } catch {}
  for (const f of fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback'))) {
    fs.rmSync(path.join(TMP, 'brain', 'memory', 'feedback', f), { recursive: true, force: true });
  }
  try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'feedback-metrics.jsonl')); } catch {}
  fs.writeFileSync(path.join(TMP, 'MEMORY.md'), '# Index\n');
  // A prior corrections-stage test may have upserted "## Pending Feedback
  // Drafts" into the shared SESSION.md; strip it so tests asserting its
  // absence aren't coupled to run order. Same anchored-section regex as
  // auto-wrap.js's own upsertSection.
  try {
    const sessionPath = path.join(TMP, 'brain', '_index', 'SESSION.md');
    const content = fs.readFileSync(sessionPath, 'utf8');
    fs.writeFileSync(sessionPath, content.replace(/## Pending Feedback Drafts[\s\S]*?(?=\n## |$)/, '').replace(/\n{3,}/g, '\n\n'));
  } catch {}
});

test('a real session writes a memory, a trail entry, and fills SESSION.md', async () => {
  const report = { wrote: [], counts: {} };
  const out = await runAutoWrap({ transcriptText: 'user: build it\nassistant: built it\n'.repeat(40), sessionId: 'sess-t1', chatFn: goodChat, report });
  assert.equal(out.written, 1);
  assert.ok(fs.existsSync(path.join(TMP, 'brain', 'memory', 'feedback', 'commit-immediately-after-green-tests.md')));
  const trail = fs.readFileSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl'), 'utf8');
  assert.match(trail, /"action":"written"/);
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /Shipped the pipelines ledger/);
  assert.ok(!/\(template\)/.test(session));
  assert.equal(report.counts.written, 1);
});

test('a junk transcript produces ZERO writes and counts.skipped', async () => {
  const report = { wrote: [], counts: {} };
  const out = await runAutoWrap({ transcriptText: 'hi', sessionId: 'sess-t2', chatFn: junkChat, report });
  assert.equal(out.written, 0);
  assert.ok(!fs.existsSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')));
  assert.equal(fs.readFileSync(path.join(TMP, 'MEMORY.md'), 'utf8'), '# Index\n');
});

test('a previously reverted slug is skipped even when re-proposed', async () => {
  const { appendTrail } = require('../lib/promote-log.js');
  appendTrail({ session: 's0', action: 'reverted', slug: 'commit-immediately-after-green-tests', type: 'feedback', title: 'x' });
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t3', chatFn: goodChat, report: { wrote: [], counts: {} } });
  assert.equal(out.written, 0);
  assert.match(out.reasons.join(' '), /reverted/);
});

test('SESSION.md stays within its 400-token budget', async () => {
  const bigChat = () => JSON.stringify({ ...GOOD_EXTRACTION, facts: Array(200).fill('a very long fact line that repeats endlessly to blow the budget wide open') });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t4', chatFn: bigChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  const { estimateTokens } = require('../lib/text-budget.js');
  assert.ok(estimateTokens(session) <= 400, `SESSION.md is ${estimateTokens(session)} tokens`);
});

test('within-batch near-duplicate candidates: first written, second gated against it', async () => {
  const dupChat = () => JSON.stringify({
    facts: ['Shipped the pipelines ledger', 'All suites green'],
    decisions: ['History ring rescues only killed runs'],
    feedback: [], threads: ['P2 file map next'],
    candidates: [
      { type: 'feedback', title: 'Commit immediately after green tests pass',
        description: 'auto-backup races sweep finished files otherwise',
        body: 'Commit as soon as a gate passes.\n**Why:** vault auto-backup races.\n**How to apply:** stage + commit per task.' },
      { type: 'feedback', title: 'Commit immediately after green tests today',
        description: 'auto-backup races sweep finished files otherwise too',
        body: 'Commit as soon as a gate passes today.\n**Why:** vault auto-backup races.\n**How to apply:** stage + commit per task now.' },
    ],
  });
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t5', chatFn: dupChat, report: { wrote: [], counts: {} } });
  assert.equal(out.written, 1);
  assert.equal(out.skipped, 1);
  assert.match(out.reasons.join(' '), /near-duplicate/);
});

test('a drifted first extraction gets one harder-framed retry and recovers', async () => {
  let calls = 0;
  const driftThenGoodChat = () => {
    calls++;
    if (calls === 1) return JSON.stringify({ summary: 'wrong shape entirely', hooks_executed: [] });
    return JSON.stringify(GOOD_EXTRACTION);
  };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t6', chatFn: driftThenGoodChat, report: { wrote: [], counts: {} } });
  assert.equal(calls, 2, 'chatFn should be called twice: once, then a harder-framed retry');
  assert.equal(out.written, 1);
});

test('an unparseable first reply gets the harder-framed retry and recovers', async () => {
  let calls = 0;
  const proseThenGoodChat = () => {
    calls++;
    if (calls === 1) return 'Sorry, there is nothing to extract here.'; // parse failure, not shape drift
    return JSON.stringify(GOOD_EXTRACTION);
  };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t8', chatFn: proseThenGoodChat, report: { wrote: [], counts: {} } });
  assert.equal(calls, 2, 'chatFn should be called twice: parse failure, then a harder-framed retry');
  assert.equal(out.written, 1);
});

test('two unparseable replies surface the original parse error', async () => {
  const proseChat = () => 'still no json, no matter how you ask';
  await assert.rejects(
    () => runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t9', chatFn: proseChat, report: { wrote: [], counts: {} } }),
    (e) => /no JSON object found/.test(e.message)
  );
});

test('non-string bullet items are coerced, not rendered as [object Object]', async () => {
  const objectBulletChat = () => JSON.stringify({
    facts: ['', 'Shipped the pipelines ledger'],
    decisions: [{ decision: 'History ring rescues only killed runs', why: 'safety' }],
    feedback: [], threads: [],
    candidates: [],
  });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t7', chatFn: objectBulletChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /History ring rescues only killed runs/);
  assert.ok(!session.includes('[object Object]'), 'must not render [object Object]');
  assert.ok(!/^-\s*$/m.test(session), 'must not leave a blank bullet line');
});

// Regression for the live 2026-08-14 failure (session 5f80f2ce): qwen returned
// {user,context} and {correction,context} objects, which matched none of the
// round-3 preferred keys and were dumped as truncated JSON into SESSION.md.
test('object keys outside the preferred list yield prose, never raw JSON', async () => {
  const unlistedKeyChat = () => JSON.stringify({
    facts: ['Relocated the brief output to cloud storage'],
    decisions: [{ user: 'Clarified "sandbox" as harness-enforced limits', context: 'user questioned loose usage' }],
    feedback: [{ correction: 'Sandbox bounds blast radius, not correctness', context: 'raised during the audit' }],
    threads: [{ nested: { noStringAnywhere: 1 } }],
    candidates: [],
  });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-t10', chatFn: unlistedKeyChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /Clarified "sandbox" as harness-enforced limits/);
  assert.match(session, /Sandbox bounds blast radius, not correctness/);
  assert.ok(!session.includes('{"'), 'must not leak raw JSON into auto-injected brain-context');
  assert.ok(!/noStringAnywhere/.test(session), 'object with no string value is dropped, not dumped');
});

// Fix round 6 regression (found while verifying round 5): budgeting charged the
// previous run's OWN bullets as fixed overhead, so a repeat run dropped every
// section and upsertSection's empty-body contract then deleted both headings.
// Deliberately sized into the pathological zone: the residual alone leaves room
// for the bullets, but residual + a previous run's copy of those same bullets
// does not. Outside that zone the bug is invisible — an oversized base is
// dropped wholesale by fitToBudget, so the sections fit anyway. Verified to FAIL
// against the pre-fix `{name:'base', text: content}` accounting.
test('a repeat run against a populated SESSION.md converges instead of wiping it', async () => {
  const { estimateTokens } = require('../lib/text-budget.js');
  const p = path.join(TMP, 'brain', '_index', 'SESSION.md');

  const chat = () => JSON.stringify({
    facts: [1, 2, 3, 4, 5, 6].map((i) =>
      `Bound the brief to the work M365 account so it cannot fall back to a personal mailbox (${i})`),
    decisions: ['Chose the residual-based budget'],
    feedback: [], threads: [], candidates: [],
  });

  // ~200 tokens of overhead auto-wrap does not own, computed so a template
  // change cannot silently move this out of the zone.
  let seed = '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n\n';
  while (estimateTokens(seed) < 200) seed += '- a pre-existing remembered note\n';
  fs.writeFileSync(p, seed);

  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-i1', chatFn: chat, report: { wrote: [], counts: {} } });
  const first = fs.readFileSync(p, 'utf8');
  assert.match(first, /## Key Context This Session/);
  assert.match(first, /cannot fall back to a personal mailbox \(6\)/, 'first run keeps every fact');

  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-i2', chatFn: chat, report: { wrote: [], counts: {} } });
  const second = fs.readFileSync(p, 'utf8');
  assert.match(second, /## Key Context This Session/, 'repeat run must not delete the heading');
  assert.match(second, /cannot fall back to a personal mailbox \(6\)/, 'repeat run must not drop the facts');
  assert.equal(second, first, 'repeat run must converge byte-for-byte');
});

test('the 400-token budget still bites when the residual itself is oversized', async () => {
  const { estimateTokens } = require('../lib/text-budget.js');
  const p = path.join(TMP, 'brain', '_index', 'SESSION.md');
  // Pad a section auto-wrap does NOT own until the residual nearly fills the
  // budget. Computed rather than hard-coded so a template change cannot quietly
  // turn this into a no-op.
  let bloated = '---\ntype: session\n---\n\n# SESSION\n\n## Key Context This Session\n\n## Things to Remember\n\n';
  while (estimateTokens(bloated) < 380) bloated += '- a remembered note that consumes real budget\n';
  fs.writeFileSync(p, bloated);

  const filler = 'this run has no room left in the working-memory budget for another bullet, so it goes. ';
  const chat = () => JSON.stringify({
    facts: [`KEEPME ${filler.repeat(3)}`], decisions: [`KEEPME2 ${filler.repeat(3)}`],
    feedback: [], threads: [], candidates: [],
  });
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-i3', chatFn: chat, report: { wrote: [], counts: {} } });
  const out = fs.readFileSync(p, 'utf8');
  assert.ok(!out.includes('KEEPME'), 'an oversized residual must still push generated bullets out');
  // Heading absent proves writeSessionSections ran and emptied the section,
  // rather than the junk gate skipping it and passing this test for free.
  assert.ok(!out.includes('## Key Context This Session'), 'empty body must remove the heading');
});

test('corrections stage: 2 detections become 2 drafts and a pending SESSION.md section', async () => {
  const correctionChat = () => JSON.stringify({ corrections: [
    { title: 'Use /usr/local/bin/node, never /opt/homebrew',
      description: 'assistant spawned the wrong node binary and had to be corrected',
      body: 'node lives at /usr/local/bin/node.\n\n**Why:** wrong spawn.\n\n**How to apply:** absolute path.\n\n**Evidence:** "node is at /usr/local/bin/node"' },
    { title: 'Ask before force-pushing any branch',
      description: 'user reverted an unrequested force push this session',
      body: 'Never force-push unasked.\n\n**Why:** revert cost.\n\n**How to apply:** plain push; ask first.\n\n**Evidence:** "I did not ask you to force push"' },
  ]});
  const report = { wrote: [], counts: {} };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-c1', chatFn: goodChat, report, corrections: { enabled: true, chatFn: correctionChat } });
  assert.equal(out.written, 1); // main extraction path untouched
  assert.equal(report.counts.drafted, 2);
  const drafts = fs.readdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts')).filter((n) => n.endsWith('.md'));
  assert.equal(drafts.length, 2);
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.match(session, /## Pending Feedback Drafts/);
  assert.match(session, /2 draft feedback rules pending review/);
});

test('corrections stage omitted: no detector call, no pending section', async () => {
  await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-c2', chatFn: goodChat, report: { wrote: [], counts: {} } });
  const session = fs.readFileSync(path.join(TMP, 'brain', '_index', 'SESSION.md'), 'utf8');
  assert.ok(!session.includes('Pending Feedback Drafts'));
});

test('corrections stage failure never breaks the wrap', async () => {
  const boom = () => { throw new Error('ollama down'); };
  const out = await runAutoWrap({ transcriptText: 'x'.repeat(200), sessionId: 'sess-c3', chatFn: goodChat, report: { wrote: [], counts: {} }, corrections: { enabled: true, chatFn: boom } });
  assert.equal(out.written, 1);
});
