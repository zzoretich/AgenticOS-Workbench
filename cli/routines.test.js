'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./routines.js');
const store = require('../brain/scripts/lib/routines-store.js');

function world() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cfg-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ vault, node: process.execPath, claude: { model: 'haiku' } }));
  const logs = []; const errs = [];
  const io = { log: (m) => logs.push(String(m)), error: (m) => errs.push(String(m)) };
  const dir = path.join(vault, 'brain', 'routines');
  const put = (slug, extra = {}, body = '') => store.write({ slug, schema: 1, name: slug, kind: 'command', schedule: '0 9 * * *', enabled: true, argv: ['true'], ...extra, body }, { dir });
  return { configDir, vault, io, logs, errs, dir, put, out: () => logs.join('\n') };
}
const NOW = new Date(2026, 8, 21, 14, 0);   // Mon 2026-09-21 14:00 local

test('list: empty vault says where routines live', async () => {
  const w = world();
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io }), 0);
  assert.match(w.out(), /no routines under .*brain\/routines/);
});

test('list: a table with cadence, next fire, last run and health; --json mirrors it', async () => {
  const w = world();
  w.put('monitor', { kind: 'duty', schedule: '0 13 * * *', guarded: true });
  w.put('off', { enabled: false });
  fs.writeFileSync(path.join(w.dir, 'bad.md'), '---\nschema: 1\nname: bad\nkind: command\nschedule: "x"\nenabled: true\nargv: [true]\n---\n');
  store.patchState('monitor', (c) => ({ ...c, lastRunAt: new Date(2026, 8, 21, 13, 0).toISOString(), lastExit: 0, lastCostUsd: 0.12, failStreak: 0, lastTrigger: 'scheduled' }), { file: path.join(w.vault, 'brain', '_index', 'routines.json') });
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  const out = w.out();
  assert.match(out, /^slug\s+kind\s+on\s+cadence\s+next\s+last\s+health$/m);
  assert.match(out, /^monitor\s+duty\s+on\s+Every day at 13:00\s+Tue 2026-09-22 13:00\s+1h ago \(exit 0, \$0\.12\)\s+ok$/m);
  assert.match(out, /^off\s+command\s+off\s+Every day at 09:00\s+—\s+never\s+off$/m);
  assert.match(out, /^bad\s+command\s+on\s+x\s+—\s+never\s+invalid$/m);
  assert.match(w.errs.join('\n'), /^bad: schedule: /m);

  w.logs.length = 0;
  assert.equal(await R.main(['list', '--json'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  const j = JSON.parse(w.out());
  assert.equal(j.schema, 1);
  const m = j.routines.find(r => r.slug === 'monitor');
  assert.equal(m.health, 'ok');
  assert.equal(m.last.usd, 0.12);
  assert.equal(m.next.length, 3);
  assert.equal(j.routines.find(r => r.slug === 'bad').health, 'invalid');
});

test('list: stale after the schedule changed since the last sync; failed after a bad exit', async () => {
  const w = world();
  w.put('alpha');
  const file = path.join(w.vault, 'brain', '_index', 'routines.json');
  store.writeState({ ...store.readState({ file }), synced: { alpha: 'command|0 8 * * *|on' }, syncedAt: NOW.toISOString() }, { file });
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^alpha\s+.*\s+stale$/m);
  store.patchState('alpha', (c) => ({ ...c, lastExit: 3, failStreak: 2 }), { file });
  store.writeState({ ...store.readState({ file }), synced: { alpha: 'command|0 9 * * *|on' } }, { file });
  w.logs.length = 0;
  assert.equal(await R.main(['list'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^alpha\s+.*\s+failed$/m);
});

test('sync: builds the template vars from persona answers and reports labels, removals and warnings', async () => {
  const w = world();
  w.put('alpha');
  fs.mkdirSync(path.join(w.vault, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'persona', 'answers.json'), JSON.stringify({ name: 'Atlas', dutyModel: 'sonnet', dutyEffort: 'high' }));
  let seen = null;
  const installSchedules = (o) => { seen = o; o.warn('launchctl load x: boom'); return { platform: 'darwin', written: ['x'], removed: ['/tmp/la/com.agenticos.gone.plist'], labels: ['com.agenticos.alpha'], warnings: ['launchctl load x: boom'] }; };
  assert.equal(await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules, platform: 'darwin' }), 1, 'a warning makes sync exit 1');
  assert.equal(seen.vars.VAULT, w.vault);
  assert.equal(seen.vars.AGENT_NAME, 'Atlas');
  assert.equal(seen.vars.MODEL, 'sonnet');
  assert.equal(seen.vars.EFFORT, 'high');
  assert.equal(seen.vars.NODE, process.execPath);
  assert.equal(seen.vars.AOS_CONFIG, path.join(w.configDir, 'agenticos.json'));
  assert.equal(seen.platform, 'darwin');
  assert.match(w.out(), /routines: scheduled com\.agenticos\.alpha; removed com\.agenticos\.gone\.plist/);
  assert.match(w.errs.join('\n'), /warning: launchctl load x: boom/);
  w.logs.length = 0;
  assert.equal(await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules: () => ({ platform: 'win32', unsupported: true, written: [], removed: [], labels: [], warnings: [] }) }), 0);
  assert.match(w.out(), /not supported on win32/);
});

test('sync without persona answers falls back to claude.model and the default agent name', async () => {
  const w = world();
  let seen = null;
  await R.main(['sync'], { configDir: w.configDir, io: w.io, installSchedules: (o) => { seen = o; return { platform: 'linux', written: [], removed: [], labels: [], warnings: [] }; } });
  assert.equal(seen.vars.MODEL, 'haiku');
  assert.equal(seen.vars.AGENT_NAME, 'persona');
  assert.match(w.out(), /scheduled nothing \(no enabled routine\)/);
});

test('enable/disable rewrite the file and sync; unknown or invalid slugs exit 2', async () => {
  const w = world();
  w.put('alpha');
  let synced = 0;
  const opts = { configDir: w.configDir, io: w.io, installSchedules: () => { synced++; return { platform: 'linux', written: [], removed: [], labels: [], warnings: [] }; } };
  assert.equal(await R.main(['disable', 'alpha'], opts), 0);
  assert.equal(store.read('alpha', { dir: w.dir }).enabled, false);
  assert.equal(await R.main(['enable', 'alpha'], opts), 0);
  assert.equal(store.read('alpha', { dir: w.dir }).enabled, true);
  assert.equal(synced, 2);
  assert.match(w.out(), /alpha: disabled[\s\S]*alpha: enabled/);
  assert.equal(await R.main(['enable', 'nope'], opts), 2);
  await assert.rejects(() => R.main(['enable'], opts), R.UsageError);
});

test('run: spawns the vendored runner with --manual (and --dry-run), propagating its exit code', async () => {
  const w = world();
  w.put('alpha');
  fs.mkdirSync(path.join(w.vault, 'brain', 'scripts', 'routines'), { recursive: true });
  fs.writeFileSync(path.join(w.vault, 'brain', 'scripts', 'routines', 'run-routine.js'), '// vendored\n');
  let seen = null;
  const spawn = (cmd, args, o) => { seen = { cmd, args, o }; return { status: 3 }; };
  assert.equal(await R.main(['run', 'alpha', '--dry-run'], { configDir: w.configDir, io: w.io, spawn }), 3);
  assert.equal(seen.cmd, process.execPath);
  assert.deepEqual(seen.args, [path.join(w.vault, 'brain', 'scripts', 'routines', 'run-routine.js'), 'alpha', '--manual', '--dry-run']);
  assert.equal(seen.o.env.AOS_VAULT, w.vault);
  assert.equal(seen.o.cwd, w.vault);
  assert.equal(await R.main(['run', 'nope'], { configDir: w.configDir, io: w.io, spawn }), 2);
  await assert.rejects(() => R.main(['run'], { configDir: w.configDir, io: w.io, spawn }), R.UsageError);
});

test('next: three fire times per routine, disabled and invalid rows say so', async () => {
  const w = world();
  w.put('alpha', { schedule: '45 7 * * 1-5' });
  w.put('off', { enabled: false });
  assert.equal(await R.main(['next'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.match(w.out(), /^alpha: Weekdays at 07:45\n  Tue 2026-09-22 07:45\n  Wed 2026-09-23 07:45\n  Thu 2026-09-24 07:45$/m);
  assert.match(w.out(), /^off: disabled$/m);
  w.logs.length = 0;
  assert.equal(await R.main(['next', 'alpha'], { configDir: w.configDir, io: w.io, now: NOW }), 0);
  assert.ok(!w.out().includes('off:'));
  assert.equal(await R.main(['next', 'nope'], { configDir: w.configDir, io: w.io }), 2);
});

test('unknown verb is a usage error; no verb means list', async () => {
  const w = world();
  await assert.rejects(() => R.main(['frob'], { configDir: w.configDir, io: w.io }), /unknown verb "frob"/);
  assert.equal(await R.main([], { configDir: w.configDir, io: w.io }), 0);
  assert.match(w.out(), /no routines/);
});
