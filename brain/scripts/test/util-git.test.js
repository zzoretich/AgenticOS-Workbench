'use strict';
// collectors/util.js git reads (spaces-redesign D11/A2, D24, spec §6): gitState, recentCommits, vaultPathCommits and
// lastCommit, each behind the repo-config guard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The test's own git setup never reads the developer's global or system config (a global hooksPath, signing).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'util-git-'));
const EMPTY_CFG = path.join(ROOT, 'empty.gitconfig');
fs.writeFileSync(EMPTY_CFG, '');
process.env.GIT_CONFIG_GLOBAL = EMPTY_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// No git call looks above the test root, wherever the temp folder sits.
process.env.GIT_CEILING_DIRECTORIES = ROOT;
const VAULT = path.join(ROOT, 'vault');
fs.mkdirSync(path.join(VAULT, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = VAULT;

const U = require('../collectors/util.js');

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function commitAll(dir, subject) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', subject);
  return git(dir, 'rev-parse', '--short=7', 'HEAD').trim();
}
function newRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

test('parsePorcelainV2: branch, short head, upstream, ahead/behind and every kind of changed entry', () => {
  const out = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaa bbbb a.md', '2 R. N... 100644 100644 100644 aaaa bbbb R100 new.md\told.md',
    'u UU N... 100644 100644 100644 100644 a b c c.md', '? new file.txt', '',
  ].join('\n');
  assert.deepEqual(U.parsePorcelainV2(out), { branch: 'main', detached: false, head: '0123456', upstream: 'origin/main', ahead: 2, behind: 1, dirty: 4 });
  assert.deepEqual(U.parsePorcelainV2('# branch.oid (initial)\n# branch.head (detached)\n'),
    { branch: null, detached: true, head: null, upstream: null, ahead: null, behind: null, dirty: 0 });
  assert.deepEqual(U.parsePorcelainV2(null).dirty, 0);
});

test('parseNameStatusLog reads token by token: odd subjects and paths, renames, a commit with no change', () => {
  const out = '\x01abc1234\x002026-10-01T10:00:00+00:00\x00vault backup: x \x01 y\x00\nM\x00workspaces/a/b c.md\x00R100\x00workspaces/old/x\x00workspaces/new/x\x00'
    + 'A\x00workspaces/a/\x01odd\x00\x01def5678\x002026-09-30T10:00:00+00:00\x00merge\x00\n\x01aaa0000\x002026-09-29T10:00:00+00:00\x00first\x00\nD\x00workspaces/a/gone.md\x00';
  const log = U.parseNameStatusLog(out);
  assert.deepEqual(log.map((c) => [c.hash, c.subject, c.changes.length]), [['abc1234', 'vault backup: x \x01 y', 3], ['def5678', 'merge', 0], ['aaa0000', 'first', 1]]);
  assert.deepEqual(log[0].changes[1], { status: 'R', score: 100, from: 'workspaces/old/x', path: 'workspaces/new/x' });
  assert.equal(log[0].changes[2].path, 'workspaces/a/\x01odd');
  assert.deepEqual(log[2].changes[0], { status: 'D', score: null, from: null, path: 'workspaces/a/gone.md' });
  assert.deepEqual(U.parseNameStatusLog(''), []);
});

test('gitState: its own repository only, with branch, head, dirty count and remote names', () => {
  const repo = newRepo(path.join(ROOT, 'own'));
  assert.deepEqual(U.gitState(repo), { kind: 'repo', branch: 'main', detached: false, head: null, upstream: null, ahead: null, behind: null, dirty: 0, remotes: [] });
  write(repo, 'a.md', 'one\n');
  write(repo, 'sub/b.md', 'two\n');
  const head = commitAll(repo, 'first');
  write(repo, 'a.md', 'changed\n');
  write(repo, 'new.md', 'untracked\n');
  assert.deepEqual(U.gitState(repo), { kind: 'repo', branch: 'main', detached: false, head, upstream: null, ahead: null, behind: null, dirty: 2, remotes: [] });
  git(repo, 'remote', 'add', 'origin', 'https://example.com/x.git');
  assert.deepEqual(U.gitState(repo).remotes, ['origin'], 'names only, never the URL');
  assert.equal(U.gitState(path.join(repo, 'sub')), null, 'a folder inside a repository has none of its own');
  assert.equal(U.gitState(path.join(ROOT, 'nowhere')), null);
  fs.mkdirSync(path.join(ROOT, 'plain'), { recursive: true });
  assert.equal(U.gitState(path.join(ROOT, 'plain')), null);
});

test('recentCommits(dir, n): its own repository, newest first, n at most; nothing for a folder without one', () => {
  const repo = newRepo(path.join(ROOT, 'recent'));
  write(repo, 'a.md', '1\n');
  const c1 = commitAll(repo, 'first');
  write(repo, 'a.md', '2\n');
  const c2 = commitAll(repo, 'second: with a colon');
  const all = U.recentCommits(repo, 10);
  assert.deepEqual(all.map((c) => [c.hash, c.subject]), [[c2, 'second: with a colon'], [c1, 'first']]);
  assert.ok(all.every((c) => !Number.isNaN(Date.parse(c.iso))));
  assert.deepEqual(U.recentCommits(repo, 1).map((c) => c.hash), [c2]);
  assert.deepEqual(U.recentCommits(repo, 0), []);
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.deepEqual(U.recentCommits(path.join(repo, 'sub'), 5), []);
});

// The vault's own git tracks some workspaces: backups ("vault backup: …") count only when they add or modify a file
// other than workspace.md and the stubs, and the moves Rename and Restore make never count (A2).
const IGNORE = ['^vault backup:', '('];   // a pattern that does not compile is skipped
newRepo(VAULT);
write(VAULT, 'workspaces/pin/notes.md', 'n\n');
write(VAULT, 'workspaces/pin-2/notes.md', 'n\n');
write(VAULT, 'workspaces/stub/notes.md', 'n\n');
write(VAULT, 'workspaces/old/notes.md', 'n\n');
write(VAULT, 'workspaces/old/workspace.md', '---\nstatus: active\n---\n');
write(VAULT, 'workspaces/_archive/back/notes.md', 'n\n');
write(VAULT, 'workspaces/work/notes.md', 'n\n');
write(VAULT, 'workspaces/hand/notes.md', 'n\n');
write(VAULT, 'workspaces/gone/keep.md', 'n\n');
write(VAULT, 'workspaces/gone/drop.md', 'n\n');
write(VAULT, 'workspaces/deep/notes.md', 'n\n');
write(VAULT, 'brain/memory/x.md', 'n\n');
const V = {};
V.first = commitAll(VAULT, 'first');
write(VAULT, 'workspaces/pin/workspace.md', '---\npinned: true\n---\n');
V.pinBackup = commitAll(VAULT, 'vault backup: 2026-10-01 10:00:00');
for (const f of ['README.md', 'CLAUDE.md', 'AGENTS.md']) write(VAULT, `workspaces/stub/${f}`, 'stub\n');
V.stubBackup = commitAll(VAULT, 'vault backup: 2026-10-01 10:30:00');
git(VAULT, 'mv', 'workspaces/old', 'workspaces/renamed');
git(VAULT, 'mv', 'workspaces/_archive/back', 'workspaces/back');
V.moveBackup = commitAll(VAULT, 'vault backup: 2026-10-01 11:00:00');
write(VAULT, 'workspaces/work/notes.md', 'edited outside any session\n');
V.workBackup = commitAll(VAULT, 'vault backup: 2026-10-01 11:30:00');
write(VAULT, 'workspaces/hand/workspace.md', '---\nstatus: paused\n---\n');
V.hand = commitAll(VAULT, 'hand: pause it');
fs.unlinkSync(path.join(VAULT, 'workspaces/gone/drop.md'));
V.goneBackup = commitAll(VAULT, 'vault backup: 2026-10-01 12:00:00');
write(VAULT, 'workspaces/deep/sub/workspace.md', 'not the manifest\n');
V.deepBackup = commitAll(VAULT, 'vault backup: 2026-10-01 12:30:00');
write(VAULT, 'workspaces/pin-2/more.md', 'n\n');
V.pin2 = commitAll(VAULT, 'pin-2 only');

const vpc = (rel, opts = {}) => U.vaultPathCommits(VAULT, rel, { n: 10, ignoreCommitSubjects: IGNORE, ...opts });
const hashes = (rows) => rows.map((c) => c.hash);

test('vaultPathCommits: a backup that touches only workspace.md or a stub is not work', () => {
  const pin = vpc('workspaces/pin');
  assert.equal(pin.tracked, true);
  assert.deepEqual(hashes(pin.commits), [V.first], 'backups are left out of the list, and pin-2 is another folder');
  assert.equal(pin.activity.hash, V.first);
  assert.equal(pin.activity.ignored, false);
  assert.equal(vpc('workspaces/stub').activity.hash, V.first);
});

test('vaultPathCommits: Rename and Restore moves never count, and the history before a move stays with the old path', () => {
  const renamed = vpc('workspaces/renamed');
  assert.equal(renamed.tracked, true);
  assert.deepEqual(renamed.commits, []);
  assert.equal(renamed.activity, null, 'an exact rename into the folder is a move, not work');
  assert.equal(vpc('workspaces/back').activity, null);
  assert.equal(vpc('workspaces/old').activity.hash, V.first);
  assert.equal(vpc('workspaces/_archive/back').activity.hash, V.first);
});

test('vaultPathCommits: a backup that adds or modifies another file is work; a deletion is not', () => {
  const work = vpc('workspaces/work');
  assert.deepEqual(hashes(work.commits), [V.first]);
  assert.equal(work.activity.hash, V.workBackup);
  assert.equal(work.activity.ignored, true);
  assert.equal(vpc('workspaces/deep').activity.hash, V.deepBackup, 'only the top-level workspace.md is the verbs\'');
  assert.equal(vpc('workspaces/gone').activity.hash, V.first);
});

test('vaultPathCommits: a commit that is not a backup counts, even when it touches only workspace.md', () => {
  const hand = vpc('workspaces/hand');
  assert.deepEqual(hashes(hand.commits), [V.hand, V.first]);
  assert.equal(hand.activity.hash, V.hand);
  assert.deepEqual(hashes(vpc('workspaces/hand', { n: 1 }).commits), [V.hand]);
  assert.deepEqual(hashes(vpc('workspaces/hand', { ignoreCommitSubjects: [] }).commits), [V.hand, V.first]);
  assert.deepEqual(hashes(vpc('workspaces/pin', { ignoreCommitSubjects: [] }).commits), [V.pinBackup, V.first]);
});

test('vaultPathCommits: untracked or odd paths, and recentCommits with a path, which takes the same filter', () => {
  write(VAULT, 'workspaces/fresh/notes.md', 'n\n');
  assert.deepEqual(vpc('workspaces/fresh'), { tracked: false, commits: [], activity: null });
  for (const bad of ['', '/etc', '../x', 'workspaces/../brain', 'workspaces/./pin']) assert.deepEqual(vpc(bad), { tracked: false, commits: [], activity: null }, bad);
  assert.equal(vpc('workspaces/pin/').activity.hash, V.first, 'a trailing slash is the same folder');
  assert.deepEqual(hashes(U.recentCommits(VAULT, 10, { path: 'workspaces/hand', ignoreCommitSubjects: IGNORE })), [V.hand, V.first]);
  assert.deepEqual(U.vaultPathCommits(path.join(ROOT, 'plain'), 'workspaces/pin'), { tracked: false, commits: [], activity: null });
});

test('vaultPathCommits is pure over a parsed log', () => {
  const log = [
    { hash: 'c3', iso: '2026-10-03T00:00:00Z', subject: 'vault backup: 3', changes: [{ status: 'R', score: 87, from: 'workspaces/a/x.md', path: 'workspaces/a/y.md' }] },
    { hash: 'c2', iso: '2026-10-02T00:00:00Z', subject: 'vault backup: 2', changes: [{ status: 'M', score: null, from: null, path: 'workspaces/a/workspace.md' }] },
    { hash: 'c1', iso: '2026-10-01T00:00:00Z', subject: 'start', changes: [{ status: 'A', score: null, from: null, path: 'workspaces/a/x.md' }] },
  ];
  const r = U.vaultPathCommits('/nowhere', 'workspaces/a', { log, ignoreCommitSubjects: ['^vault backup:'] });
  assert.equal(r.tracked, null);
  assert.deepEqual(hashes(r.commits), ['c1']);
  assert.deepEqual(r.activity, { hash: 'c3', iso: '2026-10-03T00:00:00Z', subject: 'vault backup: 3', ignored: true }, 'a rename that also changed the file is work');
});

test('lastCommit: the folder\'s own repository, else the vault\'s log of that path', () => {
  const own = path.join(ROOT, 'recent');
  assert.equal(U.lastCommit(own, 'ignored').subject, 'second: with a colon');
  const lc = U.lastCommit(path.join(VAULT, 'workspaces/hand'), 'workspaces/hand');
  assert.equal(lc.subject, 'hand: pause it');
  assert.equal(lc.hash, V.hand);
  assert.equal(U.lastCommit(path.join(ROOT, 'plain'), 'workspaces/none'), null);
  write(VAULT, 'workspaces/n*/x.md', 'n\n');
  const star = commitAll(VAULT, 'a folder named n*');
  write(VAULT, 'workspaces/na/x.md', 'n\n');
  commitAll(VAULT, 'na only');
  assert.equal(U.lastCommit(path.join(VAULT, 'workspaces/n*'), 'workspaces/n*').hash, star, 'a folder name is never a pattern');
});

test('no git call obeys repo config that runs a program: core.fsmonitor, gpg.program with log.showSignature', () => {
  const repo = newRepo(path.join(ROOT, 'hostile'));
  write(repo, 'workspaces/a/notes.md', 'n\n');
  commitAll(repo, 'first');
  // HEAD becomes a signed commit, so a log that shows signatures runs gpg.program on it.
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
  const parent = git(repo, 'rev-parse', 'HEAD').trim();
  const body = `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> 1700000000 +0000\ncommitter t <t@example.com> 1700000000 +0000\n`
    + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEabc\n =abcd\n -----END PGP SIGNATURE-----\n\nvault backup: signed\n';
  fs.writeFileSync(path.join(ROOT, 'signed.txt'), body);
  const oid = git(repo, 'hash-object', '-t', 'commit', '-w', path.join(ROOT, 'signed.txt')).trim();
  git(repo, 'update-ref', 'refs/heads/main', oid);
  write(repo, 'workspaces/a/dirty.md', 'untracked\n');
  const marker = (n) => path.join(ROOT, `marker-${n}`);
  for (const n of ['fsmonitor', 'gpg']) {
    fs.writeFileSync(path.join(ROOT, `${n}.sh`), `#!/bin/sh\ntouch "${marker(n)}"\nexit 1\n`, { mode: 0o755 });
  }
  git(repo, 'config', 'core.fsmonitor', path.join(ROOT, 'fsmonitor.sh'));
  git(repo, 'config', 'gpg.program', path.join(ROOT, 'gpg.sh'));
  git(repo, 'config', 'log.showSignature', 'true');
  // Control: plain git runs both programs, so the checks below test something.
  execFileSync('git', ['status', '--porcelain=v2'], { cwd: repo, stdio: 'ignore' });
  try { execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, stdio: 'ignore' }); } catch { /* the fake gpg fails */ }
  assert.ok(fs.existsSync(marker('fsmonitor')) && fs.existsSync(marker('gpg')), 'the control ran both programs');
  for (const n of ['fsmonitor', 'gpg']) fs.unlinkSync(marker(n));

  const st = U.gitState(repo);
  assert.equal(st.kind, 'repo');
  assert.equal(st.dirty, 1);
  assert.equal(U.recentCommits(repo, 5)[0].subject, 'vault backup: signed');
  assert.equal(U.lastCommit(repo, 'x').subject, 'vault backup: signed');
  const v = U.vaultPathCommits(repo, 'workspaces/a', { ignoreCommitSubjects: ['^vault backup:'] });
  assert.equal(v.tracked, true);
  assert.equal(v.commits[0].subject, 'first');
  assert.equal(fs.existsSync(marker('fsmonitor')), false, 'core.fsmonitor never ran');
  assert.equal(fs.existsSync(marker('gpg')), false, 'gpg.program never ran');
});

/** A script that leaves a marker, then passes its input through (a clean filter) or fails (`exit 1`). */
function markerScript(name, body = 'cat') {
  const marker = path.join(ROOT, `marker-${name}`);
  const file = path.join(ROOT, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\n${body}\n`, { mode: 0o755 });
  return { file, marker, ran: () => fs.existsSync(marker), reset: () => fs.rmSync(marker, { force: true }) };
}
const staleStat = (file) => { const t = new Date(Date.now() - 3600 * 1000); fs.utimesSync(file, t, t); };

test('filterOverrides: every driver below global and system scope, a name with = or dots included', () => {
  const out = ['local', 'filter.evil.clean', 'local', 'filter.a=b.process', 'worktree', 'filter.x.y.smudge', 'global', 'filter.lfs.clean',
    'system', 'filter.sys.clean', 'local', 'filter.evil.required', 'command', 'filter.cmd.clean', ''].join('\0');
  const off = (n) => [`--config-env=filter.${n}.clean=AOS_GIT_EMPTY`, `--config-env=filter.${n}.smudge=AOS_GIT_EMPTY`,
    `--config-env=filter.${n}.process=AOS_GIT_EMPTY`, `--config-env=filter.${n}.required=AOS_GIT_FALSE`];
  assert.deepEqual(U.filterOverrides(out), [...off('evil'), ...off('a=b'), ...off('x.y'), ...off('cmd')]);
  assert.deepEqual(U.filterOverrides(''), []);
});

test('status runs no filter driver the repository defines, while the user\'s own still runs (spec §6)', () => {
  const repo = newRepo(path.join(ROOT, 'filtered'));
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(repo, f, `${f}\n`);
  commitAll(repo, 'first');
  // Named only through .git/info/attributes, so nothing in the tree shows them: a plain driver, one named with "=", one a
  // config file the repository includes defines, and the user's own from a global config.
  const evil = markerScript('filter-evil');
  const eq = markerScript('filter-eq');
  const inc = markerScript('filter-inc');
  const mine = markerScript('filter-mine');
  git(repo, 'config', 'filter.evil.clean', evil.file);
  git(repo, 'config', 'filter.a=b.process', eq.file);
  const included = path.join(ROOT, 'filtered-include.gitconfig');
  fs.writeFileSync(included, `[filter "inc"]\n\tclean = ${inc.file}\n`);
  git(repo, 'config', 'include.path', included);
  const userCfg = path.join(ROOT, 'user-filters.gitconfig');
  fs.writeFileSync(userCfg, `[filter "mine"]\n\tclean = ${mine.file}\n`);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'a.txt filter=evil\nb.txt filter=a=b\nc.txt filter=inc\nd.txt filter=mine\n');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = userCfg;
  try {
    // Control: a tracked file whose stat no longer matches the index is re-hashed through its driver.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) staleStat(path.join(repo, f));
    try { execFileSync('git', ['status', '--porcelain=v2'], { cwd: repo, stdio: 'ignore' }); } catch { /* the fake process filter fails */ }
    assert.ok(evil.ran() && eq.ran() && inc.ran(), 'the control ran the repository\'s drivers');
    for (const s of [evil, eq, inc, mine]) s.reset();
    // A required driver that fails would fail status: turned off, it is not required either.
    git(repo, 'config', 'filter.a=b.required', 'true');
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) staleStat(path.join(repo, f));
    const st = U.gitState(repo);
    assert.equal(st.kind, 'repo');
    assert.equal(st.dirty, 0);
    assert.equal(evil.ran(), false, 'filter.evil.clean never ran');
    assert.equal(eq.ran(), false, 'a driver named with = never ran');
    assert.equal(inc.ran(), false, 'a driver from an included file never ran');
    assert.equal(mine.ran(), true, 'the user\'s own driver (global config) still runs');
  } finally { process.env.GIT_CONFIG_GLOBAL = prev; }
});

/** A partial clone missing a tree, whose promisor remote would be fetched through core.sshCommand. */
function lazyRepo(dir, ssh) {
  const repo = newRepo(dir);
  write(repo, 'sub/a.txt', 'a\n');
  write(repo, 'b.txt', 'b\n');
  commitAll(repo, 'first');
  const tree = git(repo, 'rev-parse', 'HEAD:sub').trim();
  for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', 'ssh://example.invalid/x.git'],
    ['remote.origin.promisor', 'true'], ['core.sshCommand', ssh.file], ['protocol.ssh.allow', 'always']]) git(repo, 'config', k, v);
  fs.rmSync(path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)), { force: true });
  fs.rmSync(path.join(repo, '.git', 'index'), { force: true });
  return repo;
}

test('status makes no lazy fetch in a partial clone, so its core.sshCommand never runs (spec §6)', () => {
  const ssh = markerScript('lazy-ssh', 'exit 1');
  const repo = lazyRepo(path.join(ROOT, 'lazy'), ssh);
  const env = { ...process.env };
  delete env.GIT_SSH_COMMAND;
  try { execFileSync('git', ['status', '--porcelain=v2'], { cwd: repo, env, stdio: 'ignore' }); } catch { /* the fetch fails */ }
  assert.ok(ssh.ran(), 'the control fetched through core.sshCommand');
  ssh.reset();
  U.gitState(repo);
  U.recentCommits(repo, 5);
  assert.equal(ssh.ran(), false, 'core.sshCommand never ran');
});

test('workspaceDir and workspaceFile: an existing direct child of workspaces/, a regular file inside it', () => {
  const dir = U.workspaceDir('pin', VAULT);
  assert.equal(dir, fs.realpathSync(path.join(VAULT, 'workspaces', 'pin')));
  for (const bad of ['..', '.', '_archive', 'a\\b', '-x', 'pin\n', '../x', '/etc/x', 'pin/sub', 'missing', '\0pin', 'pin\u2028', 'a\u2029b']) {
    assert.equal(U.workspaceDir(bad, VAULT), null, JSON.stringify(bad));
  }
  // The name rule itself, as the page's WS: a NUL first or a line separator anywhere fails before any path is built.
  for (const bad of ['\0pin', 'pin\u2028', 'a\u2029b', '\u2028a']) assert.equal(U.WS_NAME.test(bad), false, JSON.stringify(bad));
  assert.equal(U.workspaceFile(dir, 'notes.md'), path.join(dir, 'notes.md'));
  for (const bad of ['../pin-2/notes.md', '/etc/hosts', '-x', '.', 'missing.md', 'a\nb']) assert.equal(U.workspaceFile(dir, bad), null, bad);
});
