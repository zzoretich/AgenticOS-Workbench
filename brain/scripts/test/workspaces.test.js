'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The test's own git setup never reads the developer's global or system config (a global hooksPath, signing).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-test-'));
const EMPTY_CFG = path.join(ROOT, 'empty.gitconfig');
fs.writeFileSync(EMPTY_CFG, '');
process.env.GIT_CONFIG_GLOBAL = EMPTY_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// No git call looks above the test root, so a temp folder inside some checkout never lends its repository.
process.env.GIT_CEILING_DIRECTORIES = ROOT;

const W = require('../collectors/workspaces');
const { parseManifest } = W;

const FIXTURES = path.join(__dirname, 'fixtures');
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

let seq = 0;
function tmpVault(label = 'v') {
  const vault = path.join(ROOT, `${label}-${++seq}`);
  fs.mkdirSync(path.join(vault, 'workspaces'), { recursive: true });
  return vault;
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function git(dir, args, date) {
  const env = { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function newRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}
function commitAll(dir, subject, date = new Date(NOW).toISOString()) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', subject], date);
  return git(dir, ['rev-parse', '--short=7', 'HEAD']).trim();
}
/** collect + finalize, as scan-vault.js runs them, with fixed config and clock. */
function scan(vault, { cfg = {}, prev = [], sessions = {}, home } = {}) {
  const list = W.collectWorkspaces({ vault, home });
  for (const w of list) if (sessions[w.name]) w.sessions = sessions[w.name];
  return W.finalizeWorkspaces(list, { vault, cfg, prev, now: NOW });
}
const byName = (list) => Object.fromEntries(list.map((w) => [w.name, w]));

test('parseManifest reads scalars, objective list, and mixed subprojects', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'full-manifest', 'workspace.md'), 'utf8');
  const m = parseManifest(text);
  assert.equal(m.status, 'active');
  assert.equal(m.summary, 'Ship the onboarding skill');
  assert.deepEqual(m.objectives, ['Ship onboarding (P0)', 'QA 3 platform skills']);
  assert.deepEqual(m.subprojects, [
    { name: 'factory', path: 'factory' },
    { name: 'research', path: 'research' },
  ]);
  assert.equal(m.next, 'Finish QA on the reporting dashboard');
  assert.equal(m.pinned, false);
  assert.equal(m.archived, null);
  assert.deepEqual(m.aliases, []);
});

test('parseManifest returns empty shape when no frontmatter', () => {
  const m = parseManifest('# just a heading\nno frontmatter here');
  assert.deepEqual(m, { status: null, summary: null, objectives: [], subprojects: [], documents: [], next: null, repo: null, pinned: false, archived: null, aliases: [] });
});

test('parseManifest reads pinned, archived and aliases, and list items written unindented (spaces-redesign D16-D18, D22)', () => {
  const m = parseManifest([
    '---', 'status: on hold', 'pinned: true', 'archived: 2026-10-01', 'aliases:', '- workspaces/old-name', '  - "~/Code/app"',
    'objectives:', '- [ ] Open one', '- [x] Done one', '- ', '-', 'documents:', '- PLAN.md', 'next: Write the plan', '---', 'body',
  ].join('\n'));
  assert.equal(m.status, 'on hold');
  assert.equal(m.pinned, true);
  assert.equal(m.archived, '2026-10-01');
  assert.deepEqual(m.aliases, ['workspaces/old-name', '~/Code/app']);
  assert.deepEqual(m.objectives, ['[ ] Open one', '[x] Done one'], 'empty placeholder bullets are dropped');
  assert.deepEqual(m.documents, ['PLAN.md']);
  assert.equal(m.next, 'Write the plan');
  assert.deepEqual(parseManifest('---\naliases: [workspaces/a, "~/b"]\n---\n').aliases, ['workspaces/a', '~/b']);
  assert.deepEqual(parseManifest('---\naliases: workspaces/a\n---\n').aliases, ['workspaces/a']);
  assert.equal(parseManifest('---\npinned: false\narchived: false\n---\n').pinned, false);
  assert.equal(parseManifest('---\narchived: false\n---\n').archived, null);
  assert.equal(parseManifest('---\npinned: yes\n---\n').pinned, true);
  // An unindented item under a scalar key belongs to no list.
  assert.deepEqual(parseManifest('---\nstatus: active\n- stray\n---\n').objectives, []);
});

test('statusOverride maps the words workspace.md may set; any other word is ignored (spaces-redesign D11)', () => {
  const cases = { active: 'active', paused: 'paused', done: 'done', Shipped: 'done', complete: 'done', blocked: 'paused', parked: 'paused',
    'on hold': 'paused', 'on-hold': 'paused', ON_HOLD: 'paused', wip: null, idle: null, planned: null, stalled: null, constructor: null, '': null };
  for (const [word, want] of Object.entries(cases)) assert.equal(W.statusOverride(word), want, word);
  assert.equal(W.statusOverride(null), null);
});

test('aliasPaths expands workspaces/<old> and ~/…, and drops anything that could claim every session', () => {
  const home = path.join(path.sep, 'h');
  const vault = path.join(home, 'Vault');
  const wsRoot = path.join(vault, 'workspaces');
  const own = path.join(wsRoot, 'new-name');
  assert.deepEqual(W.aliasPaths(['workspaces/old-name', '~/Code/app', '/opt/src/x', '~/Code/app', 'workspaces/new-name'], { vault, wsRoot, ownDir: own, home }),
    [path.join(wsRoot, 'old-name'), path.join(home, 'Code', 'app'), path.resolve('/opt/src/x')]);
  for (const bad of ['~', '/', home, vault, path.dirname(vault), 'workspaces', 'brain/memory', '.', 'workspaces/../brain', '../x',
    'workspaces/_worktrees', 'workspaces/_worktrees/t/i/m', '', 'a\nb']) {
    assert.deepEqual(W.aliasPaths([bad], { vault, wsRoot, ownDir: own, home }), [], JSON.stringify(bad));
  }
  assert.deepEqual(W.aliasPaths(['workspaces/_archive/old'], { vault, wsRoot, ownDir: own, home }), [path.join(wsRoot, '_archive', 'old')]);
  assert.deepEqual(W.aliasPaths(null, { vault, wsRoot, home }), []);
});

const { detectChildren } = require('../collectors/workspaces');

test('detectChildren flags a collection and excludes noise dirs', () => {
  const abs = path.join(FIXTURES, 'collection');
  const res = detectChildren(abs, 'workspaces/collection');
  assert.equal(res.isCollection, true);
  const names = res.subprojects.map(s => s.name).sort();
  assert.deepEqual(names, ['ProjectA', 'ProjectB']);
  assert.ok(!names.includes('node_modules'));
  assert.equal(res.docs.length, 0);
});

test('detectChildren treats single-project as docs, not subprojects', () => {
  const abs = path.join(FIXTURES, 'single-project');
  const res = detectChildren(abs, 'workspaces/single-project');
  assert.equal(res.isCollection, false);
  assert.equal(res.subprojects.length, 0);
  assert.deepEqual(res.docs.map(d => d.name), ['STATUS.md']);
  assert.equal(res.docs[0].note, 'Pytest green. Setup guide done.');
  assert.equal(res.docs[0].done, false);
  assert.ok(!Number.isNaN(Date.parse(res.docs[0].mtime)));
});

const { extractObjectives, collectWorkspaces, computeInputHash } = require('../collectors/workspaces');

test('extractObjectives pulls bullets under an Objectives/Goals heading', () => {
  const md = '# Title\n\n## Objectives\n- First goal\n- Second goal\n\n## Other\n- not this';
  assert.deepEqual(extractObjectives(md), ['First goal', 'Second goal']);
});

test('collectWorkspaces builds entries with correct provenance', () => {
  const list = collectWorkspaces({ vault: __dirname, workspacesDirName: 'fixtures' });
  const byName = Object.fromEntries(list.map(w => [w.name, w]));

  const full = byName['full-manifest'];
  assert.equal(full.status, 'active');
  assert.equal(full.statusSource, 'manifest');
  assert.equal(full.statusOverride, 'active');
  assert.equal(full.summary, 'Ship the onboarding skill');
  assert.equal(full.summarySource, 'manifest');
  assert.equal(full.objectives[0].source, 'manifest');
  assert.equal(full.objectives[0].done, false);
  assert.equal(full.isCollection, false); // manifest subprojects present
  assert.deepEqual(full.subprojects.map(s => s.name), ['factory', 'research']);
  assert.equal(full.next.text, 'Finish QA on the reporting dashboard');
  assert.equal(full.next.from, 'workspace.md');
  assert.equal(full.hidden, false);
  assert.equal(full.label, 'full-manifest');

  const coll = byName['collection'];
  assert.equal(coll.isCollection, true);
  assert.deepEqual(coll.subprojects.map(s => s.name), ['ProjectA', 'ProjectB']);

  const single = byName['single-project'];
  assert.equal(single.isCollection, false);
  assert.equal(single.docs[0].name, 'STATUS.md');
  // no insight is generated by the sync collector
  assert.equal(single.insight.status, 'unavailable');
  assert.equal(single.insight.text, null);
});

test('extractObjectives also reads Scope / Project Scope headings', () => {
  const md = '# Title\n\n## Project Scope\n- Draft the thing\n- Review it\n\n## Other\n- not this';
  assert.deepEqual(extractObjectives(md), ['Draft the thing', 'Review it']);
  const bare = '# Title\n\n## Scope\n- Only this\n\n## Other\n- not this';
  assert.deepEqual(extractObjectives(bare), ['Only this']);
});

test('summary falls back to CLAUDE.md first body line', () => {
  const list = W.finalizeWorkspaces(collectWorkspaces({ vault: __dirname, workspacesDirName: 'fixtures' }), { vault: tmpVault(), cfg: {}, now: NOW });
  const w = list.find((x) => x.name === 'claude-only');
  assert.equal(w.summary, 'This workspace only has a CLAUDE.md and nothing else.');
  assert.equal(w.summarySource, 'derived');
  assert.equal(w.summaryTemplate, false);
  assert.deepEqual(w.objectives.map((o) => o.text), ['Draft the thing', 'Review the other thing']);
  assert.equal(w.objectives[0].source, 'derived');
  assert.equal(w.next.text, 'Ship the draft for review');
  assert.equal(w.next.source, 'derived');
  assert.equal(w.next.from, 'CLAUDE.md › Next');
  assert.equal(w.status, 'idle', 'no session and no repository: a plan with no activity is idle');
  assert.deepEqual(w.activity, { at: null, ageDays: null, from: null });
  assert.equal(w.statusSource, 'derived');
  assert.equal(w.status, w.statusAuto);
});

test('no commit subject as next: a folder with no Next heading keeps next empty, whatever its last commit says (spaces-redesign D23)', () => {
  const vault = newRepo(tmpVault('nonext'));
  write(vault, 'workspaces/no-next/STATUS.md', fs.readFileSync(path.join(FIXTURES, 'no-next', 'STATUS.md'), 'utf8'));
  commitAll(vault, 'vault backup: 2026-10-09 11:30:00');
  const own = newRepo(path.join(vault, 'workspaces', 'own'));
  write(own, 'notes.md', 'n\n');
  const head = commitAll(own, 'Ship the parser');
  const ws = byName(scan(vault));
  for (const name of ['no-next', 'own']) {
    assert.deepEqual(ws[name].next, { text: null, source: 'derived', from: null }, name);
  }
  assert.equal(ws['no-next'].lastEvent.subject, 'vault backup: 2026-10-09 11:30:00', 'the commit is still the last event');
  assert.equal(ws.own.lastEvent.subject, 'Ship the parser');
  assert.equal(ws.own.lastEvent.hash, head);
});

test('computeInputHash is stable for equal inputs and changes on edit', () => {
  const base = { status: 'active', summary: 's', objectives: [{ text: 'a' }], subprojects: [{ name: 'x', status: null }], next: { text: 'n' }, lastEvent: { ageDays: 1 } };
  const h1 = computeInputHash(base);
  const h2 = computeInputHash(JSON.parse(JSON.stringify(base)));
  assert.equal(h1, h2);
  const changed = { ...base, summary: 'different' };
  assert.notEqual(h1, computeInputHash(changed));
});

const { extractNext } = require('../collectors/workspaces');

test('extractNext reads the first bullet under Next / What\'s Next / TODO', () => {
  assert.equal(extractNext('## Next\n- Do the first thing\n- second'), 'Do the first thing');
  assert.equal(extractNext("### What's Next\n- Ship it"), 'Ship it');
  assert.equal(extractNext("## What’s Next\n- Smart-quoted"), 'Smart-quoted');
  assert.equal(extractNext('## TODO\n- Fix the bug'), 'Fix the bug');
  assert.equal(extractNext('# Title\nno next section here'), null);
  assert.equal(extractNext('## Next step\n\n- \n'), null, 'the stub\'s empty bullet');
  assert.equal(extractNext('## Next\n- [x] Done already\n- [ ] Then `this`'), 'Then this');
});

// ── spaces-redesign D11: the automatic status ────────────────────
test('statusFromActivity: active within activeDays, stalled with a plan after that, idle after idleDays or with no plan', () => {
  const cfg = { activeDays: 7, idleDays: 30 };
  assert.equal(W.statusFromActivity(0, false, cfg), 'active');
  assert.equal(W.statusFromActivity(6, false, cfg), 'active', 'activity makes a workspace active, plan or not');
  assert.equal(W.statusFromActivity(7, true, cfg), 'stalled');
  assert.equal(W.statusFromActivity(29, true, cfg), 'stalled');
  assert.equal(W.statusFromActivity(30, true, cfg), 'idle');
  assert.equal(W.statusFromActivity(7, false, cfg), 'idle', 'nothing planned');
  assert.equal(W.statusFromActivity(null, true, cfg), 'idle', 'no activity at all');
  assert.equal(W.statusFromActivity(3, true, { activeDays: 3, idleDays: 5 }), 'stalled');
  assert.equal(W.statusFromActivity(5, true, { activeDays: 3, idleDays: 5 }), 'idle');
});

test('finalizeWorkspaces: status from sessions and plans; the override wins and stays; document mtimes never count', () => {
  const vault = tmpVault('d11');
  write(vault, 'workspaces/busy/README.md', '# Busy\n\nWorked on daily.\n');
  write(vault, 'workspaces/planned/PLAN.md', '# Plan\n\n## Next\n\n- Write the parser\n');
  write(vault, 'workspaces/goals/README.md', '# Targets\n\n## Objectives\n\n- [x] First\n- [ ] Second\n');
  write(vault, 'workspaces/all-done/README.md', '# Done\n\n## Objectives\n\n- [x] First\n');
  write(vault, 'workspaces/old/PLAN.md', '# Plan\n\n## Next\n\n- Revisit\n');
  write(vault, 'workspaces/fresh-files/PLAN.md', '# Plan\n\n## Next\n\n- Just written\n');
  write(vault, 'workspaces/held/workspace.md', '---\nstatus: on hold\n---\n');
  write(vault, 'workspaces/shipped/workspace.md', '---\nstatus: shipped\n---\n');
  write(vault, 'workspaces/wip/workspace.md', '---\nstatus: wip\n---\n');
  const s = (lastAt, recent) => ({ claude: 1, codex: 0, total: 1, lastAt, ...(recent ? { recent } : {}) });
  const ws = byName(scan(vault, {
    sessions: {
      busy: s(daysAgo(2)), planned: s(daysAgo(10)), goals: s(daysAgo(10)), 'all-done': s(daysAgo(10)), old: s(daysAgo(40)),
      held: s(daysAgo(0)), shipped: s(daysAgo(1)), wip: s(null, [{ id: 'x', lastAt: daysAgo(3) }]),
    },
  }));
  assert.equal(ws.busy.status, 'active');
  assert.deepEqual(ws.busy.activity, { at: daysAgo(2), ageDays: 2, from: 'session' });
  assert.equal(ws.planned.status, 'stalled', 'a next step but nothing for 7+ days');
  assert.equal(ws.goals.status, 'stalled', 'an open objective is a plan');
  assert.deepEqual(ws.goals.objectives.map((o) => [o.text, o.done]), [['First', true], ['Second', false]]);
  assert.equal(ws['all-done'].status, 'idle', 'every objective ticked: nothing planned');
  assert.equal(ws.old.status, 'idle', 'nothing for idleDays');
  assert.equal(ws['fresh-files'].status, 'idle', 'files written just now are not activity');
  assert.deepEqual(ws['fresh-files'].activity, { at: null, ageDays: null, from: null });
  assert.equal(ws.held.statusAuto, 'active');
  assert.equal(ws.held.statusOverride, 'paused');
  assert.equal(ws.held.status, 'paused', 'the override stays paused while sessions run');
  assert.equal(ws.held.statusSource, 'manifest');
  assert.equal(ws.shipped.status, 'done');
  assert.equal(ws.wip.statusOverride, null, 'an unknown word is ignored');
  assert.equal(ws.wip.status, 'active', 'a recent row counts as a session too');
  for (const w of Object.values(ws)) assert.equal(typeof w.inputHash, 'string');
  // The thresholds are config.
  const tight = byName(scan(vault, { cfg: { workspaces: { activeDays: 1, idleDays: 5 } }, sessions: { busy: s(daysAgo(2)), planned: s(daysAgo(4)) } }));
  assert.equal(tight.busy.status, 'idle', 'no plan, and past activeDays');
  assert.equal(tight.planned.status, 'stalled');
});

test('finalizeWorkspaces sorts pinned first, then active, stalled, idle, paused, done, then newest activity; hidden last', () => {
  const vault = tmpVault('sort');
  const plan = '# P\n\n## Next\n\n- Do it\n';
  write(vault, 'workspaces/a-idle/README.md', '# A\n\nIdle.\n');
  write(vault, 'workspaces/b-active-old/README.md', '# B\n\nB.\n');
  write(vault, 'workspaces/c-active-new/README.md', '# C\n\nC.\n');
  write(vault, 'workspaces/d-stalled/PLAN.md', plan);
  write(vault, 'workspaces/e-paused/workspace.md', '---\nstatus: paused\n---\n');
  write(vault, 'workspaces/f-done/workspace.md', '---\nstatus: done\n---\n');
  write(vault, 'workspaces/g-pinned-idle/workspace.md', '---\npinned: true\n---\n');
  write(vault, 'workspaces/_hidden/README.md', '# H\n\nH.\n');
  const s = (n) => ({ claude: 1, codex: 0, total: 1, lastAt: daysAgo(n) });
  const list = scan(vault, { sessions: { 'b-active-old': s(5), 'c-active-new': s(1), 'd-stalled': s(10), 'e-paused': s(0), 'f-done': s(0), _hidden: s(0) } });
  assert.deepEqual(list.map((w) => w.name), ['g-pinned-idle', 'c-active-new', 'b-active-old', 'd-stalled', 'a-idle', 'e-paused', 'f-done', '_hidden']);
  assert.equal(list[0].status, 'idle', 'pinning sorts; it never changes the status');
});

// ── spaces-redesign D22: hidden and archived ─────────────────────
test('`_` folders are hidden, _archive/ children are hidden entries keyed _archive/<n>, and _worktrees gets no entry', () => {
  const vault = tmpVault('hidden');
  write(vault, 'workspaces/alpha/README.md', '# Alpha\n\nThe alpha project.\n');
  write(vault, 'workspaces/_spikes/x/notes.md', 'n\n');
  write(vault, 'workspaces/_archive/old/workspace.md', '---\narchived: 2026-09-30\nsummary: An old one\n---\n');
  write(vault, 'workspaces/_archive/plain/README.md', '# Plain\n\nNo manifest.\n');
  write(vault, 'workspaces/_archive/.DS_Store', '');
  write(vault, 'workspaces/_worktrees/team/item/member/README.md', '# Seat\n\nA seat.\n');
  write(vault, 'workspaces/.obsidian/x.json', '{}');
  const list = scan(vault);
  assert.deepEqual(list.map((w) => w.name), ['alpha', '_archive/old', '_archive/plain', '_spikes']);
  const ws = byName(list);
  assert.deepEqual([ws.alpha.hidden, ws.alpha.hiddenReason, ws.alpha.archived, ws.alpha.label], [false, null, false, 'alpha']);
  assert.deepEqual([ws._spikes.hidden, ws._spikes.hiddenReason, ws._spikes.archived], [true, 'underscore', false]);
  const old = ws['_archive/old'];
  assert.deepEqual([old.hidden, old.hiddenReason, old.label, old.path, old.archived], [true, 'archived', 'old', 'workspaces/_archive/old', '2026-09-30']);
  assert.equal(old.absPath, path.join(vault, 'workspaces', '_archive', 'old'));
  assert.equal(old.summary, 'An old one');
  assert.equal(ws['_archive/plain'].archived, true, 'archived with no date in its manifest');
});

test('an alias naming another live workspace is dropped; a former name is kept, absolute', () => {
  const vault = tmpVault('alias');
  write(vault, 'workspaces/new-name/workspace.md', '---\naliases:\n  - workspaces/old-name\n  - workspaces/other\n  - ~/Code/app\n---\n');
  write(vault, 'workspaces/other/README.md', '# Other\n\nOther.\n');
  const home = path.join(ROOT, 'home');
  const ws = byName(scan(vault, { home }));
  assert.deepEqual(ws['new-name'].aliases, [path.join(vault, 'workspaces', 'old-name'), path.join(home, 'Code', 'app')]);
  assert.deepEqual(ws.other.aliases, []);
});

// ── spaces-redesign D23: templates, handoffs, next ───────────────
test('the stubs `aos workspace new` writes give summary null and summaryTemplate true, and no objective or next', () => {
  const { stubs } = require('../../../cli/workspace.js');
  const vault = tmpVault('stubs');
  for (const [f, text] of Object.entries(stubs('tide-chart'))) write(vault, `workspaces/tide-chart/${f}`, text);
  write(vault, 'workspaces/claude-stub/CLAUDE.md', stubs('claude-stub')['CLAUDE.md']);
  write(vault, 'workspaces/a.b_c/AGENTS.md', stubs('a.b_c')['AGENTS.md']);
  for (const [f, text] of Object.entries(stubs('real'))) write(vault, `workspaces/real/${f}`, text);
  write(vault, 'workspaces/real/STATUS.md', '# Status\n\nThe parser works.\n');
  write(vault, 'workspaces/manifest-stub/workspace.md', '---\nsummary: One line about what this project is.\n---\n');
  const ws = byName(scan(vault));
  for (const name of ['tide-chart', 'claude-stub', 'a.b_c', 'manifest-stub']) {
    assert.equal(ws[name].summary, null, name);
    assert.equal(ws[name].summaryTemplate, true, name);
  }
  assert.deepEqual(ws['tide-chart'].objectives, []);
  assert.deepEqual(ws['tide-chart'].next, { text: null, source: 'derived', from: null });
  assert.equal(ws['tide-chart'].status, 'idle');
  assert.equal(ws.real.summary, 'The parser works.');
  assert.equal(ws.real.summaryTemplate, false);
  assert.equal(W.isTemplateText('This is the `workspaces/x/` workspace of an AgenticOS vault. Project notes, plans and status live here;'), true);
  assert.equal(W.isTemplateText('This is the workspaces/x/ workspace of an AgenticOS vault.'), true);
  assert.equal(W.isTemplateText('A real line.'), false);
  assert.deepEqual([...W.TEMPLATE_TEXT], ['One line about what this project is.', 'This is the `workspaces/<slug>/` workspace of an AgenticOS vault.']);
});

test('parseHandoff: Now is the first line under Now or Resume here, Next the first open bullet, asOf the heading\'s date', () => {
  assert.deepEqual(W.parseHandoff([
    '# Handoff: the parser, 2026-10-01', '', '## Goal', '', 'Parse things.', '', '## Now (2026-10-05, read this first)', '',
    '> **PR 2** is open; CI is green.', '', '## Next: phase 2', '', 'Some intro.', '', '```', '- not a bullet', '```', '- [x] Done already', '1. Merge `PR 2`', '- later',
  ].join('\n')), { now: 'PR 2 is open; CI is green.', next: 'Merge PR 2', asOf: '2026-10-05', nextHeading: 'Next: phase 2' });
  assert.deepEqual(W.parseHandoff('# Handoff (written 2026-10-07)\n\n## RESUME HERE\n\n- Release 1.3\n\n## What\'s next\n\n- Check the update\n'),
    { now: 'Release 1.3', next: 'Check the update', asOf: '2026-10-07', nextHeading: "What's next" });
  assert.deepEqual(W.parseHandoff('# H\n\n## PR 2\n\n### Remaining work, in order\n\n1. Push it\n'),
    { now: null, next: 'Push it', asOf: null, nextHeading: 'Remaining work, in order' });
  assert.deepEqual(W.parseHandoff('# H\n\n## Nowhere\n\ntext\n\n## Nextcloud\n\n- x\n'), { now: null, next: null, asOf: null, nextHeading: null });
  assert.deepEqual(W.parseHandoff('## Now\n\n## Next\n\n- \n'), { now: null, next: null, asOf: null, nextHeading: null }, 'an empty section and an empty bullet');
  assert.deepEqual(W.parseHandoff(''), { now: null, next: null, asOf: null, nextHeading: null });
});

test('the newest top-level HANDOFF*.md feeds handoff and next; the next chain is manifest, handoff, a Next heading, then empty', () => {
  const vault = tmpVault('handoff');
  const dir = path.join(vault, 'workspaces', 'proj');
  write(vault, 'workspaces/proj/HANDOFF-old.md', '# Old\n\n## Now\n\nStale.\n\n## Next\n\n- Stale next\n');
  write(vault, 'workspaces/proj/HANDOFF-proj.md', '# Handoff: proj, 2026-10-01\n\n## Now (2026-10-08)\n\nPR 2 is open.\n\n## Next: phase 2\n\n- Merge PR 2\n');
  write(vault, 'workspaces/proj/PLAN.md', '# Plan\n\n## Next\n\n- From the plan\n');
  write(vault, 'workspaces/proj/sub/HANDOFF-deep.md', '# Deep\n\n## Now\n\nNot top-level.\n');
  fs.utimesSync(path.join(dir, 'HANDOFF-old.md'), new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
  fs.utimesSync(path.join(dir, 'HANDOFF-proj.md'), new Date(NOW - DAY), new Date(NOW - DAY));
  let w = byName(scan(vault)).proj;
  assert.deepEqual(w.handoff, { file: 'HANDOFF-proj.md', now: 'PR 2 is open.', next: 'Merge PR 2', asOf: '2026-10-08', mtime: new Date(NOW - DAY).toISOString() });
  assert.deepEqual(w.next, { text: 'Merge PR 2', source: 'derived', from: 'HANDOFF-proj.md › Next: phase 2' });
  assert.equal(w.docs[0].name, 'HANDOFF-proj.md', 'a dated handoff ranks where HANDOFF.md does');
  assert.equal(w.status, 'idle', 'a plan, but no activity at all');
  write(vault, 'workspaces/proj/workspace.md', '---\nnext: From the manifest\n---\n');
  w = byName(scan(vault)).proj;
  assert.deepEqual(w.next, { text: 'From the manifest', source: 'manifest', from: 'workspace.md' });
  fs.unlinkSync(path.join(dir, 'workspace.md'));
  fs.unlinkSync(path.join(dir, 'HANDOFF-old.md'));
  fs.writeFileSync(path.join(dir, 'HANDOFF-proj.md'), '# Handoff\n\n## Now\n\nOnly a now line.\n');
  w = byName(scan(vault)).proj;
  assert.equal(w.handoff.now, 'Only a now line.');
  assert.equal(w.handoff.next, null);
  assert.deepEqual(w.next, { text: 'From the plan', source: 'derived', from: 'PLAN.md › Next' });
});

test('docs carry mtime, note (description, else the first body line) and done (status word, or every box ticked)', () => {
  const vault = tmpVault('docs');
  write(vault, 'workspaces/d/STATUS.md', '---\ndescription: Where it stands\n---\n# Status\n\nBody.\n');
  write(vault, 'workspaces/d/PLAN.md', '# Plan\n\n- [x] One\n- [x] Two\n');
  write(vault, 'workspaces/d/PROGRESS.md', '# Progress\n\n- [x] One\n- [ ] Two\n');
  write(vault, 'workspaces/d/OLD.md', '---\nstatus: superseded\n---\nReplaced.\n');
  write(vault, 'workspaces/m/workspace.md', '---\ndocuments:\n  - notes/a.md\n  - specs/\n  - ../d/STATUS.md\n---\n');
  write(vault, 'workspaces/m/notes/a.md', '# A\n\nThe A note.\n');
  write(vault, 'workspaces/m/specs/x.md', 'x\n');
  const ws = byName(scan(vault));
  const docs = Object.fromEntries(ws.d.docs.map((d) => [d.name, d]));
  assert.deepEqual(ws.d.docs.map((d) => d.name), ['STATUS.md', 'PLAN.md', 'PROGRESS.md', 'OLD.md']);
  assert.deepEqual([docs['STATUS.md'].note, docs['STATUS.md'].done], ['Where it stands', false]);
  assert.deepEqual([docs['PLAN.md'].note, docs['PLAN.md'].done], ['[x] One', true]);
  assert.equal(docs['PROGRESS.md'].done, false);
  assert.equal(docs['OLD.md'].done, true);
  assert.ok(ws.d.docs.every((d) => !Number.isNaN(Date.parse(d.mtime))));
  const m = Object.fromEntries(ws.m.docs.map((d) => [d.name, d]));
  assert.equal(m['a.md'].note, 'The A note.');
  assert.equal(m['specs/'].note, null);
  assert.ok(m['specs/'].mtime);
  assert.deepEqual([m['STATUS.md'].mtime, m['STATUS.md'].note], [null, null], 'a path out of the workspace is listed, never read');
});

test('a symlinked workspace.md, README.md or HANDOFF*.md is never read, even when it points inside the workspace', () => {
  const vault = tmpVault('links');
  const outside = path.join(ROOT, `outside-${++seq}`);
  write(outside, 'workspace.md', '---\npinned: true\nsummary: From outside\nnext: Outside next\n---\n');
  write(outside, 'README.md', '# Secret\n\nA private line.\n');
  write(outside, 'HANDOFF-x.md', '# H\n\n## Now\n\nPrivate now.\n\n## Next\n\n- Private next\n');
  write(vault, 'workspaces/linked/notes.md', '# Notes\n\nInside.\n');
  const dir = path.join(vault, 'workspaces', 'linked');
  for (const f of ['workspace.md', 'README.md', 'HANDOFF-x.md']) fs.symlinkSync(path.join(outside, f), path.join(dir, f));
  fs.symlinkSync(path.join(dir, 'notes.md'), path.join(dir, 'STATUS.md'));
  write(vault, 'workspaces/subs/workspace.md', '---\nsubprojects:\n  - sub\n  - { name: up, path: ../linked }\n---\n');
  fs.symlinkSync(outside, path.join(vault, 'workspaces', 'subs', 'sub'));
  const ws = byName(scan(vault));
  const w = ws.linked;
  assert.equal(w.pinned, false);
  assert.equal(w.summary, null, 'STATUS.md and README.md are links, the second to a file inside');
  assert.equal(w.handoff, null);
  assert.deepEqual(w.next, { text: null, source: 'derived', from: null });
  assert.deepEqual(w.docs.map((d) => d.name), ['notes.md'], 'a linked document is not listed');
  assert.deepEqual(ws.subs.subprojects.map((x) => [x.name, x.summary]), [['sub', null], ['up', null]], 'never through a linked folder or out of the workspace');
  const all = JSON.stringify(scan(vault));
  for (const s of ['From outside', 'A private line', 'Private now', 'Private next', 'Outside next']) assert.equal(all.includes(s), false, s);
});

// ── spaces-redesign D24, D11/A2: git and what counts as activity ──
test('git state and commits: the workspace\'s own repo, its repo: folder, and a folder the vault\'s git tracks', () => {
  const vault = newRepo(tmpVault('git'));
  write(vault, 'workspaces/tracked/notes.md', 'n\n');
  write(vault, 'workspaces/tracked/PLAN.md', '# P\n\n## Next\n\n- Go\n');
  const first = commitAll(vault, 'Add tracked', daysAgo(20));
  write(vault, 'workspaces/tracked/notes.md', 'edited\n');
  commitAll(vault, 'vault backup: 2026-10-08 10:00:00', daysAgo(1));
  const own = newRepo(path.join(vault, 'workspaces', 'own'));
  write(own, 'a.md', 'a\n');
  const ownHead = commitAll(own, 'First commit', daysAgo(3));
  write(own, 'b.md', 'dirty\n');
  const code = newRepo(path.join(ROOT, `code-${++seq}`));
  write(code, 'x.js', '1\n');
  commitAll(code, 'Start', daysAgo(12));
  write(code, 'x.js', '2\n');
  const codeHead = commitAll(code, 'Second', daysAgo(9));
  write(vault, 'workspaces/linked/workspace.md', `---\nrepo: ${code}\n---\n`);
  write(vault, 'workspaces/linked/PLAN.md', '# P\n\n## Next\n\n- Go\n');
  write(vault, 'workspaces/loose/README.md', '# Loose\n\nUntracked.\n');
  const ws = byName(scan(vault));

  assert.deepEqual(ws.own.git, { kind: 'repo', branch: 'main', detached: false, head: ownHead, upstream: null, ahead: null, behind: null, dirty: 1, remotes: [] });
  assert.deepEqual(ws.own.commits.map((c) => [c.hash, c.subject]), [[ownHead, 'First commit']]);
  assert.deepEqual(ws.own.activity, { at: daysAgo(3), ageDays: 3, from: 'commit' });
  assert.equal(ws.own.status, 'active');

  assert.equal(ws.linked.repoPath, path.resolve(code));
  assert.equal(ws.linked.git.kind, 'repo');
  assert.equal(ws.linked.git.head, codeHead);
  assert.deepEqual(ws.linked.commits.map((c) => c.subject), ['Second', 'Start']);
  assert.deepEqual(ws.linked.activity, { at: daysAgo(9), ageDays: 9, from: 'commit' });
  assert.equal(ws.linked.status, 'stalled');

  assert.deepEqual(ws.tracked.git, { kind: 'vault' });
  assert.deepEqual(ws.tracked.commits.map((c) => [c.hash, c.subject]), [[first, 'Add tracked']], 'backups are left out');
  assert.deepEqual(ws.tracked.activity, { at: daysAgo(1), ageDays: 1, from: 'commit' }, 'a backup that edits a file there counts');

  assert.equal(ws.loose.git, null);
  assert.deepEqual(ws.loose.commits, []);
  assert.deepEqual(byName(scan(vault, { cfg: { workspaces: { commits: 1 } } })).linked.commits.map((c) => c.subject), ['Second']);
  assert.deepEqual(byName(scan(vault, { cfg: { workspaces: { commits: 0 } } })).own.commits, []);
});

test('a vault-tracked folder: backups count only when they add or modify a file the verbs do not write, and moves never count (A2)', () => {
  const vault = newRepo(tmpVault('a2'));
  const plan = '# P\n\n## Next\n\n- Go on\n';
  for (const n of ['hand', 'pin', 'stub', 'work', 'before']) {
    write(vault, `workspaces/${n}/notes.md`, 'n\n');
    write(vault, `workspaces/${n}/PLAN.md`, plan);
  }
  write(vault, 'workspaces/_archive/back/notes.md', 'n\n');
  write(vault, 'workspaces/_archive/back/PLAN.md', plan);
  commitAll(vault, 'vault backup: 2026-08-10 10:00:00', daysAgo(60));
  const before = W.finalizeWorkspaces(W.collectWorkspaces({ vault }), { vault, cfg: {}, now: NOW });
  assert.ok(before.filter((w) => !w.hidden).every((w) => w.status === 'idle'), 'all idle after 60 days');

  write(vault, 'workspaces/hand/workspace.md', '---\nsummary: Written by hand\n---\n');
  commitAll(vault, 'Describe hand', daysAgo(1));
  write(vault, 'workspaces/pin/workspace.md', '---\npinned: true\n---\n');
  commitAll(vault, 'vault backup: 2026-10-08 10:00:00', daysAgo(1));
  write(vault, 'workspaces/stub/README.md', '# Stub\n\nOne line about what this project is.\n');
  write(vault, 'workspaces/stub/CLAUDE.md', 'stub\n');
  commitAll(vault, 'vault backup: 2026-10-08 10:30:00', daysAgo(1));
  git(vault, ['mv', 'workspaces/before', 'workspaces/renamed']);
  git(vault, ['mv', 'workspaces/_archive/back', 'workspaces/back']);
  commitAll(vault, 'vault backup: 2026-10-08 11:00:00', daysAgo(1));
  write(vault, 'workspaces/work/notes.md', 'edited outside any session\n');
  write(vault, 'workspaces/work/new.md', 'added\n');
  commitAll(vault, 'vault backup: 2026-10-08 11:30:00', daysAgo(1));

  const ws = byName(scan(vault));
  assert.equal(ws.hand.status, 'active', 'a commit that is not a backup counts, even on workspace.md alone');
  assert.equal(ws.hand.activity.at, daysAgo(1));
  assert.equal(ws.pin.pinned, true);
  assert.equal(ws.pin.status, 'idle', 'an idle workspace pinned and rescanned stays idle');
  assert.equal(ws.pin.activity.at, daysAgo(60));
  assert.equal(ws.pin.git.kind, 'vault');
  assert.equal(ws.pin.commits.length, 0, 'every commit there is a backup');
  assert.equal(ws.stub.status, 'idle', 'a backup writing only the stubs');
  assert.equal(ws.renamed.status, 'idle', 'Rename moved the folder; nothing changed');
  assert.deepEqual(ws.renamed.activity, { at: null, ageDays: null, from: null });
  assert.equal(ws.back.status, 'idle', 'Restore moved the folder back; nothing changed');
  assert.equal(ws.work.status, 'active', 'a backup that adds or modifies another file counts');
  assert.equal(ws.work.activity.from, 'commit');
  assert.equal(ws.pin.name, scan(vault)[0].name, 'pinned sorts first');
});

test('no git call obeys repo config that runs a program, through the collector (spec §6)', () => {
  const vault = tmpVault('hostile');
  const repo = newRepo(path.join(vault, 'workspaces', 'hostile'));
  write(repo, 'notes.md', 'n\n');
  commitAll(repo, 'first');
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
  const parent = git(repo, ['rev-parse', 'HEAD']).trim();
  const body = `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> 1700000000 +0000\ncommitter t <t@example.com> 1700000000 +0000\n`
    + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEabc\n =abcd\n -----END PGP SIGNATURE-----\n\nsigned\n';
  const signed = path.join(vault, 'signed.txt');
  fs.writeFileSync(signed, body);
  const oid = git(repo, ['hash-object', '-t', 'commit', '-w', signed]).trim();
  git(repo, ['update-ref', 'refs/heads/main', oid]);
  write(repo, 'dirty.md', 'untracked\n');
  const marker = (n) => path.join(vault, `marker-${n}`);
  for (const n of ['fsmonitor', 'gpg']) fs.writeFileSync(path.join(vault, `${n}.sh`), `#!/bin/sh\ntouch "${marker(n)}"\nexit 1\n`, { mode: 0o755 });
  git(repo, ['config', 'core.fsmonitor', path.join(vault, 'fsmonitor.sh')]);
  git(repo, ['config', 'gpg.program', path.join(vault, 'gpg.sh')]);
  git(repo, ['config', 'log.showSignature', 'true']);
  execFileSync('git', ['status', '--porcelain=v2'], { cwd: repo, stdio: 'ignore' });
  try { execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, stdio: 'ignore' }); } catch { /* the fake gpg fails */ }
  assert.ok(fs.existsSync(marker('fsmonitor')) && fs.existsSync(marker('gpg')), 'the control ran both programs');
  for (const n of ['fsmonitor', 'gpg']) fs.unlinkSync(marker(n));
  const w = byName(scan(vault)).hostile;
  assert.equal(w.git.kind, 'repo');
  assert.equal(w.git.dirty, 1);
  assert.equal(w.commits[0].subject, 'signed');
  assert.equal(w.lastEvent.subject, 'signed');
  assert.equal(fs.existsSync(marker('fsmonitor')), false, 'core.fsmonitor never ran');
  assert.equal(fs.existsSync(marker('gpg')), false, 'gpg.program never ran');
});

test('the scan runs no filter driver a workspace repository defines and makes no lazy fetch (spec §6)', () => {
  const vault = tmpVault('hostile2');
  const marker = (n) => path.join(vault, `marker-${n}`);
  const script = (n, body) => {
    const file = path.join(vault, `${n}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker(n)}"\n${body}\n`, { mode: 0o755 });
    return file;
  };
  // A clean filter named through .git/info/attributes, with a tracked file whose stat no longer matches the index.
  const filtered = newRepo(path.join(vault, 'workspaces', 'filtered'));
  write(filtered, 'a.txt', 'a\n');
  commitAll(filtered, 'first');
  git(filtered, ['config', 'filter.evil.clean', script('filter', 'cat')]);
  fs.writeFileSync(path.join(filtered, '.git', 'info', 'attributes'), '* filter=evil\n');
  // A partial clone missing a tree, its promisor remote fetched through core.sshCommand.
  const lazy = newRepo(path.join(vault, 'workspaces', 'lazy'));
  write(lazy, 'sub/a.txt', 'a\n');
  commitAll(lazy, 'first');
  const tree = git(lazy, ['rev-parse', 'HEAD:sub']).trim();
  for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', 'ssh://example.invalid/x.git'],
    ['remote.origin.promisor', 'true'], ['core.sshCommand', script('ssh', 'exit 1')], ['protocol.ssh.allow', 'always']]) git(lazy, ['config', k, v]);
  fs.rmSync(path.join(lazy, '.git', 'objects', tree.slice(0, 2), tree.slice(2)), { force: true });
  fs.rmSync(path.join(lazy, '.git', 'index'), { force: true });
  const stale = () => { const t = new Date(Date.now() - 3600 * 1000); fs.utimesSync(path.join(filtered, 'a.txt'), t, t); };
  // Control: plain git runs both.
  stale();
  execFileSync('git', ['status', '--porcelain=v2'], { cwd: filtered, stdio: 'ignore' });
  const env = { ...process.env };
  delete env.GIT_SSH_COMMAND;
  try { execFileSync('git', ['status', '--porcelain=v2'], { cwd: lazy, env, stdio: 'ignore' }); } catch { /* the fetch fails */ }
  assert.ok(fs.existsSync(marker('filter')) && fs.existsSync(marker('ssh')), 'the control ran both programs');
  for (const n of ['filter', 'ssh']) fs.unlinkSync(marker(n));
  stale();
  const ws = byName(scan(vault));
  assert.equal(ws.filtered.git.kind, 'repo');
  assert.equal(ws.filtered.git.dirty, 0);
  assert.ok(ws.lazy, 'the partial clone is still listed');
  assert.equal(fs.existsSync(marker('filter')), false, 'filter.evil.clean never ran');
  assert.equal(fs.existsSync(marker('ssh')), false, 'core.sshCommand never ran');
});

// ── workspace hub D1: AGENTS.md is a project marker and a source ────────────────────────────────
test('detectChildren counts an AGENTS.md-only directory as a project and summarises it from AGENTS.md', () => {
  const abs = path.join(FIXTURES, 'collection-agents');
  const res = detectChildren(abs, 'workspaces/collection-agents');
  assert.equal(res.isCollection, true);
  assert.deepEqual(res.subprojects.map((s) => s.name), ['ProjectC', 'ProjectD']);
  assert.equal(res.subprojects[0].summary, 'A Codex-shaped project described only by AGENTS.md.');
});

test('collectWorkspaces reads summary, objectives and next from AGENTS.md when CLAUDE.md is absent', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-agents-'));
  fs.mkdirSync(path.join(vault, 'workspaces', 'codex-proj'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'collection-agents', 'ProjectC', 'AGENTS.md'), path.join(vault, 'workspaces', 'codex-proj', 'AGENTS.md'));
  const [ws] = collectWorkspaces({ vault });
  assert.equal(ws.name, 'codex-proj');
  assert.equal(ws.summary, 'A Codex-shaped project described only by AGENTS.md.');
  assert.deepEqual(ws.objectives.map((o) => o.text), ['Ship the thing', 'Measure it']);
  assert.equal(ws.next.text, 'Write the plan');
  assert.equal(ws.absPath, path.join(vault, 'workspaces', 'codex-proj'));
});

test('parseManifest reads repo:, and repoPath keeps only an absolute folder outside the vault (spec 2026-10-08 T8)', () => {
  const { repoPath } = require('../collectors/workspaces');
  assert.equal(parseManifest('---\nstatus: active\nrepo: "~/Code/app"\n---\n').repo, '~/Code/app');
  const home = path.join(path.sep, 'h');
  const vault = path.join(home, 'Vault');
  assert.equal(repoPath('~/Code/app', vault, home), path.join(home, 'Code', 'app'));
  assert.equal(repoPath('/opt/src/app', vault, home), path.resolve('/opt/src/app'));
  assert.equal(repoPath('Code/app', vault, home), null);
  assert.equal(repoPath(path.join(vault, 'workspaces', 'x'), vault, home), null);
  assert.equal(repoPath(vault, vault, home), null);
  assert.equal(repoPath(null, vault, home), null);
});

test('collectWorkspaces records a linked code folder as repoPath, after the insight hash', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-repo-'));
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-code-'));
  fs.mkdirSync(path.join(vault, 'workspaces', 'linked'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'workspaces', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'workspaces', 'linked', 'workspace.md'), `---\nstatus: active\nrepo: ${code}\n---\n`);
  fs.writeFileSync(path.join(vault, 'workspaces', 'plain', 'workspace.md'), '---\nstatus: active\n---\n');
  const ws = W.finalizeWorkspaces(collectWorkspaces({ vault }), { vault, cfg: {}, now: NOW });
  const linked = ws.find((w) => w.name === 'linked');
  const plain = ws.find((w) => w.name === 'plain');
  assert.equal(linked.repoPath, path.resolve(code));
  assert.equal('repoPath' in plain, false);
  assert.equal(typeof linked.inputHash, 'string');
  assert.equal(linked.inputHash, plain.inputHash, 'neither the path nor the code folder is a hash input');
});
