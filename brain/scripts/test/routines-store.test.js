'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/routines-store.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'routines');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-routines-'));

test('list: every fixture, sorted, invalid ones carry errors', () => {
  const all = store.list({ dir: FIXTURES });
  assert.deepEqual(all.map(r => r.slug), ['bad-cron', 'bad-kind', 'missing-argv', 'monitor', 'morning-brief', 'scan-refresh']);
  const bySlug = Object.fromEntries(all.map(r => [r.slug, r]));
  assert.deepEqual(bySlug.monitor.errors, []);
  assert.deepEqual(bySlug['morning-brief'].errors, []);
  assert.deepEqual(bySlug['scan-refresh'].errors, []);
  assert.match(bySlug['bad-cron'].errors[0], /^schedule: hour/);
  assert.match(bySlug['bad-kind'].errors[0], /^kind must be one of/);
  assert.match(bySlug['missing-argv'].errors[0], /argv/);
});

test('list: a missing dir is an empty list; README.md is skipped', () => {
  assert.deepEqual(store.list({ dir: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()) }), []);
  assert.ok(!store.list({ dir: FIXTURES }).some(r => r.slug.toLowerCase() === 'readme'));
});

test('read: frontmatter types, flow arrays with quoted items, body', () => {
  const r = store.read('morning-brief', { dir: FIXTURES });
  assert.equal(r.schema, 1);
  assert.equal(r.kind, 'prompt');
  assert.equal(r.schedule, '30 7 * * 1-5');
  assert.equal(r.enabled, true);
  assert.equal(r.budgetUsd, 0.5);
  assert.equal(r.timeoutSec, 600);
  assert.deepEqual(r.tags, ['brief', 'two words']);
  assert.match(r.body, /^Read today's daily note/);
  assert.match(r.body, /one action\.\n$/);
  const cmd = store.read('scan-refresh', { dir: FIXTURES });
  assert.deepEqual(cmd.argv, ['node', 'brain/scripts/scan-vault.js', '--quiet']);
  assert.equal(cmd.enabled, false);
  assert.equal(cmd.body, '');
  assert.equal(store.read('nope', { dir: FIXTURES }), null);
  assert.equal(store.read('../etc/passwd', { dir: FIXTURES }), null);
});

test('validate: kind-specific rules and the slug rule', () => {
  const base = { slug: 'ok-slug', schema: 1, name: 'x', kind: 'prompt', schedule: '0 9 * * *', enabled: true, body: 'hi' };
  assert.deepEqual(store.validate(base), []);
  assert.deepEqual(store.validate({ ...base, kind: 'command', argv: ['ls'] }), []);
  assert.deepEqual(store.validate({ ...base, kind: 'duty', body: '' }), []);
  assert.match(store.validate({ ...base, body: '' }).join(), /needs a body/);
  assert.match(store.validate({ ...base, effort: 'max' }).join(), /effort/);
  assert.match(store.validate({ ...base, budgetUsd: -1 }).join(), /budgetUsd/);
  assert.match(store.validate({ ...base, timeoutSec: 1.5 }).join(), /timeoutSec/);
  assert.match(store.validate({ ...base, tags: 'x' }).join(), /tags/);
  assert.match(store.validate({ ...base, guarded: 'yes' }).join(), /guarded/);
  assert.match(store.validate({ ...base, enabled: 'true' }).join(), /enabled/);
  assert.match(store.validate({ ...base, schema: 2 }).join(), /schema/);
  assert.match(store.validate({ ...base, schedule: '0 9 1 * 1' }).join(), /both be restricted/);
  assert.match(store.validate({ ...base, kind: 'command', argv: ['ls', 3] }).join(), /argv/);
  for (const slug of ['A', 'a', '-a', 'a b', 'a'.repeat(42), 'Ünï']) {
    assert.match(store.validate({ ...base, slug }).join(), /slug/, `slug ${JSON.stringify(slug)}`);
  }
});

test('write + read round-trips every valid fixture byte-for-byte after one normalisation', () => {
  const dir = tmpDir();
  for (const slug of ['monitor', 'morning-brief', 'scan-refresh']) {
    const r = store.read(slug, { dir: FIXTURES });
    store.write(r, { dir });
    const again = store.read(slug, { dir });
    const strip = (x) => { const { errors, ...rest } = x; return rest; };   // eslint-disable-line no-unused-vars
    assert.deepEqual(strip(again), strip(r), slug);
    // Second write is a fixed point.
    const first = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8');
    store.write(again, { dir });
    assert.equal(fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8'), first);
  }
});

test('write: refuses an invalid routine and leaves no file behind', () => {
  const dir = tmpDir();
  assert.throws(() => store.write({ slug: 'x-y', schema: 1, name: 'n', kind: 'prompt', schedule: 'bad', enabled: true, body: 'b' }, { dir }), /invalid routine: schedule/);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('serializer: quoting rules and key order', () => {
  const text = store.toFile({ slug: 's', schema: 1, name: 'Needs "quotes": yes', kind: 'command', schedule: '0 9 * * *', enabled: true,
    argv: ['sh', '-c', 'echo "hi, there"'], tags: ['true', 'plain'], body: '' });
  const lines = text.split('\n');
  assert.equal(lines[0], '---');
  assert.deepEqual(lines.slice(1, 8), [
    'schema: 1',
    'name: "Needs \\"quotes\\": yes"',
    'kind: command',
    'schedule: "0 9 * * *"',
    'enabled: true',
    'argv: [sh, "-c", "echo \\"hi, there\\""]',
    'tags: ["true", plain]',
  ]);
  const back = store.fromFile('s', text);
  assert.deepEqual(back.argv, ['sh', '-c', 'echo "hi, there"']);
  assert.deepEqual(back.tags, ['true', 'plain']);
  assert.equal(back.name, 'Needs "quotes": yes');
});

test('parseFrontmatter: no block, unterminated block, comments, unknown keys kept', () => {
  assert.deepEqual(store.parseFrontmatter('plain').hasFrontmatter, false);
  assert.deepEqual(store.parseFrontmatter('---\nname: x\n').hasFrontmatter, false);
  const { frontmatter, body } = store.parseFrontmatter('---\n# a comment\nname: x\ncustom: 3\nempty:\n---\n\nbody\n');
  assert.deepEqual(frontmatter, { name: 'x', custom: 3, empty: null });
  assert.equal(body, 'body\n');
  assert.match(store.fromFile('s', 'no frontmatter').errors[0], /no frontmatter/);
});

test('fingerprint: kind, schedule (whitespace-normalised) and enabled', () => {
  const a = { kind: 'duty', schedule: '0  13 * * *', enabled: true };
  assert.equal(store.fingerprint(a), 'duty|0 13 * * *|on');
  assert.notEqual(store.fingerprint(a), store.fingerprint({ ...a, enabled: false }));
  assert.equal(store.fingerprint(a), store.fingerprint({ ...a, schedule: '0 13 * * *', name: 'different' }));
});

test('state: missing/corrupt → empty; patchState creates and updates; schema pinned', () => {
  const file = path.join(tmpDir(), 'routines.json');
  assert.deepEqual(store.readState({ file }), { schema: 1, routines: {}, synced: {}, syncedAt: null });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(store.readState({ file }).routines, {});
  const e = store.patchState('monitor', (cur) => ({ ...cur, lastExit: 0, lastRunAt: '2026-09-21T13:00:00.000Z', failStreak: 0 }), { file });
  assert.equal(e.lastExit, 0);
  store.patchState('monitor', (cur) => { cur.failStreak = 2; }, { file });
  const st = store.readState({ file });
  assert.equal(st.routines.monitor.failStreak, 2);
  assert.equal(st.routines.monitor.lastRunAt, '2026-09-21T13:00:00.000Z');
  assert.equal(st.schema, 1);
  store.writeState({ ...st, synced: { monitor: 'duty|0 13 * * *|on' }, syncedAt: 'x' }, { file });
  assert.equal(store.readState({ file }).synced.monitor, 'duty|0 13 * * *|on');
});

test('health: off, invalid, stale, failed, missed, ok', () => {
  const r = { kind: 'duty', schedule: '0 13 * * *', enabled: true, errors: [] };
  const now = new Date(2026, 8, 21, 14, 0);
  assert.equal(store.health({ ...r, enabled: false }, null, now), 'off');
  assert.equal(store.health({ ...r, errors: ['x'] }, null, now), 'invalid');
  assert.equal(store.health(r, null, now, { synced: 'duty|0 12 * * *|on' }), 'stale');
  assert.equal(store.health(r, { lastExit: 1 }, now), 'failed');
  assert.equal(store.health(r, { lastExit: 0, lastRunAt: new Date(2026, 8, 20, 13, 0).toISOString() }, now), 'missed');
  assert.equal(store.health(r, { lastExit: 0, lastRunAt: new Date(2026, 8, 21, 13, 0).toISOString() }, now), 'ok');
  assert.equal(store.health(r, { lastExit: 0, lastRunAt: new Date(2026, 8, 20, 13, 0).toISOString() }, new Date(2026, 8, 21, 13, 10)), 'ok', 'inside the grace window');
  assert.equal(store.health(r, null, now), 'ok', 'never run, never synced: nothing to miss yet');
});
