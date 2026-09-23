'use strict';
// cross-review/runner.js (spec 2026-09-23-cross-review). The cases port upstream claudex-loop tests/test_runner.py at
// 8cf5e2c (real subprocesses, disposable git repos, one fake CLI playing both providers, no model calls), plus what the
// AgenticOS port adds: the child's env, the ledger row, runs.jsonl, the daily cap, the host check and same-provider labels.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const R = require('../cross-review/runner.js');

const RUNNER = path.join(__dirname, '..', 'cross-review', 'runner.js');
const SESSION = '12345678-1234-4567-8123-123456789abc';

// One fake for both CLIs: `exec` in argv means codex. FAKE_CASE picks the behaviour; FAKE_DIR collects what it saw.
const FAKE = `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const codex = argv[0] === 'exec' || path.basename(process.argv[1]) === 'codex';
if (argv.includes('--version')) { console.log(codex ? 'codex-cli 9.9.9' : '9.9.9 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_OUT !== 'claude' })); process.exit(0); }
if (argv[0] === 'login') { if (process.env.FAKE_LOGGED_OUT === 'codex') { console.log('Not logged in'); process.exit(1); } console.log('Logged in using ChatGPT'); process.exit(0); }
const who = codex ? 'codex' : 'claude';
const dir = process.env.FAKE_DIR;
const kase = process.env['FAKE_CASE_' + who.toUpperCase()] || process.env.FAKE_CASE || 'ok';
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(dir, who + '-args.json'), JSON.stringify(argv));
fs.writeFileSync(path.join(dir, who + '-prompt.txt'), prompt);
fs.writeFileSync(path.join(dir, who + '-env.json'), JSON.stringify({ AOS_HEADLESS: process.env.AOS_HEADLESS || null, CLAUDECODE: process.env.CLAUDECODE || null, CODEX_HOME: process.env.CODEX_HOME || null }));
if (kase === 'timeout') {
  const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'pids'), process.pid + ' ' + kid.pid);
  setTimeout(() => {}, 30000);
  return;
}
if (kase === 'exit') { console.error('Authentication failed'); process.exit(7); }
if (kase === 'empty') process.exit(0);
if (kase === 'mutate_plan') fs.writeFileSync(process.env.FAKE_PLAN, 'Changed after launch');
if (kase === 'mutate_code') fs.writeFileSync('new.py', 'changed during inspection');
if (kase === 'build') fs.writeFileSync('built.py', 'print(42)\\n');
if (kase === 'commit') { fs.writeFileSync('built.py', 'x'); require('child_process').execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'x', '--allow-empty']); }
let review = { verdict: 'APPROVED', summary: 'Inspected supplied plan.', findings: [], coverage: ['custom plan.md'], limitations: [] };
if (kase === 'revise') review = { ...review, verdict: 'REVISE', findings: [{ id: 'R1', severity: 'high', path: 'plan', evidence: 'Deletion before successful copy loses the only copy.', fix: 'Verify the new copy first.' }] };
if (kase === 'approved_material') review = { ...review, findings: [{ id: 'R1', severity: 'medium', path: 'plan', evidence: 'e', fix: 'f' }] };
if (kase === 'blocked') review = { ...review, verdict: 'BLOCKED', coverage: [], limitations: ['Required schema unavailable.'] };
if (kase === 'malformed') review = { verdict: 'APPROVED' };
const text = ['build', 'commit', 'text'].includes(kase) ? 'Built; proof passed.' : kase === 'blank' ? '   ' : JSON.stringify(review);
if (codex) {
  const out = argv[argv.indexOf('-o') + 1];
  fs.writeFileSync(out, kase === 'notjson' ? 'hello' : text);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '${SESSION}' }));
  if (kase === 'turn_failed') console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }));
  else if (kase !== 'incomplete') console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20000, cached_input_tokens: 0, output_tokens: 500 } }));
} else {
  const value = { type: 'result', subtype: 'success', is_error: false, session_id: kase === 'bad_session' ? 'nope' : '${SESSION}',
    structured_output: review, result: text, total_cost_usd: 0.12, modelUsage: { 'claude-fable-5-1': { inputTokens: 10 } }, usage: { input_tokens: 10, output_tokens: 5 } };
  if (kase === 'turn_failed') Object.assign(value, { subtype: 'error_during_execution', is_error: true });
  console.log(JSON.stringify(kase === 'array' ? [{ type: 'system', subtype: 'init' }, value] : value));
}
`;

const gitIn = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A vault, two fakes recorded as the host bins, and a git repo "with spaces" holding a committed plan. */
function sandbox({ cfg = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-xr-')));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  const bins = path.join(root, 'bin');
  fs.mkdirSync(bins);
  for (const n of ['claude', 'codex']) fs.writeFileSync(path.join(bins, n), FAKE, { mode: 0o755 });
  const fake = path.join(root, 'fake');
  fs.mkdirSync(fake);
  const repo = path.join(root, 'repo with spaces');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'custom plan.md'), '# Plan\n\nCopy, verify, then delete.\n');
  fs.writeFileSync(path.join(repo, 'app.py'), 'print(1)\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-qm', 'base');
  const config = path.join(root, 'agenticos.json');
  fs.writeFileSync(config, JSON.stringify({ vault, hosts: { claude: { enabled: true, bin: path.join(bins, 'claude') }, codex: { enabled: true, bin: path.join(bins, 'codex') } }, ...cfg }));
  const env = { PATH: process.env.PATH, HOME: root, AOS_VAULT: vault, AOS_CONFIG: config, CODEX_HOME: path.join(root, 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-cfg'), FAKE_DIR: fake, FAKE_PLAN: path.join(repo, 'custom plan.md') };
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    const first = (r.stdout || '').split('\n')[0];
    let record = null;
    try { const launch = JSON.parse(first); record = JSON.parse(fs.readFileSync(path.join(launch.artifacts, 'result.json'), 'utf8')); record.resultFile = path.join(launch.artifacts, 'result.json'); } catch { record = null; }
    return { ...r, record };
  };
  const seen = (who, what) => { const p = path.join(fake, `${who}-${what}`); return what.endsWith('.json') ? JSON.parse(fs.readFileSync(p, 'utf8')) : fs.readFileSync(p, 'utf8'); };
  const spendRows = () => { try { return fs.readFileSync(path.join(vault, 'brain', '_index', 'provider-spend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  const runRows = () => { try { return fs.readFileSync(path.join(vault, 'brain', '_index', 'cross-review', 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { root, vault, repo, env, run, seen, spendRows, runRows, plan: path.join(repo, 'custom plan.md') };
}

const PLAN = ['--plan', 'custom plan.md'];

// ── pure pieces ───────────────────────────────────────────────────────────────
test('resolveRoles: the other provider reviews; the inspector is opposite the builder; same-provider only when asked', () => {
  assert.deepEqual(R.resolveRoles('claude'), { host: 'claude', planner: 'claude', reviewer: 'codex', builder: 'claude', inspector: 'codex' });
  assert.deepEqual(R.resolveRoles('codex', { builder: 'claude' }), { host: 'codex', planner: 'codex', reviewer: 'claude', builder: 'claude', inspector: 'codex' });
  assert.deepEqual(R.resolveRoles('claude', { sameProvider: true }), { host: 'claude', planner: 'claude', reviewer: 'claude', builder: 'claude', inspector: 'claude' });
  assert.throws(() => R.resolveRoles('gemma'), R.UsageError);
});

test('validateReview: structure, verdict consistency, unique ids and severities', () => {
  const good = { verdict: 'APPROVED', summary: 's', findings: [], coverage: ['p'], limitations: [] };
  assert.equal(R.validateReview(good), good, 'zero findings is a valid approval');
  assert.ok(R.validateReview({ ...good, findings: [{ id: 'L1', severity: 'low', path: 'p', evidence: 'e', fix: 'f' }] }), 'low advice may accompany APPROVED');
  const bad = [
    [{ verdict: 'APPROVED' }, /exactly verdict/],
    [{ ...good, extra: 1 }, /exactly verdict/],
    [{ ...good, verdict: 'LGTM' }, /Invalid review verdict/],
    [{ ...good, summary: ' ' }, /Missing review summary/],
    [{ ...good, coverage: [] }, /identify what was inspected/],
    [{ ...good, coverage: [''] }, /Invalid coverage/],
    [{ ...good, findings: [{ id: 'a', severity: 'high', path: 'p', evidence: 'e', fix: 'f' }] }, /APPROVED cannot contain/],
    [{ ...good, verdict: 'REVISE' }, /REVISE must explain/],
    [{ ...good, verdict: 'BLOCKED', coverage: [] }, /BLOCKED must explain/],
    [{ ...good, verdict: 'REVISE', findings: [{ id: 'a', severity: 'critical', path: 'p', evidence: 'e', fix: 'f' }] }, /severity must be/],
    [{ ...good, verdict: 'REVISE', findings: [{ id: 'a', severity: 'high', path: 'p', evidence: 'e', fix: 'f' }, { id: 'a', severity: 'low', path: 'p', evidence: 'e', fix: 'f' }] }, /unique/],
    [{ ...good, verdict: 'REVISE', findings: [{ id: 'a', severity: 'high', path: 'p', evidence: '', fix: 'f' }] }, /needs an id/],
    [{ ...good, verdict: 'REVISE', findings: [{ id: 'a', severity: 'high', path: 'p', evidence: 'e' }] }, /Invalid finding fields/],
  ];
  for (const [value, re] of bad) assert.throws(() => R.validateReview(value), re, JSON.stringify(value));
  assert.ok(R.validateReview({ ...good, verdict: 'BLOCKED', coverage: [], limitations: ['no access'] }), 'BLOCKED needs no coverage');
});

test('snapshot: tracked, staged, deleted and untracked changes, without staging anything', () => {
  const s = sandbox();
  const base = gitIn(s.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(s.repo, 'app.py'), 'print(2)\n');
  fs.writeFileSync(path.join(s.repo, 'staged.py'), 's\n');
  gitIn(s.repo, 'add', 'staged.py');
  fs.rmSync(path.join(s.repo, 'custom plan.md'));
  fs.writeFileSync(path.join(s.repo, 'new.py'), 'n\n');
  const snap = R.snapshot(s.repo, base);
  assert.deepEqual(snap.files.map((f) => `${f.kind}:${f.path}`), ['file:app.py', 'deleted:custom plan.md', 'file:new.py', 'file:staged.py']);
  assert.equal(snap.base, base);
  assert.equal(gitIn(s.repo, 'diff', '--cached', '--name-only'), 'staged.py', 'nothing new was staged');
  fs.writeFileSync(path.join(s.repo, 'new.py'), 'n2\n');
  assert.notEqual(R.snapshot(s.repo, base).sha256, snap.sha256, 'an untracked edit changes the fingerprint');
});

// ── review ────────────────────────────────────────────────────────────────────
test('review from claude: a read-only, ephemeral codex reviewer with a strict schema; ledgered, indexed, AOS_HEADLESS child', () => {
  const s = sandbox();
  const r = s.run(['review', '--host', 'claude', ...PLAN], { CLAUDECODE: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rec = r.record;
  assert.equal(rec.status, 'completed');
  assert.equal(rec.provider, 'codex');
  assert.equal(rec.independence, 'cross-provider');
  assert.equal(rec.response.verdict, 'APPROVED');
  assert.equal(rec.sessionId, SESSION);
  assert.equal(rec.plan, s.plan);
  assert.match(rec.planSha256, /^[0-9a-f]{64}$/);
  assert.ok(rec.artifacts.startsWith(path.join(s.vault, 'brain', '_index', 'cross-review', 'runs') + path.sep), rec.artifacts);
  for (const f of ['prompt.txt', 'command.json', 'stdout.txt', 'stderr.txt', 'result.json', 'schema.json']) assert.ok(fs.existsSync(path.join(rec.artifacts, f)), f);
  const argv = s.seen('codex', 'args.json');
  for (const flag of ['--ephemeral', 'read-only', 'features.hooks=false', 'features.apps=false', 'approval_policy="never"', '--output-schema']) assert.ok(argv.includes(flag), flag);
  const schema = JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema') + 1], 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['verdict', 'summary', 'findings', 'coverage', 'limitations']);
  assert.deepEqual(s.seen('codex', 'env.json'), { AOS_HEADLESS: '1', CLAUDECODE: null, CODEX_HOME: s.env.CODEX_HOME });
  const prompt = s.seen('codex', 'prompt.txt');
  assert.match(prompt, /You are the independent reviewer/);
  assert.match(prompt, /<plan>\n# Plan\n\nCopy, verify, then delete\.\n\n<\/plan>/);
  const [row] = s.spendRows();
  assert.equal(row.feature, 'cross-review:review');
  assert.equal(row.provider, 'codex');
  assert.ok(row.usd > 0, 'codex spend is estimated from the usage block');
  assert.equal(rec.usd, row.usd);
  const [idx] = s.runRows();
  assert.equal(idx.schema, 1);
  assert.equal(idx.verdict, 'APPROVED');
  assert.equal(idx.independence, 'cross-provider');
  assert.equal(idx.status, 'completed');
});

test('review from codex: a claude reviewer in safe mode with only Read/Glob/Grep, the per-call cap, the reported cost', () => {
  const s = sandbox({ cfg: { crossReview: { claudeModel: 'claude-fable-5-1', perCallUsd: 2 } } });
  const r = s.run(['review', '--host', 'codex', ...PLAN, '--effort', 'max']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.record.provider, 'claude');
  assert.equal(r.record.requestedModel, 'claude-fable-5-1');
  assert.deepEqual(r.record.observedModels, ['claude-fable-5-1']);
  const argv = s.seen('claude', 'args.json');
  for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--no-chrome', '--json-schema']) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '2');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'max');
  assert.equal(s.spendRows()[0].usd, 0.12);
  assert.equal(s.spendRows()[0].model, 'claude-fable-5-1');
});

test('a completed turn is not approval: REVISE and BLOCKED complete with their verdict', () => {
  const s = sandbox();
  for (const [kase, verdict] of [['revise', 'REVISE'], ['blocked', 'BLOCKED']]) {
    const r = s.run(['review', '--host', 'claude', ...PLAN], { FAKE_CASE: kase });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.record.response.verdict, verdict);
  }
});

test('failed, empty, malformed and inconsistent turns never count as a review', () => {
  const s = sandbox();
  const cases = [
    ['claude', 'exit', /codex exited 7/], ['claude', 'empty', /Missing or ambiguous Codex/], ['claude', 'turn_failed', /failed turn/],
    ['claude', 'incomplete', /Missing or ambiguous Codex/], ['claude', 'notjson', /not JSON/], ['claude', 'malformed', /exactly verdict/],
    ['claude', 'approved_material', /APPROVED cannot contain/],
    ['codex', 'turn_failed', /did not finish successfully/], ['codex', 'bad_session', /valid session id/], ['codex', 'malformed', /exactly verdict/],
  ];
  for (const [host, kase, re] of cases) {
    const r = s.run(['review', '--host', host, ...PLAN], { FAKE_CASE: kase });
    assert.equal(r.status, 1, `${host}/${kase}: ${r.stdout}`);
    assert.equal(r.record.status, 'failed', `${host}/${kase}`);
    assert.match(r.record.error, re, `${host}/${kase}`);
  }
  assert.equal(s.runRows().filter((x) => x.status === 'failed').length, cases.length, 'every failed turn is indexed');
});

test('the claude event-array result format is accepted', () => {
  const s = sandbox();
  const r = s.run(['review', '--host', 'codex', ...PLAN], { FAKE_CASE: 'array' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.record.response.verdict, 'APPROVED');
  assert.equal(s.spendRows()[0].usd, 0.12, 'the array format is ledgered too');
});

test('approval is bound to the plan hash: check passes, a later edit invalidates it, an edit during the run fails it', () => {
  const s = sandbox();
  const ok = s.run(['review', '--host', 'claude', ...PLAN]);
  const check = s.run(['check', '--host', 'claude', ...PLAN, '--approval', ok.record.resultFile]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Approval matches the current plan/);
  fs.appendFileSync(s.plan, 'One more step.\n');
  const stale = s.run(['check', '--host', 'claude', ...PLAN, '--approval', ok.record.resultFile]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Plan changed after approval/);
  const during = s.run(['review', '--host', 'claude', ...PLAN], { FAKE_CASE: 'mutate_plan' });
  assert.equal(during.record.status, 'failed');
  assert.match(during.record.error, /Plan changed during the run/);
  const revise = s.run(['review', '--host', 'claude', ...PLAN], { FAKE_CASE: 'revise' });
  assert.match(s.run(['check', '--host', 'claude', ...PLAN, '--approval', revise.record.resultFile]).stderr, /completed APPROVED plan review is required/);
});

test('a prior round carries its findings and the dispositions; a mismatched or failed prior is refused', () => {
  const s = sandbox();
  const first = s.run(['review', '--host', 'claude', ...PLAN], { FAKE_CASE: 'revise' });
  const disp = path.join(s.root, 'dispositions.md');
  fs.writeFileSync(disp, 'R1 accepted: verify before delete.\n');
  const second = s.run(['review', '--host', 'claude', ...PLAN, '--prior', first.record.resultFile, '--feedback', disp]);
  assert.equal(second.status, 0, second.stderr);
  const prompt = s.seen('codex', 'prompt.txt');
  assert.match(prompt, /PRIOR ROUND \(your previous structured review\):[\s\S]*"R1"/);
  assert.match(prompt, /HOST DISPOSITIONS \/ FIX REQUEST:\nR1 accepted/);
  const moved = s.run(['review', '--host', 'claude', ...PLAN, '--prior', first.record.resultFile, '--model', 'gpt-6-astra']);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /Prior requestedModel does not match/);
  const failed = s.run(['review', '--host', 'claude', ...PLAN], { FAKE_CASE: 'exit' });
  assert.match(s.run(['review', '--host', 'claude', ...PLAN, '--prior', failed.record.resultFile]).stderr, /did not complete/);
  assert.match(s.run(['inspect', '--host', 'claude', ...PLAN, '--base', 'HEAD', '--prior', first.record.resultFile]).stderr, /always starts fresh/);
});

// ── single-CLI users (D6) ─────────────────────────────────────────────────────
test('only one CLI: preflight says same-provider only; a labelled same-provider review needs its own acceptance to build', () => {
  const s = sandbox();
  const noCodex = { AOS_NO_CODEX: '1' };
  const pre = s.run(['preflight', '--host', 'claude'], noCodex);
  assert.equal(pre.status, 3, pre.stdout + pre.stderr);
  assert.match(pre.stdout, /^codex\s+not found$/m);
  assert.match(pre.stdout, /same-provider only: codex CLI not found \(pass --same-provider/);
  const plain = s.run(['review', '--host', 'claude', ...PLAN], noCodex);
  assert.equal(plain.record.status, 'failed');
  assert.match(plain.record.error, /codex CLI not found/);
  const same = s.run(['review', '--host', 'claude', ...PLAN, '--same-provider'], noCodex);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.record.provider, 'claude');
  assert.equal(same.record.independence, 'same-provider');
  assert.equal(s.runRows().at(-1).independence, 'same-provider');
  const refused = s.run(['check', '--host', 'claude', ...PLAN, '--approval', same.record.resultFile]);
  assert.match(refused.stderr, /same-provider review; pass --accept-same-provider/);
  assert.equal(s.run(['check', '--host', 'claude', ...PLAN, '--approval', same.record.resultFile, '--accept-same-provider']).status, 0);
  const loggedOut = s.run(['preflight', '--host', 'codex'], { FAKE_LOGGED_OUT: 'claude' });
  assert.equal(loggedOut.status, 3);
  assert.match(loggedOut.stdout, /claude CLI not logged in/);
  const both = s.run(['preflight', '--host', 'codex', '--json']);
  assert.equal(both.status, 0);
  assert.equal(JSON.parse(both.stdout).independence, 'cross-provider');
});

// ── build and inspect ─────────────────────────────────────────────────────────
test('build: a clean checkout, an approval or an explicit unreviewed spec, a proof command, and HEAD left alone', () => {
  const s = sandbox();
  const approval = s.run(['review', '--host', 'claude', ...PLAN]).record.resultFile;
  fs.writeFileSync(path.join(s.repo, 'stray.txt'), 'x');
  assert.match(s.run(['build', '--host', 'claude', '--builder', 'codex', ...PLAN, '--approval', approval, '--proof', 'true']).stderr, /clean checkout/);
  fs.rmSync(path.join(s.repo, 'stray.txt'));
  assert.match(s.run(['build', '--host', 'claude', '--builder', 'codex', ...PLAN, '--proof', 'true']).stderr, /--unreviewed-spec/);
  assert.match(s.run(['build', '--host', 'claude', '--builder', 'codex', ...PLAN, '--approval', approval]).stderr, /--proof/);
  const built = s.run(['build', '--host', 'claude', '--builder', 'codex', ...PLAN, '--approval', approval, '--proof', 'python3 -m unittest'], { FAKE_CASE: 'build' });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  assert.equal(built.record.response, 'Built; proof passed.');
  assert.deepEqual(built.record.changedFiles, ['M built.py']);
  assert.equal(built.record.base, gitIn(s.repo, 'rev-parse', 'HEAD'));
  const argv = s.seen('codex', 'args.json');
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  assert.match(s.seen('codex', 'prompt.txt'), /Run the agreed proof command: python3 -m unittest/);
  assert.equal(s.spendRows().at(-1).feature, 'cross-review:build');
  // a fix round resumes against the recorded baseline and refuses intervening edits
  const fix = s.run(['build', '--host', 'claude', '--builder', 'codex', ...PLAN, '--approval', approval, '--proof', 'true', '--prior', built.record.resultFile], { FAKE_CASE: 'text' });
  assert.equal(fix.status, 0, fix.stderr + fix.stdout);
  fs.writeFileSync(path.join(s.repo, 'intervening.py'), 'x');
  assert.match(s.run(['build', '--host', 'claude', '--builder', 'codex', ...PLAN, '--approval', approval, '--proof', 'true', '--prior', built.record.resultFile]).stderr, /Checkout changed since the previous build/);
});

test('build: a builder that commits is caught; an unreviewed spec builds and says so', () => {
  const s = sandbox();
  const r = s.run(['build', '--host', 'codex', '--builder', 'claude', ...PLAN, '--unreviewed-spec', '--proof', 'true'], { FAKE_CASE: 'commit' });
  assert.equal(r.record.status, 'failed');
  assert.match(r.record.error, /changed HEAD despite the no-commit contract/);
  assert.equal(s.seen('claude', 'args.json')[s.seen('claude', 'args.json').indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('inspect: fresh, needs the base, sends the manifest and diff, and refuses code that changed during inspection', () => {
  const s = sandbox();
  const base = gitIn(s.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(s.repo, 'app.py'), 'print(2)\n');
  fs.writeFileSync(path.join(s.repo, 'added.py'), 'a\n');
  assert.match(s.run(['inspect', '--host', 'claude', ...PLAN]).stderr, /requires --base/);
  const r = s.run(['inspect', '--host', 'claude', ...PLAN, '--base', base]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.record.provider, 'codex', 'the builder defaults to the host, so codex inspects');
  assert.deepEqual(r.record.snapshot.files.map((f) => f.path), ['added.py', 'app.py']);
  const prompt = s.seen('codex', 'prompt.txt');
  assert.match(prompt, /CHANGE MANIFEST[\s\S]*added\.py/);
  assert.match(prompt, /TRACKED DIFF:\n[\s\S]*-print\(1\)\n\+print\(2\)/);
  const moving = s.run(['inspect', '--host', 'claude', ...PLAN, '--base', base], { FAKE_CASE: 'mutate_code' });
  assert.equal(moving.record.status, 'failed');
  assert.match(moving.record.error, /Code changed during inspection/);
  assert.match(s.run(['inspect', '--host', 'claude', '--builder', 'codex', ...PLAN, '--base', base]).stdout, /"provider": "claude"/, 'a codex build is inspected by claude');
});

// ── handoff (D13) ─────────────────────────────────────────────────────────────
test('handoff: a read-only consult by default, same-provider allowed and labelled, a write handoff gated like a build', () => {
  const s = sandbox();
  const brief = path.join(s.root, 'brief.md');
  fs.writeFileSync(brief, 'Diagnose the failing test in app.py. Expected: a cause with a file reference.\n');
  const consult = s.run(['handoff', '--host', 'claude', '--provider', 'codex', '--brief', brief, '--model', 'gpt-5.6-terra'], { FAKE_CASE: 'text' });
  assert.equal(consult.status, 0, consult.stderr + consult.stdout);
  assert.equal(consult.record.independence, 'cross-provider');
  assert.equal(consult.record.plan, null);
  const argv = s.seen('codex', 'args.json');
  assert.ok(argv.includes('read-only') && !argv.includes('--output-schema'));
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.6-terra');
  assert.match(s.seen('codex', 'prompt.txt'), /You cannot edit files[\s\S]*<brief>\nDiagnose the failing test/);
  assert.equal(s.spendRows().at(-1).feature, 'cross-review:handoff');
  const same = s.run(['handoff', '--host', 'claude', '--provider', 'claude', '--brief', brief], { FAKE_CASE: 'text' });
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.record.independence, 'same-provider');
  assert.ok(s.seen('claude', 'args.json').includes('--safe-mode'));
  assert.match(s.run(['handoff', '--host', 'claude', '--provider', 'codex', '--brief', brief], { FAKE_CASE: 'blank' }).record.error, /reply is empty/);
  fs.writeFileSync(path.join(s.repo, 'stray.txt'), 'x');
  assert.match(s.run(['handoff', '--host', 'claude', '--provider', 'codex', '--brief', brief, '--write']).stderr, /write handoff requires a clean checkout/);
  fs.rmSync(path.join(s.repo, 'stray.txt'));
  const write = s.run(['handoff', '--host', 'claude', '--provider', 'codex', '--brief', brief, '--write'], { FAKE_CASE: 'build' });
  assert.equal(write.status, 0, write.stderr + write.stdout);
  assert.deepEqual(write.record.changedFiles, ['M built.py']);
  assert.match(s.seen('codex', 'prompt.txt'), /Make only the changes the brief asks for/);
  assert.match(s.run(['handoff', '--host', 'claude', '--brief', brief]).stderr, /--provider claude\|codex/);
});

// ── guards ────────────────────────────────────────────────────────────────────
test('a timeout kills the whole process group and records a failure', () => {
  const s = sandbox();
  const t0 = Date.now();
  const r = s.run(['review', '--host', 'claude', ...PLAN, '--timeout', '1'], { FAKE_CASE: 'timeout' });
  assert.ok(Date.now() - t0 < 15000, 'returned promptly');
  assert.equal(r.record.status, 'failed');
  assert.match(r.record.error, /timed out after 1s/);
  const pids = fs.readFileSync(path.join(s.root, 'fake', 'pids'), 'utf8').trim().split(' ').map(Number);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  assert.deepEqual(pids.filter(alive), [], 'the fake and its grandchild are gone');
});

test('the daily cap, the off switch, a contradicting host signal, a foreign effort and in-repo artifacts are refused before launch', () => {
  const s = sandbox();
  const ledger = path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), feature: 'cross-review:review', provider: 'codex', usd: 10 }) + '\n');
  assert.match(s.run(['review', '--host', 'claude', ...PLAN]).stderr, /reached crossReview\.perDayUsd \(\$10\)/);
  fs.rmSync(ledger);
  const off = sandbox({ cfg: { crossReview: { enabled: false } } });
  assert.match(off.run(['review', '--host', 'claude', ...PLAN]).stderr, /crossReview\.enabled=false/);
  const wrongHost = s.run(['review', '--host', 'codex', ...PLAN], { CLAUDECODE: '1' });
  assert.equal(wrongHost.status, 1);
  assert.match(wrongHost.stderr, /this shell belongs to claude \(claude-env\)[\s\S]*AOS_HOST/);
  assert.equal(s.run(['review', '--host', 'codex', ...PLAN], { CLAUDECODE: '1', AOS_HOST: 'codex' }).status, 0, 'AOS_HOST settles it');
  assert.match(s.run(['review', '--host', 'claude', ...PLAN, '--effort', 'max']).stderr, /--effort max is not one the codex CLI takes/);
  assert.match(s.run(['review', '--host', 'claude', ...PLAN, '--artifacts', path.join(s.repo, 'runs')]).stderr, /outside the target checkout/);
  assert.equal(fs.existsSync(path.join(s.root, 'fake', 'claude-args.json')), true, 'the AOS_HOST run launched its claude reviewer');
  assert.equal(fs.existsSync(path.join(s.root, 'fake', 'codex-args.json')), false, 'no refused run launched anything');
});

test('usage errors exit 2', () => {
  const s = sandbox();
  assert.equal(s.run([]).status, 2);
  assert.equal(s.run(['review', ...PLAN]).status, 2, 'no --host');
  assert.equal(s.run(['review', '--host', 'claude', ...PLAN, '--frobnicate']).status, 2);
  assert.equal(s.run(['review', '--host', 'claude']).status, 2, 'no --plan');
  assert.equal(s.run(['review', '--host', 'claude', ...PLAN, '--timeout', '-1']).status, 2);
});
