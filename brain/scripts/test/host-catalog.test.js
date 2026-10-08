'use strict';
// host-catalog.js: each host's own answer becomes the menus' models and commands (spec 2026-10-07-sessions-ux U3–U5,
// U8). The answers follow the shapes claude 2.1.293's initialize control response and codex-cli 0.158.0's
// `debug models` / `debug prompt-input` print; the CLIs themselves are faked, so nothing here runs a host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const C = require('../lib/host-catalog.js');

const NOW = new Date('2026-10-07T20:00:00.000Z');

const INIT = {
  type: 'control_response',
  response: {
    subtype: 'success', request_id: 'catalog',
    response: {
      commands: [
        { name: 'code-review', description: 'Review the current diff', argumentHint: '[level]' },
        { name: 'agenticos:recall', description: 'Search your memory', argumentHint: '' },
        { name: 'bad name', description: 'a space is not a command' },
        { name: 'code-review', description: 'a duplicate' },
      ],
      models: [
        { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
        { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Older', supportedEffortLevels: ['low', 'medium', 'high', 'max', 'turbo'] },
        { value: '--dangerous', displayName: 'A flag' },
      ],
      account: { email: 'someone@example.com', organization: 'Example', subscriptionType: 'Max' },
      pid: 4242,
    },
  },
};

const MODELS = { models: [
  { slug: 'gpt-luna', display_name: 'GPT-Luna', description: 'Fast and affordable.', visibility: 'list', priority: 4, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'max' }] },
  { slug: 'gpt-astra', display_name: 'GPT-Astra', description: 'Frontier intelligence.', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
  { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 1, supported_reasoning_levels: [] },
  { slug: 'gpt-sol', display_name: 'GPT-Sol', description: 'Workhorse.', visibility: 'list', priority: 3, supported_reasoning_levels: ['low', 'high'] },
  { slug: 'gpt-old', display_name: 'GPT-Old', description: 'Older.', visibility: 'list', priority: 9, supported_reasoning_levels: [{ effort: 'low' }] },
] };

const PROMPT_INPUT = [
  { type: 'message', role: 'developer', content: [{ type: 'input_text', text: [
    '<skills_instructions>', '## Skills', '### Skill roots', '- `r0` = `/somewhere/skills`', '### Available skills',
    '- imagegen: Generate or edit images (file: r0/imagegen/SKILL.md)',
    '- agenticos:recall: Search your memory (file: r1/recall/SKILL.md)',
    '- imagegen: a duplicate (file: r0/x/SKILL.md)',
    '### How to use skills', '- not-a-skill: this line follows the list', '</skills_instructions>',
  ].join('\n') }] },
];

test('claude: aliases are current, full ids older; efforts are the levels the CLI takes; the account is never kept', () => {
  const e = C.claudeEntry(INIT, '2.1.293', NOW);
  assert.equal(e.ok, true);
  assert.equal(e.version, '2.1.293');
  assert.deepEqual(e.models.map((m) => [m.id, m.main]), [['default', true], ['sonnet', true], ['claude-haiku-4-5-20251001', false], ['claude-opus-4-6', false]]);
  assert.deepEqual(e.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(e.models[2].efforts, [], 'a model without levels takes none');
  assert.deepEqual(e.models[3].efforts, ['low', 'medium', 'high', 'max'], 'an unknown level is dropped');
  assert.deepEqual(e.commands, [
    { name: 'code-review', insert: '/code-review ', description: 'Review the current diff', hint: '[level]' },
    { name: 'agenticos:recall', insert: '/agenticos:recall ', description: 'Search your memory', hint: null },
  ]);
  const s = JSON.stringify(e);
  assert.ok(!s.includes('example.com') && !s.includes('subscriptionType') && !s.includes('4242'), 'nothing but models and commands');
});

test('claude: an answer with no models falls back to the aliases', () => {
  const e = C.claudeEntry({ type: 'control_response', response: { subtype: 'success', response: { models: [] } } }, null, NOW);
  assert.equal(e.ok, false);
  assert.deepEqual(e.models.map((m) => m.id), ['default', 'opus', 'fable', 'sonnet', 'haiku']);
});

test('codex: listed models by priority, the first three current; skills become $name commands without their paths', () => {
  const e = C.codexEntry(MODELS, PROMPT_INPUT, { model: 'gpt-sol', effort: 'high' }, '0.158.0', NOW);
  assert.equal(e.ok, true);
  assert.deepEqual(e.models.map((m) => [m.id, m.main]), [['gpt-astra', true], ['gpt-sol', true], ['gpt-luna', true], ['gpt-old', false]]);
  assert.deepEqual(e.models[0].efforts, ['low', 'ultra']);
  assert.deepEqual(e.models[1].efforts, ['low', 'high'], 'plain strings are read too');
  assert.equal(e.models[0].description, 'Frontier intelligence', 'the trailing full stop is dropped');
  assert.deepEqual([e.defaultModel, e.defaultEffort], ['gpt-sol', 'high']);
  assert.deepEqual(e.commands, [
    { name: 'imagegen', insert: '$imagegen ', description: 'Generate or edit images', hint: null },
    { name: 'agenticos:recall', insert: '$agenticos:recall ', description: 'Search your memory', hint: null },
  ]);
  assert.ok(!JSON.stringify(e).includes('/somewhere'));
});

test('codex: no model list keeps the user default as the one choice', () => {
  const e = C.codexEntry(null, null, { model: 'gpt-sol', effort: null }, null, NOW);
  assert.equal(e.ok, false);
  assert.deepEqual(e.models.map((m) => m.id), ['gpt-sol']);
  assert.deepEqual(C.codexEntry(null, null, {}, null, NOW).models, []);
});

test('codex defaults come from the top of config.toml only', () => {
  assert.deepEqual(C.topLevelToml('model = "gpt-sol"\nmodel_reasoning_effort = "high" # comment\n[profiles.x]\nmodel = "other"\n'), { model: 'gpt-sol', model_reasoning_effort: 'high' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-luna"\nmodel_reasoning_effort = "turbo"\n');
  assert.deepEqual(C.codexDefaults(home), { model: 'gpt-luna', effort: null }, 'an unknown effort is not passed on');
  assert.deepEqual(C.codexDefaults(path.join(home, 'missing')), { model: null, effort: null });
});

/** A fake CLI: answers each argv with `script(args, child, bin)`. */
function fakeSpawn(script, calls = []) {
  return (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env, cwd: opts.cwd });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = null;
    child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit('close', null)); };
    setImmediate(() => script(args, child, bin));
    return child;
  };
}
const exit = (child, out, code = 0) => { child.stdout.end(out); setImmediate(() => child.emit('close', code)); };

test('fetchCatalog asks each enabled host headless, ends claude after its answer, and reads codex in three calls', async () => {
  const calls = [];
  const spawnFn = fakeSpawn((args, child, bin) => {
    if (args[0] === '--version') return exit(child, bin.endsWith('codex') ? 'codex-cli 0.158.0\n' : '2.1.293 (Claude Code)\n');
    if (args[0] === '-p') {
      child.stdin.on('data', (d) => {
        const req = JSON.parse(String(d));
        assert.equal(req.request.subtype, 'initialize');
        child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'status' })}\n${JSON.stringify(INIT)}\n`);
      });
      return;
    }
    if (args[1] === 'models') return exit(child, JSON.stringify(MODELS));
    if (args[1] === 'prompt-input') return exit(child, JSON.stringify(PROMPT_INPUT));
    exit(child, '', 2);
  }, calls);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-sol"\n');
  const lookup = (name) => `/bin/${name}`;
  const cat = await C.fetchCatalog({ cfg: { hosts: { claude: { enabled: true }, codex: { enabled: true, home } } }, env: { CLAUDECODE: '1' }, spawnFn, lookup, candidates: false, now: NOW });
  assert.equal(cat.schema, 1);
  assert.equal(cat.hosts.claude.ok, true);
  assert.equal(cat.hosts.claude.version, '2.1.293');
  assert.equal(cat.hosts.codex.ok, true);
  assert.equal(cat.hosts.codex.version, '0.158.0');
  assert.equal(cat.hosts.codex.defaultModel, 'gpt-sol');
  const init = calls.find((c) => c.args[0] === '-p');
  assert.deepEqual(init.args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
  assert.equal(init.env.AOS_HEADLESS, '1');
  assert.equal(init.env.CLAUDECODE, undefined, 'a catalog run is never inside another session');
  assert.equal(calls.find((c) => c.args[1] === 'models').env.CODEX_HOME, home);
  assert.ok(!JSON.stringify(cat).includes('example.com'));
});

test('a host that is off, missing, slow or failing keeps its fallback and says why', async () => {
  const spawnFn = fakeSpawn((args, child) => {
    if (args[0] === '-p') return;                         // never answers
    if (args[1] === 'models') return exit(child, '', 1);  // fails
    exit(child, '');
  });
  const lookup = (name) => `/bin/${name}`;
  const both = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  const cat = await C.fetchCatalog({ cfg: both, env: {}, spawnFn, lookup, candidates: false, timeoutMs: 50, now: NOW });
  assert.equal(cat.hosts.claude.ok, false);
  assert.match(cat.hosts.claude.reason, /did not answer/);
  assert.deepEqual(cat.hosts.claude.models.map((m) => m.id), ['default', 'opus', 'fable', 'sonnet', 'haiku']);
  assert.equal(cat.hosts.codex.ok, false);
  assert.match(cat.hosts.codex.reason, /codex debug models failed/);

  const off = await C.fetchCatalog({ cfg: { hosts: { claude: { enabled: true }, codex: { enabled: false } } }, env: {}, spawnFn, lookup: () => null, candidates: false, now: NOW });
  assert.deepEqual([off.hosts.codex.ok, off.hosts.codex.off, off.hosts.codex.reason], [false, true, 'Codex is off on this machine']);
  assert.deepEqual([off.hosts.claude.ok, off.hosts.claude.reason], [false, 'no claude binary found']);
});

test('the cache: written whole, fresh for a day when every host answered or is off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  const file = path.join(dir, 'brain', '_index', 'host-catalog.json');
  const cat = { schema: 1, fetchedAt: NOW.toISOString(), hosts: { claude: { ok: true }, codex: { ok: false, off: true } } };
  C.saveCatalog(file, cat);
  assert.deepEqual(C.loadCatalog(file), cat);
  assert.equal(C.isFresh(cat, new Date(NOW.getTime() + 60_000)), true);
  assert.equal(C.isFresh(cat, new Date(NOW.getTime() + C.MAX_AGE_MS)), false, 'a day old is stale');
  assert.equal(C.isFresh({ ...cat, hosts: { claude: { ok: false }, codex: { ok: true } } }, NOW), false, 'a host that failed is asked again');
  fs.writeFileSync(file, '{"schema":0}');
  assert.equal(C.loadCatalog(file), null);
});
