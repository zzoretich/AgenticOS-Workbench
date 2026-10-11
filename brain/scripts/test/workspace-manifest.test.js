'use strict';
// lib/workspace-manifest.js (spaces-redesign D18, D28, §6): the shared parser, the line-preserving writer, the --expect
// hash, the `set` rules and the symlink refusals. Every file lives in a temp vault; HOME is never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../lib/workspace-manifest.js');
const W = require('../collectors/workspaces.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-wsm-test-'));
let seq = 0;
function tmpVault() {
  const vault = path.join(ROOT, `v-${++seq}`);
  fs.mkdirSync(path.join(vault, 'workspaces'), { recursive: true });
  return fs.realpathSync(vault);
}
function ws(vault, name, files = {}) {
  const dir = path.join(vault, 'workspaces', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  return dir;
}
const code = (c) => (e) => e instanceof M.ManifestError && e.code === c;

test('the collector parses with the shared parser: same function, same repoPath', () => {
  assert.equal(W.parseManifest, M.parseManifest);
  assert.equal(W.repoPath, M.repoPath);
});

test('setFields round trip: every value parseManifest reads back is exactly the one set', () => {
  const tricky = [
    'plain words', 'a: b', 'ends with colon:', '#tag', 'x #y', 'true', 'no', '123', '1.5', '~', '~/Code/app', '- dash',
    '[ ] open box', '[x] done box', '{brace}', '"quoted" start', "it's", "it's \"both\"", 'ends quote\'', 'back\\slash',
    ' lead space', 'trail space ', '* star', '& anchor', '! tag', '| pipe', '> fold', '% pct', '@ at', '`tick`', 'é ünïcode ✓',
  ];
  for (const v of tricky) {
    const text = M.setFields('---\nstatus: active\n---\n', { summary: v, next: v, repo: v, objectives: [v, 'second'] });
    const m = M.parseManifest(text);
    assert.equal(m.summary, v, `summary ${JSON.stringify(v)} → ${text}`);
    assert.equal(m.next, v);
    assert.equal(m.repo, v);
    assert.deepEqual(m.objectives, [v, 'second']);
    assert.equal(m.status, 'active');
  }
  const t = M.setFields(null, { pinned: true, archived: '2026-10-10', aliases: ['workspaces/old', '~/elsewhere'] });
  const m = M.parseManifest(t);
  assert.equal(m.pinned, true);
  assert.equal(m.archived, '2026-10-10');
  assert.deepEqual(m.aliases, ['workspaces/old', '~/elsewhere']);
  assert.equal(M.parseManifest(M.setFields(t, { pinned: false })).pinned, false);
});

test('setFields is line-preserving: unknown keys, comments, blank lines, CRLF and the body are kept byte for byte', () => {
  const before = [
    '---',
    'type: project',
    'status: active # by hand',
    '# a comment about objectives',
    'objectives:',
    '- unindented one',
    '',
    '- after a blank',
    'custom:',
    '  nested: value',
    'tags: [a, b]',
    'summary: old',
    '  folded continuation',
    '',
    '---',
    '# Body',
    '',
    'status: not frontmatter',
    '',
  ].join('\r\n');
  const after = M.setFields(before, { summary: 'New summary', objectives: ['one', 'two'] });
  assert.equal(after, [
    '---',
    'type: project',
    'status: active # by hand',
    '# a comment about objectives',
    'objectives:',
    '  - one',
    '  - two',
    'custom:',
    '  nested: value',
    'tags: [a, b]',
    'summary: New summary',
    '',
    '---',
    '# Body',
    '',
    'status: not frontmatter',
    '',
  ].join('\r\n'));
  // A key that is absent is appended after the last non-blank line; the body is untouched.
  const added = M.setFields('---\ntype: x\n\n---\nbody\n', { pinned: true, next: 'Ship it' });
  assert.equal(added, '---\ntype: x\npinned: true\nnext: Ship it\n\n---\nbody\n');
  // Setting a value to what it already reads as, in the same form, changes nothing.
  assert.equal(M.setFields(added, { pinned: true }), added);
});

test('setFields removes with null, "" and [], collapses a repeated key, and adds or drops the frontmatter block', () => {
  const text = '---\nstatus: active\nsummary: a\nobjectives:\n  - x\nsummary: b\n---\nbody\n';
  assert.equal(M.setFields(text, { summary: 'c' }), '---\nstatus: active\nsummary: c\nobjectives:\n  - x\n---\nbody\n');
  assert.equal(M.setFields(text, { summary: null, objectives: [] }), '---\nstatus: active\n---\nbody\n');
  assert.equal(M.setFields(text, { status: '' }), '---\nsummary: a\nobjectives:\n  - x\nsummary: b\n---\nbody\n');
  assert.equal(M.setFields(text, { summary: undefined }), text, 'undefined leaves a key alone');
  // A key written without a space after the colon is still that key to the parser, so it is replaced, not repeated.
  assert.equal(M.setFields('---\nstatus:active\n---\n', { status: 'paused' }), '---\nstatus: paused\n---\n');
  // No frontmatter: one is added above the body; removing from none changes nothing.
  assert.equal(M.setFields('# Title\n\nText\n', { status: 'paused' }), '---\nstatus: paused\n---\n# Title\n\nText\n');
  assert.equal(M.setFields('# Title\n', { status: null }), '# Title\n');
  assert.equal(M.setFields(null, { summary: 'hi' }), '---\nsummary: hi\n---\n');
  // An empty block is filled; a block left with nothing is dropped.
  assert.equal(M.setFields('---\n---\nbody', { status: 'done' }), '---\nstatus: done\n---\nbody');
  assert.equal(M.setFields('---\nstatus: x\n---\nbody', { status: null }), 'body');
});

test('setFields refuses a bad key and any control character, so no value can add a frontmatter line', () => {
  assert.throws(() => M.setFields('', { 'bad key': 'x' }), code('INVALID'));
  assert.throws(() => M.setFields('', { summary: 'a\nstatus: done' }), code('INVALID'));
  assert.throws(() => M.setFields('', { objectives: ['ok', 'b\r'] }), code('INVALID'));
  for (const ch of ['\u0000', '\t', '\u001f', '\u007f', '\u2028', '\u2029']) {
    assert.throws(() => M.setFields('', { next: `x${ch}y` }), code('INVALID'), JSON.stringify(ch));
  }
  assert.throws(() => M.setFields('', { summary: { nested: true } }), code('INVALID'));
});

test('manifestHash: sha256 of the bytes, "none" for a missing file; readManifest agrees with it', () => {
  const vault = tmpVault();
  const dir = ws(vault, 'demo');
  const missing = M.readManifest(dir);
  assert.equal(missing.exists, false);
  assert.equal(missing.hash, 'none');
  assert.equal(missing.text, null);
  fs.writeFileSync(path.join(dir, 'workspace.md'), '---\nstatus: active\n---\n');
  const r = M.readManifest(dir);
  assert.equal(r.exists, true);
  assert.equal(r.refused, null);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(r.hash, M.manifestHash('---\nstatus: active\n---\n'));
  assert.equal(r.manifest.status, 'active');
  assert.notEqual(M.manifestHash('a'), M.manifestHash('b'));
  assert.equal(M.manifestHash(null), 'none');
});

test('readManifest never reads through a symlinked workspace.md (outward, inward or dangling), a folder or a huge file', () => {
  const vault = tmpVault();
  const secret = path.join(ROOT, `secret-${seq}.md`);
  fs.writeFileSync(secret, '---\nsummary: SECRET-OUTSIDE\n---\n');
  const out = ws(vault, 'out');
  fs.symlinkSync(secret, path.join(out, 'workspace.md'));
  const inw = ws(vault, 'inw', { 'real.md': '---\nsummary: inside\n---\n' });
  fs.symlinkSync(path.join(inw, 'real.md'), path.join(inw, 'workspace.md'));
  const dang = ws(vault, 'dang');
  fs.symlinkSync(path.join(dang, 'nowhere.md'), path.join(dang, 'workspace.md'));
  for (const dir of [out, inw, dang]) {
    const r = M.readManifest(dir);
    assert.match(r.refused, /symlink/);
    assert.equal(r.text, null);
    assert.equal(r.hash, null);
    assert.equal(r.manifest.summary, null);
  }
  const folder = ws(vault, 'folder');
  fs.mkdirSync(path.join(folder, 'workspace.md'));
  assert.match(M.readManifest(folder).refused, /not a regular file/);
  const big = ws(vault, 'big', { 'workspace.md': `---\nsummary: x\n---\n${'y'.repeat(M.MAX_READ)}` });
  assert.match(M.readManifest(big).refused, /larger than/);
});

test('setManifest: --expect refuses a changed file; --dry-run writes nothing; a write keeps the body and unknown keys', () => {
  const vault = tmpVault();
  const dir = ws(vault, 'demo', { 'workspace.md': '---\ntype: project\nstatus: active\n---\n# Demo\n\nNotes.\n' });
  const base = M.readManifest(dir).hash;
  const dry = M.setManifest(dir, { summary: 'Drafted' }, { expect: base, dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(dry.written, false);
  assert.equal(dry.text, '---\ntype: project\nstatus: active\nsummary: Drafted\n---\n# Demo\n\nNotes.\n');
  assert.equal(dry.beforeText, '---\ntype: project\nstatus: active\n---\n# Demo\n\nNotes.\n', 'the file as it was, for the preview\'s + marks');
  assert.equal(fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8'), '---\ntype: project\nstatus: active\n---\n# Demo\n\nNotes.\n');
  const done = M.setManifest(dir, { summary: 'Drafted' }, { expect: base });
  assert.equal(done.written, true);
  assert.equal(fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8'), dry.text);
  assert.equal(done.hash, M.readManifest(dir).hash);
  assert.equal(done.before, base);
  // The old hash no longer matches: the dialog is told to draft again, and nothing is written.
  assert.throws(() => M.setManifest(dir, { next: 'x' }, { expect: base }), (e) => code('CHANGED')(e) && e.message === 'workspace.md changed: draft again');
  assert.equal(fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8'), dry.text);
  // A first write: no file yet, so the expected hash is "none".
  const fresh = ws(vault, 'fresh');
  assert.throws(() => M.setManifest(fresh, { pinned: true }, { expect: 'a'.repeat(16) }), code('CHANGED'));
  assert.equal(M.setManifest(fresh, { pinned: true }, { expect: 'none', dryRun: true }).beforeText, null, 'no file before');
  M.setManifest(fresh, { pinned: true }, { expect: 'none' });
  assert.equal(fs.readFileSync(path.join(fresh, 'workspace.md'), 'utf8'), '---\npinned: true\n---\n');
  // Nothing to change → nothing written.
  const same = M.setManifest(fresh, { pinned: true });
  assert.equal(same.changed, false);
  assert.equal(same.written, false);
});

test('setManifest refuses a symlinked workspace.md and leaves the link and its target alone', () => {
  const vault = tmpVault();
  const target = path.join(ROOT, `target-${seq}.md`);
  fs.writeFileSync(target, 'TARGET\n');
  const dir = ws(vault, 'linked');
  fs.symlinkSync(target, path.join(dir, 'workspace.md'));
  assert.throws(() => M.setManifest(dir, { pinned: true }), code('UNSAFE'));
  assert.throws(() => M.setManifest(dir, { pinned: true }, { expect: 'none' }), code('UNSAFE'));
  assert.ok(fs.lstatSync(path.join(dir, 'workspace.md')).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'TARGET\n');
});

test('writeManifest is atomic and replaces a link that appeared since, never writing its target', () => {
  const vault = tmpVault();
  const target = path.join(ROOT, `target2-${seq}.md`);
  fs.writeFileSync(target, 'TARGET\n');
  const dir = ws(vault, 'race');
  fs.symlinkSync(target, path.join(dir, 'workspace.md'));
  M.writeManifest(dir, '---\npinned: true\n---\n');
  const st = fs.lstatSync(path.join(dir, 'workspace.md'));
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8'), '---\npinned: true\n---\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'TARGET\n');
  assert.deepEqual(fs.readdirSync(dir), ['workspace.md'], 'no temp file left behind');
});

test('workspaceDir: a WS name whose real folder is a direct child of workspaces/ (or _archive/)', () => {
  const vault = tmpVault();
  ws(vault, 'demo');
  ws(vault, 'My Project');
  fs.mkdirSync(path.join(vault, 'workspaces', '_archive', 'old'), { recursive: true });
  assert.equal(M.workspaceDir(vault, 'demo'), path.join(vault, 'workspaces', 'demo'));
  assert.equal(M.workspaceDir(vault, 'My Project'), path.join(vault, 'workspaces', 'My Project'));
  assert.equal(M.workspaceDir(vault, 'old', { archived: true }), path.join(vault, 'workspaces', '_archive', 'old'));
  for (const bad of ['', '.', '..', '_archive', '-x', ' x', 'a/b', 'a\\b', '.hidden', '../demo', 'x\ny', 42, null]) {
    assert.throws(() => M.workspaceDir(vault, bad), code('INVALID'), String(bad));
  }
  assert.throws(() => M.workspaceDir(vault, 'nope'), code('NOT_FOUND'));
  assert.throws(() => M.workspaceDir(vault, 'old'), code('NOT_FOUND'));
  // A link under workspaces/, to a folder outside or to a sibling, is never a workspace folder.
  const outside = fs.mkdtempSync(path.join(ROOT, 'outside-'));
  fs.symlinkSync(outside, path.join(vault, 'workspaces', 'escape'));
  fs.symlinkSync(path.join(vault, 'workspaces', 'demo'), path.join(vault, 'workspaces', 'twin'));
  assert.throws(() => M.workspaceDir(vault, 'escape'), code('UNSAFE'));
  assert.throws(() => M.workspaceDir(vault, 'twin'), code('UNSAFE'));
  assert.throws(() => M.workspaceDir(vault, 'escape'), (e) => /is a symlink/.test(e.message));
  fs.writeFileSync(path.join(vault, 'workspaces', 'file'), 'x');
  assert.throws(() => M.workspaceDir(vault, 'file'), code('UNSAFE'));
});

test('workspacesRoot and workspaceDir: a linked or file workspaces/ or _archive is refused; names match the entry exactly', () => {
  const vault = tmpVault();
  ws(vault, 'demo');
  assert.equal(M.workspacesRoot(vault), path.join(vault, 'workspaces'));
  assert.throws(() => M.workspacesRoot(vault, { archived: true }), code('NOT_FOUND'));
  assert.equal(M.workspacesRoot(vault, { archived: true, make: true }), path.join(vault, 'workspaces', '_archive'));
  // A case variant (found by a case-insensitive lookup on macOS) is no entry of the folder.
  assert.throws(() => M.workspaceDir(vault, 'DEMO'), code('NOT_FOUND'));
  assert.throws(() => M.workspaceDir(vault, 'dеmo'), code('NOT_FOUND'), 'a look-alike letter');
  // workspaces/ linked out of the vault (`workspaces -> ..`): every name refused, nothing resolved through it.
  const v2 = path.join(ROOT, `v-${++seq}`);
  fs.mkdirSync(path.join(v2, 'Documents'), { recursive: true });
  fs.symlinkSync('.', path.join(v2, 'workspaces'));
  assert.throws(() => M.workspacesRoot(v2), code('UNSAFE'));
  assert.throws(() => M.workspaceDir(v2, 'Documents'), (e) => e.code === 'UNSAFE' && /workspaces is not a plain folder/.test(e.message));
  // _archive linked elsewhere, or a file.
  const v3 = tmpVault();
  const elsewhere = fs.mkdtempSync(path.join(ROOT, 'elsewhere-'));
  fs.mkdirSync(path.join(elsewhere, 'loot'));
  fs.symlinkSync(elsewhere, path.join(v3, 'workspaces', '_archive'));
  assert.throws(() => M.workspaceDir(v3, 'loot', { archived: true }), (e) => e.code === 'UNSAFE' && /workspaces\/_archive is not a plain folder/.test(e.message));
  assert.throws(() => M.workspacesRoot(v3, { archived: true, make: true }), code('UNSAFE'));
  fs.unlinkSync(path.join(v3, 'workspaces', '_archive'));
  fs.writeFileSync(path.join(v3, 'workspaces', '_archive'), 'x');
  assert.throws(() => M.workspacesRoot(v3, { archived: true, make: true }), code('UNSAFE'));
  // A vault reached through a link of its own is still the vault.
  const linkedVault = path.join(ROOT, `vlink-${seq}`);
  fs.symlinkSync(vault, linkedVault);
  assert.equal(M.workspaceDir(linkedVault, 'demo'), path.join(vault, 'workspaces', 'demo'));
});

test('readManifest and writeManifest refuse a workspace folder swapped for a link after it was located', () => {
  const vault = tmpVault();
  const dir = M.workspaceDir(vault, path.basename(ws(vault, 'swap')));
  const outside = fs.mkdtempSync(path.join(ROOT, 'swap-out-'));
  fs.rmdirSync(dir);
  fs.symlinkSync(outside, dir);
  assert.throws(() => M.writeManifest(dir, '---\npinned: true\n---\n'), code('UNSAFE'));
  assert.throws(() => M.readManifest(dir), code('UNSAFE'));
  assert.throws(() => M.setManifest(dir, { pinned: true }), code('UNSAFE'));
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the link');
});

test('listField reads a frontmatter list the parser leaves alone (Archive\'s record); setFields keeps an indented comment under a scalar', () => {
  const text = '---\nstatus: paused\narchivedNotes:\n  - brain/memory/projects/a.md\n  - "brain/memory/projects/b.md"\narchivedFrom: harbor\ntags: [x, y]\n---\n';
  assert.deepEqual(M.listField(text, 'archivedNotes'), ['brain/memory/projects/a.md', 'brain/memory/projects/b.md']);
  assert.deepEqual(M.listField(text, 'archivedFrom'), ['harbor']);
  assert.deepEqual(M.listField(text, 'tags'), ['x', 'y']);
  assert.deepEqual(M.listField(text, 'missing'), []);
  assert.deepEqual(M.listField('no frontmatter', 'archivedNotes'), []);
  assert.deepEqual(M.listField(M.setFields(text, { archivedNotes: null, archivedFrom: null }), 'archivedNotes'), []);
  // Comments are kept byte for byte: one indented under a scalar key is not part of its value.
  assert.equal(M.setFields('---\nstatus: active\n  # keep me\nnext: x\n---\n', { status: 'paused' }), '---\nstatus: paused\n  # keep me\nnext: x\n---\n');
  assert.equal(M.setFields('---\nsummary: a\n  continued\n---\n', { summary: 'b' }), '---\nsummary: b\n---\n', 'a continuation line is the value');
  assert.equal(M.setFields('---\nsummary: |\n  # a line of the text\n  more\nnext: x\n---\n', { summary: 'b' }), '---\nsummary: b\nnext: x\n---\n', 'a block scalar owns its lines');
  assert.equal(M.setFields('---\nobjectives:\n  # todo\n  - a\n---\n', { objectives: ['b'] }), '---\nobjectives:\n  - b\n---\n');
});

test('validateSetFields: the six keys with their types and limits; "" clears; a JSON string is parsed', () => {
  const vault = tmpVault();
  const ok = M.validateSetFields('{"status":"paused","pinned":true,"objectives":[" a ","","b"],"summary":" s ","next":""}', { vault, configDirs: [] });
  assert.deepEqual(ok, { status: 'paused', pinned: true, objectives: ['a', 'b'], summary: 's', next: null });
  assert.deepEqual(M.validateSetFields({ status: '' }, { vault }), { status: null });
  for (const word of M.STATUS_WORDS) assert.equal(M.validateSetFields({ status: word }, { vault }).status, word);
  const bad = [
    'not json', '[]', '{}', 'null', { nope: 1 }, { status: 'stalled' }, { status: 'Active' }, { status: null },
    { pinned: 'true' }, { pinned: 1 }, { objectives: 'one' }, { objectives: [1] },
    { objectives: Array.from({ length: 21 }, (_, i) => `o${i}`) }, { objectives: ['x'.repeat(201)] },
    { summary: 'x'.repeat(501) }, { next: 'x'.repeat(501) }, { summary: 5 }, { archived: '2026-10-10' }, { aliases: [] },
  ];
  for (const b of bad) assert.throws(() => M.validateSetFields(b, { vault }), code('INVALID'), JSON.stringify(b));
  // Limits count characters, not UTF-16 units.
  assert.equal(M.validateSetFields({ summary: '✓'.repeat(500) }, { vault }).summary.length, 500);
  assert.equal(M.validateSetFields({ objectives: Array.from({ length: 20 }, () => 'x'.repeat(200)) }, { vault }).objectives.length, 20);
  for (const ch of ['\n', '\r', '\t', '\u0000', '\u007f', '\u2028', '\u2029']) {
    for (const key of ['summary', 'next']) assert.throws(() => M.validateSetFields({ [key]: `a${ch}b` }, { vault }), code('INVALID'));
    assert.throws(() => M.validateSetFields({ objectives: [`a${ch}b`] }, { vault }), code('INVALID'));
    assert.throws(() => M.validateSetFields({ status: `done${ch}` }, { vault }), code('INVALID'));
  }
});

test('validateSetFields repo: an existing folder outside the vault, not / or home, clear of the host config folders', () => {
  const vault = tmpVault();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'home-')));
  const code1 = path.join(home, 'Code', 'app');
  fs.mkdirSync(code1, { recursive: true });
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  const ctx = { vault, home, configDirs: [claudeDir, codexDir] };
  assert.deepEqual(M.validateSetFields({ repo: '~/Code/app' }, ctx), { repo: '~/Code/app' });
  assert.deepEqual(M.validateSetFields({ repo: code1 }, ctx), { repo: '~/Code/app' }, 'written as ~/… under home');
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'elsewhere-')));
  assert.deepEqual(M.validateSetFields({ repo: elsewhere }, ctx), { repo: elsewhere });
  assert.deepEqual(M.validateSetFields({ repo: '' }, ctx), { repo: null }, '"" unlinks');
  fs.mkdirSync(path.join(vault, 'workspaces', 'in'), { recursive: true });
  const bad = [
    'Code/app', './x', '~/Code/missing', '/', '~', home, path.join(vault, 'workspaces', 'in'), vault, path.dirname(vault),
    claudeDir, path.join(claudeDir, 'projects'), codexDir, '~/.codex', 'x\ny',
  ];
  for (const b of bad) assert.throws(() => M.validateSetFields({ repo: b }, ctx), code('INVALID'), b);
  // A folder that contains a host config folder (here the home's parent holds both) is refused too.
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'parent-')));
  const inner = path.join(parent, 'cfg');
  fs.mkdirSync(inner);
  assert.throws(() => M.validateSetFields({ repo: parent }, { vault, home, configDirs: [inner] }), code('INVALID'));
  // A link to the vault is caught by its real path.
  const link = path.join(home, 'vault-link');
  fs.symlinkSync(vault, link);
  assert.throws(() => M.validateSetFields({ repo: link }, ctx), code('INVALID'));
});

test('what set writes is what the scan reads: pinned, status, summary, objectives and next after setManifest', () => {
  const vault = tmpVault();
  const dir = ws(vault, 'demo', { 'workspace.md': '---\ntype: project\n---\n# Demo\n', 'README.md': '# Demo\n\nReadme line.\n' });
  const fields = M.validateSetFields({ pinned: true, status: 'paused', summary: 'A: drafted summary', objectives: ['[ ] open one', '[x] done'], next: 'Write the "tests"' }, { vault });
  M.setManifest(dir, fields, { expect: M.readManifest(dir).hash });
  const [e] = W.collectWorkspaces({ vault });
  assert.equal(e.pinned, true);
  assert.equal(e.statusOverride, 'paused');
  assert.equal(e.summary, 'A: drafted summary');
  assert.equal(e.summarySource, 'manifest');
  assert.deepEqual(e.objectives.map((o) => [o.text, o.done]), [['open one', false], ['done', true]]);
  assert.deepEqual(e.next, { text: 'Write the "tests"', source: 'manifest', from: 'workspace.md' });
  assert.match(fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8'), /\n---\n# Demo\n$/);
});
