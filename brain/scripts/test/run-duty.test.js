'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'persona', 'run-duty.sh');

/** A vault with one duty, a STATE.md and a fake `claude` that prints a result JSON and
 *  journals only when FAKE_JOURNAL is set. Never touches the real claude binary. */
function sandbox() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'persona', 'duties'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'persona', 'duties', 'testduty.md'), 'ascii fixture duty\n');
  fs.writeFileSync(path.join(vault, 'persona', 'IDENTITY.md'), '# Atlas\n');
  fs.writeFileSync(path.join(vault, 'persona', 'STATE.md'), '# Persona State\n## Flags\n## Priorities\n');
  const fake = path.join(vault, 'fake-claude');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    '[ -n "${FAKE_ARGS:-}" ] && printf "%s\\n" "$@" > "$FAKE_ARGS"',
    '[ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf "\\n## 09:00 — duty: testduty\\n- status: OK\\n" >> "$FAKE_JOURNAL"; }',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.0123,\\"usage\\":{\\"input_tokens\\":10,\\"output_tokens\\":5},\\"duration_ms\\":100}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const logDir = path.join(vault, 'logs');
  const env = {
    ...process.env,
    AOS_VAULT: vault,
    AOS_CONFIG: path.join(vault, 'no-agenticos.json'),
    AOS_NODE: process.execPath,
    PERSONA_CLAUDE_BIN: fake,
    PERSONA_LOG_DIR: logDir,
    PERSONA_TIMEOUT: '20',
  };
  delete env.AOS_HEADLESS;
  // execution amendment 2026-09-15 (A5): the runner names the journal by the LOCAL day (`date +%Y-%m-%d`), so the
  // test must too — toISOString() is UTC and disagrees for the last hours of every local day (4/7 red each evening).
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { vault, env, logDir, journal: path.join(vault, 'persona', 'journal', `${day}.md`) };
}
// final review Minor 14 (tests-8): a hung runner must fail the test, not hang the lane. 60 s is ~60× the
// slowest real sub-run here (the 1 s PERSONA_TIMEOUT watchdog case), so it can never fire on a green run.
function run(args, env) { return spawnSync('sh', [RUNNER, ...args], { env, encoding: 'utf8', timeout: 60000 }); }

test('dry-run prints the invocation (binary, model, effort, tools, budget, json output, MCP/session flags) and executes nothing', () => {
  const s = sandbox();
  const r = run(['testduty', '--dry-run'], s.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--model\nhaiku$/m);
  assert.match(r.stdout, /^--effort\nmedium$/m);
  assert.match(r.stdout, /^--allowedTools$/m);
  assert.match(r.stdout, /^--max-budget-usd\n2$/m, 'perDutyUsd default without a --check run');
  assert.match(r.stdout, /^--append-system-prompt$/m);
  assert.match(r.stdout, /brain\/scripts\/persona\/ledger\.js:\*\)/, 'duties may append to the proposal ledger');
  assert.match(r.stdout, /^--strict-mcp-config$/m);          // execution amendment 2026-09-15 (A25)
  assert.match(r.stdout, /^--no-session-persistence$/m);     // execution amendment 2026-09-15 (A25)
  assert.ok(!r.stdout.includes('bypassPermissions'));
  assert.ok(!r.stdout.includes('Bash(git:*)'), 'git is scoped to status/log/diff — never push');   // execution amendment 2026-09-15 (A26)
  assert.ok(!r.stdout.includes('Bash(git add') && !r.stdout.includes('Bash(git commit'), 'a duty never commits — docs/chief-of-staff.md');   // final review F3/safety-5
  assert.ok(!fs.existsSync(s.logDir), 'dry-run writes no logs');
  // execution amendment 2026-09-15 (A24): without PERSONA_CLAUDE_BIN the runner takes agenticos.json's claude.bin
  // (contract §2 addendum) before the PATH lookup; the first printed line is the resolved binary.
  const cfg = path.join(s.vault, 'agenticos.json');
  fs.writeFileSync(cfg, JSON.stringify({ vault: s.vault, claude: { model: 'haiku', bin: s.env.PERSONA_CLAUDE_BIN } }, null, 2));
  // final review F8/spec-7 ([ledger:147] ii): PATH/HOME are pinned so that if the PERSONA_CLAUDE_BIN guard
  // ever regressed, this sub-run could not resolve the developer's real `claude` and make a live billed call.
  const viaCfg = { ...s.env, AOS_CONFIG: cfg, PATH: '/usr/bin:/bin', HOME: s.vault }; delete viaCfg.PERSONA_CLAUDE_BIN;
  assert.equal(run(['testduty', '--dry-run'], viaCfg).stdout.split('\n')[0], s.env.PERSONA_CLAUDE_BIN, 'claude.bin from agenticos.json is honored before the PATH lookup');
});

test('PERSONA_MODEL, PERSONA_EFFORT and PERSONA_MAX_USD override the defaults', () => {
  const s = sandbox();
  const r = run(['testduty', '--dry-run'], { ...s.env, PERSONA_MODEL: 'sonnet', PERSONA_EFFORT: 'high', PERSONA_MAX_USD: '0.5' });
  assert.match(r.stdout, /^--model\nsonnet$/m);
  assert.match(r.stdout, /^--effort\nhigh$/m);
  assert.match(r.stdout, /^--max-budget-usd\n0\.5$/m);
});

test('unknown duty exits 1 with a message; kill switch exits 0 without an invocation', () => {
  const s = sandbox();
  const bad = run(['no-such-duty', '--dry-run'], s.env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown duty 'no-such-duty'/);
  fs.writeFileSync(path.join(s.vault, 'persona', 'DISABLED'), 'x');
  const off = run(['testduty', '--dry-run'], s.env);
  assert.equal(off.status, 0);
  assert.match(off.stdout, /DISABLED/);
  assert.ok(!off.stdout.includes('--model'));
});

// final review Minor 7 (safety-9 = spec-12): the PERSONA_CLAUDE_BIN guard sits BELOW the kill switch and
// the unknown-duty check, so a stale non-executable override cannot turn either of those two exits into a
// misconfiguration failure. A disabled persona must exit 0 no matter what the override points at.
test('the kill switch and the unknown-duty check both outrank a stale non-executable PERSONA_CLAUDE_BIN', () => {
  const s = sandbox();
  const stale = path.join(s.vault, 'stale-claude');
  fs.writeFileSync(stale, '#!/bin/sh\necho should never run\n', { mode: 0o644 });
  // Same PATH/HOME hardening as the sub-runs above (final review F8): if the guard regressed to a
  // fall-through, this sub-run still could not resolve a developer's real `claude`.
  const env = { ...s.env, PERSONA_CLAUDE_BIN: stale, PATH: '/usr/bin:/bin', HOME: s.vault };

  const unknown = run(['no-such-duty', '--dry-run'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown duty 'no-such-duty'/);
  assert.ok(!unknown.stderr.includes('not executable'), 'the unknown-duty check runs before the binary guard');

  fs.writeFileSync(path.join(s.vault, 'persona', 'DISABLED'), 'x');
  const off = run(['testduty', '--dry-run'], env);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /DISABLED/);
  assert.ok(!off.stderr.includes('not executable'), 'a disabled persona exits 0 whatever the override points at');
  assert.ok(!off.stdout.includes('--model'), 'nothing is invoked');
});

test('watchdog: a duty that never journals is recorded FAILED, flagged in STATE.md, and its spend is ledgered', () => {
  const s = sandbox();
  const r1 = run(['testduty'], s.env);
  assert.equal(r1.status, 1, r1.stderr);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: FAILED/);
  const state = fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8');
  assert.match(state, /## Flags\n- \[ \] \d{4}-\d{2}-\d{2} duty 'testduty' FAILED/);
  const r2 = run(['testduty'], s.env);
  assert.equal(r2.status, 1);
  const entries = fs.readFileSync(s.journal, 'utf8').match(/duty: testduty/g).length;
  assert.equal(entries, 2, 'the before/after count check catches a same-day repeat failure');
  const ledger = fs.readFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledger.length, 2);
  const row = JSON.parse(ledger[0]);
  assert.equal(row.feature, 'duty:testduty');
  assert.equal(row.usd, 0.0123);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /FAILED \(contract unmet\)/);
});

test('a duty that journals succeeds with exit 0', () => {
  const s = sandbox();
  const argsFile = path.join(s.vault, 'claude-args.txt');
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal, FAKE_ARGS: argsFile });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /duty=testduty done \(exit 0\)/);
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.match(args, /^--append-system-prompt\nToday is \d{4}-\d{2}-\d{2} \(local time \d{2}:\d{2}\)\. This run's journal file is .*\/persona\/journal\/\d{4}-\d{2}-\d{2}\.md\.\n\n# Atlas\n/m, 'the system prompt opens with the date and journal path (a post-midnight duty otherwise journals into yesterday)');
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('FAILED'));
});

test('the daily duty cap (persona.perDayUsd over duty:* rows) skips the duty with exit 0, a log line and a SKIPPED journal entry', () => {
  const s = sandbox();
  const today = new Date().toISOString();
  fs.writeFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'), [
    JSON.stringify({ ts: today, feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 50, inputTokens: 1, outputTokens: 1, ms: 1 }),  // hook spend: ignored
    JSON.stringify({ ts: today, feature: 'duty:other', provider: 'claude', model: 'haiku', usd: 6, inputTokens: 1, outputTokens: 1, ms: 1 }),        // = perDayUsd (6.0)
    '',
  ].join('\n'));
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(s.logDir, 'duty-testduty.log'), 'utf8'), /daily spend cap reached/);
  const journal = fs.readFileSync(s.journal, 'utf8');
  assert.match(journal, /## \d{2}:\d{2} — duty: testduty\n- status: SKIPPED daily-cap/);
  assert.ok(!journal.includes('status: OK'), 'the fake claude never ran');
});

test('hook spend alone never blocks a duty', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'brain', '_index', 'provider-spend.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 50, inputTokens: 1, outputTokens: 1, ms: 1 }) + '\n');
  const r = run(['testduty'], { ...s.env, FAKE_JOURNAL: s.journal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: OK/);
});

// A49/A50: the watchdog must kill the claude process itself (not a wrapper shell around it), and a SET
// PERSONA_CLAUDE_BIN that is not executable must fail loudly instead of falling through to the PATH lookup.
test('watchdog kills the claude process itself on PERSONA_TIMEOUT; a non-executable PERSONA_CLAUDE_BIN is refused', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'monitor.md'), 'ascii fixture duty\n');
  const pidFile = path.join(s.vault, 'claude.pid');
  const sleeper = path.join(s.vault, 'fake-claude-sleep');
  fs.writeFileSync(sleeper, [
    '#!/bin/sh',
    `echo $$ > "${pidFile}"`,
    'exec sleep 30',
    '',
  ].join('\n'), { mode: 0o755 });

  const isAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

  let pid = null;
  try {
    // final review Minor 14 (tests-8): the timing assertion runs INSIDE the try, so a slow runner still
    // reaches the finally below and the `sleep 30` fake is reaped instead of being left running.
    const start = Date.now();
    const r = run(['monitor'], { ...s.env, PERSONA_CLAUDE_BIN: sleeper, PERSONA_TIMEOUT: '1', PATH: '/usr/bin:/bin', HOME: s.vault });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10000, `runner should return within a few seconds of the 1s timeout, took ${elapsed}ms`);

    assert.ok(fs.existsSync(pidFile), 'the fake claude should have started and recorded its own pid');
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    let alive = isAlive(pid);
    const deadline = Date.now() + 2000;
    while (alive && Date.now() < deadline) alive = isAlive(pid);
    assert.ok(!alive, `claude process ${pid} should be reaped by the watchdog, not orphaned`);

    // No journal entry was written before the timeout killed it: the runner's own duty-contract check
    // treats that as a failure, same as the plain watchdog test above.
    assert.equal(r.status, 1, r.stderr);
    assert.match(fs.readFileSync(s.journal, 'utf8'), /- status: FAILED/);
    assert.match(fs.readFileSync(path.join(s.logDir, 'duty-monitor.log'), 'utf8'), /FAILED \(contract unmet\)/);
  } finally {
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }

  fs.rmSync(pidFile, { force: true });
  const notExec = path.join(s.vault, 'not-executable-claude');
  fs.writeFileSync(notExec, '#!/bin/sh\necho should never run\n', { mode: 0o644 });
  // Same hardening as viaCfg above — NOT PATH: '' (that fails `sh` itself with ENOENT and reddens the assertions below).
  const bad = run(['monitor'], { ...s.env, PERSONA_CLAUDE_BIN: notExec, PATH: '/usr/bin:/bin', HOME: s.vault });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not executable/);
  assert.ok(!fs.existsSync(pidFile), 'a misconfigured PERSONA_CLAUDE_BIN must never launch anything');
});

// Spec 2026-09-22-persona-tick-design D3: the tick's helper (persona/tick.js) decides runner-side whether the model
// runs at all. A `precheck` exit 3 skips the run with one log line and no journal entry — and exit 0, so run-routine.js
// still records a run and the watchdog never mistakes an idle hour for a miss. `beat` runs only after the contract passes.
test('tick helper: precheck skips an unchanged vault silently, beat runs after a met contract and not after a failed one', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'tick.md'), 'ascii fixture tick\n');
  // A fake claude that journals the tick entry only when FAKE_JOURNAL is set (the sandbox fake hardcodes testduty).
  const fake = path.join(s.vault, 'fake-tick-claude');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    '[ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf "\\n## 09:00 — duty: tick\\n- status: OK\\n" >> "$FAKE_JOURNAL"; }',
    'echo "{\\"type\\":\\"result\\",\\"result\\":\\"done\\",\\"total_cost_usd\\":0.01,\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1},\\"duration_ms\\":10}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...s.env, PERSONA_CLAUDE_BIN: fake };
  const tickState = () => JSON.parse(fs.readFileSync(path.join(s.vault, 'brain', '_index', 'persona-tick.json'), 'utf8'));
  const log = () => fs.readFileSync(path.join(s.logDir, 'duty-tick.log'), 'utf8');

  // 1. first run: a change by definition → the model runs, the contract passes, the beat is recorded
  const r1 = run(['tick'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(log(), /duty=tick done \(exit 0\)/);
  assert.equal(tickState().beats, 1);
  assert.equal(tickState().pending, null);
  assert.equal(fs.readFileSync(s.journal, 'utf8').match(/duty: tick/g).length, 1);

  // 2. nothing changed since the beat → skipped: exit 0, one log line, no new journal entry, no FAILED flag
  const r2 = run(['tick'], { ...env, FAKE_JOURNAL: s.journal });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(log(), /duty=tick skipped: unchanged since the last beat/);
  assert.equal((log().match(/ start$/mg) || []).length, 1, 'the model started once');
  assert.equal(fs.readFileSync(s.journal, 'utf8').match(/duty: tick/g).length, 1, 'a skip writes no journal entry');
  assert.equal(tickState().skipped, 1);
  assert.ok(!fs.readFileSync(path.join(s.vault, 'persona', 'STATE.md'), 'utf8').includes('FAILED'));

  // 3. a new feedback draft → the model runs but never journals → FAILED as usual, and the beat is NOT recorded
  const draft = path.join(s.vault, 'brain', 'memory', 'feedback', '_drafts', 'r-1.md');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, '# Rule\n');
  const r3 = run(['tick'], env);
  assert.equal(r3.status, 1);
  assert.match(fs.readFileSync(s.journal, 'utf8'), /duty: tick\n- status: FAILED/);
  assert.equal(tickState().beats, 1, 'no beat after a failed contract');
  assert.ok(tickState().pending, 'the pending signature waits for a run that meets the contract');
});

test('tick helper: the budget and allowlist come from the env like any duty (run-routine.js sets them from the routine file)', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'persona', 'duties', 'tick.md'), 'ascii fixture tick\n');
  const r = run(['tick', '--dry-run'], { ...s.env, PERSONA_MAX_USD: '0.05', PERSONA_TOOLS: 'Read,Glob,Grep,Bash(node tick.js:*)' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--max-budget-usd\n0\.05$/m);
  assert.match(r.stdout, /^--allowedTools\nRead,Glob,Grep,Bash\(node tick\.js:\*\)$/m);
  assert.ok(!fs.existsSync(path.join(s.vault, 'brain', '_index', 'persona-tick.json')), 'dry-run runs no precheck');
});
