'use strict';
// lib/statusline-render.js (spec 2026-09-28-statusline-design §4.3): three lines from a payload and the model, width
// fitting, OSC 8 links from allow-listed targets (D10), subagent rows (D8) and the Codex summary line (D7).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/statusline-render.js');

const NOW = Date.UTC(2026, 8, 28, 19, 0, 0);
const S = NOW / 1000;
const PAYLOAD = {
  session_id: 'abc',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5 (1M context)' },
  effort: { level: 'high' },
  thinking: { enabled: true },
  workspace: { current_dir: '/work/AgenticOS-Workbench/sub', project_dir: '/work/AgenticOS-Workbench' },
  cost: { total_cost_usd: 3.4213, total_lines_added: 156, total_lines_removed: 23 },
  context_window: { remaining_percentage: 62, context_window_size: 1000000 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: S + 7200 }, seven_day: { used_percentage: 41.2, resets_at: S + 300000 } },
  prompt_cache: { warm: true, hit_ratio: 0.91, expires_at: S + 42 * 60 },
  pr: { number: 63, url: 'https://github.com/o/r/pull/63', review_state: 'pending' },
};
const MODEL = {
  schema: 1, at: new Date(NOW).toISOString(), vault: 'AgenticOS',
  needs: { gates: [{ team: 'dev', item: 'devbar-01', stage: 'ship' }, { team: 'dev', item: 'site-02', stage: 'discuss' }], alerts: 1, breaking: 0, flags: 1 },
  runs: [{ team: 'dev', member: 'woz', stage: 'execute', item: 'devbar-01' }],
  spend: { family: 'duties', usd: 4.8, cap: 6, ratio: 0.8 },
  health: { update: '0.21.0', provider: null, unwrapped: false, drafts: 11 },
};
const WORK = { kind: 'task', text: 'Writing the spec' };
const GIT = { branch: 'feat/statusline', dirty: true, ahead: 1, behind: 0 };
const plainLines = (lines) => lines.map(R.plain);

test('render: three lines from a full payload and model', () => {
  const lines = R.render({ payload: PAYLOAD, model: MODEL, work: WORK, git: GIT, now: NOW, links: false });
  assert.deepEqual(plainLines(lines), [
    'Opus 5.5 (1M) ·high ·think │ Writing the spec │ AgenticOS-Workbench ⎇ feat/statusline*↑1 │ #63 review',
    '████░░░░░░ 46% │ 5h 24% · 7d 41% │ $3.42 │ cache 91% · 42m │ +156/-23',
    '◆ 2 gates · 1 alert · 1 flag │ ▶ woz execute devbar-01 │ duties $4.80/$6 │ ↑ 0.21.0 · 11 drafts',
  ]);
  assert.ok(lines[0].includes('\x1b['), 'colored');
});

test('render: L3 is omitted when nothing needs the user; a bare payload is one line', () => {
  const quiet = { ...MODEL, needs: { gates: [], alerts: 0, breaking: 0, flags: 0 }, runs: [], spend: null, health: { update: null, provider: null, unwrapped: false, drafts: 0 } };
  assert.equal(R.render({ payload: PAYLOAD, model: quiet, now: NOW }).length, 2);
  assert.deepEqual(plainLines(R.render({ payload: null })), ['Claude']);
  assert.deepEqual(plainLines(R.render({ payload: { model: { display_name: 'Sonnet 5.5' }, workspace: { current_dir: '/x/proj' } } })), ['Sonnet 5.5 │ proj']);
});

test('render: segments switch off by config', () => {
  const lines = plainLines(R.render({ payload: PAYLOAD, model: MODEL, now: NOW, links: false, segments: ['runs'] }));
  assert.equal(lines[2], '▶ woz execute devbar-01');
});

test('render: a narrow terminal drops the lowest-priority segments instead of wrapping', () => {
  const at = (columns) => plainLines(R.render({ payload: PAYLOAD, model: MODEL, work: WORK, git: GIT, now: NOW, links: false, columns }));
  assert.deepEqual(at(72), [
    'Opus 5.5 (1M) ·high ·think │ AgenticOS-Workbench ⎇ feat/statusline*↑1',
    '████░░░░░░ 46% │ 5h 24% · 7d 41% │ $3.42 │ cache 91% · 42m │ +156/-23',
    '◆ 2 gates · 1 alert · 1 flag │ ▶ woz execute devbar-01 │ duties $4.80/$6',
  ], 'PR then work leave L1; health leaves L3');
  assert.deepEqual(at(50), [
    'Opus 5.5 (1M) ·high ·think',
    '████░░░░░░ 46% │ 5h 24% · 7d 41% │ $3.42',
    '◆ 2 gates · 1 alert · 1 flag',
  ]);
  for (const l of [...at(72), ...at(50)]) assert.ok(R.width(l) <= 72, `${l} fits`);
  assert.equal(plainLines(R.render({ payload: PAYLOAD, columns: 5 }))[0], 'Opus…', 'a last segment too wide is clipped, not wrapped (SL-10)');
});

test('render: OSC 8 links only to allow-listed targets', () => {
  const lines = R.render({ payload: PAYLOAD, model: MODEL, now: NOW, links: true });
  const all = lines.join('\n');
  // The app registers agenticos:// (lib/hud-host.js): a link names a tab or a vault file, never a vault.
  assert.ok(all.includes('\x1b]8;;agenticos://workbench?tab=agent-teams\x07◆ 2 gates\x1b]8;;\x07'));
  assert.ok(all.includes('agenticos://workbench?tab=notifications'));
  assert.ok(all.includes('agenticos://note?file=persona%2FSTATE.md'));
  assert.ok(!all.includes('obsidian://'), 'no Obsidian link is left');
  assert.ok(all.includes(`https://github.com/${R.REPO_SLUG}/releases/tag/v0.21.0`));
  assert.ok(all.includes('\x1b]8;;https://github.com/o/r/pull/63\x07'));
  const unsafe = R.render({ payload: { ...PAYLOAD, pr: { number: 1, url: 'javascript:alert(1)' } }, links: true }).join('');
  assert.ok(!unsafe.includes('javascript:'), 'a non-https PR url is not linked');
  assert.ok(!R.render({ payload: PAYLOAD, model: MODEL, now: NOW, links: false }).join('').includes('\x1b]8;;'));
  assert.equal(R.targets().release('0.21.0;rm'), null);
});

test('contextUsed: scaled to the usable window, honoring CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
  assert.equal(R.contextUsed({ remaining_percentage: 62, context_window_size: 1e6 }), 46);
  assert.equal(R.contextUsed({ remaining_percentage: 62, context_window_size: 1e6 }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }), 76);
  assert.equal(R.contextUsed({ used_percentage: 10 }), 0 + Math.round(100 - ((90 - 16.5) / 83.5) * 100));
  assert.equal(R.contextUsed({ remaining_percentage: 10 }), 100);
  assert.equal(R.contextUsed({ remaining_percentage: null }), null);
  assert.equal(R.contextUsed(null), null);
});

test('limits and cache: reset time at 80 % and over, a cold cache says so', () => {
  const p = { ...PAYLOAD, rate_limits: { five_hour: { used_percentage: 85, resets_at: S + 2 * 3600 + 5 * 60 } }, prompt_cache: { warm: false, hit_ratio: 0.5 } };
  assert.equal(plainLines(R.render({ payload: p, now: NOW }))[1], '████░░░░░░ 46% │ 5h 85% ↻2h05m │ $3.42 │ cache 50% · cold │ +156/-23');
});

test('summaryLine: the plain Codex notice, empty when quiet', () => {
  assert.equal(R.summaryLine(MODEL), 'AgenticOS: 2 gates need you (devbar-01 ship, site-02 discuss) · 1 alert · 1 open flag · running: woz execute devbar-01 · duties spend $4.80 of $6 today · update 0.21.0 available');
  assert.equal(R.summaryLine({ ...MODEL, needs: {}, runs: [], spend: null, health: {} }), '');
  assert.equal(R.summaryLine(null), '');
  assert.equal(R.summaryLine(MODEL, ['health']), 'AgenticOS: update 0.21.0 available');
});

test('subagentRows: one JSON line per task with an id, short model, context share and age', () => {
  const rows = R.subagentRows({
    columns: 200,
    tasks: [
      { id: 't1', name: 'Explore', description: 'Find the status bar code', model: 'claude-haiku-4-5-20251001', effort: 'low', tokenCount: 50000, contextWindowSize: 200000, startTime: NOW - 4 * 60e3 },
      { name: 'no id' },
      { id: 't2', type: 'general-purpose', startTime: new Date(NOW - 90 * 60e3).toISOString() },
    ],
  }, { now: NOW });
  assert.equal(rows.length, 2);
  const [a, b] = rows.map((r) => JSON.parse(r));
  assert.equal(a.id, 't1');
  assert.equal(R.plain(a.content), 'Explore │ Find the status bar code │ Haiku 4.5 ·low │ ctx 25% │ 4m');
  assert.equal(R.plain(b.content), 'general-purpose │ 1h30m');
  const narrow = JSON.parse(R.subagentRows({ columns: 30, tasks: [{ id: 'x', name: 'Explore', description: 'long long long', model: 'claude-opus-5-5', tokenCount: 1, contextWindowSize: 100 }] }, { now: NOW })[0]);
  assert.equal(R.plain(narrow.content), 'Explore │ Opus 5.5 │ ctx 1%', 'the description and age drop first; order is kept');
});

test('width: escapes are free, wide glyphs count two', () => {
  assert.equal(R.width('\x1b[1;35m\x1b]8;;agenticos://x\x07ab\x1b]8;;\x07\x1b[0m'), 2);
  assert.equal(R.width('日本'), 4);
  assert.equal(R.width('◆ ▶ ⎇ │'), 7);
  assert.equal(R.shortModel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(R.shortModel('gpt-5'), 'gpt-5');
  assert.equal(R.until(59 * 60e3), '59m');
  assert.equal(R.until(3 * 86400e3 + 4 * 3600e3), '3d4h');
});

test('SL-01: no dynamic value can put a control byte on the terminal; a PR link must parse as https', () => {
  const hostile = '\x1b]8;;https://evil.example\x07click\x1b]8;;\x07\x1b[2J';
  const lines = R.render({
    payload: { ...PAYLOAD, model: { display_name: `Opus${hostile}` }, workspace: { current_dir: `/x/${hostile}` }, pr: { number: 7, url: `https://github.com/o/r/pull/7${hostile}` }, vim: { mode: hostile } },
    model: { ...MODEL, needs: { gates: [{ item: hostile, stage: hostile }], alerts: 0, breaking: 0, flags: 0 }, runs: [{ member: hostile }], health: { update: `1.2.3${hostile}` } },
    work: { kind: 'task', text: hostile }, git: { branch: hostile }, now: NOW, links: true,
  });
  for (const l of lines) {
    const withoutOurs = l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;(?:https:\/\/github\.com\/o\/r\/pull\/7[^\x07\x1b]*|agenticos:\/\/[^\x07\x1b]*|https:\/\/github\.com\/[^\x07\x1b]*releases[^\x07\x1b]*|)\x07/g, '');
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(withoutOurs), JSON.stringify(l));
  }
  assert.ok(!lines.join('').includes('evil.example\x07'), 'no injected link target');
  assert.equal(R.safeHttps('https://github.com/o/r/pull/7\x07x'), 'https://github.com/o/r/pull/7%07x');
  assert.equal(R.safeHttps('http://github.com/o'), null);
  assert.equal(R.clean('a\x1bb\x07c\u009bd'), 'a b c d');
  const rows = R.subagentRows({ tasks: [{ id: 'x', name: `n${hostile}`, description: hostile, model: hostile }] }, { now: NOW });
  assert.ok(!/[\x00-\x08\x0b-\x1a\x1c-\x1f]|\x1b(?!\[[0-9;]*m)/.test(JSON.parse(rows[0]).content));
});

test('SL-07: malformed model data drops its own segment, never the whole line', () => {
  const bad = { ...MODEL, needs: { gates: [null], alerts: 1 }, runs: [null], spend: { family: 'duties', usd: 'x', cap: 6 }, health: null };
  const lines = plainLines(R.render({ payload: PAYLOAD, model: bad, now: NOW, links: false }));
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '1 alert');
});

test('SL-10: clipping keeps escapes whole and closes an open link', () => {
  const s = `\x1b[1;35m\x1b]8;;agenticos://x\x07◆ 2 gates waiting\x1b]8;;\x07\x1b[0m`;
  const c = R.clipStyled(s, 6);
  assert.equal(R.plain(c), '◆ 2 g…');
  assert.ok(c.endsWith('\x1b]8;;\x07\x1b[0m'), 'the link is closed and the style reset');
  assert.equal(R.clipStyled('short', 10), 'short');
});
