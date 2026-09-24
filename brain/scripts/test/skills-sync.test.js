'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills-sync.js');

/** A private HOME, Claude config dir, Codex home and vault: the hook must never reach the developer's real ones. */
function sandbox({ hosts = { claude: { enabled: true }, codex: { enabled: true } } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skills-hook-'));
  const home = path.join(base, 'home');
  const claude = path.join(base, 'claude');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nBody\n');
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\n---\nReview.\n');
  fs.mkdirSync(home, { recursive: true });
  const config = path.join(claude, 'agenticos.json');
  fs.writeFileSync(config, JSON.stringify({ vault, hosts }));
  const env = {
    PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(base, 'codex'),
    AOS_VAULT: vault, AOS_CONFIG: config, AOS_DETACHED: '1',
  };
  return { base, home, claude, vault, env };
}
const hook = (env) => spawnSync(process.execPath, [SCRIPT], { env, input: '{"hook_event_name":"SessionEnd"}', encoding: 'utf8' });

test('skills-sync hook: mirrors and writes the cache inline, with empty stdout and exit 0', () => {
  const s = sandbox();
  const r = hook(s.env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const cache = JSON.parse(fs.readFileSync(path.join(s.vault, 'brain', '_index', 'skills.json'), 'utf8'));
  assert.equal(cache.sync.on, true);
  assert.deepEqual(cache.sync.written, ['deploy']);
  assert.ok(fs.existsSync(path.join(s.home, '.agents', 'skills', 'deploy', 'SKILL.md')));
});

test('skills-sync hook: the agent sync rides the same hook (spec 2026-09-23-universal-agents D5)', () => {
  const s = sandbox();
  const r = hook(s.env);
  assert.equal(r.status, 0, r.stderr);
  const cache = JSON.parse(fs.readFileSync(path.join(s.vault, 'brain', '_index', 'agents.json'), 'utf8'));
  assert.deepEqual(cache.sync.written, ['reviewer']);
  assert.ok(fs.existsSync(path.join(s.base, 'codex', 'agents', 'reviewer.toml')));
});

test('skills-sync hook: a skill sync that throws still lets the agent sync run', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.vault, 'brain', '_index', 'skills.json')); // a directory: the skills cache write fails
  const r = hook({ ...s.env, AOS_DEBUG: '1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /skills-sync \(skills\)/);
  assert.ok(fs.existsSync(path.join(s.vault, 'brain', '_index', 'agents.json')));
});

test('skills-sync hook: no vault → exit 0, empty stdout', () => {
  const s = sandbox();
  const r = hook({ ...s.env, AOS_VAULT: path.join(s.base, 'missing'), AOS_CONFIG: path.join(s.base, 'none.json') });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('skills-sync hook: a sync that throws (cache path unwritable) → exit 0, empty stdout', () => {
  const s = sandbox();
  fs.rmSync(path.join(s.vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(s.vault, 'brain', '_index'), 'not a dir');
  const r = hook({ ...s.env, AOS_DEBUG: '1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('skills-sync hook: AOS_HEADLESS=1 (inside a headless worker) does nothing', () => {
  const s = sandbox();
  const r = hook({ ...s.env, AOS_HEADLESS: '1' });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(s.vault, 'brain', '_index', 'skills.json')), false);
});
