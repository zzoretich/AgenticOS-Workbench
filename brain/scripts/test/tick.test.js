'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../persona/tick.js');

const NOW = new Date('2026-09-22T10:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const HOUR = 3600e3, DAY = 86400e3;

/** A vault with the inputs the tick watches, all stamped an hour before NOW so a later touch is visible. */
function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-vault-'));
  const put = (rel, text = '') => { const f = path.join(v, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  put('persona/journal/2026-09-22.md', '## 09:00 — duty: sitrep\n- status: OK\n');
  put('brain/memory/feedback/existing-rule.md', '# Existing rule\n');
  put('brain/memory/feedback/_drafts/.keep', '');
  put('persona/STATE.md', '# Persona State\n\n## Sitrep\n- fine\n\n## Flags\n- [ ] 2026-09-01 duty \'monitor\' FAILED — old\n- [ ] 2026-09-20 fresh flag\n\n## Priorities\n- tests\n');
  put('persona/proposals/README.md', '# Proposals\n');
  put('persona/ledger.jsonl', JSON.stringify({ schema: 1, ts: '2026-09-15T00:00:00.000Z', event: 'approved', slug: 'old-fix', kind: 'self' }) + '\n');
  const repo = path.join(v, 'repo');
  put('repo/.git/HEAD', 'ref: refs/heads/main\n');
  put('repo/.planning/STATE.md', 'phase: 2 of 5\n');
  put('persona/repos.json', JSON.stringify({ stall_threshold_days: 4, repos: [{ name: 'app', path: repo }] }));
  put('brain/_index/persona-heartbeat.json', JSON.stringify({ schema: 1, checkedAt: at(-HOUR).toISOString(), beats: { sitrep: { status: 'ok', lastRunAt: '2026-09-22T07:45:00.000Z' } } }));
  const old = at(-HOUR);
  const stamp = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) stamp(f); fs.utimesSync(f, old, old); } fs.utimesSync(dir, old, old); };
  stamp(v);
  return v;
}
function deps(v, cfg = {}) { return { vault: v, config: () => cfg, now: () => NOW }; }
const touch = (f, when) => { fs.utimesSync(f, when, when); };
const state = (v) => JSON.parse(fs.readFileSync(path.join(v, 'brain', '_index', 'persona-tick.json'), 'utf8'));
const queueLines = (v) => { try { return fs.readFileSync(path.join(v, 'persona', 'queue.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

test('precheck: the first run is a change; after a beat an untouched vault is unchanged and counts the skip', () => {
  const v = vault(); const d = deps(v);
  const first = T.precheck({ deps: d });
  assert.deepEqual(first, { changed: true, changes: ['first-run'], since: null });
  assert.ok(state(v).pending, 'the pending signature waits for the beat');
  const b = T.beat({ deps: d, now: at(60e3) });
  assert.equal(b.beats, 1);
  assert.equal(state(v).pending, null);
  const second = T.precheck({ deps: d, now: at(HOUR) });
  assert.equal(second.changed, false);
  assert.deepEqual(second.changes, []);
  assert.equal(second.since, at(60e3).toISOString());
  assert.equal(state(v).skipped, 1);
  assert.equal(T.main(['precheck', '--root', v]), T.EXIT_UNCHANGED, 'the CLI exit the runner keys on');
});

test('precheck: a new draft, a repo commit, a new miss and a proposal each wake the tick, named in changes', () => {
  const v = vault(); const d = deps(v);
  T.precheck({ deps: d }); T.beat({ deps: d });
  const later = at(30 * 60e3);
  const draft = path.join(v, 'brain', 'memory', 'feedback', '_drafts', 'r-1.md');
  fs.writeFileSync(draft, '# Rule\n'); touch(draft, later);
  assert.deepEqual(T.precheck({ deps: d, now: at(HOUR) }).changes, ['drafts']);
  T.beat({ deps: d, now: at(HOUR) });
  touch(path.join(v, 'repo', '.git', 'HEAD'), at(2 * HOUR));
  assert.deepEqual(T.precheck({ deps: d, now: at(2 * HOUR) }).changes, ['repos.app']);
  T.beat({ deps: d, now: at(2 * HOUR) });
  // The watchdog file is rewritten every 30 min: a fresh checkedAt alone is not a change, a status change is.
  const hb = path.join(v, 'brain', '_index', 'persona-heartbeat.json');
  const cur = JSON.parse(fs.readFileSync(hb, 'utf8'));
  fs.writeFileSync(hb, JSON.stringify({ ...cur, checkedAt: at(3 * HOUR).toISOString() }));
  assert.equal(T.precheck({ deps: d, now: at(3 * HOUR) }).changed, false, 'checkedAt alone is not news');
  cur.beats.sitrep.status = 'missed';
  fs.writeFileSync(hb, JSON.stringify(cur));
  assert.deepEqual(T.precheck({ deps: d, now: at(3 * HOUR) }).changes, ['beats']);
  T.beat({ deps: d, now: at(3 * HOUR) });
  const prop = path.join(v, 'persona', 'proposals', '2026-09-22-x.md');
  fs.writeFileSync(prop, '---\nslug: x\n---\n'); touch(prop, at(4 * HOUR));
  assert.deepEqual(T.precheck({ deps: d, now: at(4 * HOUR) }).changes, ['proposals']);
});

test('beat: the tick\'s own journal and STATE.md writes do not wake the next tick, a change during the run still does', () => {
  const v = vault(); const d = deps(v);
  T.precheck({ deps: d });
  // during the "model run": the tick appends its journal entry and its STATE line, and the user edits a feedback rule
  const j = path.join(v, 'persona', 'journal', '2026-09-22.md');
  fs.appendFileSync(j, '\n## 10:00 — duty: tick\n- status: OK\n'); touch(j, at(60e3));
  const st = path.join(v, 'persona', 'STATE.md');
  fs.appendFileSync(st, '- tick: 2026-09-22 OK\n'); touch(st, at(60e3));
  const rule = path.join(v, 'brain', 'memory', 'feedback', 'existing-rule.md');
  fs.appendFileSync(rule, 'more\n'); touch(rule, at(60e3));
  T.beat({ deps: d, now: at(2 * 60e3) });
  assert.deepEqual(T.precheck({ deps: d, now: at(HOUR) }).changes, ['feedback'], 'only the external edit is news');
});

test('signals: one candidate per type with a source pointer, nothing older than the last beat, queued ones marked', () => {
  const v = vault(); const d = deps(v, { persona: { tick: { flagAgeDays: 7 } } });
  // The fixture is stamped one hour before NOW; the last beat lands a minute after that, so only later writes are news.
  const SINCE = at(-HOUR + 60e3);
  T.precheck({ deps: d }); T.beat({ deps: d, now: SINCE });
  const draft = path.join(v, 'brain', 'memory', 'feedback', '_drafts', 'r-1.md');
  fs.writeFileSync(draft, '# Always run the gate\n'); touch(draft, at(-30 * 60e3));
  const hb = path.join(v, 'brain', '_index', 'persona-heartbeat.json');
  fs.writeFileSync(hb, JSON.stringify({ schema: 1, checkedAt: NOW.toISOString(), beats: {
    sitrep: { status: 'missed', due: at(-20 * 60e3).toISOString(), lastRunAt: '2026-09-21T07:45:00.000Z' },
    monitor: { status: 'failed', lastRunAt: at(-3 * HOUR).toISOString() },   // before the last beat: already seen
    reflect: { status: 'ok', lastRunAt: '2026-09-20T18:00:00.000Z' },
  } }));
  touch(path.join(v, 'repo', '.planning', 'STATE.md'), at(-5 * DAY));
  fs.appendFileSync(path.join(v, 'persona', 'ledger.jsonl'), JSON.stringify({ schema: 1, ts: at(-10 * 60e3).toISOString(), event: 'regressed', slug: 'old-fix', kind: 'self' }) + '\n');
  T.queue({ type: 'repo-stall', source: 'app:.planning/STATE.md', note: 'already there', deps: d });

  const r = T.signals({ deps: d });
  assert.equal(r.since, SINCE.toISOString());
  assert.equal(r.flagAgeDays, 7);
  const by = Object.fromEntries(r.candidates.map(c => [c.type, c]));
  assert.deepEqual(Object.keys(by).sort(), ['correction', 'duty-failure', 'flag-aged', 'regressed', 'repo-stall']);
  assert.equal(r.candidates.length, 5, 'monitor failed before the last beat and the 2-day-old flag are not candidates');
  assert.equal(by.correction.source, 'brain/memory/feedback/_drafts/r-1.md');
  assert.equal(by.correction.title, 'Always run the gate');
  assert.equal(by['duty-failure'].source, 'brain/_index/persona-heartbeat.json#sitrep');
  assert.equal(by['duty-failure'].title, "duty 'sitrep' missed");
  assert.equal(by['repo-stall'].source, 'app:.planning/STATE.md');
  assert.equal(by['repo-stall'].queued, true, 'already in the queue');
  assert.match(by['repo-stall'].title, /^app planning idle 5d$/);
  assert.equal(by.regressed.source, 'persona/ledger.jsonl#old-fix');
  assert.equal(by['flag-aged'].source, "persona/STATE.md#duty 'monitor' FAILED — old");
  assert.match(by['flag-aged'].title, /^flag open 21d: /);
  for (const c of r.candidates.filter(c => c.type !== 'repo-stall')) assert.equal(c.queued, false, c.type);
});

test('signals: a first run looks back 24 h, not forever', () => {
  const v = vault(); const d = deps(v);
  const old = path.join(v, 'brain', 'memory', 'feedback', 'existing-rule.md');
  touch(old, at(-2 * DAY));
  const recent = path.join(v, 'brain', 'memory', 'feedback', 'new-rule.md');
  fs.writeFileSync(recent, '# New\n'); touch(recent, at(-2 * HOUR));
  const r = T.signals({ deps: d });
  assert.equal(r.since, at(-DAY).toISOString());
  assert.deepEqual(r.candidates.filter(c => c.type === 'correction').map(c => c.source), ['brain/memory/feedback/new-rule.md']);
});

test('queue: validates the type and the source, appends the line shape, dedupes on (type, source)', () => {
  const v = vault(); const d = deps(v);
  assert.throws(() => T.queue({ type: 'gossip', source: 'x', deps: d }), /type must be one of/);
  assert.throws(() => T.queue({ type: 'correction', source: ' ', deps: d }), /--source/);
  const a = T.queue({ type: 'correction', source: 'brain/memory/feedback/_drafts/r-1.md', note: '  the third time this week  ', deps: d });
  assert.equal(a.duplicate, false);
  assert.deepEqual(a.record, { schema: 1, ts: NOW.toISOString(), type: 'correction', source: 'brain/memory/feedback/_drafts/r-1.md', note: 'the third time this week', by: 'tick' });
  const b = T.queue({ type: 'correction', source: 'brain/memory/feedback/_drafts/r-1.md', deps: d, now: at(HOUR) });
  assert.equal(b.duplicate, true);
  assert.equal(b.record.ts, NOW.toISOString(), 'the original record is returned');
  T.queue({ type: 'flag-aged', source: 'persona/STATE.md#old', deps: d });
  assert.deepEqual(queueLines(v).map(q => q.type), ['correction', 'flag-aged']);
  assert.equal(queueLines(v)[1].note, null);
});

// Spec 2026-09-22-persona-reflect-daily-design D7: the queue can bring the daily reflect forward, decided runner-side.
test('shouldReflectEarly: 3 corrections, a duty with failStreak 2, or two duties failing once; nothing below', () => {
  const T0 = { corrections: 3, dutyFailures: 2 };
  const c = (n) => Array.from({ length: n }, (_, i) => ({ type: 'correction', source: `brain/memory/feedback/r-${i}.md` }));
  const fail = (slug) => ({ type: 'duty-failure', source: `brain/_index/persona-heartbeat.json#${slug}` });
  assert.equal(T.shouldReflectEarly(c(2), null, T0).trigger, false);
  assert.equal(T.shouldReflectEarly(c(3), null, T0).trigger, true);
  assert.match(T.shouldReflectEarly(c(3), null, T0).reason, /3 corrections queued/);
  assert.equal(T.shouldReflectEarly([fail('reflect')], { routines: { reflect: { failStreak: 1 } } }, T0).trigger, false);
  assert.equal(T.shouldReflectEarly([fail('reflect')], { routines: { reflect: { failStreak: 2 } } }, T0).trigger, true, 'one duty failing twice in a row is a streak');
  assert.equal(T.shouldReflectEarly([fail('reflect'), fail('monitor')], null, T0).trigger, true, 'two duties failing once each');
  assert.deepEqual(T.shouldReflectEarly([...c(1), fail('sitrep'), { type: 'repo-stall', source: 'app:x' }], { routines: {} }, T0), { trigger: false, reason: null, corrections: 1, failures: 1 });
  assert.equal(T.shouldReflectEarly([], null, T0).trigger, false, 'a drained queue never triggers');
  assert.deepEqual(T.earlyThresholds({}), { corrections: 3, dutyFailures: 2 });
  assert.deepEqual(T.earlyThresholds({ persona: { tick: { earlyReflect: { corrections: 2, dutyFailures: -1 } } } }), { corrections: 2, dutyFailures: 2 });
});

test('beat starts reflect-daily early once per day through run-routine.js, and not when the routine is missing or disabled', () => {
  const v = vault();
  const spawned = [];
  const d = { ...deps(v), spawnReflect: (argv) => { spawned.push(argv); return 4242; } };
  for (let i = 0; i < 3; i++) T.queue({ type: 'correction', source: `brain/memory/feedback/r-${i}.md`, deps: d });
  T.precheck({ deps: d });
  // no routine file yet → decision is yes, but nothing to start
  const b0 = T.beat({ deps: d });
  assert.equal(b0.earlyReflect.started, false);
  assert.match(b0.earlyReflect.reason, /no valid brain\/routines\/reflect-daily\.md/);
  assert.equal(spawned.length, 0);
  // seed the routine like aos persona does, then the next beat starts it
  const routines = path.join(v, 'brain', 'routines');
  fs.mkdirSync(routines, { recursive: true });
  const seed = path.join(__dirname, '..', '..', '..', 'vault-template', 'persona', 'routines', 'reflect-daily.md');
  fs.copyFileSync(seed, path.join(routines, 'reflect-daily.md'));
  // (NOW is 10:00 UTC; the two same-day beats stay within the hour so they share a local day in every timezone)
  const b1 = T.beat({ deps: d, now: at(30 * 60e3) });
  assert.equal(b1.earlyReflect.started, true, JSON.stringify(b1.earlyReflect));
  assert.equal(b1.earlyReflect.pid, 4242);
  assert.deepEqual(b1.earlyReflect.argv, [process.execPath, path.join(__dirname, '..', 'routines', 'run-routine.js'), 'reflect-daily', '--early']);
  assert.equal(state(v).lastEarlyReflectAt, at(30 * 60e3).toISOString());
  // same day, still over threshold → not again
  const b2 = T.beat({ deps: d, now: at(HOUR) });
  assert.equal(b2.earlyReflect.started, false);
  assert.match(b2.earlyReflect.reason, /already started today/);
  assert.equal(spawned.length, 1);
  // next day → again; disabled routine → never
  const b3 = T.beat({ deps: d, now: at(DAY + 2 * HOUR) });
  assert.equal(b3.earlyReflect.started, true);
  fs.writeFileSync(path.join(routines, 'reflect-daily.md'), fs.readFileSync(path.join(routines, 'reflect-daily.md'), 'utf8').replace('enabled: true', 'enabled: false'));
  const b4 = T.beat({ deps: d, now: at(2 * DAY + 2 * HOUR) });
  assert.equal(b4.earlyReflect.started, false);
  assert.match(b4.earlyReflect.reason, /disabled/);
  assert.equal(spawned.length, 2);
  // below threshold → the check says so and touches nothing
  fs.writeFileSync(path.join(v, 'persona', 'queue.jsonl'), '');
  const b5 = T.beat({ deps: d, now: at(3 * DAY) });
  assert.deepEqual(b5.earlyReflect, { started: false, reason: 'below threshold', corrections: 0, failures: 0 });
  assert.equal(b5.beats, 6, 'the beat itself is always recorded');
});

test('CLI: queue prints the record, a bad queue call exits 2, usage exits 2, a corrupt state file reads as empty', () => {
  const v = vault();
  assert.equal(T.main(['queue', 'regressed', '--source', 'persona/ledger.jsonl#x', '--note', 'n', '--root', v]), 0);
  assert.equal(queueLines(v).length, 1);
  assert.equal(T.main(['queue', 'nope', '--source', 'x', '--root', v]), 2);
  assert.equal(T.main(['--root', v]), 2);
  assert.deepEqual(T.positionals(['--root', v, 'queue', 'correction', '--source', 'a b', '--note', 'why']), ['queue', 'correction']);
  fs.writeFileSync(path.join(v, 'brain', '_index', 'persona-tick.json'), '{ not json');
  assert.equal(T.readState(deps(v)).lastBeatAt, null);
  assert.equal(T.main(['precheck', '--root', v]), 0, 'a first run after a corrupt state is a change');
  assert.equal(state(v).schema, 1);
});
