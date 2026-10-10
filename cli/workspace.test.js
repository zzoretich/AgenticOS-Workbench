'use strict';
delete process.env.AOS_CONFIG; delete process.env.AOS_VAULT; delete process.env.AOS_REPO_HINT;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('./workspace.js');

// A scan reads host folders through the runtime: point them at empty temp folders, never the developer's own.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-cli-cfg-'));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-cli-codex-'));

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
      { name: 'alpha', status: 'active', sessions: { claude: 12, codex: 3, total: 15, lastAt: day.toISOString() },
        next: { text: 'Merge PR 2', source: 'derived', from: 'HANDOFF-alpha.md › Next' }, git: { kind: 'vault' }, commits: [], hidden: false },
      { name: 'beta', status: 'idle' },
      { name: '_archive/old', label: 'old', status: 'idle', hidden: true, hiddenReason: 'archived' },
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
  assert.doesNotMatch(out, /_archive\/old/, 'a hidden entry is left out of the table');
  assert.match(out, /\(1 hidden: _ folders and _archive\/; --json lists them\)/);
  sb.lines.length = 0;
  assert.equal(await W.main(['list', '--json'], sb.opts), 0);
  const j = JSON.parse(sb.lines.join('\n'));
  assert.equal(j.source, 'snapshot');
  assert.equal(j.workspaces[0].sessions.total, 15);
  assert.deepEqual(j.workspaces[1].sessions, { claude: 0, codex: 0, total: 0, lastAt: null });
  assert.equal(j.outsideWorkspaces.length, 1);
  // spaces-redesign D22, D23: each entry passes through whole, hidden ones included.
  assert.deepEqual(j.workspaces[0].next, { text: 'Merge PR 2', source: 'derived', from: 'HANDOFF-alpha.md › Next' });
  assert.deepEqual(j.workspaces[0].git, { kind: 'vault' });
  assert.deepEqual(j.workspaces.map((w) => [w.name, w.hidden]), [['alpha', false], ['beta', undefined], ['_archive/old', true]]);
  assert.equal(j.workspaces[2].hiddenReason, 'archived');
});

test('list without a snapshot scans the vault directly, finalizes the entries, and --json passes them through whole', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'gamma'));
  fs.writeFileSync(path.join(sb.vault, 'workspaces', 'gamma', 'AGENTS.md'), '# Gamma\n\nA Codex-shaped project.\n\n## Next\n\n- Write the plan\n');
  fs.mkdirSync(path.join(sb.vault, 'workspaces', 'held'));
  fs.writeFileSync(path.join(sb.vault, 'workspaces', 'held', 'workspace.md'), '---\nstatus: parked\npinned: true\n---\n');
  fs.mkdirSync(path.join(sb.vault, 'workspaces', '_spikes'));
  fs.mkdirSync(path.join(sb.vault, 'workspaces', '_worktrees', 'team', 'item', 'member'), { recursive: true });
  const r = await W.main(['list', '--json'], { ...sb.opts, vault: sb.vault });
  assert.equal(r, 0);
  const j = JSON.parse(sb.lines.join('\n'));
  assert.equal(j.source, 'scan');
  assert.deepEqual(j.workspaces.map((w) => w.name), ['held', 'gamma', '_spikes'], 'pinned first, hidden last, no _worktrees entry');
  const [held, gamma, spikes] = j.workspaces;
  // spaces-redesign D11: finalize ran after the sessions were attached.
  assert.deepEqual([held.status, held.statusOverride, held.statusAuto, held.pinned], ['paused', 'paused', 'idle', true]);
  assert.deepEqual([gamma.status, gamma.statusAuto, gamma.statusOverride], ['idle', 'idle', null]);
  assert.deepEqual(gamma.activity, { at: null, ageDays: null, from: null }, 'files just written are not activity');
  assert.deepEqual(gamma.next, { text: 'Write the plan', source: 'derived', from: 'AGENTS.md › Next' });
  assert.equal(typeof gamma.inputHash, 'string');
  assert.equal(gamma.git, null);
  assert.deepEqual(gamma.commits, []);
  assert.deepEqual([spikes.hidden, spikes.hiddenReason], [true, 'underscore']);
  sb.lines.length = 0;
  assert.equal(await W.main(['list'], { ...sb.opts, vault: sb.vault }), 0);
  const out = sb.lines.join('\n');
  assert.match(out, /^held\s+paused\s+claude\s+0\s+codex\s+0\s+never$/m);
  assert.match(out, /^gamma\s+idle\s+/m);
  assert.doesNotMatch(out, /_spikes/);
  assert.match(out, /\(1 hidden: /);
  assert.match(out, /\(fresh scan\)/);
});

test('list without a snapshot counts both hosts through the folders agenticos.json names, and keeps the session index in the vault', async () => {
  const sb = sandbox();
  // Both hosts on, as `aos init --host both` writes them; the Claude folder is the config dir this command read.
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault: sb.vault, hosts: { claude: { enabled: true }, codex: { enabled: true, home: sb.codex } } }));
  const ws = path.join(sb.vault, 'workspaces', 'tide');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), '# Tide\n\nTide tables for the harbour.\n');
  const ts = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const jsonl = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
  const cid = '0199bbbb-0000-4000-8000-000000000001';
  const xid = '0199bbbb-0000-4000-8000-000000000002';
  jsonl(path.join(sb.cfg, 'projects', 'tide-slug', `${cid}.jsonl`), [
    { type: 'user', sessionId: cid, cwd: path.join(ws, 'src'), timestamp: ts, entrypoint: 'cli', message: { role: 'user', content: 'Parse the tide table' } },
  ]);
  jsonl(path.join(sb.codex, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${xid}.jsonl`), [
    { timestamp: ts, type: 'session_meta', payload: { id: xid, timestamp: ts, cwd: ws, originator: 'codex_cli_rs', source: 'cli' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the tide parser' }] } },
  ]);
  assert.equal(await W.main(['list', '--json'], { ...sb.opts, vault: sb.vault }), 0);
  const j = JSON.parse(sb.lines.join('\n'));
  const tide = j.workspaces.find((w) => w.name === 'tide');
  assert.deepEqual([tide.sessions.claude, tide.sessions.codex, tide.sessions.total], [1, 1, 2]);
  assert.deepEqual(tide.sessions.recent.map((r) => [r.host, r.via, r.resumable]).sort(), [['claude', 'cwd', true], ['codex', 'cwd', true]]);
  // spaces-redesign D11: finalize read the attached sessions.
  assert.deepEqual([tide.status, tide.activity.from], ['active', 'session']);
  assert.deepEqual(j.outsideWorkspaces, []);
  assert.ok(fs.existsSync(path.join(sb.vault, 'brain', '_index', 'session-index.json')), 'the incremental cache sits in the vault');
});

test('a run from the vault root finds the configured vault; with none configured it is refused from anywhere', async () => {
  const sb = sandbox();
  // The real path, so the cwd after chdir (macOS reports /private/var for /var) equals the configured vault exactly.
  const vault = fs.realpathSync(sb.vault);
  fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ vault, hosts: { codex: { enabled: true, home: sb.codex } } }));
  // A scan in an earlier test sets AOS_VAULT for the collectors; this test reads agenticos.json alone.
  const cwd = process.cwd();
  const envVault = process.env.AOS_VAULT;
  delete process.env.AOS_VAULT;
  try {
    process.chdir(vault);
    assert.equal(W.resolveCtx({ configDir: sb.cfg, home: sb.home }).vault, vault);
    assert.equal(await W.main(['new', 'kelp-watch'], sb.opts), 0);
    assert.ok(fs.existsSync(path.join(vault, 'workspaces', 'kelp-watch', 'README.md')));
    fs.writeFileSync(path.join(sb.cfg, 'agenticos.json'), JSON.stringify({ hosts: {} }));
    assert.throws(() => W.resolveCtx({ configDir: sb.cfg, home: sb.home }), /no vault configured/);
    process.chdir(sb.dir);
    assert.throws(() => W.resolveCtx({ configDir: sb.cfg, home: sb.home }), /no vault configured/);
    assert.throws(() => W.resolveCtx({ configDir: sb.cfg, home: sb.home, vault: '  ' }), /no vault configured/);
  } finally {
    process.chdir(cwd);
    if (envVault === undefined) delete process.env.AOS_VAULT; else process.env.AOS_VAULT = envVault;
  }
});

test('ago renders today, 1d ago, Nd ago and never', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  assert.equal(W.ago(null, now), 'never');
  assert.equal(W.ago('2026-09-21T09:00:00.000Z', now), 'today');
  assert.equal(W.ago('2026-09-20T09:00:00.000Z', now), '1d ago');
  assert.equal(W.ago('2026-09-10T09:00:00.000Z', now), '11d ago');
});
