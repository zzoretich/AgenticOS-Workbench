'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/host-routines.js');

const NOW = new Date('2026-09-21T23:00:00.000Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hosts-'));

test('describeRrule: the forms the Codex app writes, else the raw string', () => {
  assert.equal(H.describeRrule('FREQ=HOURLY;INTERVAL=24;BYMINUTE=0'), 'Every 24 h at :00');
  assert.equal(H.describeRrule('FREQ=HOURLY;INTERVAL=1'), 'Every hour');
  assert.equal(H.describeRrule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0'), 'Every day at 09:00');
  assert.equal(H.describeRrule('FREQ=DAILY;INTERVAL=2;BYHOUR=7;BYMINUTE=30'), 'Every 2 days at 07:30');
  assert.equal(H.describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=45'), 'Weekdays at 07:45');
  assert.equal(H.describeRrule('FREQ=WEEKLY;BYDAY=WE,MO;BYHOUR=18;BYMINUTE=30'), 'Mon, Wed at 18:30');
  assert.equal(H.describeRrule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=18'), 'Sundays at 18:00');
  assert.equal(H.describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0'), 'Every 2 weeks on Fridays at 16:00');
  assert.equal(H.describeRrule('RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=8;BYMINUTE=30'), 'Monthly on day 1 at 08:30');
  assert.equal(H.describeRrule('FREQ=MINUTELY;INTERVAL=15'), 'Every 15 min');
  assert.equal(H.describeRrule('FREQ=YEARLY;BYMONTH=1'), 'FREQ=YEARLY;BYMONTH=1');
  assert.equal(H.describeRrule(''), '');
  assert.equal(H.describeRrule(null), '');
});

const CODEX_ROWS = [
  { id: 'auto_1', name: 'Nightly triage', status: 'ACTIVE', kind: 'cron', rrule: 'FREQ=DAILY;BYHOUR=22;BYMINUTE=0',
    next_run_at: Date.parse('2026-09-22T22:00:00Z'), last_run_at: Date.parse('2026-09-21T22:00:00Z'), model: 'gpt-5-codex', cwds: '["/tmp/proj"]', target_type: 'local',
    prompt: 'Triage open issues.\nThen summarize.', run_status: 'completed', run_at: Date.parse('2026-09-21T22:00:10Z') },
  { id: 'auto_2', name: 'Paused one', status: 'PAUSED', kind: 'cron', rrule: 'FREQ=HOURLY;INTERVAL=24;BYMINUTE=0',
    next_run_at: Date.parse('2026-09-22T22:00:00Z'), last_run_at: null, model: null, cwds: 'not json', target_type: null, prompt: '', run_status: null, run_at: null },
];

test('readCodex: rows through an injected sqlite3, read-only and JSON', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  fs.writeFileSync(H.codexDbPath(home), '');
  const calls = [];
  const exec = (bin, args, opts) => { calls.push({ bin, args, opts }); return JSON.stringify(CODEX_ROWS); };
  const s = H.readCodex({ home, exec, now: NOW });
  assert.equal(s.ok, true); assert.equal(s.warning, null); assert.equal(s.fetchedAt, NOW.toISOString());
  assert.equal(calls[0].bin, 'sqlite3');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-readonly', '-json']);
  assert.equal(calls[0].args[2], H.codexDbPath(home));
  assert.match(calls[0].args[3], /FROM automations a/);
  assert.equal(s.routines.length, 2);
  const [a, b] = s.routines;
  assert.equal(a.id, 'auto_1'); assert.equal(a.name, 'Nightly triage'); assert.equal(a.enabled, true); assert.equal(a.status, 'active');
  assert.equal(a.cadence, 'Every day at 22:00'); assert.equal(a.schedule, 'FREQ=DAILY;BYHOUR=22;BYMINUTE=0');
  assert.equal(a.next, '2026-09-22T22:00:00.000Z');
  assert.deepEqual(a.last, { at: '2026-09-21T22:00:10.000Z', status: 'completed' });
  assert.equal(a.model, 'gpt-5-codex'); assert.equal(a.target, '/tmp/proj'); assert.equal(a.link, null);
  assert.equal(a.summary, 'Triage open issues.');
  assert.equal(b.enabled, false); assert.equal(b.status, 'paused'); assert.equal(b.next, null); assert.equal(b.last, null);
  assert.equal(b.target, null); assert.equal(b.cadence, 'Every 24 h at :00'); assert.equal(b.summary, '');
});

test('readCodex: no database, no binary, a failing query, empty output — all ok:false or empty, never a throw', () => {
  const home = tmp();
  const none = H.readCodex({ home, exec: () => { throw new Error('must not run'); }, now: NOW });
  assert.equal(none.ok, false); assert.match(none.warning, /no Codex automations database/); assert.deepEqual(none.routines, []);
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  fs.writeFileSync(H.codexDbPath(home), '');
  const enoent = H.readCodex({ home, exec: () => { const e = new Error('spawn sqlite3 ENOENT'); e.code = 'ENOENT'; throw e; }, now: NOW });
  assert.equal(enoent.ok, false); assert.match(enoent.warning, /sqlite3 is not on PATH/);
  const bad = H.readCodex({ home, exec: () => { const e = new Error('Command failed'); e.stderr = 'Error: no such table: automations\n'; throw e; }, now: NOW });
  assert.equal(bad.ok, false); assert.match(bad.warning, /no such table: automations/);
  const empty = H.readCodex({ home, exec: () => '', now: NOW });
  assert.equal(empty.ok, true); assert.deepEqual(empty.routines, []);
  const garbage = H.readCodex({ home, exec: () => 'not json', now: NOW });
  assert.equal(garbage.ok, false); assert.match(garbage.warning, /unexpected sqlite3 output/);
});

const CLOUD = {
  data: [
    { id: 'trig_02', name: 'Weekly digest', cron_expression: '0 13 * * 1', enabled: true, next_run_at: '2026-09-28T13:00:00Z', last_fired_at: '2026-09-21T13:00:05Z',
      ended_reason: '', derived_state: { model: 'claude-sonnet-5', prompt: 'Summarize the week.\nMore.' },
      job_config: { ccr: { session_context: { model: 'claude-sonnet-5', sources: [{ git_repository: { url: 'https://github.com/example/repo' } }] } } } },
    { id: 'trig_01', name: 'One shot', run_once_at: '2026-05-16T13:00:00Z', enabled: false, next_run_at: '2026-05-17T13:00:06Z', last_fired_at: '2026-05-16T13:00:06Z',
      ended_reason: 'run_once_fired', derived_state: { model: 'claude-sonnet-4-6' }, job_config: { ccr: { session_context: { sources: [] } } } },
    { id: 'trig_03', name: 'Bare', enabled: false },
    null, { name: 'no id' },
  ],
  has_more: false,
};

test('normalizeCloud: cron (UTC), once-fired, bare, and junk entries; sorted by name', () => {
  const s = H.normalizeCloud(CLOUD, NOW);
  assert.equal(s.fetchedAt, NOW.toISOString());
  assert.deepEqual(s.routines.map(r => r.id), ['trig_03', 'trig_01', 'trig_02']);
  const [bare, once, weekly] = s.routines;
  assert.equal(weekly.cadence, 'Mondays at 13:00 (UTC)'); assert.equal(weekly.schedule, '0 13 * * 1');
  assert.equal(weekly.enabled, true); assert.equal(weekly.status, 'active'); assert.equal(weekly.next, '2026-09-28T13:00:00Z');
  assert.deepEqual(weekly.last, { at: '2026-09-21T13:00:05Z', status: 'fired' });
  assert.equal(weekly.model, 'claude-sonnet-5'); assert.equal(weekly.target, 'https://github.com/example/repo');
  assert.equal(weekly.link, 'https://claude.ai/code/routines/trig_02'); assert.equal(weekly.summary, 'Summarize the week.');
  assert.match(once.cadence, /^once at (Sat|Sun|Mon|Tue|Wed|Thu|Fri) 2026-05-1\d \d\d:\d\d$/);
  assert.equal(once.enabled, false); assert.equal(once.status, 'ran once'); assert.equal(once.next, null);
  assert.deepEqual(once.last, { at: '2026-05-16T13:00:06Z', status: 'ran once' });
  assert.equal(once.model, 'claude-sonnet-4-6'); assert.equal(once.target, null);
  assert.equal(bare.cadence, 'no schedule'); assert.equal(bare.status, 'paused'); assert.equal(bare.last, null); assert.equal(bare.model, null);
});

test('normalizeCloud: anything but the list payload is a TypeError', () => {
  for (const bad of [null, 'x', {}, { data: 'nope' }, []]) assert.throws(() => H.normalizeCloud(bad, NOW), TypeError);
});

test('cache: write merges per host, null drops a host, corrupt or missing reads as empty', () => {
  const vault = tmp();
  const file = H.cacheFile(vault);
  assert.deepEqual(H.readCache(file), { schema: 1, hosts: {} });
  H.writeCache(file, { codex: { fetchedAt: 'a', ok: true, warning: null, routines: [] } });
  H.writeCache(file, { claude: { fetchedAt: 'b', routines: [{ id: 'x' }] } });
  let c = H.readCache(file);
  assert.deepEqual(Object.keys(c.hosts).sort(), ['claude', 'codex']);
  assert.equal(c.hosts.codex.fetchedAt, 'a');
  H.writeCache(file, { codex: null });
  c = H.readCache(file);
  assert.deepEqual(Object.keys(c.hosts), ['claude']);
  fs.writeFileSync(file, '{nope');
  assert.deepEqual(H.readCache(file), { schema: 1, hosts: {} });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, hosts: { claude: { fetchedAt: 'b' }, other: { routines: [] } } }));
  assert.deepEqual(H.readCache(file), { schema: 1, hosts: {} });
});

test('refresh: honours hosts.codex.enabled and hosts.codex.home; importCloud keeps the codex section', () => {
  const vault = tmp(); const home = tmp();
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  fs.writeFileSync(H.codexDbPath(home), '');
  const exec = () => JSON.stringify(CODEX_ROWS.slice(0, 1));
  let c = H.refresh({ vault, cfg: { hosts: { codex: { home } } }, env: {}, exec, now: NOW });
  assert.equal(c.hosts.codex.ok, true); assert.equal(c.hosts.codex.routines.length, 1);
  c = H.importCloud({ vault, payload: CLOUD, now: NOW });
  assert.equal(c.hosts.codex.routines.length, 1); assert.equal(c.hosts.claude.routines.length, 3);
  c = H.refresh({ vault, cfg: { hosts: { codex: { enabled: false, home } } }, env: {}, exec, now: NOW });
  assert.equal(c.hosts.codex, undefined); assert.equal(c.hosts.claude.routines.length, 3);
  assert.equal(H.codexHomeOf({}, { CODEX_HOME: home }), home);
  assert.equal(H.codexHomeOf({ hosts: { codex: { home } } }, { CODEX_HOME: '/elsewhere' }), home);
  const flat = H.flatten(H.readCache(H.cacheFile(vault)));
  assert.deepEqual(flat.map(r => r.host), ['claude', 'claude', 'claude']);
  assert.equal(flat[0].fetchedAt, NOW.toISOString());
});
