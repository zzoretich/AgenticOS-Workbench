'use strict';
// lib/team-run.js (spec 2026-09-28-agent-teams D5-D9): one seat's run end to end against fake claude and codex binaries
// that commit real work in their worktree, so every path runs for free: refusals, the cross-provider rule, merge back,
// spend, telemetry, posts, a signalled run, and --detach against fake launchctl and systemd-run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const T = require('../lib/teams.js');
const TR = require('../lib/team-run.js');
const H = require('../lib/headless.js');
const { main } = require('../team.js');

const TEAM_JS = path.join(__dirname, '..', 'team.js');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, GIT_ENV); // merge commits made in this process

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify({ bin: 'claude', args, cwd: process.cwd(), headless: process.env.AOS_HEADLESS_SEEN }) + '\\n');
const mode = process.env.FAKE_MODE || 'post';
const member = args[args.indexOf('--agent') + 1].replace(/^seat-/, '');
const item = args[1].split('\\n')[0];
if (mode === 'fail') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.3, result: '' })); process.exit(1); }
fs.writeFileSync(member + '.txt', member + ' was here ' + Date.now() + ' ' + Math.random() + '\\n');
if (mode !== 'dirty') { execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', member + ': work']); }
if (mode === 'failcommit') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.2, result: '' })); process.exit(1); }
if (mode === 'hang') { fs.writeFileSync(process.env.FAKE_PIDFILE, String(process.pid)); setInterval(() => {}, 1 << 30); return; }
if (mode === 'post') execFileSync(process.execPath, [process.env.TEAM_JS, 'post', 'dev', '--from', member, '--item', item, '--kind', 'handoff', member + ' done at $40; next is lead']);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, result: 'Work done.\\nhandoff: ' + member + ' finished', session_id: 'sess-1', usage: { input_tokens: 10, output_tokens: 5 } }));
`;
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify({ bin: 'codex', args, cwd: process.cwd(), stdin }) + '\\n');
const cwd = args[args.indexOf('-C') + 1]; const out = args[args.indexOf('-o') + 1];
const member = /AGENT=(\\w+)/.exec(stdin)[1];
if (process.env.FAKE_MODE !== 'nocommit') {
  fs.writeFileSync(path.join(cwd, member + '-codex.txt'), 'built on codex\\n');
  execFileSync('git', ['-C', cwd, 'add', '-A']); execFileSync('git', ['-C', cwd, 'commit', '-qm', member + ': codex work']);
}
fs.writeFileSync(out, 'All waves ran.\\nhandoff: ' + member + ' finished wave 1 on codex');
process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } }) + '\\n');
`;
const FAKE_LOGGER = `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LC_LOG, JSON.stringify(args) + '\\n');
const state = process.env.FAKE_LC_STATE || 'none';
if (args[0] === 'print') {
  if (state === 'none') { process.stderr.write('Could not find service'); process.exit(113); }
  process.stdout.write('gui/501/x = {\\n\\tactive count = 0\\n\\tstate = ' + state + '\\n}\\n');
}
`;

const TEAM_MD = `---
type: team
id: dev
name: Dev
lead: lead
gates: [discuss, ship]
budget: {mode: per-phase, default: 25}
members:
${['lead:claude:all:inherit', 'planner:claude:discuss:claude-sonnet-5', 'builder:claude:execute:claude-sonnet-5', 'platform:codex:execute:inherit', 'reviewer:opposite:verify:claude-opus-5-5', 'shipper:claude:ship:claude-sonnet-5']
  .map((s) => { const [id, provider, stage, model] = s.split(':'); return `  - id: ${id}\n    name: ${id}\n    agent: seat-${id}\n    provider: ${provider}\n    model: ${model}\n    effort: high\n    stage: [${stage}]\n    paused: false`; }).join('\n')}
---
`;

function sh(cwd, cmd, args) { return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim(); }

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-run-'));
  const vault = path.join(root, 'vault');
  const claudeDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  const fakebin = path.join(root, 'fakebin');
  for (const d of [path.join(vault, 'brain', '_index'), path.join(vault, 'persona', 'teams', 'dev'), path.join(claudeDir, 'agents'), codexDir, fakebin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  fs.writeFileSync(path.join(vault, 'persona', 'teams', 'dev', 'TEAM.md'), TEAM_MD);
  for (const id of ['lead', 'planner', 'builder', 'platform', 'reviewer', 'shipper']) {
    fs.writeFileSync(path.join(claudeDir, 'agents', `seat-${id}.md`), `---\nname: seat-${id}\ndescription: ${id}\n---\n\nAGENT=${id}\nYou are ${id}.\n`);
  }
  for (const [name, src] of [['claude', FAKE_CLAUDE], ['codex', FAKE_CODEX], ['launchctl', FAKE_LOGGER], ['systemd-run', FAKE_LOGGER]]) {
    fs.writeFileSync(path.join(fakebin, name), src, { mode: 0o755 });
  }
  const repo = path.join(vault, 'workspaces', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  sh(repo, 'git', ['add', '-A']); sh(repo, 'git', ['commit', '-qm', 'init']);
  const hosts = { claude: { enabled: true, bin: path.join(fakebin, 'claude') }, codex: { enabled: true, bin: path.join(fakebin, 'codex'), home: codexDir } };
  const configFile = path.join(root, 'agenticos.json');
  fs.writeFileSync(configFile, JSON.stringify({ vault, hosts }));
  const argsLog = path.join(root, 'args.jsonl');
  const lcLog = path.join(root, 'launchctl.jsonl');
  const env = {
    ...process.env, ...GIT_ENV, AOS_VAULT: vault, AOS_CONFIG: configFile, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir,
    FAKE_ARGS_LOG: argsLog, FAKE_LC_LOG: lcLog, TEAM_JS, AOS_LAUNCHCTL_BIN: path.join(fakebin, 'launchctl'), AOS_SYSTEMD_RUN_BIN: path.join(fakebin, 'systemd-run'),
  };
  delete env.NODE_OPTIONS; // the suite's preload is a relative path, and seats run from their worktree
  const t = () => T.readTeam(T.teamsRoot(vault), 'dev');
  return { root, vault, claudeDir, codexDir, repo, hosts, argsLog, lcLog, env, t, cfg: { hosts } };
}

// Fixture writes: gates and budgets are the user's (put refuses them, AT-01), so fixtures write the board directly.
function put(w, patch) { const t = w.t(); T.withBoard(t, () => T.writeItem(t, patch, { by: 'fixture', existing: T.boardItems(t).get(patch.id) || null })); }
async function dispatch(w, args, extra = {}) {
  const out = [];
  const err = [];
  const code = await main(['dispatch', 'dev', ...args], {
    stdout: (s) => out.push(s), stderr: (s) => err.push(s), vault: w.vault, cfg: w.cfg,
    env: { ...w.env, ...extra }, dirs: { claudeDir: w.claudeDir, codexDir: w.codexDir }, platform: extra.PLATFORM || process.platform,
  });
  return { code, out: out.join('').trim(), err: err.join('').trim() };
}
function jsonl(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
const item = (w, id) => T.boardItems(w.t()).get(id);
const APPROVED = { name: 'discuss', state: 'approved', by: 'user', ts: '2026-09-28T00:00:00Z', note: '' };
const base = (over) => ({ id: 'demo-01', project: 'demo', path: 'workspaces/demo', phase: '01', title: 'Demo', stage: 'discuss', owner: 'planner', status: 'working', ...over });

test('seatArgs: claude gets the agent, auto permissions and the budget left; codex gets the sandbox and the agent inlined', () => {
  const c = H.seatArgs('claude', { agent: 'seat-x', prompt: 'x-01', model: 'claude-sonnet-5', effort: 'high', budget: 12.5, addDir: '/team' });
  assert.deepEqual(c.argv, ['-p', 'x-01', '--agent', 'seat-x', '--output-format', 'json', '--permission-mode', 'auto', '--permission-prompts', 'none',
    '--max-budget-usd', '12.50', '--add-dir', '/team', '--model', 'claude-sonnet-5', '--effort', 'high']);
  assert.deepEqual(H.seatArgs('claude', { agent: 'a', model: 'inherit', effort: 'inherit' }).argv.slice(-2), ['--permission-prompts', 'none']);
  const x = H.seatArgs('codex', { prompt: 'x-01', body: 'You are x.', cwd: '/wt', gitDir: '/repo/.git', outFile: '/o', effort: 'high', model: 'inherit' });
  assert.deepEqual(x.argv, ['exec', '-', '--skip-git-repo-check', '-s', 'workspace-write', '-C', '/wt', '--add-dir', '/repo/.git',
    '-c', 'sandbox_workspace_write.network_access=true', '-c', 'features.hooks=false', '-c', 'approval_policy="never"', '--json', '-o', '/o', '-c', 'model_reasoning_effort="high"']);
  assert.equal(x.stdin, `You are x.\n\n---\n\n${H.SEAT_CODEX_TAIL}\n\n---\n\nx-01`);
  assert.throws(() => H.seatArgs('claude', {}), /needs its agent/);
});

test('a dry run resolves the seat and changes nothing', async () => {
  const w = world();
  put(w, base());
  const r = await dispatch(w, ['planner', 'demo-01', '--wave', '1', '--note', 'go', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  const plan = JSON.parse(r.out);
  assert.deepEqual([plan.provider, plan.model, plan.budgetLeftUsd, plan.agent], ['claude', 'claude-sonnet-5', 25, 'seat-planner']);
  assert.match(plan.prompt, /^demo-01\n\nWaves: 1\n\nNote from the lead: go$/);
  assert.equal(sh(w.repo, 'git', ['branch', '--list', 'team/*']), '');
});

test('refusals: owner, lead, gates, budget, kill switch, pause, the project path, and the host', async () => {
  const w = world();
  put(w, base());
  const err = async (args, extra) => { const r = await dispatch(w, args, extra); assert.equal(r.code, 1, `${args.join(' ')}: ${r.err}`); return r.err; };
  assert.match(await err(['builder', 'demo-01']), /not the owner/);
  assert.match(await err(['lead', 'demo-01']), /is the lead/);
  assert.match(await err(['planner', 'nope-01']), /no board item/);
  put(w, { id: 'demo-01', status: 'gate', gate: { name: 'discuss', state: 'pending' } });
  assert.match(await err(['planner', 'demo-01']), /waits on the user/);
  put(w, { id: 'demo-01', stage: 'plan', status: 'working', gate: { name: 'discuss', state: 'redirected' } });
  assert.match(await err(['planner', 'demo-01']), /discuss gate is not approved/);
  put(w, { id: 'demo-01', stage: 'ship', owner: 'shipper', gate: APPROVED });
  assert.match(await err(['shipper', 'demo-01']), /ship gate is not approved/);
  put(w, { id: 'demo-01', stage: 'plan', owner: 'planner', gate: APPROVED, budget: { usd: 25, spentUsd: 25 } });
  assert.match(await err(['planner', 'demo-01']), /budget is spent/);
  put(w, { id: 'demo-01', budget: { spentUsd: 0 } });
  fs.writeFileSync(path.join(w.t().dir, 'DISABLED'), '');
  assert.match(await err(['planner', 'demo-01']), /DISABLED/);
  fs.unlinkSync(path.join(w.t().dir, 'DISABLED'));
  w.cfg.hosts.claude.enabled = false;
  assert.match(await err(['planner', 'demo-01']), /claude host is off on this machine/);
  w.cfg.hosts.claude.enabled = true;
  assert.match(await err(['planner', 'demo-01'], { AOS_NO_CLAUDE: '1' }), /no claude CLI was found/, 'never a real binary on this machine');
  T.setPaused(w.t(), { memberId: 'planner', paused: true, env: {} });
  assert.match(await err(['planner', 'demo-01']), /paused/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'team-outside-'));
  sh(outside, 'git', ['init', '-q']);
  fs.symlinkSync(outside, path.join(w.vault, 'workspaces', 'linked'));
  put(w, { id: 'demo-03', path: 'workspaces/linked', owner: 'builder', stage: 'execute', gate: APPROVED });
  assert.match(await err(['builder', 'demo-03']), /leads outside workspaces/, 'AT-R2');
  put(w, { id: 'demo-02', path: 'workspaces/_spikes/x', owner: 'builder', stage: 'execute', gate: APPROVED });
  assert.match(await err(['builder', 'demo-02']), /not a project under workspaces/);
});

test('a claude seat runs in its worktree, posts, spends, and fast-forwards the trunk', async () => {
  const w = world();
  put(w, base());
  const r = await dispatch(w, ['planner', 'demo-01']);
  assert.equal(r.code, 0, r.err || r.out);
  assert.match(r.out, /planner on demo-01 via claude claude-sonnet-5\/high .* \$0\.50 · 1 commit\(s\) merged into team\/dev\/demo-01\/trunk · posted handoff/);
  const call = jsonl(w.argsLog)[0];
  for (const a of ['--agent', 'seat-planner', '--model', 'claude-sonnet-5', '--effort', 'high', '--permission-mode', 'auto', '--max-budget-usd', '25.00']) assert.ok(call.args.includes(a), a);
  assert.match(call.cwd, /\/workspaces\/_worktrees\/dev\/demo-01\/planner$/);
  assert.equal(fs.existsSync(call.cwd), false, 'a clean worktree is removed');
  assert.equal(sh(w.repo, 'git', ['log', '-1', '--format=%s', 'team/dev/demo-01/trunk']), 'planner: work');
  assert.equal(sh(w.repo, 'git', ['log', '-1', '--format=%s', 'main']), 'init', 'main is untouched');
  const it = item(w, 'demo-01');
  assert.deepEqual([it.budget.spentUsd, it.by], [0.5, 'dispatch']);
  const posts = T.tail(w.t());
  assert.deepEqual(posts.map((p) => [p.from, p.text]), [['planner', 'planner done at $40; next is lead']], 'the seat posted itself; its dollar amount survived');
  const runs = jsonl(path.join(w.t().dir, 'runs.jsonl'));
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].status, runs[0].session, runs[0].usd, runs[0].commits], ['ok', 'sess-1', 0.5, 1]);
  assert.match(runs[0].run, /^dev-demo-01-planner-/);
  assert.deepEqual(T.liveMarkers(w.t()), [], 'the marker goes once the row is written');
});

test('a codex seat gets the agent inlined, its final line posted, an estimated cost, and becomes a builder', async () => {
  const w = world();
  put(w, base({ stage: 'execute', owner: ['platform', 'builder'], gate: APPROVED }));
  const r = await dispatch(w, ['platform', 'demo-01', '--wave', '1']);
  assert.equal(r.code, 0, r.err || r.out);
  const call = jsonl(w.argsLog)[0];
  assert.equal(call.bin, 'codex');
  assert.ok(call.args.includes('workspace-write') && call.args.includes('--add-dir') && call.args.includes('sandbox_workspace_write.network_access=true'));
  assert.match(call.stdin, /AGENT=platform[\s\S]*Your last message must be your one-line channel post[\s\S]*demo-01\n\nWaves: 1$/);
  const it = item(w, 'demo-01');
  assert.deepEqual([it.budget.codexRuns, it.budget.spentUsd, it.builders], [1, 0, { claude: [], codex: ['platform'] }], 'a Codex run is counted, not charged (D8)');
  const post = T.tail(w.t()).pop();
  assert.deepEqual([post.from, post.kind, post.text], ['platform', 'handoff', 'platform finished wave 1 on codex']);
  const run = jsonl(path.join(w.t().dir, 'runs.jsonl'))[0];
  assert.ok(run.usd > 0, 'priced from the token usage');
  assert.match(r.out, /codex run \(~\$/);
});

test('a seat that commits nothing is not a builder; a failed run is charged and reported', async () => {
  const w = world();
  put(w, base({ stage: 'execute', owner: ['platform'], gate: APPROVED }));
  assert.equal((await dispatch(w, ['platform', 'demo-01'], { FAKE_MODE: 'nocommit' })).code, 0);
  assert.deepEqual(item(w, 'demo-01').builders.codex, []);
  const w2 = world();
  put(w2, base());
  const r = await dispatch(w2, ['planner', 'demo-01'], { FAKE_MODE: 'fail' });
  assert.equal(r.code, 3);
  assert.match(r.out, /FAILED: error_max_budget_usd/);
  assert.equal(item(w2, 'demo-01').budget.spentUsd, 0.3);
  assert.deepEqual(T.tail(w2.t()).map((p) => [p.from, p.kind]).pop(), ['dispatch', 'blocker']);
  assert.equal(jsonl(path.join(w2.t().dir, 'runs.jsonl'))[0].status, 'failed');
});

test('reviewers run on the provider that did not build the work, once per provider when both built', async () => {
  const w = world();
  put(w, base({ stage: 'verify', owner: ['reviewer'], gate: APPROVED, builders: { claude: [], codex: ['platform'] } }));
  assert.match((await dispatch(w, ['reviewer', 'demo-01', '--provider', 'codex'])).err, /never on codex/);
  const plan = JSON.parse((await dispatch(w, ['reviewer', 'demo-01', '--dry-run'])).out);
  assert.deepEqual([plan.provider, plan.model], ['claude', 'claude-opus-5-5']);
  put(w, { id: 'demo-01', builders: { claude: ['builder'], codex: ['platform'] } });
  assert.match((await dispatch(w, ['reviewer', 'demo-01'])).err, /both providers built/);
  assert.equal(JSON.parse((await dispatch(w, ['reviewer', 'demo-01', '--provider', 'codex', '--dry-run'])).out).provider, 'codex');
  put(w, { id: 'demo-01', builders: { claude: [], codex: [] } });
  assert.match((await dispatch(w, ['reviewer', 'demo-01'])).err, /no builders yet/);
});

test('uncommitted work keeps the worktree and blocks the next run of that seat', async () => {
  const w = world();
  put(w, base());
  assert.equal((await dispatch(w, ['planner', 'demo-01'], { FAKE_MODE: 'dirty' })).code, 3);
  assert.ok(fs.existsSync(path.join(w.vault, 'workspaces', '_worktrees', 'dev', 'demo-01', 'planner', 'planner.txt')));
  assert.match(T.tail(w.t()).pop().text, /uncommitted changes/);
  assert.equal(jsonl(path.join(w.t().dir, 'runs.jsonl'))[0].status, 'blocked', 'a dirty run is blocked, not ok (AT-07)');
  const waited = await main(['wait', 'dev', 'demo-01', 'planner', '--since', '2000-01-01T00:00:00Z'], { stdout: () => {}, stderr: () => {}, vault: w.vault });
  assert.equal(waited, 3, 'wait exits 3 when the run it returns is not ok');
  assert.match((await dispatch(w, ['planner', 'demo-01'])).err, /left its worktree/);
});

test('mergeBack: fast-forward, merge commit, and conflict', () => {
  const w = world();
  const g = (...a) => sh(w.repo, 'git', a);
  g('branch', 'trunk'); g('branch', 'seat');
  const commitOn = (branch, file, text) => { g('checkout', '-q', branch); fs.writeFileSync(path.join(w.repo, file), text); g('add', '-A'); g('commit', '-qm', `${branch} ${file}`); g('checkout', '-q', 'main'); };
  commitOn('seat', 'a.txt', 'a');
  assert.deepEqual([TR.mergeBack(w.repo, 'trunk', 'seat').commits, g('rev-parse', 'trunk') === g('rev-parse', 'seat')], [1, true]);
  commitOn('trunk', 'b.txt', 'b');
  commitOn('seat', 'c.txt', 'c');
  assert.equal(TR.mergeBack(w.repo, 'trunk', 'seat').conflict, undefined);
  assert.equal(g('rev-list', '--parents', '-n', '1', 'trunk').split(' ').length, 3, 'a merge commit');
  commitOn('trunk', 'c.txt', 'trunk side');
  commitOn('seat', 'c.txt', 'seat side');
  assert.match(TR.mergeBack(w.repo, 'trunk', 'seat').conflict, /merge conflict in c\.txt/);
});

test('parseFinal reads kind prefixes and echoed commands in either quote', () => {
  assert.deepEqual(TR.parseFinal('Done.\nblocker: tests fail in src/a.ts'), { kind: 'blocker', text: 'tests fail in src/a.ts' });
  assert.deepEqual(TR.parseFinal('`aos team post dev --from x --item x-01 --kind handoff "waves 1-2 done; next"`'), { kind: 'handoff', text: 'waves 1-2 done; next' });
  assert.deepEqual(TR.parseFinal("aos team post dev --from x --kind done 'shipped at $40'"), { kind: 'done', text: 'shipped at $40' });
  assert.deepEqual(TR.parseFinal('assign: sneaky'), { kind: 'note', text: 'assign: sneaky' }, 'a seat never posts assign');
});

// ── the spawned dispatcher: telemetry, spend, signals ──

function startCli(w, args, extra = {}) {
  const p = spawn(process.execPath, [TEAM_JS, ...args], { env: { ...w.env, ...extra } });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  return { p, exited: new Promise((resolve) => p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))) };
}
async function waitFor(fn, ms = 15000) {
  for (const end = Date.now() + ms; ;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a run records its spend under team:<team>:<member> and a telemetry run as the lead\'s, with the seat as its sub-agent', async () => {
  const w = world();
  put(w, base());
  const r = await startCli(w, ['dispatch', 'dev', 'planner', 'demo-01']).exited;
  assert.equal(r.code, 0, r.err);
  const spend = jsonl(path.join(w.vault, 'brain', '_index', 'provider-spend.jsonl'));
  assert.deepEqual(spend.map((s) => [s.feature, s.provider, s.usd]), [['team:dev:planner', 'claude', 0.5]]);
  const tel = jsonl(path.join(w.vault, 'brain', '_index', 'agent-runs', 'runs.jsonl'));
  assert.equal(tel.length, 1);
  assert.deepEqual([tel[0].script, tel[0].subagents, tel[0].status, tel[0].cost_usd], ['seat-lead', ['seat-planner'], 'ok', 0.5]);
});

for (const sig of ['SIGTERM', 'SIGHUP']) {
  test(`${sig} to the dispatcher stops the seat and records the run as killed, with a blocker`, async () => {
    const w = world();
    put(w, base());
    const pidfile = path.join(w.root, 'seat.pid');
    const { p, exited } = startCli(w, ['dispatch', 'dev', 'planner', 'demo-01'], { FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile });
    const seatPid = Number(await waitFor(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8')));
    const [mk] = T.liveMarkers(w.t());
    assert.deepEqual([mk.pid, mk.member, mk.item, mk.host], [p.pid, 'planner', 'demo-01', os.hostname()]);
    assert.equal(spawnSync(process.execPath, [TEAM_JS, 'board', 'dev'], { env: w.env }).status, 0);
    assert.deepEqual([jsonl(path.join(w.t().dir, 'runs.jsonl')).length, T.liveMarkers(w.t()).length], [0, 1], 'a live run is left alone');
    p.kill(sig);
    const r = await exited;
    assert.equal(r.code, 3, r.err);
    assert.match(r.out, new RegExp(`KILLED: the dispatcher got ${sig}`));
    assert.throws(() => process.kill(seatPid, 0), 'the seat was stopped with its dispatcher');
    const runs = jsonl(path.join(w.t().dir, 'runs.jsonl'));
    assert.deepEqual(runs.map((x) => [x.status, x.run, x.commits]), [['killed', mk.run, 1]]);
    assert.match(T.tail(w.t()).pop().text, new RegExp(`^planner's run on demo-01 was killed \\(the dispatcher got ${sig}\\)`));
    assert.deepEqual(T.liveMarkers(w.t()), []);
  });
}

// ── --detach ──

test('--detach on macOS: checks the run, then hands the same command to launchd as a one-shot job', async () => {
  const w = world();
  put(w, base());
  const r = await dispatch(w, ['planner', 'demo-01', '--note', 'go --detach', '--detach'], { PLATFORM: 'darwin' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /detached planner on demo-01 as the launchd job com\.agenticos\.team\.dev\.demo-01\.planner/);
  assert.match(r.out, /\n {2}wait: {2}aos team wait dev demo-01 planner --since \d{4}-\d\d-\d\dT[\d:.]+Z\n/);
  const calls = jsonl(w.lcLog);
  assert.deepEqual(calls.map((c) => c[0]), ['print', 'bootstrap']);
  const plist = fs.readFileSync(calls[1][2], 'utf8');
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const i = strings.indexOf('dispatch');
  assert.deepEqual(strings.slice(i, i + 6), ['dispatch', 'dev', 'planner', 'demo-01', '--note', 'go --detach'], 'the same dispatch, without --detach');
  assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>\n\t<key>KeepAlive<\/key>\n\t<false\/>/);
  assert.ok(strings.includes(w.vault) && strings.includes(w.env.AOS_CONFIG), 'the job resolves the same vault and config');
  assert.equal(jsonl(w.argsLog).length, 0, 'the seat runs under launchd, not here');
  // A finished job is booted out first; a running one refuses; a refused run never reaches launchd.
  assert.equal((await dispatch(w, ['planner', 'demo-01', '--detach'], { PLATFORM: 'darwin', FAKE_LC_STATE: 'not running' })).code, 0);
  assert.deepEqual(jsonl(w.lcLog).map((c) => c[0]).slice(2), ['print', 'bootout', 'bootstrap']);
  assert.match((await dispatch(w, ['planner', 'demo-01', '--detach'], { PLATFORM: 'darwin', FAKE_LC_STATE: 'running' })).err, /still running/);
  const n = jsonl(w.lcLog).length;
  assert.match((await dispatch(w, ['builder', 'demo-01', '--detach'], { PLATFORM: 'darwin' })).err, /not the owner/);
  assert.equal(jsonl(w.lcLog).length, n);
});

test('--detach on Linux runs the dispatch as a transient systemd user unit', async () => {
  const w = world();
  put(w, base());
  const r = await dispatch(w, ['planner', 'demo-01', '--detach'], { PLATFORM: 'linux' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /as the systemd user unit com-agenticos-team-dev-demo-01-planner/);
  const [args] = jsonl(w.lcLog);
  assert.deepEqual(args.slice(0, 3), ['--user', '--unit=com-agenticos-team-dev-demo-01-planner', '--collect']);
  assert.ok(args.includes(`--setenv=AOS_VAULT=${w.vault}`));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), [process.execPath, TEAM_JS, 'dispatch', 'dev', 'planner', 'demo-01']);
  assert.ok(!args.some((a) => /^--setenv=AOS_HEADLESS=/.test(a)), 'a seat gets AOS_HEADLESS from the dispatcher, not the unit');
});

// ── the review's fixes (AT-02, AT-03, AT-05, AT-06) ──

test('a failed run keeps its commits on its branch, and the lead takes them with aos team merge (AT-03)', async () => {
  const w = world();
  put(w, base({ stage: 'execute', owner: ['builder'], gate: APPROVED }));
  const r = await dispatch(w, ['builder', 'demo-01'], { FAKE_MODE: 'failcommit' });
  assert.equal(r.code, 3);
  assert.match(r.out, /1 commit\(s\) held on team\/dev\/demo-01\/builder/);
  assert.equal(sh(w.repo, 'git', ['rev-list', '--count', 'team/dev/demo-01/trunk..team/dev/demo-01/builder']), '1', 'not merged');
  assert.deepEqual(item(w, 'demo-01').builders.claude, [], 'held work built nothing');
  const run = jsonl(path.join(w.t().dir, 'runs.jsonl'))[0];
  assert.deepEqual([run.status, run.commits, run.merged], ['failed', 1, false]);
  assert.match(T.tail(w.t()).pop().text, /aos team merge dev demo-01 builder --from lead takes them/);
  const io = { stdout: () => {}, stderr: () => {}, vault: w.vault };
  assert.equal(await main(['merge', 'dev', 'demo-01', 'builder', '--from', 'builder'], io), 1, 'only the lead merges');
  assert.equal(await main(['merge', 'dev', 'demo-01', 'builder', '--from', 'lead'], { ...io, env: { AOS_HEADLESS: '1' } }), 1, 'never from a headless run (AT-R4)');
  assert.equal(await main(['merge', 'dev', 'demo-01', 'builder', '--from', 'lead'], io), 0);
  assert.equal(sh(w.repo, 'git', ['log', '-1', '--format=%s', 'team/dev/demo-01/trunk']), 'builder: work');
  assert.deepEqual(item(w, 'demo-01').builders.claude, ['builder'], 'merged execute work counts as built (AT-R3)');
  assert.equal(await main(['merge', 'dev', 'demo-01', 'builder', '--from', 'lead'], io), 1, 'nothing held any more');
});

test('parallel Claude seats share one budget: a live run holds its reservation, and --max-usd splits it (AT-02)', async () => {
  const w = world();
  put(w, base({ stage: 'verify', owner: ['reviewer', 'planner'], gate: APPROVED, builders: { claude: [], codex: ['platform'] } }));
  const hold = (usd) => { fs.mkdirSync(T.runningDir(w.t()), { recursive: true }); fs.writeFileSync(path.join(T.runningDir(w.t()), 'held.json'), JSON.stringify({ run: 'held', member: 'planner', item: 'demo-01', provider: 'claude', pid: process.pid, pidStart: T.processStart(process.pid), host: os.hostname(), reservedUsd: usd })); };
  assert.match((await dispatch(w, ['reviewer', 'demo-01', '--max-usd', '0.001'])).err, /at least 0\.01/, 'AT-R7');
  hold(20);
  const first = await dispatch(w, ['reviewer', 'demo-01']);
  assert.equal(first.code, 0, `${first.out}\n${first.err}`);
  assert.ok(jsonl(w.argsLog)[0].args.join(' ').includes('--max-budget-usd 5.00'), 'only what the live run does not hold');
  hold(24.5);
  assert.match((await dispatch(w, ['reviewer', 'demo-01'])).err, /held by live runs/);
  fs.rmSync(path.join(T.runningDir(w.t()), 'held.json'));
  const third = await dispatch(w, ['reviewer', 'demo-01', '--max-usd', '3']);
  assert.equal(third.code, 0, `${third.out}\n${third.err}`);
  assert.ok(jsonl(w.argsLog).pop().args.join(' ').includes('--max-budget-usd 3.00'));
});

test('a codex seat runs its own Codex definition and model; a claude seat needs its Claude Code file (AT-05, AT-06)', async () => {
  const w = world();
  const codexModel = require('../lib/settings-schema.js').CODEX_MODELS[0];
  fs.mkdirSync(path.join(w.codexDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(w.codexDir, 'agents', 'seat-platform.toml'), 'name = "seat-platform"\ndeveloper_instructions = "AGENT=platform, the Codex-native definition."\n');
  T.setMember(w.t(), { memberId: 'platform', key: 'model', value: codexModel, env: {} });
  put(w, base({ stage: 'execute', owner: ['platform', 'builder'], gate: APPROVED }));
  assert.equal((await dispatch(w, ['platform', 'demo-01'])).code, 0);
  const call = jsonl(w.argsLog)[0];
  assert.match(call.stdin, /the Codex-native definition/);
  assert.deepEqual(call.args.slice(call.args.indexOf('-m'), call.args.indexOf('-m') + 2), ['-m', codexModel]);
  fs.rmSync(path.join(w.claudeDir, 'agents', 'seat-builder.md'));
  assert.match((await dispatch(w, ['builder', 'demo-01'])).err, /no Claude Code agent file/);
});
