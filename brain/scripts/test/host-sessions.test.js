'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectHostSessions, attachSessions, firstLine, insideDir } = require('../collectors/hostSessions');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hs-'));
const VAULT = '/home/demo/AgenticOS';
const WS = (n) => `${VAULT}/workspaces/${n}`;

// Claude: three cwd slugs, one of them a Windows path
const claude = path.join(T, 'projects');
for (const [slug, n, day] of [['-home-demo-AgenticOS-workspaces-alpha', 2, 10], ['-home-demo', 1, 5], ['C--Users-demo-proj', 1, 20], ['not-a-cwd-slug', 3, 1]]) {
  fs.mkdirSync(path.join(claude, slug), { recursive: true });
  for (let i = 0; i < n; i++) {
    const f = path.join(claude, slug, `aaaaaaaa-0000-4000-8000-00000000000${i}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    const t = new Date(Date.UTC(2026, 8, day, 12 + i)); // UTC: lastAt is compared as an ISO (UTC) date
    fs.utimesSync(f, t, t);
  }
}
// Codex: rollouts by date, one archived, one without a cwd, one unparseable
const codex = path.join(T, 'codex', 'sessions');
const day = path.join(codex, '2026', '09', '21');
fs.mkdirSync(day, { recursive: true });
fs.mkdirSync(path.join(T, 'codex', 'archived_sessions'), { recursive: true });
const rollout = (dir, id, cwd, ts, extra = '') => fs.writeFileSync(path.join(dir, `rollout-2026-09-21T10-00-00-${id}.jsonl`),
  (cwd === null ? JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id } }) : JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, cwd } })) + '\n' + extra + '{"type":"event_msg","payload":{"type":"task_started"}}\n');
rollout(day, 'a1', `${WS('alpha')}/sub`, '2026-09-21T15:00:00.000Z');
rollout(day, 'a2', WS('alphabet'), '2026-09-21T16:00:00.000Z');
rollout(day, 'a3', null, '2026-09-21T17:00:00.000Z');
rollout(day, 'a4', `${VAULT}/brain`, '2026-09-21T18:00:00.000Z');
rollout(path.join(T, 'codex', 'archived_sessions'), 'old', '/home/demo/elsewhere', '2026-08-01T09:00:00.000Z');
fs.writeFileSync(path.join(day, 'rollout-garbage.jsonl'), 'not json\n');

const opts = { claudeProjectsDir: claude, codexSessionsDir: codex, codexArchivedDir: path.join(T, 'codex', 'archived_sessions') };

test('collectHostSessions counts both hosts per decoded cwd and reads only the first rollout line', () => {
  const { byCwd, scannedAt } = collectHostSessions(opts);
  assert.ok(Date.parse(scannedAt) > 0);
  assert.deepEqual(Object.keys(byCwd).sort(), [
    'C:\\Users\\demo\\proj', '/home/demo', `${VAULT}/brain`, `${WS('alpha')}/sub`, WS('alphabet'), '/home/demo/elsewhere', WS('alpha'),
  ].sort());
  assert.equal(byCwd[WS('alpha')].claude, 2);
  assert.equal(byCwd[WS('alpha')].codex, 0);
  assert.match(byCwd[WS('alpha')].lastAt, /^2026-09-10T/);
  assert.deepEqual(byCwd[`${WS('alpha')}/sub`], { claude: 0, codex: 1, lastAt: '2026-09-21T15:00:00.000Z' });
  assert.deepEqual(byCwd['/home/demo/elsewhere'], { claude: 0, codex: 1, lastAt: '2026-08-01T09:00:00.000Z' });
  assert.equal(byCwd['C:\\Users\\demo\\proj'].claude, 1);
  assert.ok(!('not-a-cwd-slug' in byCwd), 'a user-named folder under projects/ is not a cwd');
});

test('attachSessions pins by longest path prefix, never a sibling with a shared name prefix, and lists the rest', () => {
  const { byCwd } = collectHostSessions(opts);
  const workspaces = [
    { name: 'alpha', absPath: WS('alpha') },
    { name: 'alphabet', absPath: WS('alphabet') },
    { name: 'no-path' },
  ];
  const outside = attachSessions(workspaces, byCwd, { vault: VAULT, ignore: ['/home/demo'] });
  assert.deepEqual(workspaces[0].sessions, { claude: 2, codex: 1, total: 3, lastAt: '2026-09-21T15:00:00.000Z' });
  assert.deepEqual(workspaces[1].sessions, { claude: 0, codex: 1, total: 1, lastAt: '2026-09-21T16:00:00.000Z' });
  assert.deepEqual(workspaces[2].sessions, { claude: 0, codex: 0, total: 0, lastAt: null });
  // outside: the Windows project and the archived elsewhere session; the home dir (ignored) and the vault's own
  // brain/ (inside the vault, outside workspaces/) are infrastructure, not stray projects
  assert.deepEqual(outside.map((o) => o.cwd), ['C:\\Users\\demo\\proj', '/home/demo/elsewhere']);
  assert.equal(outside[0].claude, 1);
  assert.equal(outside[1].codex, 1);
});

test('empty or missing roots yield nothing and never throw', () => {
  const r = collectHostSessions({ claudeProjectsDir: path.join(T, 'nope'), codexSessionsDir: null, codexArchivedDir: null });
  assert.deepEqual(r.byCwd, {});
  assert.deepEqual(attachSessions([], {}, { vault: VAULT, ignore: [] }), []);
  assert.deepEqual(attachSessions(null, null, { vault: VAULT, ignore: [] }), []);
});

test('firstLine and insideDir helpers', () => {
  const f = path.join(T, 'two-lines.txt');
  fs.writeFileSync(f, 'first\nsecond\n');
  assert.equal(firstLine(f), 'first');
  assert.equal(firstLine(path.join(T, 'absent')), '');
  assert.equal(insideDir('/a/b/c', '/a/b'), true);
  assert.equal(insideDir('/a/bc', '/a/b'), false, 'a shared name prefix is not containment');
  assert.equal(insideDir('/a/b', '/a/b'), true);
  assert.equal(insideDir('C:\\Users\\x\\p', 'C:\\Users\\x'), true);
});
