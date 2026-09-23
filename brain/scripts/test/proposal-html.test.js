'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const P = require('../persona/proposal-html.js');

const NOW = new Date('2026-09-22T12:00:00.000Z');
const TITLED = `---
slug: trim-playbook
filed: 2026-09-18
kind: product
surface: brain
target: brain/scripts/persona/playbook.js
recheck: "grep -q x persona/playbook.md"
---

# Trim the playbook

Context before the sections.

## What
Remove <script>alert(1)</script> and **keep** the rest.

## Why
Evidence.

## Risk
Low.

## Premises
| Premise | Status | Evidence |
|---|---|---|
| the file exists | VERIFIED | \`ls\` on 2026-09-18 |
| nobody reads it | ASSUMED | a guess |
`;
const UNTITLED = `---
slug: fix-monitor
filed: 2026-09-20
target: duties/monitor.md (guarded)
---
## What
change x
`;

function vault(files = { '2026-09-18-trim-playbook.md': TITLED, '2026-09-20-fix-monitor.md': UNTITLED }) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-html-'));
  const dir = path.join(v, 'persona', 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Proposals\n');
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  return v;
}
const md = (v, n) => path.join(v, 'persona', 'proposals', n);
const url = (v, n) => pathToFileURL(P.pagePath(v, n)).href;

test('withLinkLine: goes after the title, else first in the body; replaced in place; a no-op when already right', () => {
  const titled = P.withLinkLine(TITLED, 'file:///v/a.html');
  assert.match(titled, /\n# Trim the playbook\n\n\*\*\[Open the proposal in browser\]\(file:\/\/\/v\/a\.html\)\*\*\n\nContext before the sections\.\n\n## What\n/);
  assert.equal(P.withLinkLine(titled, 'file:///v/a.html'), titled);
  assert.equal(P.withLinkLine(titled, 'file:///w/a.html'), titled.replace('file:///v/a.html', 'file:///w/a.html'));
  const untitled = P.withLinkLine(UNTITLED, 'file:///v/b.html');
  assert.equal(untitled, UNTITLED.replace('---\n## What', '---\n**[Open the proposal in browser](file:///v/b.html)**\n\n## What'));
  const extra = P.withLinkLine('# T\n\n**[Open the proposal in browser](file:///old.html)** · [copy](https://a.example)\n\n## What\nx\n', 'file:///new.html');
  assert.equal(extra, '# T\n\n**[Open the proposal in browser](file:///new.html)** · [copy](https://a.example)\n\n## What\nx\n');
  assert.equal(P.withLinkLine('## What\nx\n', 'file:///c.html'), '**[Open the proposal in browser](file:///c.html)**\n\n## What\nx\n');
});

test('renderPage: title, header facts, escaped body, premise pills, a no-script CSP', () => {
  const html = P.renderPage({ name: '2026-09-18-trim-playbook.md', text: TITLED, file: '/v/persona/proposals/2026-09-18-trim-playbook.md', now: NOW });
  assert.match(html, /<title>Trim the playbook<\/title>/);
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
  assert.match(html, /<span class="pill kind">product<\/span> · surface brain · filed 2026-09-18 · trim-playbook/);
  assert.match(html, /<dt>Decision<\/dt><dd>Accept \(kept in the backlog\) or dismiss<\/dd>/);
  assert.match(html, /<code>grep -q x persona\/playbook\.md<\/code>/);
  assert.match(html, /<div class="intro"><p>Context before the sections\.<\/p><\/div>/);
  assert.match(html, /Remove &lt;script&gt;alert\(1\)&lt;\/script&gt; and <strong>keep<\/strong>/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /1 verified · 1 assumed/);
  assert.match(html, /<span class="pill ok">VERIFIED<\/span>/);
  assert.match(html, /<a href="obsidian:\/\/open\?path=%2Fv%2Fpersona%2Fproposals%2F2026-09-18-trim-playbook\.md">Open in Obsidian<\/a>/);
  const plain = P.renderPage({ name: '2026-09-20-fix-monitor.md', text: UNTITLED, file: '/v/p.md', now: NOW });
  assert.match(plain, /<title>Fix monitor<\/title>/);
  assert.match(plain, /Approve \(applied exactly as written\) or reject/);
  assert.match(plain, /none — the review cannot re-verify it/);
});

test('render: links and renders every pending proposal once; a re-run touches nothing', () => {
  const v = vault();
  const r1 = P.render({ root: v, now: NOW });
  assert.deepEqual(r1, { schema: 1, rendered: ['2026-09-18-trim-playbook.md', '2026-09-20-fix-monitor.md'], linked: ['2026-09-18-trim-playbook.md', '2026-09-20-fix-monitor.md'], skipped: 0, errors: [] });
  assert.ok(fs.readFileSync(md(v, '2026-09-20-fix-monitor.md'), 'utf8').includes(`(${url(v, '2026-09-20-fix-monitor.md')})`));
  assert.ok(fs.existsSync(P.pagePath(v, '2026-09-18-trim-playbook.md')));
  assert.ok(!fs.existsSync(P.pagePath(v, 'README.md')));
  const before = fs.statSync(md(v, '2026-09-18-trim-playbook.md')).mtimeMs;
  assert.deepEqual(P.render({ root: v, now: NOW }), { schema: 1, rendered: [], linked: [], skipped: 2, errors: [] });
  assert.equal(fs.statSync(md(v, '2026-09-18-trim-playbook.md')).mtimeMs, before, 'an up-to-date file is never rewritten');
});

test('render: a page older than its Markdown or from an older renderer is redrawn; the page outlives its source', () => {
  const v = vault();
  P.render({ root: v, now: NOW });
  const page = P.pagePath(v, '2026-09-18-trim-playbook.md');
  const earlier = new Date(fs.statSync(md(v, '2026-09-18-trim-playbook.md')).mtimeMs - 60e3);
  fs.utimesSync(page, earlier, earlier);
  assert.deepEqual(P.render({ root: v, now: NOW }).rendered, ['2026-09-18-trim-playbook.md']);
  fs.writeFileSync(P.pagePath(v, '2026-09-20-fix-monitor.md'), '<meta name="aos-renderer" content="0">');
  assert.deepEqual(P.render({ root: v, now: NOW }).rendered, ['2026-09-20-fix-monitor.md']);
  fs.rmSync(md(v, '2026-09-18-trim-playbook.md'));
  P.render({ root: v, now: NOW });
  assert.ok(fs.existsSync(page), 'a decided proposal keeps its page');
});

test('render: no proposals folder is a no-op; a broken file is reported and the rest still render', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-html-empty-'));
  assert.deepEqual(P.render({ root: empty }), { schema: 1, rendered: [], linked: [], skipped: 0, errors: [] });
  const v = vault();
  const r = P.render({ root: v, files: [md(v, 'gone.md'), md(v, 'README.md'), md(v, '2026-09-20-fix-monitor.md')], now: NOW });
  assert.deepEqual(r.rendered, ['2026-09-20-fix-monitor.md']);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[1], /README\.md: not a proposal file/);
});

test('CLI: renders the named files or all of them, one JSON line; bad flags exit 2', () => {
  const v = vault();
  const io = () => { const o = { out: '', err: '' }; return { o, opts: { stdout: (s) => { o.out += s; }, stderr: (s) => { o.err += s; }, now: NOW } }; };
  let { o, opts } = io();
  assert.equal(P.main([md(v, '2026-09-20-fix-monitor.md'), '--root', v], opts), 0);
  assert.deepEqual(JSON.parse(o.out).rendered, ['2026-09-20-fix-monitor.md']);
  ({ o, opts } = io());
  assert.equal(P.main(['--root', v], opts), 0);
  assert.deepEqual(JSON.parse(o.out).rendered, ['2026-09-18-trim-playbook.md']);
  for (const bad of [['--root'], ['--root', '--x'], ['--force']]) {
    ({ o, opts } = io());
    assert.equal(P.main(bad, opts), 2);
    assert.match(o.err, /usage/);
  }
  ({ o, opts } = io());
  assert.equal(P.main([], opts), 0, 'without --root it renders the resolved vault (the test setup gives one with no proposals)');
  assert.equal(JSON.parse(o.out).rendered.length, 0);
});
