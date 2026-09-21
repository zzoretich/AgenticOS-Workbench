'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AOS = path.join(__dirname, 'aos.js');

function world() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vault-'));
  fs.mkdirSync(path.join(vault, 'brain', '_index'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agenticos.json'), JSON.stringify({ version: '0.1.0', vault, node: process.execPath, claudeConfigDir: configDir, provider: 'none', claude: { model: 'haiku', perCallUsd: 0.05, perDayUsd: 0.5 }, cost: { enabled: false }, persona: { enabled: true } }, null, 2));
  return { configDir, vault };
}
function aos(args, w) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: w.configDir };
  delete env.AOS_CONFIG; delete env.AOS_VAULT; delete env.BRAIN_VAULT;
  return spawnSync(process.execPath, [AOS, ...args], { encoding: 'utf8', env });
}

test('aos persona off/on is wired through cli/aos.js', () => {
  const w = world();
  const off = aos(['persona', 'off'], w);
  assert.equal(off.status, 0, off.stderr);
  assert.ok(fs.existsSync(path.join(w.vault, 'persona', 'DISABLED')));
  const on = aos(['persona', 'on'], w);
  assert.equal(on.status, 0, on.stderr);
  assert.ok(!fs.existsSync(path.join(w.vault, 'persona', 'DISABLED')));
});

test('vendorRuntime copies cli/ (no tests, fixtures, rehearsal), the persona templates and extras/ into the vault', () => {
  const w = world();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-home-'));   // linkLauncher writes $HOME/.local/bin/aos
  const script = `require(${JSON.stringify(AOS)}).vendorRuntime({ repo: ${JSON.stringify(path.join(__dirname, '..'))}, vault: ${JSON.stringify(w.vault)}, written: [] })`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, AOS_SKIP_NPM: '1', CLAUDE_CONFIG_DIR: w.configDir } });
  assert.equal(r.status, 0, r.stderr);
  const S = (rel) => path.join(w.vault, 'brain', 'scripts', rel);
  for (const rel of ['cli/aos.js', 'cli/persona-cmd.js', 'cli/schedule.js', 'persona/interview.js', 'persona/templates/identity.template.md',
    'persona/templates/duties/monitor.md', 'persona/templates/proposals/README.md', 'extras/schedule/launchd/routine.plist.tmpl',
    'extras/cost/analyze_transcript.py', 'extras/cost/pricing.json']) {
    assert.ok(fs.existsSync(S(rel)), `vendored ${rel}`);
  }
  for (const rel of ['cli/aos.test.js', 'cli/persona-cmd.test.js', 'cli/schedule.test.js', 'cli/fixtures', 'cli/rehearsal', 'extras/cost/test_analyze_transcript.py', 'test']) {
    assert.ok(!fs.existsSync(S(rel)), `${rel} is not vendored`);
  }
});

test('aos cost disable is wired through cli/aos.js', () => {
  const w = world();
  const r = aos(['cost', 'disable'], w);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.configDir, 'agenticos.json'), 'utf8')).cost.enabled, false);
  assert.match(r.stdout, /cost: disabled/);
});
