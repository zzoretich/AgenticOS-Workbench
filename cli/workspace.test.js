'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('./workspace.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-cli-'));
  const home = path.join(dir, 'home');
  const cfg = path.join(home, '.claude');
  const codex = path.join(home, '.codex');
  const vault = path.join(home, 'Vault');
  for (const d of [cfg, path.join(codex, 'sessions'), path.join(vault, 'brain', '_index'), path.join(vault, 'workspaces')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agenticos.json'), JSON.stringify({ vault, hosts: { codex: { enabled: true, home: codex } } }));
  const lines = [];
  const io = { log: (m) => lines.push(String(m)), warn: (m) => lines.push('warning: ' + m) };
  return { dir, home, cfg, codex, vault, io, lines, opts: { configDir: cfg, home, io } };
}

test('slugify follows the kebab-case convention', () => {
  assert.equal(W.slugify('My Project'), 'my-project');
  assert.equal(W.slugify('  BZ Wedding  '), 'bz-wedding');
  assert.equal(W.slugify('1 - Ruflo'), '1-ruflo');
  assert.equal(W.slugify('---'), '');
});

test('new creates the workspace with README, CLAUDE.md and an identical AGENTS.md; reserved and duplicate names are refused', async () => {
  const sb = sandbox();
  assert.equal(await W.main(['new', 'My Project'], sb.opts), 0);
  const dir = path.join(sb.vault, 'workspaces', 'my-project');
  for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'));
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /^# My Project — project instructions/);
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /^# My Project\n/);
  assert.match(sb.lines.join('\n'), /created .*my-project/);
  await assert.rejects(() => W.main(['new', 'my project'], sb.opts), /already exists/);
  await assert.rejects(() => W.main(['new', '_archive'], sb.opts), (e) => e instanceof W.UsageError && /reserved/.test(e.message));
  await assert.rejects(() => W.main(['new', '!!!'], sb.opts), (e) => e instanceof W.UsageError);
  await assert.rejects(() => W.main(['frob'], sb.opts), (e) => e instanceof W.UsageError && /unknown verb/.test(e.message));
  await assert.rejects(() => W.main(['list', '--bogus'], sb.opts), (e) => e instanceof W.UsageError && /unknown flag/.test(e.message));
});

test('adopt moves a folder in, mirrors the one instruction file it had, adds the README, and keeps a nested git repo', async () => {
  const sb = sandbox();
  const src = path.join(sb.dir, 'Documents', 'ChatGPT', 'BZ Wedding');
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.mkdirSync(path.join(src, 'app'), { recursive: true });
  fs.writeFileSync(path.join(src, 'AGENTS.md'), '# Wedding\n\nUse the wedding skill.\n');
  fs.writeFileSync(path.join(src, 'app', 'index.html'), '<html/>');
  assert.equal(await W.main(['adopt', src], sb.opts), 0);
  const dst = path.join(sb.vault, 'workspaces', 'bz-wedding');
  assert.ok(!fs.existsSync(src));
  assert.ok(fs.existsSync(path.join(dst, 'app', 'index.html')));
  assert.ok(fs.existsSync(path.join(dst, '.git')));
  assert.equal(fs.readFileSync(path.join(dst, 'CLAUDE.md'), 'utf8'), '# Wedding\n\nUse the wedding skill.\n', 'CLAUDE.md mirrors the existing AGENTS.md');
  assert.match(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), /^# Bz Wedding\n/);
  const out = sb.lines.join('\n');
  assert.match(out, /CLAUDE\.md \(mirrored from AGENTS\.md\)/);
  assert.match(out, /git repository of its own/);
  assert.match(out, /Codex asks once to trust the new path/);
  // --name and the cross-device fallback (rename throws EXDEV → copy + remove)
  const src2 = path.join(sb.dir, 'x20-c');
  fs.mkdirSync(src2); fs.writeFileSync(path.join(src2, 'notes.txt'), 'n');
  const calls = [];
  const exdev = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  assert.equal(await W.main(['adopt', src2, '--name', 'Voice Chat'], { ...sb.opts, rename: exdev, copy: (a, b, o) => { calls.push(['copy', a, b, o.recursive]); fs.cpSync(a, b, { recursive: true }); }, remove: (a) => { calls.push(['remove', a]); fs.rmSync(a, { recursive: true, force: true }); } }), 0);
  assert.ok(fs.existsSync(path.join(sb.vault, 'workspaces', 'voice-chat', 'notes.txt')));
  assert.ok(!fs.existsSync(src2));
  assert.deepEqual(calls.map((c) => c[0]), ['copy', 'remove']);
  for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(sb.vault, 'workspaces', 'voice-chat', f)), f);
});

test('adopt refuses the vault, its insides, the config dirs, the home dir, a file, and an existing target', async () => {
  const sb = sandbox();
  const plain = path.join(sb.dir, 'plain'); fs.mkdirSync(plain);
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'plain'));
  await assert.rejects(() => W.main(['adopt', sb.vault], sb.opts), /inside the vault/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.vault, 'brain')], sb.opts), /inside the vault/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.vault, 'workspaces', 'plain')], sb.opts), /already under/);
  await assert.rejects(() => W.main(['adopt', sb.cfg], sb.opts), /Claude config dir/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.codex, 'sessions')], sb.opts), /Codex home/);
  await assert.rejects(() => W.main(['adopt', sb.home], sb.opts), /home directory|contains/);
  await assert.rejects(() => W.main(['adopt', path.join(sb.dir, 'nope')], sb.opts), /not a directory/);
  await assert.rejects(() => W.main(['adopt', plain], sb.opts), /already exists/);
  await assert.rejects(() => W.main(['adopt'], sb.opts), (e) => e instanceof W.UsageError);
  assert.ok(fs.existsSync(plain), 'a refused source is untouched');
});

test('list reads the snapshot when it carries hostSessions, prints per-host counts and the outside list, and has a --json form', async () => {
  const sb = sandbox();
  const day = new Date(); day.setDate(day.getDate() - 2);
  fs.writeFileSync(path.join(sb.vault, 'brain', '_index', 'snapshot.json'), JSON.stringify({
    scannedAt: '2026-09-21T20:00:00.000Z',
    workspaces: [
      { name: 'alpha', status: 'active', sessions: { claude: 12, codex: 3, total: 15, lastAt: day.toISOString() } },
      { name: 'beta', status: 'idle' },
    ],
    hostSessions: { byCwd: {}, outsideWorkspaces: [{ cwd: path.join(sb.home, 'Documents', 'Codex', 'x'), claude: 0, codex: 2, total: 2, lastAt: day.toISOString() }] },
  }));
  assert.equal(await W.main(['list'], sb.opts), 0);
  const out = sb.lines.join('\n');
  assert.match(out, /^alpha\s+active\s+claude\s+12\s+codex\s+3\s+2d ago$/m);
  assert.match(out, /^beta\s+idle\s+claude\s+0\s+codex\s+0\s+never$/m);
  assert.match(out, /outside workspaces\/ \(1\):/);
  assert.match(out, /~\/Documents\/Codex\/x\s+claude\s+0\s+codex\s+2\s+2d ago\s+aos workspace adopt ~\/Documents\/Codex\/x/);
  assert.match(out, /from the snapshot of 2026-09-21T20:00:00.000Z/);
  sb.lines.length = 0;
  assert.equal(await W.main(['list', '--json'], sb.opts), 0);
  const j = JSON.parse(sb.lines.join('\n'));
  assert.equal(j.source, 'snapshot');
  assert.equal(j.workspaces[0].sessions.total, 15);
  assert.deepEqual(j.workspaces[1].sessions, { claude: 0, codex: 0, total: 0, lastAt: null });
  assert.equal(j.outsideWorkspaces.length, 1);
});

test('list without a snapshot scans the vault directly', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'gamma'));
  fs.writeFileSync(path.join(sb.vault, 'workspaces', 'gamma', 'AGENTS.md'), '# Gamma\n\nA Codex-shaped project.\n');
  const r = await W.main(['list', '--json'], { ...sb.opts, vault: sb.vault });
  assert.equal(r, 0);
  const j = JSON.parse(sb.lines.join('\n'));
  assert.equal(j.source, 'scan');
  assert.deepEqual(j.workspaces.map((w) => w.name), ['gamma']);
});

test('ago renders today, 1d ago, Nd ago and never', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  assert.equal(W.ago(null, now), 'never');
  assert.equal(W.ago('2026-09-21T09:00:00.000Z', now), 'today');
  assert.equal(W.ago('2026-09-20T09:00:00.000Z', now), '1d ago');
  assert.equal(W.ago('2026-09-10T09:00:00.000Z', now), '11d ago');
});
