'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepOrphans } = require('../sweep-orphans.js');

const ORPHAN = '11111111-1111-4111-8111-111111111111';
const LIVE = '22222222-2222-4222-8222-222222222222';

test('sweepOrphans removes empty orphan dirs under the config dir and keeps a UUID that has a transcript under projects/', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'so-vault-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'so-cfg-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  // -1, not 0: the age gate compares an integer Date.now() with a sub-millisecond mtimeMs, so a 0-minute gate can call a
  // dir created in the same millisecond "too young"; a negative gate is unambiguous.
  fs.writeFileSync(path.join(vault, 'brain', '_index', 'scanner-config.json'), JSON.stringify({ autoSweepOrphans: true, orphanUuidMinAgeMinutes: -1 }));
  for (const u of [ORPHAN, LIVE]) {
    fs.mkdirSync(path.join(cfg, 'session-env', u), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'file-history', u), { recursive: true });
  }
  fs.mkdirSync(path.join(cfg, 'projects', '-home-alice-proj'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'projects', '-home-alice-proj', `${LIVE}.jsonl`), '{}\n');
  const r = sweepOrphans({ vault, claudeConfigDir: cfg });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.swept.sessionEnv, [ORPHAN]);
  assert.deepEqual(r.swept.fileHistory, [ORPHAN]);
  assert.equal(r.skipped.hasJsonl, 2);
  assert.ok(!fs.existsSync(path.join(cfg, 'session-env', ORPHAN)));
  assert.ok(fs.existsSync(path.join(cfg, 'session-env', LIVE)), 'a UUID with a transcript is never swept');
  assert.ok(fs.existsSync(path.join(cfg, 'file-history', LIVE)));
});

test('sweepOrphans is inert unless scanner-config.json enables it', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'so-vault-off-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'so-cfg-off-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'session-env', ORPHAN), { recursive: true });
  const r = sweepOrphans({ vault, claudeConfigDir: cfg });
  assert.equal(r.enabled, false);
  assert.ok(fs.existsSync(path.join(cfg, 'session-env', ORPHAN)));
});

test('sweepOrphans fails closed when <claudeConfigDir>/projects cannot be read', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'so-vault-noproj-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'so-cfg-noproj-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', '_index', 'scanner-config.json'), JSON.stringify({ autoSweepOrphans: true, orphanUuidMinAgeMinutes: -1 }));
  fs.mkdirSync(path.join(cfg, 'session-env', ORPHAN), { recursive: true }); // and no projects/ directory at all
  const r = sweepOrphans({ vault, claudeConfigDir: cfg });
  assert.equal(r.enabled, true);
  assert.equal(r.reason, 'projects-unreadable:ENOENT');
  assert.equal(r.skipped.error, 1);
  assert.deepEqual(r.swept.sessionEnv, []);
  assert.ok(fs.existsSync(path.join(cfg, 'session-env', ORPHAN)), 'nothing is swept while the allow-list is unknown');
});

test('sweepOrphans protects a UUID whose transcript lives under a project dir with an unusual cwd slug', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'so-vault-slug-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'so-cfg-slug-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'brain', '_index', 'scanner-config.json'), JSON.stringify({ autoSweepOrphans: true, orphanUuidMinAgeMinutes: -1 }));
  fs.mkdirSync(path.join(cfg, 'session-env', LIVE), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'projects', '-workspaces-app'), { recursive: true }); // a devcontainer cwd: no /Users or /home prefix
  fs.writeFileSync(path.join(cfg, 'projects', '-workspaces-app', `${LIVE}.jsonl`), '{}\n');
  const r = sweepOrphans({ vault, claudeConfigDir: cfg });
  assert.equal(r.reason, undefined);
  assert.equal(r.skipped.hasJsonl, 1);
  assert.deepEqual(r.swept.sessionEnv, []);
  assert.ok(fs.existsSync(path.join(cfg, 'session-env', LIVE)));
});

test('the test harness pins CLAUDE_CONFIG_DIR away from the real ~/.claude, and a no-argument sweep is inert', () => {
  const { PATHS } = require('../lib/paths.js');
  assert.notEqual(path.resolve(PATHS.CLAUDE_CONFIG_DIR), path.resolve(os.homedir(), '.claude'));
  assert.equal(PATHS.CLAUDE_CONFIG_DIR, path.resolve(process.env.CLAUDE_CONFIG_DIR));
  const r = sweepOrphans(); // the shared test vault carries no scanner-config.json → enabled: false before any read or removal
  assert.equal(r.enabled, false);
});
