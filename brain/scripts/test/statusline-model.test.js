'use strict';
// lib/statusline-model.js (spec 2026-09-28-statusline-design): the vault → statusline.json model, read-only over the
// vault (D4), flags in both forms (D5), the spend family nearest its cap (D6), and the stale/lock rules (D3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../lib/statusline-model.js');

const NOW = new Date(2026, 8, 28, 15, 0, 0);
const HOST = 'this-host';
const TEAM_MD = '---\ntype: team\nid: dev\nname: Dev\nlead: lead\ngates: [ship]\nmembers:\n  - id: lead\n    name: Lead\n  - id: woz\n    name: Woz\n---\n';

function put(vault, rel, text) {
  const f = path.join(vault, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const iso = (h, m = 0) => new Date(2026, 8, 28, h, m).toISOString();

function fixtureVault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-model-'));
  put(v, 'persona/teams/dev/TEAM.md', TEAM_MD);
  put(v, 'persona/teams/dev/board.jsonl', jsonl([
    { schema: 1, ts: iso(9), id: 'devbar-01', title: 'Menubar', stage: 'ship', status: 'working' },
    { schema: 1, ts: iso(10), id: 'devbar-01', title: 'Menubar', stage: 'ship', status: 'gate', gate: { name: 'ship', state: 'pending' } },
    { schema: 1, ts: iso(8), id: 'site-02', title: 'Site', stage: 'discuss', status: 'gate', gate: { name: 'discuss', state: 'pending' } },
    { schema: 1, ts: iso(11), id: 'old-03', title: 'Old', stage: 'ship', status: 'done', gate: { name: 'ship', state: 'approved' } },
  ]));
  put(v, 'persona/teams/dev/running/live.json', JSON.stringify({ schema: 1, team: 'dev', member: 'woz', item: 'devbar-01', stage: 'execute', provider: 'codex', pid: 101, host: HOST, startedAt: iso(12) }));
  put(v, 'persona/teams/dev/running/dead.json', JSON.stringify({ schema: 1, team: 'dev', member: 'jordan', item: 'devbar-01', stage: 'execute', pid: 102, host: HOST, startedAt: iso(12) }));
  put(v, 'persona/teams/dev/running/away.json', JSON.stringify({ schema: 1, team: 'dev', member: 'dieter', item: 'site-02', stage: 'plan', pid: 101, host: 'other-host', startedAt: iso(12) }));
  put(v, 'persona/teams/broken/TEAM.md', '---\nid: broken\ntags:\n  - one\n---\n');
  const note = (id, level) => put(v, `brain/notifications/2026/${id}.md`, `---\nschema: 1\nid: "${id}"\nfrom: "ron"\nlevel: "${level}"\ntitle: "T"\ncreated: "${iso(9)}"\n---\nbody\n`);
  note('2026-09-28T0900-ron-breaking-one', 'breaking');
  note('2026-09-28T0901-ron-alert-one', 'alert');
  note('2026-09-28T0902-ron-alert-read', 'alert');
  note('2026-09-28T0903-ron-alert-archived', 'alert');
  note('2026-09-28T0904-ron-edition', 'edition');
  put(v, 'brain/notifications/state.json', JSON.stringify({ schema: 1, items: { '2026-09-28T0902-ron-alert-read': { read: true }, '2026-09-28T0903-ron-alert-archived': { archived: true } } }));
  put(v, 'persona/STATE.md', '# State\n\n## Sitrep\n- a line\n\n## Flags\n- [ ] 2026-09-27 duty FAILED\n- Write tool blocked (bare bullet)\n- [x] closed one\n\n## Priorities\n- tests\n');
  put(v, 'brain/_index/provider-spend.jsonl', jsonl([
    { ts: iso(9), feature: 'duty:sitrep', usd: 4.2 },
    { ts: iso(10), feature: 'auto-wrap', usd: 0.2 },
    { ts: new Date(2026, 8, 27, 23, 0).toISOString(), feature: 'duty:reflect', usd: 5 },
    { ts: iso(11), feature: 'team:dev', usd: 40 },
  ]) + 'not json\n');
  put(v, 'brain/_index/update-line.txt', '⬆ AgenticOS 0.21.0\n');
  put(v, 'brain/_index/provider-state.json', JSON.stringify({ name: 'none', reason: 'claude-not-logged-in' }));
  put(v, 'brain/_index/SESSION.md', '# Session\n\n## Wrap Status\n- Session abc not wrapped (provider: none) — run /wrap.\n');
  put(v, 'brain/memory/feedback/_drafts/a.md', 'x');
  put(v, 'brain/memory/feedback/_drafts/b.md', 'x');
  put(v, 'brain/memory/feedback/_drafts/notes.txt', 'x');
  return v;
}

test('build: gates longest-waiting first, live runs from this host only, unread alert levels, flags, spend, health', () => {
  const v = fixtureVault();
  const m = M.build(v, { now: NOW, host: HOST, alive: (pid) => pid === 101, cfg: {} });
  assert.equal(m.schema, 1);
  assert.equal(m.at, NOW.toISOString());
  assert.equal(m.vault, path.basename(v));
  assert.deepEqual(m.needs.gates.map((g) => [g.item, g.stage]), [['site-02', 'discuss'], ['devbar-01', 'ship']]);
  assert.deepEqual(m.runs.map((r) => [r.member, r.stage, r.item, r.provider]), [['woz', 'execute', 'devbar-01', 'codex']], 'dead and other-host markers are hidden');
  assert.equal(m.needs.breaking, 1);
  assert.equal(m.needs.alerts, 1, 'read and archived alerts do not count; editions never do');
  assert.equal(m.needs.flags, 2, 'a `- [ ]` flag and a bare bullet; `- [x]` is closed');
  assert.deepEqual(m.spend, { family: 'duties', usd: 4.2, cap: 6, ratio: 0.7 }, 'yesterday and teams (no cap) are left out');
  assert.deepEqual(m.health, { update: '0.21.0', provider: 'claude-not-logged-in', unwrapped: true, drafts: 2 });
});

test('build: the vault only ever gains statusline.json (D4)', () => {
  const v = fixtureVault();
  const list = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  const before = list(v);
  M.refresh(v, { now: NOW, host: HOST, alive: () => false });
  assert.deepEqual(list(v), [...before, path.join('brain', '_index', 'statusline.json')].sort());
  assert.ok(fs.existsSync(path.join(v, 'persona/teams/dev/running/dead.json')), 'a dead marker is never reaped here');
});

test('build: an empty vault is a quiet model, never an error', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-empty-'));
  const m = M.build(v, { now: NOW });
  assert.deepEqual(m.needs, { gates: [], alerts: 0, breaking: 0, flags: 0 });
  assert.deepEqual(m.runs, []);
  assert.equal(m.spend, null);
  assert.deepEqual(m.health, { update: null, provider: null, unwrapped: false, drafts: 0 });
});

test('health: a provider forced to none is the user\'s choice, not a warning', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-forced-'));
  put(v, 'brain/_index/provider-state.json', JSON.stringify({ name: 'none', reason: 'forced' }));
  assert.equal(M.build(v, { now: NOW }).health.provider, null);
  put(v, 'brain/_index/provider-state.json', JSON.stringify({ name: 'none', reason: 'daily-cap' }));
  assert.equal(M.build(v, { now: NOW }).health.provider, 'daily-cap');
});

test('countFlags: only the Flags section, both bullet forms, never closed or "none"', () => {
  assert.equal(M.countFlags(null), 0);
  assert.equal(M.countFlags('## Flags\n\n## Priorities\n- a\n'), 0);
  assert.equal(M.countFlags('## Flags\n- none\n- (none)\n'), 0);
  assert.equal(M.countFlags('## Flags\n- [ ] a\n* b\n- [X] c\n  - nested detail\n## Next\n- d\n'), 2);
});

test('spend: families follow the ledger prefixes, the hook cap follows the provider, cap 0 hides a family', () => {
  assert.equal(M.familyOf('duty:sitrep'), 'duties');
  assert.equal(M.familyOf('cross-review:plan'), 'crossReview');
  assert.equal(M.familyOf('auto-wrap'), 'hooks');
  const caps = M.capsOf({ claude: { perDayUsd: 1 }, codex: { perDayUsd: 2 }, persona: { perDayUsd: 0 } }, 'codex');
  assert.equal(caps.hooks, 2, 'the codex cap when codex answers hooks');
  assert.equal(M.capsOf({ claude: { perDayUsd: 1 } }, 'ollama').hooks, 1);
  assert.equal(caps.duties, 0);
  assert.equal(caps.reasoner, 5, 'the default when unset');
  assert.equal(M.spendOf({ duties: 9, hooks: 0.9 }, caps), null, 'duties has cap 0; hooks is under half');
  assert.deepEqual(M.spendOf({ hooks: 1.8, routines: 5.5 }, { ...caps, routines: 6 }), { family: 'routines', usd: 5.5, cap: 6, ratio: 0.92 });
  assert.deepEqual(M.spendToday('{"ts":"bad","usd":1}\n{"ts":"' + iso(9) + '","usd":"1"}\n', NOW), {});
});

test('read/write/isStale: round trip, another schema reads as null, stale after 15 s or from the future', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-rw-'));
  assert.equal(M.read(v), null);
  const m = M.build(v, { now: NOW });
  M.write(v, m);
  assert.deepEqual(M.read(v), m);
  assert.equal(M.isStale(m, new Date(NOW.getTime() + 10e3)), false);
  assert.equal(M.isStale(m, new Date(NOW.getTime() + 16e3)), true);
  assert.equal(M.isStale(m, new Date(NOW.getTime() - 120e3)), true, 'clock skew re-builds rather than waits');
  assert.equal(M.isStale(null, NOW), true);
  fs.writeFileSync(M.modelPath(v), JSON.stringify({ ...m, schema: 2 }));
  assert.equal(M.read(v), null);
});

test('refresh: a held lock skips the rebuild instead of piling up (D3)', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-lock-'));
  const lock = `${M.modelPath(v)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id: 'held', until: new Date(Date.now() + 60e3).toISOString() }));
  assert.equal(M.refresh(v, { now: NOW }), null);
  assert.equal(M.read(v), null);
  fs.unlinkSync(lock);
  assert.equal(M.refresh(v, { now: NOW }).at, NOW.toISOString());
});
