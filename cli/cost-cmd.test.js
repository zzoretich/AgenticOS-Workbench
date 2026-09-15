'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./cost-cmd.js');

const py = (line) => () => ({ stdout: `${line}\n`, stderr: '' });

function world() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ version: '0.1.0', vault, node: '/usr/bin/node', claudeConfigDir: configDir, provider: 'auto', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 }, cost: { enabled: false }, persona: { enabled: true } }, null, 2));
  const logs = []; const io = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  const agenticos = () => JSON.parse(fs.readFileSync(path.join(configDir, 'agenticos.json'), 'utf8'));
  const vaultCfg = () => JSON.parse(fs.readFileSync(path.join(vault, 'brain', 'config.json'), 'utf8'));
  return { configDir, vault, io, logs, agenticos, vaultCfg };
}

test('pythonVersion parses and enforces the 3.9 floor', () => {
  assert.deepEqual(C.pythonVersion(py('Python 3.11.4')), { ok: true, version: '3.11.4', reason: null });
  assert.equal(C.pythonVersion(py('Python 3.9.6')).ok, true);
  assert.equal(C.pythonVersion(py('Python 3.8.10')).ok, false);
  assert.match(C.pythonVersion(() => ({ error: new Error('ENOENT'), stdout: '', stderr: '' })).reason, /not found/);
});

test('enable copies the analyzer, flips cost.enabled and stores the budget', async () => {
  const w = world();
  const r = await C.enable({ configDir: w.configDir, budget: '120', io: w.io, exec: py('Python 3.12.1') });
  assert.equal(r.monthlyBudget, 120);
  for (const f of C.FILES) assert.ok(fs.existsSync(path.join(w.vault, 'brain', 'scripts', 'cost', f)), f);
  assert.equal(w.agenticos().cost.enabled, true);
  assert.equal(w.agenticos().vault, w.vault, 'other keys untouched');
  assert.equal(w.vaultCfg().cost.monthlyBudget, 120);
});

test('enable refuses an old python and writes nothing', async () => {
  const w = world();
  await assert.rejects(() => C.enable({ configDir: w.configDir, budget: '10', io: w.io, exec: py('Python 3.8.1') }), /3\.9/);
  assert.ok(!fs.existsSync(path.join(w.vault, 'brain', 'scripts', 'cost')));
  assert.equal(w.agenticos().cost.enabled, false);
});

test('disable flips the flag and leaves the files; run() maps subcommands to exit codes', async () => {
  const w = world();
  assert.equal(await C.run([], { configDir: w.configDir, io: w.io }), 0);
  assert.equal(w.logs.at(-1), 'cost disabled', 'bare `aos cost` reports the flag (Plan 3 assertion)');
  assert.equal(await C.run(['enable'], { configDir: w.configDir, io: w.io, yes: true, exec: py('Python 3.10.0') }), 0);
  // execution amendment 2026-09-15 (A38): with --yes and no --budget nothing is written to brain/config.json (the file does not even exist yet).
  assert.ok(!fs.existsSync(path.join(w.vault, 'brain', 'config.json')), 'no budget asked with --yes: brain/config.json untouched');
  assert.equal(await C.run([], { configDir: w.configDir, io: w.io }), 0);
  assert.equal(w.logs.at(-1), 'cost enabled');
  assert.equal(await C.run(['disable'], { configDir: w.configDir, io: w.io }), 0);
  assert.equal(w.agenticos().cost.enabled, false);
  assert.ok(fs.existsSync(path.join(w.vault, 'brain', 'scripts', 'cost', 'analyze_transcript.py')));
  assert.equal(await C.run(['bogus'], { configDir: w.configDir, io: w.io }), 2);
  assert.equal(await C.run(['enable'], { configDir: w.configDir, io: w.io, exec: py('Python 3.12.0'), ask: async () => '75' }), 0);
  assert.equal(w.vaultCfg().cost.monthlyBudget, 75);
  assert.equal(await C.run(['enable'], { configDir: w.configDir, io: w.io, budget: '40', exec: py('Python 3.12.0') }), 0, 'opts.budget comes from Plan 3 flags.budget');
  assert.equal(w.vaultCfg().cost.monthlyBudget, 40);
  // execution amendment 2026-09-15 (A38): a re-run without --budget keeps the stored budget instead of resetting it to null.
  assert.equal(await C.run(['enable'], { configDir: w.configDir, io: w.io, yes: true, exec: py('Python 3.12.0') }), 0);
  assert.equal(w.vaultCfg().cost.monthlyBudget, 40, 'stored budget survives a --yes re-run');
  // execution amendment 2026-09-15 (A39): a non-numeric --budget is a usage mistake, not "no budget".
  assert.equal(await C.run(['enable'], { configDir: w.configDir, io: w.io, budget: 'abc', exec: py('Python 3.12.0') }), 1);
  assert.match(w.logs.at(-1), /--budget must be a positive number/);
  assert.equal(w.vaultCfg().cost.monthlyBudget, 40, 'a rejected --budget writes nothing');
});

test('extrasDirFor prefers an explicit hint, then the checkout, then the marketplace clone', () => {
  const w = world();
  const hint = fs.mkdtempSync(path.join(os.tmpdir(), 'hint-'));
  fs.mkdirSync(path.join(hint, 'extras', 'cost'), { recursive: true });
  fs.writeFileSync(path.join(hint, 'extras', 'cost', 'analyze_transcript.py'), '# stub\n');
  assert.equal(C.extrasDirFor(w.configDir, hint), path.join(hint, 'extras', 'cost'));
  assert.equal(C.extrasDirFor(w.configDir, null), C.EXTRAS, 'the checkout copy exists in this repo');
  const clone = path.join(w.configDir, 'plugins', 'marketplaces', 'agenticos-workbench', 'extras', 'cost');
  assert.equal(C.extrasDirFor(w.configDir, null, { checkout: '/nonexistent' }), clone);
});
