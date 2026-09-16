'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('./update-check.js');

// update-check.js resolves the vault and config from the environment, so a developer's exported
// AOS_CONFIG/AOS_VAULT would redirect this file's writes at their real vault
// (same class as cli/cost-cmd.test.js:10-13).
delete process.env.AOS_CONFIG;
delete process.env.AOS_VAULT;
delete process.env.AOS_REPO_HINT;

test('cmpSemver orders releases and refuses what it cannot order', () => {
  assert.equal(U.cmpSemver('0.1.0', '0.1.0'), 0);
  assert.equal(U.cmpSemver('0.1.0', '0.1.1'), -1);
  assert.equal(U.cmpSemver('0.1.0', '0.2.0'), -1);
  assert.equal(U.cmpSemver('0.9.9', '1.0.0'), -1);
  assert.equal(U.cmpSemver('1.0.0', '0.9.9'), 1);
  assert.equal(U.cmpSemver('v1.2.3', '1.2.3'), 0, 'a leading v is accepted on either side');
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0'), -1, 'a prerelease precedes its release');
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(U.cmpSemver('1.0.0-alpha-1', '1.0.0'), -1, 'a hyphen inside the prerelease is not a separator');
  // Semver §11 prerelease precedence. A plain string compare gets every one of these wrong.
  assert.equal(U.cmpSemver('1.0.0-rc.9', '1.0.0-rc.10'), -1, 'numeric identifiers compare numerically, not as text');
  assert.equal(U.cmpSemver('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  assert.equal(U.cmpSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(U.cmpSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'fewer identifiers rank lower');
  assert.equal(U.cmpSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1, 'numeric ranks below alphanumeric');
  assert.equal(U.cmpSemver('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(U.cmpSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(U.cmpSemver('nightly', '1.0.0'), null);
  assert.equal(U.cmpSemver('1.0', '1.0.0'), null, 'two-part versions are not orderable');
  assert.equal(U.cmpSemver(null, '1.0.0'), null);
});

test('parseTag normalises a release tag or refuses it', () => {
  assert.equal(U.parseTag('v0.2.0'), '0.2.0');
  assert.equal(U.parseTag('0.2.0'), '0.2.0');
  assert.equal(U.parseTag('v1.0.0-rc.1'), '1.0.0-rc.1');
  assert.equal(U.parseTag('nightly'), null);
  assert.equal(U.parseTag('v2-beta'), null);
  assert.equal(U.parseTag(''), null);
  assert.equal(U.parseTag(undefined), null);
});

test('lowerVersion implements the skew rule from design section 8', () => {
  assert.equal(U.lowerVersion('0.2.0', '0.1.0'), '0.1.0');
  assert.equal(U.lowerVersion('0.1.0', '0.2.0'), '0.1.0');
  assert.equal(U.lowerVersion('0.1.0', '0.1.0'), '0.1.0');
  assert.equal(U.lowerVersion(null, '0.1.0'), '0.1.0', 'an unobserved plugin version falls back to the vault');
  assert.equal(U.lowerVersion('0.1.0', null), '0.1.0');
  assert.equal(U.lowerVersion(null, null), null);
  assert.equal(U.lowerVersion('nightly', '0.1.0'), 'nightly', 'an unorderable pair keeps the first argument');
});

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A temp vault with brain/_index/, plus helpers to read what the module wrote. `configDir` is a
 * second, empty temp dir standing in for `~/.claude` — `updatesConfig`/`runCheck` default `configDir`
 * to the REAL `CLAUDE_CONFIG_DIR || ~/.claude`, so any test that skips this would read (and could be
 * broken by) the developer's actual `agenticos.json` (same class as cli/cost-cmd.test.js:18-20).
 */
function vaultWorld() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-upd-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-upd-cfg-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  return {
    vault,
    configDir,
    line: () => fs.readFileSync(path.join(vault, 'brain', '_index', 'update-line.txt'), 'utf8'),
    store: () => JSON.parse(fs.readFileSync(path.join(vault, 'brain', '_index', 'update-check.json'), 'utf8')),
  };
}

const behindState = (over = {}) => ({
  schema: 1, checkedAt: '2026-09-15T00:00:00.000Z', installed: '0.1.0',
  vaultVersion: '0.1.0', pluginVersion: '0.1.0', latest: '0.2.0', behind: true,
  url: 'https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.2.0',
  snooze: null, lastError: null, consecutiveFailures: 0, ...over,
});

test('readState refuses a foreign schema and an unparseable store', () => {
  const w = vaultWorld();
  assert.equal(U.readState(w.vault), null, 'missing is not an error');
  U.writeState(w.vault, behindState());
  assert.equal(U.readState(w.vault).latest, '0.2.0');
  fs.writeFileSync(path.join(w.vault, 'brain', '_index', 'update-check.json'), '{ not json');
  assert.equal(U.readState(w.vault), null);
  U.writeState(w.vault, behindState({ schema: 99 }));
  assert.equal(U.readState(w.vault), null, 'a future schema is treated as no state, never migrated');
});

test('writeAtomic leaves no .tmp file behind', () => {
  const w = vaultWorld();
  U.writeState(w.vault, behindState());
  const entries = fs.readdirSync(path.join(w.vault, 'brain', '_index'));
  assert.deepEqual(entries.filter((f) => f.endsWith('.tmp')), []);
});

test('isBehind requires an orderable pair', () => {
  assert.equal(U.isBehind(behindState()), true);
  assert.equal(U.isBehind(behindState({ latest: '0.1.0' })), false);
  assert.equal(U.isBehind(behindState({ latest: null })), false, 'no release yet is not behind');
  assert.equal(U.isBehind(behindState({ installed: '0.3.0' })), false, 'never advise upgrading backwards');
  assert.equal(U.isBehind(behindState({ latest: 'nightly' })), false);
  assert.equal(U.isBehind(null), false);
});

test('isSnoozed covers only the snoozed version, and expires', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  const snoozed = behindState({ snooze: { version: '0.2.0', until: '2026-09-22T00:00:00.000Z' } });
  assert.equal(U.isSnoozed(snoozed, now), true);
  assert.equal(U.isSnoozed(behindState({
    snooze: { version: '0.2.0', until: '2026-09-15T00:00:00.000Z' },
  }), now), false, 'an expired snooze re-notifies');
  assert.equal(U.isSnoozed({ ...snoozed, latest: '0.3.0' }, now), false, 'a newer release breaks the snooze');
  assert.equal(U.isSnoozed(behindState(), now), false);
});

test('isStale honours the interval, failure backoff and clock skew', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  const at = (iso, over = {}) => behindState({ checkedAt: iso, ...over });
  assert.equal(U.isStale(null, { now }), true, 'no state is stale');
  assert.equal(U.isStale(at('2026-09-15T23:00:00.000Z'), { now }), false, 'one hour old, 24h interval');
  assert.equal(U.isStale(at('2026-09-14T23:00:00.000Z'), { now }), true, '25h old, 24h interval');
  assert.equal(U.isStale(at('2026-09-15T12:00:00.000Z', { consecutiveFailures: 0 }), { now, intervalHours: 6 }), true,
    '12h old against a 6h interval');
  assert.equal(U.isStale(at('2026-09-15T13:00:00.000Z', { consecutiveFailures: 1 }), { now, intervalHours: 6 }), false,
    'one failure doubles 6h to 12h, so an 11h-old check is not yet due');
  assert.equal(U.isStale(at('2026-09-15T12:00:00.000Z', { consecutiveFailures: 1 }), { now, intervalHours: 6 }), true,
    'exactly one interval elapsed counts as due');
  // These two together pin the cap at FOUR doublings (16x24h = 16 days). A three-doubling cap
  // (8 days) would make the 10-day case stale and silently pass the 46-day case too.
  assert.equal(U.isStale(at('2026-08-01T00:00:00.000Z', { consecutiveFailures: 99 }), { now }), true,
    '46 days old is past even the capped 16-day backoff');
  assert.equal(U.isStale(at('2026-09-06T00:00:00.000Z', { consecutiveFailures: 99 }), { now }), false,
    '10 days old is still inside the capped 16-day backoff');
  assert.equal(U.isStale(at('2026-09-15T23:00:00.000Z', { consecutiveFailures: -5 }), { now }), false,
    'a negative failure count must not shrink the interval');
  assert.equal(U.isStale(at('2026-09-17T00:00:00.000Z'), { now }), true, 'a future checkedAt is clock skew');
  assert.equal(U.isStale(at('not a date'), { now }), true);
});

test('renderStatusline is the fragment or nothing', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  assert.equal(U.renderStatusline(behindState(), now), '⬆ AgenticOS 0.2.0');
  assert.equal(U.renderStatusline(behindState({ latest: '0.1.0' }), now), '');
  assert.equal(U.renderStatusline(null, now), '');
  assert.equal(U.renderStatusline(behindState({
    snooze: { version: '0.2.0', until: '2026-09-22T00:00:00.000Z' },
  }), now), '');
});

test('renderNotice names the skew when the plugin and vault disagree', () => {
  const now = new Date('2026-09-16T00:00:00.000Z');
  assert.equal(
    U.renderNotice(behindState(), now),
    'AgenticOS Workbench 0.2.0 available (you have 0.1.0) — run `aos upgrade`');
  assert.equal(
    U.renderNotice(behindState({ pluginVersion: '0.2.0', vaultVersion: '0.1.0', installed: '0.1.0' }), now),
    'AgenticOS Workbench 0.2.0 available (plugin 0.2.0, vault 0.1.0) — run `aos upgrade`');
  assert.equal(U.renderNotice(behindState({ latest: '0.1.0' }), now), '');
  assert.equal(U.renderNotice(null, now), '');
});

test('writeFragment writes zero bytes when there is nothing to say', () => {
  const w = vaultWorld();
  const now = new Date('2026-09-16T00:00:00.000Z');
  U.writeFragment(w.vault, behindState(), now);
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n');
  U.writeFragment(w.vault, behindState({ latest: '0.1.0' }), now);
  assert.equal(w.line(), '', 'exactly zero bytes, so a cat contributes nothing');
});

const { EventEmitter } = require('events');

/** A fake https.get: replays one scripted response (or an error) with no network. */
function fakeGet({ status = 200, body = '{}', err = null, chunks = null } = {}) {
  return (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.destroy = (e) => { if (e) req.emit('error', e); };
    req.setTimeout = () => {};
    process.nextTick(() => {
      if (err) return req.emit('error', err);
      const res = new EventEmitter();
      res.statusCode = status;
      res.setEncoding = () => {};
      res.resume = () => {};
      cb(res);
      for (const c of (chunks || [body])) res.emit('data', c);
      res.emit('end');
    });
    return req;
  };
}

const release = (tag) => JSON.stringify({ tag_name: tag, body: 'CHANGELOG\nwith\nmany\nlines' });
const NOW3 = () => new Date('2026-09-16T00:00:00.000Z');

/**
 * `runCheck` bound to one world's ISOLATED config dir and a fixed clock. Tests call this, never
 * `U.runCheck` directly — `configDir` defaults to `CLAUDE_CONFIG_DIR || ~/.claude`, so a call that
 * omits it reads the developer's real `agenticos.json`. Binding it here makes that mistake
 * impossible instead of relying on every future call site to remember.
 */
const check = (w, opts = {}) => U.runCheck({ vault: w.vault, configDir: w.configDir, now: NOW3, ...opts });

test('httpGetJson surfaces the status code on a non-200', async () => {
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ status: 404 }) }),
    (e) => e.statusCode === 404);
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ status: 403 }) }),
    (e) => e.statusCode === 403);
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ body: 'not json' }) }),
    /bad JSON/);
  await assert.rejects(
    () => U.httpGetJson('https://example.invalid/x', { getFn: fakeGet({ err: new Error('ENOTFOUND') }) }),
    /ENOTFOUND/);
});

test('runCheck records a newer release and never renders the release body', async () => {
  const w = vaultWorld();
  const s = await check(w, { vaultVersion: '0.1.0', pluginVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  assert.equal(s.latest, '0.2.0');
  assert.equal(s.behind, true);
  assert.equal(s.installed, '0.1.0');
  assert.equal(s.url, 'https://github.com/zzoretich/AgenticOS-Workbench/releases/tag/v0.2.0');
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastError, null);
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n');
  assert.ok(!JSON.stringify(s).includes('CHANGELOG'), 'the release body never enters the store');
});

test('runCheck treats 404 as "no release yet" and stays silent', async () => {
  const w = vaultWorld();
  const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ status: 404 }) });
  assert.equal(s.latest, null);
  assert.equal(s.behind, false);
  assert.equal(w.line(), '', 'a private repo or an untagged repo says nothing at all');
});

test('runCheck keeps the last known-good latest when the transport fails', async () => {
  const w = vaultWorld();
  await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  for (const bad of [{ err: new Error('ENOTFOUND') }, { status: 403 }, { body: 'not json' }]) {
    const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet(bad) });
    assert.equal(s.latest, '0.2.0', 'the notice must not flicker on a flaky network');
    assert.equal(s.behind, true);
    assert.ok(s.lastError);
  }
  assert.equal(U.readState(w.vault).consecutiveFailures, 3);
  const ok = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  assert.equal(ok.consecutiveFailures, 0, 'a success resets the backoff');
});

test('runCheck carries pluginVersion forward when it cannot observe it', async () => {
  const w = vaultWorld();
  await check(w, { vaultVersion: '0.1.0', pluginVersion: '0.2.0', get: fakeGet({ body: release('v0.2.0') }) });
  // The detached producer has no CLAUDE_PLUGIN_ROOT, so it passes no pluginVersion at all.
  const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
  assert.equal(s.pluginVersion, '0.2.0', 'the skew signal survives a daily check');
  assert.equal(s.installed, '0.1.0');
});

test('runCheck ignores a tag it cannot order', async () => {
  const w = vaultWorld();
  const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('nightly') }) });
  assert.equal(s.latest, null);
  assert.equal(w.line(), '');
});

test('updatesConfig merges brain/config.json under agenticos.json', () => {
  const w = vaultWorld();
  const configDir = w.configDir;
  assert.deepEqual(U.updatesConfig({ configDir, vault: w.vault }), { check: true, intervalHours: 24 });
  fs.writeFileSync(path.join(w.vault, 'brain', 'config.json'),
    JSON.stringify({ updates: { check: true, intervalHours: 6 } }));
  assert.equal(U.updatesConfig({ configDir, vault: w.vault }).intervalHours, 6);
  fs.writeFileSync(path.join(configDir, 'agenticos.json'),
    JSON.stringify({ vault: w.vault, updates: { check: false } }));
  assert.deepEqual(U.updatesConfig({ configDir, vault: w.vault }), { check: false, intervalHours: 6 },
    'agenticos.json wins key by key');
});

test('runCheck does nothing when the check is disabled', async () => {
  const w = vaultWorld();
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'),
    JSON.stringify({ vault: w.vault, updates: { check: false } }));
  const s = await check(w, {
    vaultVersion: '0.1.0',
    get: () => { throw new Error('the network must not be touched'); },
  });
  assert.equal(s, null);
  assert.equal(fs.existsSync(path.join(w.vault, 'brain', '_index', 'update-check.json')), false);
});

/**
 * A vault plus an agenticos.json pointing at it, and a captured io. Reuses the isolated `configDir`
 * `vaultWorld()` already owns — never the developer's real `~/.claude`.
 */
function cmdWorld(extra = {}) {
  const w = vaultWorld();
  fs.writeFileSync(path.join(w.configDir, 'agenticos.json'),
    JSON.stringify({ version: '0.1.0', vault: w.vault, node: process.execPath, ...extra }, null, 2));
  const outs = [];
  return { ...w, outs, io: { log: (m) => outs.push(String(m)), error: (m) => outs.push(`ERR ${m}`) } };
}

const NOW = () => new Date('2026-09-16T00:00:00.000Z');

test('parseSnooze accepts whole days and hours only', () => {
  assert.equal(U.parseSnooze('7d'), 7 * 86400e3);
  assert.equal(U.parseSnooze('12h'), 12 * 3600e3);
  assert.equal(U.parseSnooze('1d'), 86400e3);
  assert.equal(U.parseSnooze('0d'), null);
  assert.equal(U.parseSnooze('7'), null);
  assert.equal(U.parseSnooze('7w'), null);
  assert.equal(U.parseSnooze('1.5d'), null);
  assert.equal(U.parseSnooze(''), null);
});

test('update-status --statusline prints the fragment and nothing else', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { statusline: true }, io: w.io, now: NOW }), 0);
  assert.deepEqual(w.outs, ['⬆ AgenticOS 0.2.0']);
});

test('update-status --statusline prints nothing when current, and still exits 0', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ latest: '0.1.0' }));
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { statusline: true }, io: w.io, now: NOW }), 0);
  assert.deepEqual(w.outs, []);
});

test('update-status with no state explains itself to a human', async () => {
  const w = cmdWorld();
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: {}, io: w.io, now: NOW }), 0);
  assert.match(w.outs.join('\n'), /never checked|no update information/i);
});

test('update-status --snooze records the version and rejects a bad argument', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { snooze: '7d' }, io: w.io, now: NOW }), 0);
  const s = U.readState(w.vault);
  assert.equal(s.snooze.version, '0.2.0');
  assert.equal(s.snooze.until, '2026-09-23T00:00:00.000Z');
  assert.equal(w.line(), '', 'the fragment is re-rendered immediately');

  const bad = cmdWorld();
  U.writeState(bad.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: bad.vault, configDir: bad.configDir, flags: { snooze: '7w' }, io: bad.io, now: NOW }), 2);
  assert.match(bad.outs.join('\n'), /ERR .*--snooze/);
});

test('update-status --off writes to agenticos.json and clears the fragment', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  U.writeFragment(w.vault, behindState(), NOW());
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n', 'precondition: a fragment exists');

  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { off: true }, io: w.io, now: NOW }), 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(w.configDir, 'agenticos.json'), 'utf8'));
  assert.equal(cfg.updates.check, false);
  assert.equal(cfg.vault, w.vault, 'the rest of the config survives');
  assert.equal(fs.existsSync(path.join(w.vault, 'brain', 'config.json')), false,
    'the off switch must live where nothing can override it');
  assert.equal(w.line(), '', 'nothing will refresh the fragment again, so it must not outlive the switch');
});

test('update-status --off refuses an unparseable agenticos.json instead of clobbering it', async () => {
  const w = cmdWorld();
  const cfgFile = path.join(w.configDir, 'agenticos.json');
  const corrupt = '{ not json, and definitely not the vault/node/claude.bin the user had';
  fs.writeFileSync(cfgFile, corrupt);
  const code = await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: { off: true }, io: w.io, now: NOW });
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), corrupt, 'a file that does not parse is left byte-identical, never replaced');
  assert.match(w.outs.join('\n'), /ERR .*refusing/);
});

test('update-status with state present prints the full dump (default, no flags)', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState());
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: {}, io: w.io, now: NOW }), 0);
  const text = w.outs.join('\n');
  assert.match(text, /installed 0\.1\.0 · latest 0\.2\.0/);
  assert.match(text, /checked 2026-09-15T00:00:00\.000Z/);
  assert.match(text, /AgenticOS Workbench 0\.2\.0 available/);
});

test('update-status default dump falls back on a store with no checkedAt instead of printing "checked undefined"', async () => {
  const w = cmdWorld();
  const s = behindState();
  delete s.checkedAt;
  U.writeState(w.vault, s);
  assert.equal(await U.cmdUpdateStatus({ vault: w.vault, configDir: w.configDir, flags: {}, io: w.io, now: NOW }), 0);
  assert.match(w.outs.join('\n'), /checked \(unknown\)/);
});

test('runCheck resolves rather than rejecting when the vault cannot be written (spec §9)', async (t) => {
  const w = vaultWorld();
  const idx = path.join(w.vault, 'brain', '_index');
  fs.chmodSync(idx, 0o500);
  // A root process (or some filesystems) ignores this chmod entirely — verify it actually blocks a
  // write before trusting the assertion below, per plan instructions, rather than passing vacuously.
  let blocked = true;
  try {
    fs.writeFileSync(path.join(idx, 'probe.tmp'), 'x');
    fs.unlinkSync(path.join(idx, 'probe.tmp'));
    blocked = false;
  } catch { /* expected: this is what the test needs */ }
  if (!blocked) {
    fs.chmodSync(idx, 0o700);
    return t.skip('this platform/user does not enforce directory permissions (likely running as root)');
  }
  try {
    const s = await check(w, { vaultVersion: '0.1.0', get: fakeGet({ body: release('v0.2.0') }) });
    assert.equal(s.latest, '0.2.0', 'the result is still computed even though nothing could be written to disk');
    assert.equal(s.behind, true);
  } finally {
    fs.chmodSync(idx, 0o700); // restore write access so the OS can reclaim the temp dir later
  }
});

test('update-check --quiet writes state and prints nothing', async () => {
  const w = cmdWorld();
  assert.equal(await U.cmdUpdateCheck({
    vault: w.vault, configDir: w.configDir, flags: { quiet: true }, io: w.io, now: NOW,
    get: fakeGet({ body: release('v0.2.0') }),
  }), 0);
  assert.deepEqual(w.outs, []);
  assert.equal(U.readState(w.vault).latest, '0.2.0');
});

test('update-check without --quiet prints the installed/latest line', async () => {
  const w = cmdWorld();
  assert.equal(await U.cmdUpdateCheck({
    vault: w.vault, configDir: w.configDir, flags: {}, io: w.io, now: NOW,
    get: fakeGet({ body: release('v0.2.0') }),
  }), 0);
  assert.equal(w.outs.length, 1);
  assert.match(w.outs[0], /^installed 0\.1\.0 · latest 0\.2\.0$/);
});

test('update-notice prints the notice and re-renders the fragment', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ checkedAt: NOW().toISOString() }));
  const spawned = [];
  assert.equal(await U.cmdUpdateNotice({
    vault: w.vault, configDir: w.configDir, io: w.io, now: NOW,
    spawnFn: (...a) => spawned.push(a),
  }), 0);
  assert.equal(w.outs.length, 1);
  assert.match(w.outs[0], /^AgenticOS Workbench 0\.2\.0 available/);
  assert.equal(w.line(), '⬆ AgenticOS 0.2.0\n');
  assert.deepEqual(spawned, [], 'a fresh check is not re-spawned');
});

test('update-notice spawns a detached check when the state is stale, without waiting', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ checkedAt: '2026-09-01T00:00:00.000Z' }));
  const spawned = [];
  assert.equal(await U.cmdUpdateNotice({
    vault: w.vault, configDir: w.configDir, io: w.io, now: NOW,
    spawnFn: (...a) => spawned.push(a),
  }), 0);
  assert.equal(spawned.length, 1, 'exactly one detached producer');
  assert.match(w.outs[0], /0\.2\.0 available/, 'the notice still comes from the cached state');
});

test('AOS_NO_SPAWN=1 suppresses the detached producer but not the notice', async () => {
  const w = cmdWorld();
  U.writeState(w.vault, behindState({ checkedAt: '2026-09-01T00:00:00.000Z' }));
  const spawned = [];
  process.env.AOS_NO_SPAWN = '1';
  try {
    assert.equal(await U.cmdUpdateNotice({
      vault: w.vault, configDir: w.configDir, io: w.io, now: NOW,
      spawnFn: (...a) => spawned.push(a),
    }), 0);
  } finally { delete process.env.AOS_NO_SPAWN; }
  assert.deepEqual(spawned, [], 'the CI rehearsal must never reach the network');
  assert.match(w.outs[0], /0\.2\.0 available/);
});

test('update-notice is silent and exits 0 with no vault, no state, or an unreadable store', async () => {
  const none = cmdWorld();
  assert.equal(await U.cmdUpdateNotice({ vault: null, configDir: none.configDir, io: none.io, now: NOW, spawnFn: () => {} }), 0);
  assert.deepEqual(none.outs, []);

  const empty = cmdWorld();
  assert.equal(await U.cmdUpdateNotice({ vault: empty.vault, configDir: empty.configDir, io: empty.io, now: NOW, spawnFn: () => {} }), 0);
  assert.deepEqual(empty.outs, [], 'nothing to say before the first check');

  const broken = cmdWorld();
  fs.writeFileSync(path.join(broken.vault, 'brain', '_index', 'update-check.json'), '{ not json');
  assert.equal(await U.cmdUpdateNotice({ vault: broken.vault, configDir: broken.configDir, io: broken.io, now: NOW, spawnFn: () => {} }), 0);
  assert.deepEqual(broken.outs, []);
});

test('update-notice records the plugin version it can see', async () => {
  const w = cmdWorld();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-plug-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agenticos', version: '0.2.0' }));
  U.writeState(w.vault, behindState({ checkedAt: NOW().toISOString(), latest: '0.3.0' }));
  await U.cmdUpdateNotice({ vault: w.vault, configDir: w.configDir, io: w.io, now: NOW, spawnFn: () => {}, pluginRoot: root });
  const s = U.readState(w.vault);
  assert.equal(s.pluginVersion, '0.2.0');
  assert.equal(s.installed, '0.1.0', 'min(plugin 0.2.0, vault 0.1.0)');
  assert.match(w.outs[0], /\(plugin 0\.2\.0, vault 0\.1\.0\)/);
});

const { spawnSync } = require('child_process');

test('aos.js dispatches the three update commands and rejects a bad flag', () => {
  const w = cmdWorld();
  // AOS_NO_SPAWN=1 is mandatory here: this runs a real subprocess against the real clock, so the
  // seeded checkedAt is stale and update-notice would otherwise spawn a live api.github.com request,
  // breaking the no-network constraint.
  const env = {
    ...process.env, AOS_CONFIG: path.join(w.configDir, 'agenticos.json'),
    HOME: w.configDir, AOS_NO_SPAWN: '1',
  };
  const aos = (args) => spawnSync(process.execPath, [path.join(__dirname, 'aos.js'), ...args], { encoding: 'utf8', env });

  U.writeState(w.vault, behindState());
  const line = aos(['update-status', '--statusline']);
  assert.equal(line.status, 0, line.stderr);
  assert.equal(line.stdout.trim(), '⬆ AgenticOS 0.2.0');

  const notice = aos(['update-notice']);
  assert.equal(notice.status, 0, notice.stderr);
  assert.match(notice.stdout, /0\.2\.0 available/);

  const bad = aos(['update-status', '--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown flag --nope/);

  const help = aos(['help']);
  assert.match(help.stdout, /aos update-status/);
});
