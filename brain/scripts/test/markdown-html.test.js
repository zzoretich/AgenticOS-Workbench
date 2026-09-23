'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toHtml, inline, safeHref } = require('../lib/markdown-html.js');

test('blocks: headings, paragraphs with soft breaks, rules, quotes', () => {
  assert.equal(toHtml('### Plan\n\nline one\nline two\n\n---\n\n> quoted **bold**'),
    '<h3>Plan</h3>\n<p>line one<br>\nline two</p>\n<hr>\n<blockquote><p>quoted <strong>bold</strong></p></blockquote>');
});

test('lists: ordered with a start number, a nested bullet list, tight items without <p>', () => {
  const html = toHtml('3. **first** item\n   - nested a\n   - nested b\n4. second');
  assert.equal(html, '<ol start="3">\n<li><strong>first</strong> item\n<ul>\n<li>nested a</li>\n<li>nested b</li>\n</ul></li>\n<li>second</li>\n</ol>');
});

test('lists: a blank line between items makes them loose; a new marker type starts a new list', () => {
  assert.equal(toHtml('- a\n\n- b'), '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>');
  assert.equal(toHtml('- a\n1. b'), '<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>');
});

test('tables: header, alignment, inline cells, escaped pipes; a table inside a list item', () => {
  assert.equal(toHtml('| A | B |\n|:--|--:|\n| `x` | a \\| b |'),
    '<div class="table"><table>\n<thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th></tr></thead>\n<tbody>\n<tr><td style="text-align:left"><code>x</code></td><td style="text-align:right">a | b</td></tr>\n</tbody>\n</table></div>');
  assert.match(toHtml('- item\n\n  | A | B |\n  |---|---|\n  | 1 | 2 |'), /<li><p>item<\/p>\n<div class="table"><table>/);
});

test('fences: code is escaped verbatim; a diff fence colours added, removed and hunk lines', () => {
  assert.equal(toHtml('```js\nif (a < b) **x**\n```'), '<pre class="lang-js"><code>if (a &lt; b) **x**</code></pre>');
  assert.equal(toHtml('```diff\n@@ -1 +1 @@\n-old\n+new\n same\n```'),
    '<pre class="lang-diff"><code><span class="hunk">@@ -1 +1 @@</span>\n<span class="del">-old</span>\n<span class="add">+new</span>\n same</code></pre>');
  assert.equal(toHtml('~~~~\nunclosed'), '<pre><code>unclosed</code></pre>');
});

test('inline: bold around a link, emphasis, code spans, snake_case left alone', () => {
  assert.equal(inline('**[Open](file:///tmp/a%20b.html)** · *em* and _em_ in snake_case_name `a*b*c`'),
    '<strong><a href="file:///tmp/a%20b.html">Open</a></strong> · <em>em</em> and <em>em</em> in snake_case_name <code>a*b*c</code>');
});

test('escaping: raw HTML and attribute quotes never survive; an ampersand in an href is encoded', () => {
  assert.equal(toHtml('<script>alert(1)</script> <img src=x onerror="y">'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;y&quot;&gt;</p>');
  assert.equal(inline('[q](https://a.example/?x=1&y="2")'), '<a href="https://a.example/?x=1&amp;y=&quot;2&quot;">q</a>');
  assert.equal(inline('`<b>` \u0000 [`<i>`](#top)'), '<code>&lt;b&gt;</code>  <a href="#top"><code>&lt;i&gt;</code></a>');
});

test('links: only http, https, file, obsidian and relative targets become anchors', () => {
  for (const u of ['https://a.example', 'http://a.example', 'file:///tmp/x.html', 'obsidian://open?path=%2Fv%2Fa.md', 'docs/a.md', '#frag']) assert.equal(safeHref(u), u);
  for (const u of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'vbscript:x', '//evil.example/x']) assert.equal(safeHref(u), null);
  assert.equal(inline('[click](javascript:alert(1))'), 'click');
  assert.equal(inline('[wiki](https://en.example/wiki/A_(b))'), '<a href="https://en.example/wiki/A_(b)">wiki</a>');
});
