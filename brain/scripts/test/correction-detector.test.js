'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cdet-'));
for (const d of ['brain/_index', 'brain/memory/feedback/_drafts']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# t');
process.env.BRAIN_VAULT = TMP;
const { detectCorrections, runCorrectionStage, MAX_DRAFTS_PER_SESSION, DETECT_SCHEMA } = require('../lib/correction-detector.js');
const { listDrafts, readEvents, METRICS_PATH } = require('../lib/feedback-drafts.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'correction-session.txt'), 'utf8');

const TWO_CORRECTIONS = { corrections: [
  { title: 'Use /usr/local/bin/node, never /opt/homebrew',
    description: 'assistant spawned the wrong node binary and had to be corrected',
    body: 'node lives at /usr/local/bin/node on this machine.\n\n**Why:** a spawn against /opt/homebrew failed this session.\n\n**How to apply:** use the absolute path /usr/local/bin/node in every spawn and script.\n\n**Evidence:** "no — node is at /usr/local/bin/node on this machine"' },
  { title: 'Ask before force-pushing any branch',
    description: 'user reverted an unrequested force push this session',
    body: 'Never force-push without an explicit ask.\n\n**Why:** an unrequested force push had to be reverted.\n\n**How to apply:** plain push by default; if rejected, ask before any --force.\n\n**Evidence:** "I did not ask you to force push"' },
]};
const twoChat = () => JSON.stringify(TWO_CORRECTIONS);

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'brain', 'memory', 'feedback'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'brain', 'memory', 'feedback', '_drafts'), { recursive: true });
  try { fs.unlinkSync(METRICS_PATH); } catch {}
  try { fs.unlinkSync(path.join(TMP, 'brain', '_index', 'promote-log.jsonl')); } catch {}
});

test('fixture transcript with 2 seeded corrections yields exactly 2 drafts', async () => {
  const out = await runCorrectionStage({ transcriptText: FIXTURE, sessionId: 's-fx', chatFn: twoChat });
  assert.equal(out.drafted, 2);
  assert.equal(out.recurred, 0);
  assert.equal(listDrafts().length, 2);
  const slugs = listDrafts().map((d) => d.slug);
  assert.ok(slugs.includes('ask-before-force-pushing-any-branch'));
  assert.equal(readEvents({ sinceDays: 1 }).filter((r) => r.event === 'captured').length, 2);
});

test('cap: 5 detected corrections produce at most 3 drafts', async () => {
  const five = { corrections: [
    'Always run tests before any commit', 'Never edit generated graph output files',
    'Prefer rg over grep inside scripts', 'Ask before deleting remote branches',
    'Use ISO dates in all filenames',
  ].map((t, i) => ({ title: t, description: `repeated correction number ${i} from this session`,
    body: `${t}.\n\n**Why:** corrected this session.\n\n**How to apply:** do it.\n\n**Evidence:** "quote"` })) };
  const out = await runCorrectionStage({ transcriptText: FIXTURE, sessionId: 's-cap', chatFn: () => JSON.stringify(five) });
  assert.equal(out.drafted, MAX_DRAFTS_PER_SESSION);
  assert.equal(listDrafts().length, 3);
});

test('a correction matching an existing ACTIVE rule logs recurred, writes no draft', async () => {
  fs.writeFileSync(path.join(TMP, 'brain', 'memory', 'feedback', 'use-usr-local-bin-node-never.md'),
    '---\ntype: memory\n---\n\n# Use /usr/local/bin/node, never /opt/homebrew\n\nbody\n');
  const out = await runCorrectionStage({ transcriptText: FIXTURE, sessionId: 's-rec', chatFn: twoChat });
  assert.equal(out.recurred, 1);
  assert.equal(out.drafted, 1);
  const rec = readEvents({ sinceDays: 1 }).filter((r) => r.event === 'recurred');
  assert.equal(rec.length, 1);
  assert.match(rec[0].matched, /usr\/local\/bin\/node/);
});

test('detectCorrections retries once on wrong shape, then recovers', async () => {
  let calls = 0;
  const driftThenGood = () => { calls++; return calls === 1 ? JSON.stringify({ summary: 'wrong' }) : twoChat(); };
  const out = await detectCorrections(FIXTURE, { chatFn: driftThenGood });
  assert.equal(calls, 2);
  assert.equal(out.length, 2);
});

test('detectCorrections hands the provider a real JSON Schema and its feature label', async () => {
  const seen = [];
  const out = await detectCorrections(FIXTURE, { chatFn: (o) => { seen.push(o); return twoChat(); } });
  assert.equal(out.length, 2);
  assert.deepEqual(seen[0].schema, DETECT_SCHEMA);
  assert.equal(seen[0].feature, 'correction-detector');
});

test('detector failure is soft: throwing chatFn yields zero corrections, zero drafts', async () => {
  const boom = () => { throw new Error('ollama down'); };
  const out = await runCorrectionStage({ transcriptText: FIXTURE, sessionId: 's-err', chatFn: boom });
  assert.deepEqual(out, { drafted: 0, recurred: 0, skipped: 0, reasons: [] });
  assert.equal(listDrafts().length, 0);
});

const { prefilterCorrections, needsReviewCandidate } = require('../lib/correction-detector.js');
const { writeDraft, parseDraft } = require('../lib/feedback-drafts.js');

test('prefilterCorrections finds correction-shaped user turns, capped, ignoring the assistant', () => {
  const t = [
    'user: no, use the other binary',
    'assistant: actually I think this is fine',
    'user: I said use tabs, not spaces',
    'user: looks good',
    'user: stop doing that in every file',
    'user: that\'s wrong, the path is /home/alice/x',
  ].join('\n');
  const out = prefilterCorrections(t);
  assert.equal(out.length, 3);
  assert.equal(out[0].quote, 'no, use the other binary');
  assert.equal(out[1].quote, 'I said use tabs, not spaces');
  assert.equal(out[2].quote, 'stop doing that in every file');
  assert.deepEqual(prefilterCorrections('user: all good\nassistant: no, wait'), []);
});

test('needsReviewCandidate passes the noise gate and writeDraft tags it needs-review', () => {
  const { gateCandidate } = require('../lib/noise-gate.js');
  const cand = needsReviewCandidate('no, use the other binary');
  assert.equal(cand.type, 'feedback');
  assert.ok(gateCandidate(cand, { existingTitles: [], revertedSlugs: new Set() }).ok);
  const res = writeDraft({ ...cand, session: 's-nr', needsReview: true });
  const raw = fs.readFileSync(res.draftPath, 'utf8');
  assert.match(raw, /tags: \[memory\/feedback, status\/needs-review\]/);
  assert.match(raw, /source: prefilter/);
  assert.match(raw, /\*\*Evidence:\*\* "no, use the other binary"/);
  assert.equal(parseDraft(res.draftPath).title, cand.title);
});
